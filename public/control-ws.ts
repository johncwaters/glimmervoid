import { nextReconnectDelayMs } from './reconnect-backoff.ts';
import { createHandshakeRace } from './handshake-race-core.ts';
import { buildWebSocketUrl } from './ws-url-core.ts';
import { clearPageToken, loadPageToken, pageToken, withPageToken } from './ws-token.ts';
import { ServerMessage } from '#shared/contracts/control-messages.ts';
import { NOT_CONNECTED_TEXT, REQUEST_TIMED_OUT_TEXT } from './updates-view-core.ts';
import { createClientLogReporter, createHoldingSender, createNoticeTelemetryReporter, describeSchemaIssues, frameTypeOf } from './client-error-core.ts';
import type { NoticeShownReport } from './client-error-core.ts';
import type { AdoptedHandshake } from './reconnect-report-core.ts';
import type { DASHBOARD_TELEMETRY_EVENTS } from '#shared/contracts/control/control-fields.ts';

type ControlMessageHandler = (message: ServerMessage) => void;
type ConnectionStateCallback = (state: string, label: string) => void;
type ControlSocketChange = 'connecting' | 'opened' | 'closed';
type ControlSocketChangeListener = (change: ControlSocketChange) => void;
type UnreadableServerMessageListener = () => void;

export const UNREADABLE_SERVER_MESSAGE_TEXT = 'The server sent a message this dashboard could not read. Reload the page to pick up the current version.';

interface PendingRequest {
  type: string;
  requestId: string;
  payload: Record<string, unknown> | undefined;
  timeoutMs: number;
  socketWaitLeftMs: number;
  socketWaitStartedAtMs: number | null;
  delivery: 'unsent' | 'sent';
  resolve: (message: ServerMessage) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ControlClientOptions {
  onMessage(message: ServerMessage): void;
  onStateChange?(state: string, label: string): void;
  onSocketChange?(change: ControlSocketChange): void;
  onOpened?(adopted: AdoptedHandshake): void;
  onUnreadableMessage?(): void;
}

interface ControlClient {
  connect(): void;
  abandon(): void;
  reconnectNow(): void;
  raceHandshake(): void;
  send(msg: Record<string, unknown>): boolean;
  request(type: string, payload?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<ServerMessage>;
}

let requestSequence = 0;
const pageRequestTag = Array.from(crypto.getRandomValues(new Uint8Array(6)), (randomByte) => randomByte.toString(16).padStart(2, '0')).join('');

export function nextRequestId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${pageRequestTag}-${requestSequence}`;
}

function createControlClient(options: ControlClientOptions): ControlClient {
  let controlWs: WebSocket | null = null;
  let controlRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let controlRetryAttempt = 0;
  let lastSeq = 0;
  let isAbandoned = false;
  let isTokenFetchPending = false;
  const pendingRequests = new Map<string, PendingRequest>();
  const handshakeRace = createHandshakeRace<WebSocket>((attempt) => attempt.close());

  function send(msg: Record<string, unknown>): boolean {
    if (controlWs?.readyState !== WebSocket.OPEN) return false;
    controlWs.send(JSON.stringify(msg));
    return true;
  }

  function clearRequestTimer(pending: PendingRequest) {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.socketWaitStartedAtMs === null) return;
    pending.socketWaitLeftMs = Math.max(0, pending.socketWaitLeftMs - (performance.now() - pending.socketWaitStartedAtMs));
    pending.socketWaitStartedAtMs = null;
  }

  function failRequest(requestId: string, reasonText: string) {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    clearRequestTimer(pending);
    pendingRequests.delete(requestId);
    pending.reject(new Error(reasonText));
  }

  function carryRequest(pending: PendingRequest, socket: WebSocket) {
    clearRequestTimer(pending);
    const resentMarker = pending.delivery === 'sent' ? { resent: true } : {};
    socket.send(JSON.stringify({ type: pending.type, requestId: pending.requestId, ...pending.payload, ...resentMarker }));
    pending.delivery = 'sent';
    pending.timer = setTimeout(() => failRequest(pending.requestId, REQUEST_TIMED_OUT_TEXT), pending.timeoutMs);
  }

  function awaitSocketFor(pending: PendingRequest) {
    clearRequestTimer(pending);
    pending.socketWaitStartedAtMs = performance.now();
    pending.timer = setTimeout(() => failRequest(pending.requestId, NOT_CONNECTED_TEXT), pending.socketWaitLeftMs);
  }

  function holdPendingRequests() {
    for (const pending of pendingRequests.values()) awaitSocketFor(pending);
  }

  function resendPendingRequests(socket: WebSocket) {
    for (const pending of pendingRequests.values()) carryRequest(pending, socket);
  }

  function request(type: string, payload?: Record<string, unknown>, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<ServerMessage> {
    const requestId = nextRequestId(type);
    return new Promise<ServerMessage>((resolve, reject) => {
      const pending: PendingRequest = { type, requestId, payload, timeoutMs, socketWaitLeftMs: timeoutMs, socketWaitStartedAtMs: null, delivery: 'unsent', resolve, reject, timer: null };
      pendingRequests.set(requestId, pending);
      if (controlWs?.readyState === WebSocket.OPEN) {
        carryRequest(pending, controlWs);
        return;
      }
      awaitSocketFor(pending);
    });
  }

  function rejectUnreadableReply(rawMessage: unknown) {
    if (typeof rawMessage !== 'object' || rawMessage === null || !('requestId' in rawMessage)) return;
    const requestId = rawMessage.requestId;
    if (typeof requestId !== 'string') return;
    failRequest(requestId, UNREADABLE_SERVER_MESSAGE_TEXT);
  }

  function clearControlRetryTimer() {
    if (controlRetryTimer !== null) clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
  }

  function abandon() {
    const abandonedSocket = controlWs;
    controlWs = null;
    isAbandoned = true;
    clearControlRetryTimer();
    handshakeRace.closeAll();
    holdPendingRequests();
    options.onStateChange?.('disconnected', 'Reconnecting');
    abandonedSocket?.close();
  }

  function reconnectNow() {
    abandon();
    controlRetryAttempt = 0;
    connect();
  }

  function raceHandshake() {
    if (isAbandoned || controlWs !== null) return;
    connect();
  }

  function receive(ws: WebSocket, event: MessageEvent<string>) {
    if (controlWs !== ws) return;
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(event.data);
    } catch {
      reportToServerLog('control', 'dropped a message that is not JSON');
      return;
    }
    const parsedMessage = ServerMessage.safeParse(rawMessage);
    if (!parsedMessage.success) {
      reportToServerLog('control', `dropped ${frameTypeOf(rawMessage)}: ${describeSchemaIssues(parsedMessage.error.issues)}`);
      rejectUnreadableReply(rawMessage);
      options.onUnreadableMessage?.();
      return;
    }
    const msg = parsedMessage.data;

    if (msg.type === 'snapshot') lastSeq = 0;

    if (typeof msg.seq === 'number') {
      if (msg.seq <= lastSeq) return;
      lastSeq = msg.seq;
    }

    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const pending = requestId ? pendingRequests.get(requestId) : undefined;
    if (pending) {
      clearRequestTimer(pending);
      pendingRequests.delete(requestId);
      pending.resolve(msg);
      return;
    }

    options.onMessage(msg);
  }

  function connect() {
    isAbandoned = false;
    clearControlRetryTimer();

    if (isTokenFetchPending) return;
    if (!pageToken()) {
      isTokenFetchPending = true;
      void loadPageToken().finally(() => {
        isTokenFetchPending = false;
        if (!isAbandoned) connect();
      });
      return;
    }

    const since = lastSeq > 0 ? `?since=${lastSeq}` : '';
    const url = buildWebSocketUrl(location, withPageToken(`/control${since}`));
    const ws = new WebSocket(url);
    const startedAtMs = performance.now();
    handshakeRace.start(ws);
    options.onSocketChange?.('connecting');
    let hasEverOpened = false;

    ws.addEventListener('open', () => {
      const attempts = handshakeRace.adopt(ws);
      if (attempts === null) return;
      controlWs = ws;
      hasEverOpened = true;
      controlRetryAttempt = 0;
      resendPendingRequests(ws);
      options.onStateChange?.('connected', 'Connected');
      options.onOpened?.({ handshakeMs: performance.now() - startedAtMs, attempts });
      options.onSocketChange?.('opened');
    });

    ws.addEventListener('message', (event: MessageEvent<string>) => receive(ws, event));

    ws.addEventListener('close', () => {
      const wasRacing = handshakeRace.isRacing(ws);
      if (wasRacing && handshakeRace.drop(ws) > 0) return;
      if (!wasRacing && controlWs !== ws) return;
      controlWs = null;
      holdPendingRequests();

      if (!hasEverOpened) clearPageToken();
      options.onStateChange?.('disconnected', 'Reconnecting');
      options.onSocketChange?.('closed');
      const retryDelayMs = nextReconnectDelayMs(controlRetryAttempt);
      controlRetryAttempt += 1;
      controlRetryTimer = setTimeout(connect, retryDelayMs);
    });
  }

  return { connect, abandon, reconnectNow, raceHandshake, send, request };
}

let _messageHandler: ControlMessageHandler | null = null;
let lastAdoptedHandshake: AdoptedHandshake | null = null;
let _connectionStateCallback: ConnectionStateCallback | null = null;
let _controlSocketChangeListener: ControlSocketChangeListener | null = null;
let _unreadableServerMessageListener: UnreadableServerMessageListener | null = null;

const localClient = createControlClient({
  onMessage: (message) => _messageHandler?.(message),
  onStateChange: (state, label) => _connectionStateCallback?.(state, label),
  onSocketChange: (change) => _controlSocketChangeListener?.(change),
  onUnreadableMessage: () => _unreadableServerMessageListener?.(),
  onOpened: (adopted) => {
    lastAdoptedHandshake = adopted;
    clientLogReporter.flushUnsent();
    noticeTelemetryReporter.flushUnsent();
    dashboardTelemetrySender.flushUnsent();
  },
});

export function setConnectionStateCallback(fn: ConnectionStateCallback) {
  _connectionStateCallback = fn;
}

export function onControlSocketChange(listener: ControlSocketChangeListener) {
  _controlSocketChangeListener = listener;
}

export function onUnreadableServerMessage(listener: UnreadableServerMessageListener) {
  _unreadableServerMessageListener = listener;
}

export function onControlMessage(handler: ControlMessageHandler) {
  _messageHandler = handler;
}

export function sendControlMsg(msg: Record<string, unknown>): boolean {
  return localClient.send(msg);
}

const clientLogReporter = createClientLogReporter(localClient.send);
const noticeTelemetryReporter = createNoticeTelemetryReporter(localClient.send);
const dashboardTelemetrySender = createHoldingSender(localClient.send);

type DashboardTelemetryEvent = Exclude<(typeof DASHBOARD_TELEMETRY_EVENTS)[number], 'notice_shown'>;

export function reportDashboardTelemetry(event: DashboardTelemetryEvent, properties: object): void {
  dashboardTelemetrySender.sendOrHold({ type: 'dashboard-telemetry', event, properties });
}

export function readLastAdoptedHandshake(): AdoptedHandshake | null {
  return lastAdoptedHandshake;
}

export function reportToServerLog(scope: string, text: string): void {
  console.warn(`[${scope}] ${text}`);
  clientLogReporter.report(scope, text);
}

export function reportNoticeShown(report: NoticeShownReport): void {
  clientLogReporter.report(`notice ${report.notice}`, report.message);
  noticeTelemetryReporter.report(report);
}

export function sendControlRequest(type: string, payload?: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<ServerMessage> {
  return localClient.request(type, payload, options);
}

export function abandonControlSocket() {
  localClient.abandon();
}

export function replaceControlSocket() {
  localClient.reconnectNow();
}

export function raceControlHandshake() {
  localClient.raceHandshake();
}

export function probeControl(deadlineMs: number, isAnnounced: boolean): Promise<boolean> {
  if (isAnnounced && _connectionStateCallback) _connectionStateCallback('connecting', 'Connecting');
  return localClient.request('ping', {}, { timeoutMs: deadlineMs }).then(
    () => {
      if (isAnnounced && _connectionStateCallback) _connectionStateCallback('verified', 'Connected');
      return true;
    },
    () => false,
  );
}

export function connectControl() {
  localClient.connect();
}
