import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { WebSocketError } from 'ws';
import type { ScreenSnapshot } from '../../session/session-output.ts';
import type { Session } from '../../session/sessions.ts';
import { CONTROL_FRAME_MAX_BYTES } from '../../shared/contracts/control-messages.ts';
import { describeDataAttach, FAST_TERMINAL_CLOSE_MS, LOGGED_FAST_CLOSE_COUNTS, OUTPUT_BEAT_INTERVAL_MS, parseDataAttach, parseDataClientMessage } from '../../shared/contracts/data-messages.ts';
import type { OutputBeatFrame } from '../../shared/contracts/data-messages.ts';
import type { PtySizeFrame } from '../../shared/contracts/data-messages.ts';
import { createReplayLog } from '../core/control-replay-core.ts';
import type { ControlMessageRecord, ReplayLog } from '../core/control-replay-core.ts';
import { decideControlSend } from '../core/control-send-core.ts';
import { decideHostAllowed } from '../core/host-policy.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { classifyRequestOrigin, decideUpgradeAccess } from '../core/request-trust.ts';
import type { RequestTrust } from '../core/request-trust.ts';
import { classifyUpgradePath, dataSessionIdFromUrl, upgradeTokenFromUrl } from '../core/upgrade-route.ts';
import { resolveSessionSize } from '../core/viewer-size-core.ts';
import { createWsSender } from '../ws-sender.ts';
import type { WsSender } from '../ws-sender.ts';

type ControlBroadcast = (message: ControlMessageRecord) => void;

type ControlSocket = WebSocket & { glimmervoidTrust?: RequestTrust };

type UpgradeSocket = Duplex & { localPort?: number };

interface ViewerSizeRecord {
  cols: number;
  rows: number;
  resizeSeq: number;
}

interface BackendWebSocketDependencies {
  remote: { enabled: boolean; allowedOrigins: string[] };
  remoteAuth: { isUpgradeAuthorized: (request: IncomingMessage) => boolean } | null;
  remoteListenerPort: number | null;
  allowedHosts: string[];
  listenerPortsFor: (socket: { localPort?: number | null } | null) => number[];
  tokenMatches: (token: string | null) => boolean;
  getSession: (id: string) => Session | null;
  recordOutcome?: OutcomeRecorder;
  logger: Pick<Console, 'warn'>;
}

interface BackendWebSockets {
  controlWss: WebSocketServer;
  dataWss: WebSocketServer;
  controlReplayLog: ReplayLog;
  sessionDataClients: Map<string, Map<WebSocket, ViewerSizeRecord | null>>;
  broadcastControl: ControlBroadcast;
  closeSessionDataClients(sessionId: string): void;
  attachDataConnection(): void;
  handleUpgrade(request: IncomingMessage, socket: UpgradeSocket, head: Buffer): void;
}

function sendControlFrame(client: WebSocket, payload: string, type: string, logger: Pick<Console, 'warn'>): void {
  if (client.readyState !== 1) return;
  const decision = decideControlSend({ bufferedAmount: client.bufferedAmount, type });
  if (decision.action === 'drop') return;
  if (decision.action === 'close') {
    logger.warn(`[control-ws] client past the buffer ceiling (${client.bufferedAmount} bytes) - closing so it reconnects`);
    try {
      client.terminate();
    } catch {}
    return;
  }
  client.send(payload);
}

function sendPtySizeFrame(sender: WsSender, size: { cols: number; rows: number; seq: number }): void {
  const frame: PtySizeFrame = { type: 'pty-size', cols: size.cols, rows: size.rows, seq: size.seq };
  sender.sendOutOfBand(Buffer.from(JSON.stringify(frame), 'utf8'));
}

const OUTPUT_BEAT_FRAME = Buffer.from(JSON.stringify({ type: 'output-beat' } satisfies OutputBeatFrame), 'utf8');

const NO_LIVE_SESSION_KEY = '';

function frameType(stamped: ControlMessageRecord): string {
  return typeof stamped.type === 'string' ? stamped.type : '';
}

function createBackendWebSockets(dependencies: BackendWebSocketDependencies): BackendWebSockets {
  const {
    remote,
    remoteAuth,
    remoteListenerPort,
    allowedHosts,
    listenerPortsFor,
    tokenMatches,
    getSession,
    recordOutcome = () => {},
    logger,
  } = dependencies;
  const controlWss = new WebSocketServer({ noServer: true, maxPayload: CONTROL_FRAME_MAX_BYTES, perMessageDeflate: true });
  const dataWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: true });
  controlWss.on('connection', (socket) => {
    recordOutcome('controlWsOpened');
    socket.on('close', () => recordOutcome('controlWsClosed'));
  });
  const controlReplayLog = createReplayLog();
  const sessionDataClients = new Map<string, Map<WebSocket, ViewerSizeRecord | null>>();
  const fastCloseCountBySessionKey = new Map<string, number>();
  const socketsClosedByServer = new WeakSet<WebSocket>();
  let nextViewerResizeSeq = 0;

  function controlClients(): Iterable<ControlSocket> {
    return controlWss.clients as Set<ControlSocket>;
  }

  function broadcastControl(message: ControlMessageRecord): void {
    const stamped = controlReplayLog.stamp({ ...message });
    const payload = JSON.stringify(stamped);
    for (const client of controlClients()) {
      sendControlFrame(client, payload, frameType(stamped), logger);
    }
  }

  function closeSessionDataClients(sessionId: string): void {
    const clients = sessionDataClients.get(sessionId);
    if (!clients) return;
    for (const socket of clients.keys()) {
      closeDataSocketFromServer(socket, 1001, 'Session removed');
    }
    sessionDataClients.delete(sessionId);
    fastCloseCountBySessionKey.delete(sessionId);
  }

  function closeDataSocketFromServer(socket: WebSocket, code: number, reason: string): void {
    socketsClosedByServer.add(socket);
    socket.close(code, reason);
  }

  function logDataSocketClose(socket: WebSocket, sessionId: string | null, attachDescription: string, openedAtMs: number, code: number, reason: string): void {
    const openMs = Date.now() - openedAtMs;
    const isReject = code === 1008;
    const session = sessionId === null ? null : getSession(sessionId);
    const sessionKey = session ? session.id : NO_LIVE_SESSION_KEY;
    if (openMs >= FAST_TERMINAL_CLOSE_MS && !isReject) {
      fastCloseCountBySessionKey.delete(sessionKey);
      return;
    }
    const fastCloseCount = (fastCloseCountBySessionKey.get(sessionKey) ?? 0) + 1;
    fastCloseCountBySessionKey.set(sessionKey, fastCloseCount);
    if (!LOGGED_FAST_CLOSE_COUNTS.has(fastCloseCount)) return;
    const label = session ? session.name : `unknown session ${sessionId ?? '(invalid id)'}`;
    const closer = socketsClosedByServer.has(socket) ? 'server' : 'peer';
    logger.warn(`[data-ws] ${label} closed after ${openMs} ms by ${closer}: code ${code}, reason '${reason}', attach ${attachDescription}, fast close ${fastCloseCount}x`);
  }

  function attachDataConnection(): void {
    dataWss.on('connection', (socket, request) => {
      recordOutcome('dataWsOpened');
      const openedAtMs = Date.now();
      const sessionId = dataSessionIdFromUrl(request.url);
      const attach = parseDataAttach(request.url);
      socket.on('close', (code, reason) => {
        recordOutcome('dataWsClosed');
        logDataSocketClose(socket, sessionId, describeDataAttach(attach), openedAtMs, code, reason.toString());
      });
      if (sessionId === null) {
        closeDataSocketFromServer(socket, 1008, 'Invalid session id');
        return;
      }
      const session = getSession(sessionId);
      if (!session) {
        closeDataSocketFromServer(socket, 1008, 'Session not found');
        return;
      }
      socket.on('error', (error) => reportDataSocketError(session, error));
      if (attach.history === 'screen') {
        wireDataSocket(socket, session, sessionId, session.getScreenSnapshot(), { isAttachedPaused: attach.isOutputPaused, isDeepAttach: false });
        return;
      }
      const messagesBeforeWiring: unknown[] = [];
      const holdMessage = (raw: unknown): void => {
        messagesBeforeWiring.push(raw);
      };
      socket.on('message', holdMessage);
      session.getDeepScreenSnapshot().then(
        (snapshot) => {
          socket.off('message', holdMessage);
          if (socket.readyState !== WebSocket.OPEN) return;
          if (getSession(sessionId) !== session) {
            closeDataSocketFromServer(socket, 1008, 'Session not found');
            return;
          }
          wireDataSocket(socket, session, sessionId, snapshot, { isAttachedPaused: attach.isOutputPaused, isDeepAttach: true });
          for (const raw of messagesBeforeWiring) socket.emit('message', raw, false);
        },
        (error: unknown) => {
          logger.warn(`[data-ws] Deep history failed for ${session.name}: ${String(error)}`);
          closeDataSocketFromServer(socket, 1011, 'History unavailable');
        },
      );
    });
  }

  function reportDataSocketError(session: Session, error: WebSocketError): void {
    const isPayload = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
    const reason = isPayload ? 'Message too large - try pasting smaller chunks' : error.message;
    logger.warn(`[data-ws] Error for ${session.name}: ${error.message}`);
    broadcastControl({
      type: 'session-error',
      id: session.id,
      session: session.name,
      message: reason,
      timestamp: Date.now(),
    });
  }

  function wireDataSocket(socket: WebSocket, session: Session, sessionId: string, snapshot: ScreenSnapshot, { isAttachedPaused, isDeepAttach }: { isAttachedPaused: boolean; isDeepAttach: boolean }): void {
    let viewerSizes = sessionDataClients.get(sessionId);
    if (!viewerSizes) {
      viewerSizes = new Map();
      sessionDataClients.set(sessionId, viewerSizes);
    }
    const activeSessionId = sessionId;
    const viewerSizeMap = viewerSizes;
    viewerSizeMap.set(socket, null);

    const applyResolvedSize = (departing: boolean): void => {
      const resolved = resolveSessionSize({
        viewers: viewerSizeMap,
        ...(departing ? { departingKey: socket } : {}),
        current: session.ptySize(),
      });
      if (!resolved.changed) return;
      session.resize(resolved.cols, resolved.rows);
    };

    const releaseViewerSize = (): void => {
      if (!viewerSizeMap.get(socket)) return;
      viewerSizeMap.set(socket, null);
      if (sessionDataClients.get(activeSessionId) !== viewerSizeMap) return;
      applyResolvedSize(true);
    };

    let lastOutputBeatAt = 0;
    const sendOutputBeat = (): void => {
      const now = Date.now();
      if (now - lastOutputBeatAt < OUTPUT_BEAT_INTERVAL_MS) return;
      lastOutputBeatAt = now;
      sender.sendDroppable(OUTPUT_BEAT_FRAME);
    };
    const sender = createWsSender(socket, {
      source: { getBufferSince: (offset: number) => session.getBufferSince(offset) },
      startOffset: snapshot.offset,
      isStartedPaused: isAttachedPaused,
      heldAttachSnapshot: isAttachedPaused && isDeepAttach ? snapshot : null,
      onPausedData: sendOutputBeat,
    });
    sendPtySizeFrame(sender, session.ptySize());
    if (snapshot.data && !isAttachedPaused) sender.sendImmediate(snapshot.data, 0);

    const dataListener = (data: string) => sender.onData(data);
    session.on('data', dataListener);
    const resizeListener = (size: { cols: number; rows: number; seq: number }) => sendPtySizeFrame(sender, size);
    session.on('resize', resizeListener);
    let resizeSeqAtPause: number | null = isAttachedPaused ? session.ptySize().seq : null;
    socket.on('message', (raw) => {
      const message = parseDataClientMessage(String(raw));
      if (!message) return;

      if (message.type === 'input') {
        if (message.data.length > 16384) {
          logger.warn(`[data-ws] Rejected oversized input (${message.data.length} chars) for ${session.name}`);
          broadcastControl({
            type: 'session-error',
            id: session.id,
            session: session.name,
            message: 'Paste too large - try pasting smaller chunks',
            timestamp: Date.now(),
          });
          return;
        }
        session.write(message.data);
        sender.markInputFlush();
        session.noteOperatorInput(message.data);
        return;
      }
      if (message.type === 'claim') {
        nextViewerResizeSeq += 1;
        viewerSizeMap.set(socket, { cols: message.cols, rows: message.rows, resizeSeq: nextViewerResizeSeq });
        applyResolvedSize(false);
        return;
      }
      if (message.type === 'unview') {
        releaseViewerSize();
        return;
      }
      if (message.type === 'pause-output') {
        resizeSeqAtPause ??= session.ptySize().seq;
        sender.pauseOutput();
        return;
      }
      if (message.type !== 'resume-output' || resizeSeqAtPause === null) return;
      const hasResizedWhilePaused = session.ptySize().seq !== resizeSeqAtPause;
      resizeSeqAtPause = null;
      sender.resumeOutput({
        outputOffset: session.getOutputOffset(),
        hasResizedWhilePaused,
        readScreenSnapshot: () => session.getScreenSnapshot(),
      });
    });

    socket.on('close', () => {
      session.removeListener('data', dataListener);
      session.removeListener('resize', resizeListener);
      sender.destroy();
      releaseViewerSize();
      const clients = sessionDataClients.get(activeSessionId);
      if (!clients) return;
      clients.delete(socket);
      if (clients.size === 0) sessionDataClients.delete(activeSessionId);
    });
  }

  function handleUpgrade(request: IncomingMessage, socket: UpgradeSocket, head: Buffer): void {
    const route = classifyUpgradePath(request.url);
    const trust = classifyRequestOrigin({ localPort: socket.localPort, remoteListenerPort });
    if (route === 'unknown') {
      if (trust === 'remote') socket.destroy();
      return;
    }
    if (!decideHostAllowed(request.headers.host, allowedHosts)) {
      socket.destroy();
      return;
    }

    const authenticated = trust === 'remote' && remoteAuth ? remoteAuth.isUpgradeAuthorized(request) : false;
    const dashboardRoute = route === 'control' || route === 'data';
    const decision = decideUpgradeAccess({
      remoteEnabled: remote.enabled,
      trust,
      origin: request.headers.origin,
      allowedOrigins: remote.allowedOrigins,
      authenticated,
      listenerPorts: listenerPortsFor(socket),
      dashboardRoute,
      tokenOk: dashboardRoute ? tokenMatches(upgradeTokenFromUrl(request.url)) : false,
    });
    if (!decision.allow) {
      if (remote.enabled) socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (route === 'control') {
      controlWss.handleUpgrade(request, socket, head, (webSocket) => {
        (webSocket as ControlSocket).glimmervoidTrust = trust;
        controlWss.emit('connection', webSocket, request);
      });
      return;
    }
    dataWss.handleUpgrade(request, socket, head, (webSocket) => {
      dataWss.emit('connection', webSocket, request);
    });
  }

  return {
    controlWss,
    dataWss,
    controlReplayLog,
    sessionDataClients,
    broadcastControl,
    closeSessionDataClients,
    attachDataConnection,
    handleUpgrade,
  };
}

export { createBackendWebSockets };
export type { ControlBroadcast, ControlSocket };
