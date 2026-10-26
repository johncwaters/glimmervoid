import { nextReconnectDelayMs } from './reconnect-backoff.ts';
import { decideLivenessAction } from './connection-liveness-core.ts';
import { buildWebSocketUrl } from './ws-url-core.ts';
import { clearPageToken, loadPageToken, pageToken, withPageToken } from './ws-token.ts';
import { ServerMessage } from '#shared/contracts/control-messages.ts';
import { NOT_CONNECTED_TEXT } from './updates-view-core.ts';
import { createClientLogReporter, describeSchemaIssues, frameTypeOf } from './client-error-core.ts';

type ControlMessageHandler = (message: ServerMessage) => void;
type ConnectionStateCallback = (state: string, label: string) => void;

interface PendingRequest {
  resolve: (message: ServerMessage) => void;
  reject: (reason: Error) => void;
  timer: number;
}

let controlWs: WebSocket | null = null;
let controlRetryTimer: number | null = null;

let controlRetryAttempt = 0;
const pendingRequests = new Map<string, PendingRequest>();
let livenessProbePromise: Promise<'ok' | 'dead'> | null = null;
let connectingSince = 0;

let tokenFetchPending = false;

let lastSeq = 0;
let requestSequence = 0;

let _messageHandler: ControlMessageHandler | null = null;
let _connectionStateCallback: ConnectionStateCallback | null = null;

export function setConnectionStateCallback(fn: ConnectionStateCallback) {
  _connectionStateCallback = fn;
}

export function onControlMessage(handler: ControlMessageHandler) {
  _messageHandler = handler;
}

export function sendControlMsg(msg: Record<string, unknown>): boolean {
  if (controlWs?.readyState !== WebSocket.OPEN) return false;
  controlWs.send(JSON.stringify(msg));
  return true;
}

const sendClientLog = createClientLogReporter(sendControlMsg);

export function reportToServerLog(scope: string, text: string): void {
  console.warn(`[${scope}] ${text}`);
  sendClientLog(scope, text);
}

export function nextRequestId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${requestSequence}`;
}

export function sendControlRequest(type: string, payload?: Record<string, unknown>, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<ServerMessage> {
  const requestId = nextRequestId(type);
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timed out'));
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

function replaceControlSocket() {
  const abandonedSocket = controlWs;
  controlWs = null;
  rejectPendingRequests(NOT_CONNECTED_TEXT);
  if (_connectionStateCallback) _connectionStateCallback('disconnected', 'Reconnecting');
  abandonedSocket?.close();
  controlRetryAttempt = 0;
  connectControl();
}

export function connectControl() {
  if (controlRetryTimer !== null) {
    if (controlRetryTimer !== null) clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
  }

  if (!pageToken() && !tokenFetchPending) {
    tokenFetchPending = true;
    void loadPageToken().finally(() => {
      tokenFetchPending = false;
      connectControl();
    });
    return;
  }
  if (tokenFetchPending) return;

  const since = lastSeq > 0 ? `?since=${lastSeq}` : '';
  const url = buildWebSocketUrl(location, withPageToken(`/control${since}`));
  const ws = new WebSocket(url);
  controlWs = ws;
  connectingSince = Date.now();
  let hasEverOpened = false;

  ws.addEventListener('open', () => {
    hasEverOpened = true;
    controlRetryAttempt = 0;
    if (_connectionStateCallback) _connectionStateCallback('connected', 'Connected');
  });

  ws.addEventListener('message', (event: MessageEvent<string>) => {
    if (controlWs !== ws) return;
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(event.data);
    } catch {
      reportToServerLog('control', 'dropped a server message that is not JSON');
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

    if (_messageHandler) _messageHandler(msg);
  });

  ws.addEventListener('close', () => {
    if (controlWs !== ws) return;
    controlWs = null;
    rejectPendingRequests(NOT_CONNECTED_TEXT);

    if (!hasEverOpened) clearPageToken();
    if (_connectionStateCallback) _connectionStateCallback('disconnected', 'Reconnecting');
    const retryDelayMs = nextReconnectDelayMs(controlRetryAttempt);
    controlRetryAttempt += 1;
    controlRetryTimer = setTimeout(connectControl, retryDelayMs);
  });
}

export async function checkControlLiveness() {
  if (_connectionStateCallback) _connectionStateCallback('connecting', 'Connecting');
  if (livenessProbePromise) return livenessProbePromise;
  const action = decideLivenessAction({
    hasSocket: !!controlWs,
    readyState: controlWs?.readyState ?? null,
    retryPending: controlRetryTimer !== null,
    connectingAgeMs: Date.now() - connectingSince,
  });
  if (action === 'retry-now') {
    if (controlRetryTimer !== null) clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
    controlRetryAttempt = 0;
    connectControl();
    return 'reconnecting';
  }
  if (action === 'connect') {
    replaceControlSocket();
    return 'reconnecting';
  }
  if (action === 'wait') return 'reconnecting';
  const probedSocket = controlWs;
  livenessProbePromise = sendControlRequest('ping', {})
    .then((): 'ok' => {
      if (_connectionStateCallback) _connectionStateCallback('verified', 'Connected');
      return 'ok';
    })
    .catch((): 'dead' => {
      if (controlWs === probedSocket && probedSocket) replaceControlSocket();
      return 'dead';
    })
    .finally(() => {
      livenessProbePromise = null;
    });
  return livenessProbePromise;
}
