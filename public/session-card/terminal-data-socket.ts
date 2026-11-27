import type { Terminal } from '@xterm/xterm';
import type { SessionUi } from './card-registry.ts';
import { el } from '../dom-helpers.ts';
import { nextReconnectDelayMs } from '../reconnect-backoff.ts';
import { HANDSHAKE_DEADLINE_MS } from '../connection-supervisor-core.ts';
import { noteWakeMark } from '../wake-timeline.ts';
import { createHandshakeRace } from '../handshake-race-core.ts';
import type { HandshakeRace } from '../handshake-race-core.ts';
import { renderScheduler } from '../render-scheduler.ts';
import { buildWebSocketUrl } from '../ws-url-core.ts';
import { clearPageToken, loadPageToken, pageToken, withPageToken } from '../ws-token.ts';
import { noteSessionOutput } from './activity.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import type { DataFrameState } from './grid-core.ts';
import { dataAttachPath, readDataFrame, shouldRequestDeepHistory } from './grid-core.ts';
import { isCardBorrowed, uiState } from '../ui-state-core.ts';
import { decideTerminalLinkState } from './terminal-link-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { describeDataAttach, FAST_TERMINAL_CLOSE_MS, LOGGED_FAST_CLOSE_COUNTS, SCREEN_RESET } from '#shared/contracts/data-messages.ts';
import { BRAND_MARK_BRACKETS, BRAND_MARK_VIEWBOX } from '#shared/brand-mark.ts';
import { createSvgShape } from '../svg-dom.ts';
import { isScrolledAwayFromLatest, refreshJumpToLatest } from './terminal-notices.ts';
import { isInputHeldForWakeCheck, sendQueuedInput } from './terminal-input.ts';

const deepHistoryLinesFromBottomBySessionUi = new WeakMap<SessionUi, number>();

const restoredLinesFromBottomBySessionUi = new WeakMap<SessionUi, number>();

const sessionUisWithDeepHistory = new WeakSet<SessionUi>();

const sessionUisReattachingQuietly = new WeakSet<SessionUi>();

const sessionUisReconnectingWhenShown = new WeakSet<SessionUi>();

const sessionUisWithoutTerminal = new WeakSet<SessionUi>();

function hasNoTerminal(ui: SessionUi): boolean {
  return ui.hasTerminal === false || sessionUisWithoutTerminal.has(ui);
}

type TerminalDrainKind = 'none' | 'reset-snapshot' | 'catchup';

type OutputFlowState = 'paused' | 'resuming' | 'flowing';

type SnapshotScrollTarget = 'bottom' | 'preserve' | number;

const CATCHUP_HIDE_MIN_BYTES = 4096;

const ERASE_SCROLLBACK_SEQUENCE = '\x1b[3J';

const ERASE_SCREEN_SEQUENCE = '\x1b[2J';

const FULL_RESET_SEQUENCE = '\x1bc';

interface PendingSnapshotDrain {
  count: number;
  scrollTarget: SnapshotScrollTarget;
}

const pendingSnapshotDrainBySessionUi = new WeakMap<SessionUi, PendingSnapshotDrain>();

function classifyTerminalDrain(frameText: string, isAwaitingResumeCatchup: boolean): TerminalDrainKind {
  if (frameText.startsWith(SCREEN_RESET)) return 'reset-snapshot';
  const clearsScrollback = frameText.includes(ERASE_SCROLLBACK_SEQUENCE);
  if (clearsScrollback && frameText.length >= CATCHUP_HIDE_MIN_BYTES) return 'catchup';
  if (!isAwaitingResumeCatchup) return 'none';
  if (frameText.length >= CATCHUP_HIDE_MIN_BYTES || clearsScrollback || frameText.includes(ERASE_SCREEN_SEQUENCE) || frameText.includes(FULL_RESET_SEQUENCE)) return 'catchup';
  return 'none';
}

function isSnapshotDraining(ui: SessionUi): boolean {
  return (pendingSnapshotDrainBySessionUi.get(ui)?.count ?? 0) > 0;
}

function beginSnapshotDrain(ui: SessionUi, drainKind: Exclude<TerminalDrainKind, 'none'>, incomingTarget: SnapshotScrollTarget) {
  const existing = pendingSnapshotDrainBySessionUi.get(ui);
  const nextCount = (existing?.count ?? 0) + 1;
  const scrollTarget = drainKind === 'reset-snapshot' || !existing ? incomingTarget : existing.scrollTarget;
  pendingSnapshotDrainBySessionUi.set(ui, { count: nextCount, scrollTarget });
  ui.card.dataset.snapshotLoading = 'true';
}

function clearSnapshotDrain(ui: SessionUi) {
  pendingSnapshotDrainBySessionUi.delete(ui);
  delete ui.card.dataset.snapshotLoading;
}

function finishSnapshotDrain(ui: SessionUi, term: Terminal) {
  const existing = pendingSnapshotDrainBySessionUi.get(ui);
  if (!existing) return;
  const remainingCount = existing.count - 1;
  if (remainingCount > 0) {
    pendingSnapshotDrainBySessionUi.set(ui, { count: remainingCount, scrollTarget: existing.scrollTarget });
    return;
  }
  const { scrollTarget } = existing;
  clearSnapshotDrain(ui);
  if (typeof scrollTarget === 'number') term.scrollToLine(Math.max(0, term.buffer.active.length - scrollTarget));
  if (scrollTarget === 'bottom') term.scrollToBottom();
  term.refresh(0, term.rows - 1);
  refreshJumpToLatest(ui, term);
}

function rememberScrollOffsetForReattach(ui: SessionUi, term: Terminal) {
  if (isSnapshotDraining(ui)) return;
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
  if (isSnapshotDraining(ui)) return;
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

const outputFlowBySocket = new WeakMap<WebSocket, OutputFlowState>();

function isTerminalOutputWanted(sessionId: string) {
  return document.visibilityState === 'visible' && isCardBorrowed(sessionId);
}

function syncTerminalOutputFlow(ui: SessionUi | null | undefined, sessionId: string) {
  if (ui && reconnectIfDeferredAndShown(ui, sessionId)) return;
  const socket = ui?.dataWs;
  if (!ui || socket?.readyState !== WebSocket.OPEN) return;
  const isWanted = isTerminalOutputWanted(sessionId);
  const currentFlow = outputFlowBySocket.get(socket);
  const isAlreadyFlowing = currentFlow === 'flowing' || currentFlow === 'resuming';
  if (currentFlow !== undefined && isAlreadyFlowing === isWanted) return;
  outputFlowBySocket.set(socket, isWanted ? 'resuming' : 'paused');
  socket.send(JSON.stringify({ type: isWanted ? 'resume-output' : 'pause-output' }));
}

function syncEveryTerminalOutputFlow() {
  for (const [sessionId, ui] of sessionUIs) syncTerminalOutputFlow(ui, sessionId);
}

document.addEventListener('visibilitychange', syncEveryTerminalOutputFlow);
uiState.subscribe((_state, changedKeys) => {
  if (changedKeys.includes('borrowedCardId') || changedKeys.includes('borrowedShellCardId')) syncEveryTerminalOutputFlow();
});

function isStillCurrentAndDetached(sessionId: string, ui: SessionUi) {
  return sessionUIs.get(sessionId) === ui && !ui.dataWs;
}

function findConnectingOverlay(termWrap: HTMLElement) {
  return termWrap.querySelector(':scope > .terminal-connecting');
}

function buildConnectingMark() {
  const mark = createSvgShape('svg', { class: 'loading-mark', viewBox: BRAND_MARK_VIEWBOX, 'aria-hidden': 'true' });
  for (const { side, d } of BRAND_MARK_BRACKETS) mark.append(createSvgShape('path', { class: 'loading-mark-bracket', 'data-side': side, d }));
  return mark;
}

function ensureConnectingOverlay(termWrap: HTMLElement) {
  if (findConnectingOverlay(termWrap)) return;
  const overlay = el('div', 'terminal-connecting');
  overlay.append(buildConnectingMark(), el('span', 'terminal-connecting-label', 'Connecting'));
  termWrap.append(overlay);
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
    if (ui.card.dataset.link === 'connecting' && isTerminalOutputWanted(sessionId)) shownConnectingTerminalCount++;
  }
  return shownConnectingTerminalCount;
}

function refreshTerminalLink(ui: SessionUi) {
  const decidedLinkState = decideTerminalLinkState({
    hasTerminal: !hasNoTerminal(ui) && (ui.term !== null || sessionUisAwaitingXterm.has(ui)),
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
  ui.card.dataset.link = linkState;
  notifyTerminalLinkSubscribers();
}

function notifyTerminalLinkSubscribers() {
  for (const notify of terminalLinkSubscribers) notify();
}

const handshakeRaceBySessionUi = new WeakMap<SessionUi, HandshakeRace<WebSocket>>();

function handshakeRaceOf(ui: SessionUi): HandshakeRace<WebSocket> {
  const existingRace = handshakeRaceBySessionUi.get(ui);
  if (existingRace) return existingRace;
  const race = createHandshakeRace<WebSocket>((attempt) => attempt.close());
  handshakeRaceBySessionUi.set(ui, race);
  return race;
}

function detachDataWs(sessionId: string, ui: SessionUi, term: Terminal) {
  handshakeRaceOf(ui).closeAll();
  rememberScrollOffsetForReattach(ui, term);
  clearSnapshotDrain(ui);
  renderScheduler.unregister(sessionId);
  ui.dataWs = null;
  refreshTerminalLink(ui);
  ui._resetGridClaim?.();
}

const pendingRetryTimerBySessionUi = new WeakMap<SessionUi, ReturnType<typeof setTimeout>>();

function cancelPendingRetry(ui: SessionUi) {
  clearTimeout(pendingRetryTimerBySessionUi.get(ui));
  pendingRetryTimerBySessionUi.delete(ui);
}

function detachThenReconnect(sessionId: string, ui: SessionUi, term: Terminal, delayMs: number) {
  detachDataWs(sessionId, ui, term);
  cancelPendingRetry(ui);
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
  if (hasNoTerminal(ui)) return false;
  const isDeferred = sessionUisReconnectingWhenShown.has(ui);
  const isWaitingOnRetry = !ui.dataWs && sessionUIs.get(sessionId) === ui;
  if (!(isDeferred || isWaitingOnRetry) || !ui.term || !isTerminalOutputWanted(sessionId)) return false;
  sessionUisReconnectingWhenShown.delete(ui);
  ui._dataWsRetryAttempt = 0;
  detachThenReconnect(sessionId, ui, ui.term, 0);
  return true;
}

function detachUntilShown(sessionId: string, ui: SessionUi, term: Terminal) {
  detachDataWs(sessionId, ui, term);
  cancelPendingRetry(ui);
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
  socket.addEventListener('message', bufferMessage);
  socket.addEventListener('close', discard);
  const unclaimedTimer = setTimeout(discard, PREWARM_UNCLAIMED_LIFETIME_MS);
  const release = () => {
    socket.removeEventListener('message', bufferMessage);
    socket.removeEventListener('close', discard);
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
  if (hasNoTerminal(ui)) return;
  sessionUisReconnectingWhenShown.delete(ui);
  const deepHistoryLinesFromBottom = deepHistoryLinesFromBottomBySessionUi.get(ui);
  deepHistoryLinesFromBottomBySessionUi.delete(ui);
  const restoredLinesFromBottom = restoredLinesFromBottomBySessionUi.get(ui);
  restoredLinesFromBottomBySessionUi.delete(ui);
  const isDeepAttach = deepHistoryLinesFromBottom !== undefined;
  const linesFromBottomToRestore = deepHistoryLinesFromBottom ?? restoredLinesFromBottom;
  let isAwaitingSnapshotScroll = false;
  const isAttachedFlowing = isTerminalOutputWanted(sessionId);
  const attachPath = dataAttachPath(sessionId, isDeepAttach, !isAttachedFlowing);
  const prewarmed = claimPrewarmedDataSocket(sessionId, attachPath);
  const ws = prewarmed?.socket ?? new WebSocket(buildWebSocketUrl(location, withPageToken(attachPath)));
  outputFlowBySocket.set(ws, isAttachedFlowing ? 'flowing' : 'paused');
  ws.binaryType = 'arraybuffer';
  const handshakeRace = handshakeRaceOf(ui);
  handshakeRace.start(ws);
  ui.dataWs = ws;
  if (isAttachedFlowing) noteWakeMark('terminal-connecting');
  refreshTerminalLink(ui);
  let hasEverOpened = false;
  const socketLife: TerminalSocketLife = { sessionId, attachDescription: describeDataAttach({ history: isDeepAttach ? 'deep' : 'screen', isOutputPaused: !isAttachedFlowing }), openedAtMs: null, hasReceivedBytes: false };
  const frameState: DataFrameState = { hasSeenSize: false, lastSeq: 0 };
  const raceAnotherAttempt = () => {
    if (deepHistoryLinesFromBottom !== undefined) deepHistoryLinesFromBottomBySessionUi.set(ui, deepHistoryLinesFromBottom);
    if (restoredLinesFromBottom !== undefined) restoredLinesFromBottomBySessionUi.set(ui, restoredLinesFromBottom);
    connectDataWs(sessionId, ui, term);
  };
  const raceAgainAfterBackoff = () => {
    const retryDelayMs = nextReconnectDelayMs(ui._dataWsRetryAttempt || 0);
    ui._dataWsRetryAttempt = (ui._dataWsRetryAttempt || 0) + 1;
    pendingRetryTimerBySessionUi.set(ui, setTimeout(() => {
      pendingRetryTimerBySessionUi.delete(ui);
      if (ui.dataWs !== ws) return;
      raceAnotherAttempt();
    }, retryDelayMs));
  };
  const handshakeTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.CONNECTING || ui.dataWs !== ws) return;
    if (isAttachedFlowing) noteWakeMark('terminal-raced');
    raceAnotherAttempt();
  }, HANDSHAKE_DEADLINE_MS);

  renderScheduler.register(sessionId, (data, cb) => term.write(data, cb));

  const handleMessage = (event: MessageEvent) => {
    if (ui.dataWs !== ws) return;
    const frame = readDataFrame(event.data, frameState);
    if (frame.kind === 'bytes') {
      socketLife.hasReceivedBytes = true;
      noteSessionOutput(ui);
      const currentFlow = outputFlowBySocket.get(ws);
      const isAwaitingResumeCatchup = currentFlow === 'resuming';
      if (isAwaitingResumeCatchup) outputFlowBySocket.set(ws, 'flowing');
      if (currentFlow !== 'paused') noteWakeMark('terminal-bytes');
      const drainKind = classifyTerminalDrain(frame.data, isAwaitingResumeCatchup);
      const isSnapshotToRestore = isAwaitingSnapshotScroll && drainKind === 'reset-snapshot';
      if (drainKind === 'reset-snapshot') isAwaitingSnapshotScroll = false;
      const scrollTarget: SnapshotScrollTarget = drainKind === 'reset-snapshot'
        ? (isSnapshotToRestore && linesFromBottomToRestore !== undefined ? linesFromBottomToRestore : 'bottom')
        : (isScrolledAwayFromLatest(term) ? 'preserve' : 'bottom');
      if (drainKind !== 'none') beginSnapshotDrain(ui, drainKind, scrollTarget);
      renderScheduler.enqueue(sessionId, frame.data);
      if (drainKind === 'none') return;
      renderScheduler.enqueueAction(sessionId, () => {
        if (ui.dataWs !== ws) return;
        finishSnapshotDrain(ui, term);
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
    if (hasNoTerminal(ui) || (event.code === 1008 && event.reason === 'Session has no terminal')) {
      sessionUisWithoutTerminal.add(ui);
      sessionUisReattachingQuietly.delete(ui);
      sessionUisReconnectingWhenShown.delete(ui);
      detachDataWs(sessionId, ui, term);
      cancelPendingRetry(ui);
      return;
    }
    const wasRacing = handshakeRace.isRacing(ws);
    if (wasRacing && handshakeRace.drop(ws) > 0) {
      if (ui.dataWs === ws) raceAgainAfterBackoff();
      return;
    }
    if (!wasRacing && ui.dataWs !== ws) return;
    reportFastTerminalClose(ui, socketLife, event);
    if (isAttachedFlowing) noteWakeMark('terminal-closed');
    sessionUisReattachingQuietly.delete(ui);
    if (!hasEverOpened) clearPageToken();
    if (!isTerminalOutputWanted(sessionId)) {
      detachUntilShown(sessionId, ui, term);
      return;
    }
    const retryDelayMs = nextReconnectDelayMs(ui._dataWsRetryAttempt || 0);
    ui._dataWsRetryAttempt = (ui._dataWsRetryAttempt || 0) + 1;
    detachThenReconnect(sessionId, ui, term, retryDelayMs);
  });

  const handleOpen = () => {
    clearTimeout(handshakeTimer);
    if (handshakeRace.adopt(ws) === null) return;
    ui.dataWs = ws;
    hasEverOpened = true;
    socketLife.openedAtMs = performance.now();
    if (isAttachedFlowing) noteWakeMark('terminal-opened');
    ui._dataWsRetryAttempt = 0;
    sessionUisReattachingQuietly.delete(ui);
    refreshTerminalLink(ui);
    syncTerminalOutputFlow(ui, sessionId);

    ui._syncGrid?.({ isActivationEdge: true });
    ui._retryOwedGridClaim?.();
    sendQueuedInput(ui);
  };
  ws.addEventListener('open', handleOpen);

  if (ws.readyState === WebSocket.OPEN) handleOpen();
  for (const bufferedMessage of prewarmed?.bufferedMessages ?? []) handleMessage(bufferedMessage);
}

function reconnectDataWs(id: unknown) {
  const ui = findSessionUi(id);
  if (typeof id !== 'string' || !ui?.term || hasNoTerminal(ui)) return;
  const abandonedSocket = ui.dataWs;
  ui._dataWsRetryAttempt = 0;
  detachThenReconnect(id, ui, ui.term, 0);
  abandonedSocket?.close();
}

function reconnectShownTerminals() {
  for (const [sessionId, ui] of sessionUIs) {
    if (!ui.term) continue;
    if (isTerminalOutputWanted(sessionId)) {
      reconnectDataWs(sessionId);
      continue;
    }
    closeUntilShown(sessionId, ui, ui.term);
  }
}

function closeUntilShown(sessionId: string, ui: SessionUi, term: Terminal) {
  const abandonedSocket = ui.dataWs;
  if (!abandonedSocket && !pendingRetryTimerBySessionUi.has(ui)) return;
  detachUntilShown(sessionId, ui, term);
  abandonedSocket?.close();
}

function closeEveryTerminalUntilShown() {
  for (const [sessionId, ui] of sessionUIs) {
    if (ui.term) closeUntilShown(sessionId, ui, ui.term);
  }
}

function closeDataWs(ui: SessionUi, sessionId: string) {
  cancelPendingRetry(ui);
  sessionUisReconnectingWhenShown.delete(ui);
  handshakeRaceOf(ui).closeAll();
  const closingSocket = ui.dataWs;
  ui.dataWs = null;
  clearSnapshotDrain(ui);
  renderScheduler.unregister(sessionId);
  if (closingSocket && closingSocket.readyState <= WebSocket.OPEN) closingSocket.close();
}

export { closeDataWs, closeEveryTerminalUntilShown, connectDataWs, countShownConnectingTerminals, ensureConnectingOverlay, isSnapshotDraining, isStillCurrentAndDetached, onTerminalLinkChange, prewarmDataSocket, reconnectDataWs, reconnectShownTerminals, refreshTerminalLink, requestDeepHistoryAtTop, sessionUisAwaitingXterm, syncTerminalOutputFlow };
