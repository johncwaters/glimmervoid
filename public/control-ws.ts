import { nextReconnectDelayMs } from './reconnect-backoff.ts';
import { buildWebSocketUrl } from './ws-url-core.ts';
import { clearPageToken, loadPageToken, pageToken, withPageToken } from './ws-token.ts';
import { ServerMessage } from '#shared/contracts/control-messages.ts';
import { NOT_CONNECTED_TEXT, REQUEST_TIMED_OUT_TEXT } from './updates-view-core.ts';
import { createClientLogReporter, createHeaderErrorTelemetryReporter, describeSchemaIssues, frameTypeOf } from './client-error-core.ts';

type ControlMessageHandler = (message: ServerMessage) => void;
type ConnectionStateCallback = (state: string, label: string) => void;
type ControlSocketChange = 'connecting' | 'opened' | 'closed';
type ControlSocketChangeListener = (change: ControlSocketChange) => void;

interface PendingRequest {
  resolve: (message: ServerMessage) => void;
  reject: (reason: Error) => void;
  timer: number;
}

interface ControlClientOptions {
  pathPrefix: string;
  isLocal: boolean;
  onMessage(message: ServerMessage): void;
  onStateChange?(state: string, label: string): void;
  onSocketChange?(change: ControlSocketChange): void;
  onOpened?(): void;
}

export interface ControlClient {
  connect(): void;
  abandon(): void;
  reconnectNow(): void;
  send(msg: Record<string, unknown>): boolean;
  request(type: string, payload?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<ServerMessage>;
}

let requestSequence = 0;

export function nextRequestId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${requestSequence}`;
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  let controlWs: WebSocket | null = null;
  let controlRetryTimer: number | null = null;
  let controlRetryAttempt = 0;
  let lastSeq = 0;
  let isAbandoned = false;
  let isTokenFetchPending = false;
  const pendingRequests = new Map<string, PendingRequest>();

  function send(msg: Record<string, unknown>): boolean {
    if (controlWs?.readyState !== WebSocket.OPEN) return false;
    controlWs.send(JSON.stringify(msg));
    return true;
  }

  function request(type: string, payload?: Record<string, unknown>, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<ServerMessage> {
    const requestId = nextRequestId(type);
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(REQUEST_TIMED_OUT_TEXT));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timer });
      if (controlWs?.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        reject(new Error(NOT_CONNECTED_TEXT));
        return;
      }
      controlWs.send(JSON.stringify({ type, requestId, ...payload }));
    });
  }

  function rejectUnreadableReply(rawMessage: unknown) {
    if (typeof rawMessage !== 'object' || rawMessage === null || !('requestId' in rawMessage)) return;
    const requestId = rawMessage.requestId;
    if (typeof requestId !== 'string') return;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.reject(new Error('The server sent a reply this dashboard could not read. Reload the page to pick up the current version.'));
  }

  function rejectPendingRequests(reason: string) {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingRequests.clear();
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
    rejectPendingRequests(NOT_CONNECTED_TEXT);
    options.onStateChange?.('disconnected', 'Reconnecting');
    abandonedSocket?.close();
  }

  function reconnectNow() {
    abandon();
    controlRetryAttempt = 0;
    connect();
  }

  function receive(ws: WebSocket, event: MessageEvent<string>) {
    if (controlWs !== ws) return;
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(event.data);
    } catch {
      reportToServerLog('control', `dropped a ${options.pathPrefix || 'local'} message that is not JSON`);
      return;
    }
    const parsedMessage = ServerMessage.safeParse(rawMessage);
    if (!parsedMessage.success) {
      reportToServerLog('control', `dropped ${frameTypeOf(rawMessage)}: ${describeSchemaIssues(parsedMessage.error.issues)}`);
      rejectUnreadableReply(rawMessage);
      return;
    }
    const msg = parsedMessage.data;

    if (msg.type === 'snapshot' && typeof msg.seq !== 'number') lastSeq = 0;

    if (typeof msg.seq === 'number') {
      if (msg.seq <= lastSeq) return;
      lastSeq = msg.seq;
    }

    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const pending = requestId ? pendingRequests.get(requestId) : undefined;
    if (pending) {
      clearTimeout(pending.timer);
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
    const url = buildWebSocketUrl(location, withPageToken(`${options.pathPrefix}/control${since}`));
    const ws = new WebSocket(url);
    controlWs = ws;
    options.onSocketChange?.('connecting');
    let hasEverOpened = false;

    ws.addEventListener('open', () => {
      if (controlWs !== ws) return;
      hasEverOpened = true;
      controlRetryAttempt = 0;
      options.onStateChange?.('connected', 'Connected');
      options.onOpened?.();
      options.onSocketChange?.('opened');
    });

    ws.addEventListener('message', (event: MessageEvent<string>) => receive(ws, event));

    ws.addEventListener('close', () => {
      if (controlWs !== ws) return;
      controlWs = null;
      rejectPendingRequests(NOT_CONNECTED_TEXT);

      if (!hasEverOpened && options.isLocal) clearPageToken();
      options.onStateChange?.('disconnected', 'Reconnecting');
      options.onSocketChange?.('closed');
      const retryDelayMs = nextReconnectDelayMs(controlRetryAttempt);
      controlRetryAttempt += 1;
      controlRetryTimer = setTimeout(connect, retryDelayMs);
    });
  }

  return { connect, abandon, reconnectNow, send, request };
}

let _messageHandler: ControlMessageHandler | null = null;
let _connectionStateCallback: ConnectionStateCallback | null = null;
let _controlSocketChangeListener: ControlSocketChangeListener | null = null;
let routeControlMessage: (msg: Record<string, unknown>) => ControlClient | null = () => null;
let listHostClients: () => readonly ControlClient[] = () => [];

const localClient = createControlClient({
  pathPrefix: '',
  isLocal: true,
  onMessage: (message) => _messageHandler?.(message),
  onStateChange: (state, label) => _connectionStateCallback?.(state, label),
  onSocketChange: (change) => _controlSocketChangeListener?.(change),
  onOpened: () => {
    clientLogReporter.flushUnsent();
    headerErrorTelemetryReporter.flushUnsent();
  },
});

export function setControlRouter(router: (msg: Record<string, unknown>) => ControlClient | null, hostClients: () => readonly ControlClient[]) {
  routeControlMessage = router;
  listHostClients = hostClients;
}

export function setConnectionStateCallback(fn: ConnectionStateCallback) {
  _connectionStateCallback = fn;
}

export function onControlSocketChange(listener: ControlSocketChangeListener) {
  _controlSocketChangeListener = listener;
}

export function onControlMessage(handler: ControlMessageHandler) {
  _messageHandler = handler;
}

export function sendControlMsg(msg: Record<string, unknown>): boolean {
  return (routeControlMessage(msg) ?? localClient).send(msg);
}

const clientLogReporter = createClientLogReporter(localClient.send);
const headerErrorTelemetryReporter = createHeaderErrorTelemetryReporter(localClient.send);

export function reportToServerLog(scope: string, text: string): void {
  console.warn(`[${scope}] ${text}`);
  clientLogReporter.report(scope, text);
}

export function reportHeaderErrorToServer(source: string, text: string): void {
  clientLogReporter.report('header error', `${source}: ${text}`);
  headerErrorTelemetryReporter.report(source, text);
}

export function sendControlRequest(type: string, payload?: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<ServerMessage> {
  return (routeControlMessage(payload ?? {}) ?? localClient).request(type, payload, options);
}

export function abandonControlSocket() {
  localClient.abandon();
  for (const hostClient of listHostClients()) hostClient.abandon();
}

export function replaceControlSocket() {
  localClient.reconnectNow();
  for (const hostClient of listHostClients()) hostClient.reconnectNow();
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
