import type { Terminal } from '@xterm/xterm';
import type { SessionUi } from './card-registry.ts';
import { el } from '../dom-helpers.ts';
import { nextReconnectDelayMs } from '../reconnect-backoff.ts';
import { HANDSHAKE_DEADLINE_MS } from '../connection-supervisor-core.ts';
import { noteWakeMark } from '../wake-timeline.ts';
import { renderScheduler } from '../render-scheduler.ts';
import { buildWebSocketUrl } from '../ws-url-core.ts';
import { clearPageToken, loadPageToken, pageToken, withPageToken } from '../ws-token.ts';
import { noteSessionOutput } from './activity.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import type { DataFrameState } from './grid-core.ts';
import { dataAttachPath, isCardTerminalHidden, readDataFrame, shouldRequestDeepHistory } from './grid-core.ts';
import { uiState } from '../ui-state-core.ts';
import { resetTerminalSecretMask } from './terminal-secret-mask.ts';
import { decideTerminalLinkState } from './terminal-link-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { describeDataAttach, FAST_TERMINAL_CLOSE_MS, LOGGED_FAST_CLOSE_COUNTS } from '#shared/contracts/data-messages.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from '../flying-animal-preview.ts';
import { isScrolledAwayFromLatest } from './terminal-notices.ts';
import { isInputHeldForWakeCheck, sendQueuedInput } from './terminal-input.ts';

function isCardTerminalHiddenNow(ui: SessionUi, sessionId: string) {
  return isCardTerminalHidden({
    isBorrowedCard: uiState.snapshot().borrowedCardId === sessionId,
    isTerminalFaceShown: ui.face === 'terminal',
  });
}

const deepHistoryLinesFromBottomBySessionUi = new WeakMap<SessionUi, number>();

const restoredLinesFromBottomBySessionUi = new WeakMap<SessionUi, number>();

const sessionUisWithDeepHistory = new WeakSet<SessionUi>();

const sessionUisReattachingQuietly = new WeakSet<SessionUi>();

const sessionUisReconnectingWhenShown = new WeakSet<SessionUi>();

function rememberScrollOffsetForReattach(ui: SessionUi, term: Terminal) {
  if (deepHistoryLinesFromBottomBySessionUi.has(ui)) return;
  if (!isScrolledAwayFromLatest(term)) return;
  const buffer = term.buffer.active;
  const linesFromBottom = buffer.length - buffer.viewportY;
  if (sessionUisWithDeepHistory.has(ui)) {
    deepHistoryLinesFromBottomBySessionUi.set(ui, linesFromBottom);
    return;
  }
  restoredLinesFromBottomBySessionUi.set(ui, linesFromBottom);
}

function requestDeepHistoryAtTop(ui: SessionUi, sessionId: string, viewportTopLine: number) {
  const term = ui.term;
  if (!term) return;
  const shouldRequest = shouldRequestDeepHistory({
    viewportTopLine,
    scrollbackLineCount: term.buffer.active.baseY,
    isDeepHistoryLoadedOrPending: sessionUisWithDeepHistory.has(ui),
  });
  if (!shouldRequest) return;
  sessionUisWithDeepHistory.add(ui);
  sessionUisReattachingQuietly.add(ui);
  deepHistoryLinesFromBottomBySessionUi.set(ui, term.buffer.active.length - viewportTopLine);
  reconnectDataWs(sessionId);
}

const isOutputFlowingBySocket = new WeakMap<WebSocket, boolean>();

function isTerminalOutputWanted(ui: SessionUi, sessionId: string) {
  return document.visibilityState === 'visible' && !isCardTerminalHiddenNow(ui, sessionId);
}

function syncTerminalOutputFlow(ui: SessionUi | null | undefined, sessionId: string) {
  if (ui && reconnectIfDeferredAndShown(ui, sessionId)) return;
  const socket = ui?.dataWs;
  if (!ui || socket?.readyState !== WebSocket.OPEN) return;
  const isWanted = isTerminalOutputWanted(ui, sessionId);
  if (isOutputFlowingBySocket.get(socket) === isWanted) return;
  isOutputFlowingBySocket.set(socket, isWanted);
  socket.send(JSON.stringify({ type: isWanted ? 'resume-output' : 'pause-output' }));
}

function syncEveryTerminalOutputFlow() {
  for (const [sessionId, ui] of sessionUIs) syncTerminalOutputFlow(ui, sessionId);
}

document.addEventListener('visibilitychange', syncEveryTerminalOutputFlow);
uiState.subscribe((_state, changedKeys) => {
  if (changedKeys.includes('borrowedCardId')) syncEveryTerminalOutputFlow();
});

function isStillCurrentAndDetached(sessionId: string, ui: SessionUi) {
  return sessionUIs.get(sessionId) === ui && !ui.dataWs;
}

function findConnectingOverlay(termWrap: HTMLElement) {
  return termWrap.querySelector(':scope > .terminal-connecting');
}

function ensureConnectingOverlay(termWrap: HTMLElement) {
  if (findConnectingOverlay(termWrap)) return;
  const overlay = el('div', 'terminal-connecting');
  overlay.append(el('span', 'terminal-connecting-label', 'Connecting'));
  termWrap.append(overlay);
}

function swapConnectingAnimal(termWrap: HTMLElement) {
  const overlay = findConnectingOverlay(termWrap);
  if (!overlay) return;
  overlay.querySelector(':scope > .terminal-connecting-animal')?.remove();
  const animal = pickRandomIncludedAnimal();
  if (!animal) return;
  overlay.prepend(buildFlyingAnimalPreview(animal, 'terminal-connecting-animal'));
}

const terminalLinkSubscribers = new Set<() => void>();

const sessionUisAwaitingXterm = new WeakSet<SessionUi>();

function onTerminalLinkChange(notify: () => void) {
  terminalLinkSubscribers.add(notify);
  return () => terminalLinkSubscribers.delete(notify);
}

function countShownConnectingTerminals() {
  let shownConnectingTerminalCount = 0;
  for (const [sessionId, ui] of sessionUIs) {
    if (ui.card.dataset.link === 'connecting' && isTerminalOutputWanted(ui, sessionId)) shownConnectingTerminalCount++;
  }
  return shownConnectingTerminalCount;
}

function refreshTerminalLink(ui: SessionUi) {
  const decidedLinkState = decideTerminalLinkState({
    hasTerminal: ui.term !== null || sessionUisAwaitingXterm.has(ui),
    isSocketOpen: ui.dataWs?.readyState === WebSocket.OPEN,
    isInputHeld: isInputHeldForWakeCheck,
  });
  const isQuietReattach = decidedLinkState === 'connecting' && !isInputHeldForWakeCheck && sessionUisReattachingQuietly.has(ui);
  const linkState = isQuietReattach ? 'live' : decidedLinkState;
  if (linkState === 'none') {
    delete ui.card.dataset.link;
    notifyTerminalLinkSubscribers();
    return;
  }
  const isStartingToConnect = linkState === 'connecting' && ui.card.dataset.link !== 'connecting';
  ui.card.dataset.link = linkState;
  if (isStartingToConnect) swapConnectingAnimal(ui.termWrap);
  notifyTerminalLinkSubscribers();
}

function notifyTerminalLinkSubscribers() {
  for (const notify of terminalLinkSubscribers) notify();
}

function detachDataWs(sessionId: string, ui: SessionUi, term: Terminal) {
  rememberScrollOffsetForReattach(ui, term);
  renderScheduler.unregister(sessionId);
  ui.dataWs = null;
  refreshTerminalLink(ui);
  ui._resetGridClaim?.();
}

const pendingRetryTimerBySessionUi = new WeakMap<SessionUi, ReturnType<typeof setTimeout>>();

function detachThenReconnect(sessionId: string, ui: SessionUi, term: Terminal, delayMs: number) {
  detachDataWs(sessionId, ui, term);
  clearTimeout(pendingRetryTimerBySessionUi.get(ui));
  pendingRetryTimerBySessionUi.delete(ui);
  if (delayMs === 0 && pageToken()) {
    connectDataWs(sessionId, ui, term);
    return;
  }
  pendingRetryTimerBySessionUi.set(ui, setTimeout(() => {
    pendingRetryTimerBySessionUi.delete(ui);
    if (!isStillCurrentAndDetached(sessionId, ui)) return;
    void loadPageToken().catch(() => {}).then(() => {
      if (!isStillCurrentAndDetached(sessionId, ui)) return;
      connectDataWs(sessionId, ui, term);
    });
  }, delayMs));
}

function reconnectIfDeferredAndShown(ui: SessionUi, sessionId: string) {
  const isDeferred = sessionUisReconnectingWhenShown.has(ui);
  const isWaitingOnRetry = !ui.dataWs && sessionUIs.get(sessionId) === ui;
  if (!(isDeferred || isWaitingOnRetry) || !ui.term || !isTerminalOutputWanted(ui, sessionId)) return false;
  sessionUisReconnectingWhenShown.delete(ui);
  ui._dataWsRetryAttempt = 0;
  detachThenReconnect(sessionId, ui, ui.term, 0);
  return true;
}

function detachUntilShown(sessionId: string, ui: SessionUi, term: Terminal) {
  detachDataWs(sessionId, ui, term);
  sessionUisReconnectingWhenShown.add(ui);
}

interface PrewarmedDataSocket {
  socket: WebSocket;
  attachPath: string;
  bufferedMessages: MessageEvent[];
  release: () => void;
}

const PREWARM_UNCLAIMED_LIFETIME_MS = 15_000;

const prewarmedDataSocketBySessionId = new Map<string, PrewarmedDataSocket>();

function prewarmDataSocket(sessionId: string) {
  if (!pageToken() || prewarmedDataSocketBySessionId.has(sessionId) || sessionUIs.get(sessionId)?.dataWs) return;
  const attachPath = dataAttachPath(sessionId, false, false);
  const socket = new WebSocket(buildWebSocketUrl(location, withPageToken(attachPath)));
  socket.binaryType = 'arraybuffer';
  const bufferedMessages: MessageEvent[] = [];
  const bufferMessage = (event: MessageEvent) => bufferedMessages.push(event);
  const discard = () => discardPrewarmedDataSocket(sessionId, socket);
  const abandonUnopenedHandshake = () => {
    if (socket.readyState === WebSocket.CONNECTING) discard();
  };
  socket.addEventListener('message', bufferMessage);
  socket.addEventListener('close', discard);
  const handshakeTimer = setTimeout(abandonUnopenedHandshake, HANDSHAKE_DEADLINE_MS);
  const unclaimedTimer = setTimeout(discard, PREWARM_UNCLAIMED_LIFETIME_MS);
  const release = () => {
    socket.removeEventListener('message', bufferMessage);
    socket.removeEventListener('close', discard);
    clearTimeout(handshakeTimer);
    clearTimeout(unclaimedTimer);
  };
  prewarmedDataSocketBySessionId.set(sessionId, { socket, attachPath, bufferedMessages, release });
}

function discardPrewarmedDataSocket(sessionId: string, socket: WebSocket) {
  const prewarmed = prewarmedDataSocketBySessionId.get(sessionId);
  if (prewarmed?.socket !== socket) return;
  prewarmedDataSocketBySessionId.delete(sessionId);
  prewarmed.release();
  socket.close();
}

function claimPrewarmedDataSocket(sessionId: string, attachPath: string): PrewarmedDataSocket | null {
  const prewarmed = prewarmedDataSocketBySessionId.get(sessionId);
  if (!prewarmed) return null;
  const isStillUsable = prewarmed.socket.readyState === WebSocket.CONNECTING || prewarmed.socket.readyState === WebSocket.OPEN;
  if (prewarmed.attachPath !== attachPath || !isStillUsable) {
    discardPrewarmedDataSocket(sessionId, prewarmed.socket);
    return null;
  }
  prewarmedDataSocketBySessionId.delete(sessionId);
  prewarmed.release();
  return prewarmed;
}

const fastCloseCountBySessionUi = new WeakMap<SessionUi, number>();

interface TerminalSocketLife {
  sessionId: string;
  attachDescription: string;
  openedAtMs: number | null;
  hasReceivedBytes: boolean;
}

function reportFastTerminalClose(ui: SessionUi, life: TerminalSocketLife, event: CloseEvent) {
  if (life.openedAtMs === null) return;
  const openMs = Math.round(performance.now() - life.openedAtMs);
  if (openMs >= FAST_TERMINAL_CLOSE_MS) {
    fastCloseCountBySessionUi.delete(ui);
    return;
  }
  const fastCloseCount = (fastCloseCountBySessionUi.get(ui) ?? 0) + 1;
  fastCloseCountBySessionUi.set(ui, fastCloseCount);
  if (!LOGGED_FAST_CLOSE_COUNTS.has(fastCloseCount)) return;
  const cleanliness = event.wasClean ? 'clean' : 'unclean';
  const bytesSeen = life.hasReceivedBytes ? 'yes' : 'no';
  reportToServerLog('terminal', `fast close ${fastCloseCount}x, session ${life.sessionId}, code ${event.code}, reason '${event.reason}', ${cleanliness}, open ${openMs} ms, bytes ${bytesSeen}, attach ${life.attachDescription}`);
}

function connectDataWs(sessionId: string, ui: SessionUi, term: Terminal) {
  sessionUisReconnectingWhenShown.delete(ui);
  const deepHistoryLinesFromBottom = deepHistoryLinesFromBottomBySessionUi.get(ui);
  deepHistoryLinesFromBottomBySessionUi.delete(ui);
  const restoredLinesFromBottom = restoredLinesFromBottomBySessionUi.get(ui);
  restoredLinesFromBottomBySessionUi.delete(ui);
  const isDeepAttach = deepHistoryLinesFromBottom !== undefined;
  const linesFromBottomToRestore = deepHistoryLinesFromBottom ?? restoredLinesFromBottom;
  let isAwaitingSnapshotScroll = false;
  const isAttachedFlowing = isTerminalOutputWanted(ui, sessionId);
  const attachPath = dataAttachPath(sessionId, isDeepAttach, !isAttachedFlowing);
  const prewarmed = claimPrewarmedDataSocket(sessionId, attachPath);
  const ws = prewarmed?.socket ?? new WebSocket(buildWebSocketUrl(location, withPageToken(attachPath)));
  isOutputFlowingBySocket.set(ws, isAttachedFlowing);
  ws.binaryType = 'arraybuffer';
  ui.dataWs = ws;
  if (isAttachedFlowing) noteWakeMark('terminal-connecting');
  refreshTerminalLink(ui);
  let hasEverOpened = false;
  let isHandshakeAbandoned = false;
  const socketLife: TerminalSocketLife = { sessionId, attachDescription: describeDataAttach({ history: isDeepAttach ? 'deep' : 'screen', isOutputPaused: !isAttachedFlowing }), openedAtMs: null, hasReceivedBytes: false };
  const frameState: DataFrameState = { hasSeenSize: false, lastSeq: 0 };
  const handshakeTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.CONNECTING) return;
    isHandshakeAbandoned = true;
    if (isAttachedFlowing) noteWakeMark('terminal-abandoned');
    ws.close();
  }, HANDSHAKE_DEADLINE_MS);

  renderScheduler.register(sessionId, (data, cb) => term.write(data, cb));

  const handleMessage = (event: MessageEvent) => {
    if (ui.dataWs !== ws) return;
    const frame = readDataFrame(event.data, frameState);
    if (frame.kind === 'bytes') {
      socketLife.hasReceivedBytes = true;
      noteSessionOutput(ui);
      if (isOutputFlowingBySocket.get(ws)) noteWakeMark('terminal-bytes');
      const isSnapshotToScroll = isAwaitingSnapshotScroll;
      isAwaitingSnapshotScroll = false;
      renderScheduler.enqueue(sessionId, frame.data);
      if (!isSnapshotToScroll) return;
      const linesFromBottom = linesFromBottomToRestore ?? 0;
      renderScheduler.enqueueAction(sessionId, () => {
        term.scrollToLine(Math.max(0, term.buffer.active.length - linesFromBottom));
      });
      return;
    }
    if (frame.kind === 'beat') {
      noteSessionOutput(ui);
      return;
    }
    if (frame.kind === 'attach-size') {
      isAwaitingSnapshotScroll = linesFromBottomToRestore !== undefined;
      if (!isDeepAttach) sessionUisWithDeepHistory.delete(ui);
      frameState.hasSeenSize = true;
      frameState.lastSeq = frame.seq;
      term.reset();
      resetTerminalSecretMask(term);
      ui.ptySize = { cols: frame.cols, rows: frame.rows };
      ui._syncGrid?.();
      return;
    }
    if (frame.kind !== 'size') return;
    frameState.lastSeq = frame.seq;
    const nextSize = { cols: frame.cols, rows: frame.rows };
    renderScheduler.enqueueAction(sessionId, () => {
      ui.ptySize = nextSize;
      ui._syncGrid?.();
    });
  };
  ws.addEventListener('message', handleMessage);

  ws.addEventListener('close', (event) => {
    clearTimeout(handshakeTimer);
    if (ui.dataWs !== ws) return;
    reportFastTerminalClose(ui, socketLife, event);
    if (isAttachedFlowing && !isHandshakeAbandoned) noteWakeMark('terminal-closed');
    sessionUisReattachingQuietly.delete(ui);
    if (!hasEverOpened && !isHandshakeAbandoned) clearPageToken();
    if (!isTerminalOutputWanted(ui, sessionId)) {
      detachUntilShown(sessionId, ui, term);
      return;
    }
    if (isHandshakeAbandoned) {
      detachThenReconnect(sessionId, ui, term, 0);
      return;
    }
    const retryDelayMs = nextReconnectDelayMs(ui._dataWsRetryAttempt || 0);
    ui._dataWsRetryAttempt = (ui._dataWsRetryAttempt || 0) + 1;
    detachThenReconnect(sessionId, ui, term, retryDelayMs);
  });

  const handleOpen = () => {
    clearTimeout(handshakeTimer);
    hasEverOpened = true;
    socketLife.openedAtMs = performance.now();
    if (isAttachedFlowing) noteWakeMark('terminal-opened');
    ui._dataWsRetryAttempt = 0;
    sessionUisReattachingQuietly.delete(ui);
    refreshTerminalLink(ui);
    syncTerminalOutputFlow(ui, sessionId);

    ui._syncGrid?.({ isActivationEdge: true });
    ui._retryOwedGridClaim?.();

    if (!ui._inputQueue?.length) return;
    setTimeout(() => {
      if (ui.dataWs !== ws) return;
      sendQueuedInput(ui);
    }, 50);
  };
  ws.addEventListener('open', handleOpen);

  if (ws.readyState === WebSocket.OPEN) handleOpen();
  for (const bufferedMessage of prewarmed?.bufferedMessages ?? []) handleMessage(bufferedMessage);
}

function reconnectDataWs(id: unknown) {
  const ui = findSessionUi(id);
  if (typeof id !== 'string' || !ui?.term) return;
  const abandonedSocket = ui.dataWs;
  ui._dataWsRetryAttempt = 0;
  detachThenReconnect(id, ui, ui.term, 0);
  abandonedSocket?.close();
}

function reconnectShownTerminals() {
  for (const [sessionId, ui] of sessionUIs) {
    if (!ui.term) continue;
    if (isTerminalOutputWanted(ui, sessionId)) {
      reconnectDataWs(sessionId);
      continue;
    }
    closeUntilShown(sessionId, ui, ui.term);
  }
}

function closeUntilShown(sessionId: string, ui: SessionUi, term: Terminal) {
  const abandonedSocket = ui.dataWs;
  if (!abandonedSocket) return;
  detachUntilShown(sessionId, ui, term);
  abandonedSocket.close();
}

function closeEveryTerminalUntilShown() {
  for (const [sessionId, ui] of sessionUIs) {
    if (ui.term) closeUntilShown(sessionId, ui, ui.term);
  }
}

function closeDataWs(ui: SessionUi, sessionId: string) {
  const closingSocket = ui.dataWs;
  ui.dataWs = null;
  renderScheduler.unregister(sessionId);
  if (closingSocket && closingSocket.readyState <= WebSocket.OPEN) closingSocket.close();
}

export { closeDataWs, closeEveryTerminalUntilShown, connectDataWs, countShownConnectingTerminals, ensureConnectingOverlay, isStillCurrentAndDetached, onTerminalLinkChange, prewarmDataSocket, reconnectDataWs, reconnectShownTerminals, refreshTerminalLink, requestDeepHistoryAtTop, sessionUisAwaitingXterm, syncTerminalOutputFlow };
