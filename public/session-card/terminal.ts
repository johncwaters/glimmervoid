
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { createActionStatus } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { currentTerminalFontFamily } from '../mono-font.ts';
import type { SessionUi } from './card-registry.ts';
import { el, writeClipboardText } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { resolveDashboardShortcut } from '../shortcuts-core.ts';
import { nextReconnectDelayMs } from '../reconnect-backoff.ts';
import { renderScheduler } from '../render-scheduler.ts';
import { getTerminalTheme } from '../theme.ts';
import { buildWebSocketUrl } from '../ws-url-core.ts';
import { clearPageToken, loadPageToken, withPageToken } from '../ws-token.ts';
import { noteSessionOutput } from './activity.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import type { DataFrameState, TerminalGrid } from './grid-core.ts';
import { dataAttachPath, decideGridActions, decideGridEngagementEdge, retainGridClaimForReconnect, isCardTerminalHidden, isFollowingGrid, isViewerEngaged, readDataFrame, shouldRequestDeepHistory } from './grid-core.ts';
import { uiState } from '../ui-state-core.ts';
import {
  bytesForBackwardDeletion,
  bytesForSoftKeyboardEdit,
  isImeProcessingKeydown,
  isTypedInputType,
} from './ime-core.ts';
import { osc8LinkHandler, registerUrlLinkProvider } from './terminal-links.ts';
import { installTerminalSecretMask, resetTerminalSecretMask } from './terminal-secret-mask.ts';
import { decideTerminalLinkState } from './terminal-link-core.ts';
import { registerUploadReporter, uploadFilesToSession } from '../session-upload.ts';
import { wireTouchScroll } from './touch-scroll.ts';
import { reacquireWebglIfStale, releaseWebgl, tryLoadWebGL } from './webgl-pool.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from '../flying-animal-preview.ts';


const INPUT_QUEUE_MAX = 1024;
const GRID_SETTLE_MS = 250;
const MOBILE_WIDTH_QUERY = '(max-width: 768px)';
const MOBILE_FONT_SIZE = 12;
const DESKTOP_FONT_SIZE = 14;

const TERMINAL_SCROLLBACK = 50000;
let _terminalCursorBlink = false;

export function setTerminalCursorBlink(v: boolean) {
  _terminalCursorBlink = v;
}


let _hasWindowBlurredSinceFocus = false;

window.addEventListener('blur', () => { _hasWindowBlurredSinceFocus = true; });
window.addEventListener('focus', () => { _hasWindowBlurredSinceFocus = false; });

function isViewerEngagedAt(card: HTMLElement) {
  const activeElement = document.activeElement;
  return isViewerEngaged({
    isDocumentVisible: document.visibilityState === 'visible',
    isDocumentFocused: document.hasFocus(),
    hasFocusInsideCard: activeElement instanceof Node && card.contains(activeElement),
    hasWindowBlurredSinceFocus: _hasWindowBlurredSinceFocus,
    isPhoneLayout: isPhoneLayout(),
  });
}

function isCardTerminalHiddenNow(ui: SessionUi, sessionId: string) {
  return isCardTerminalHidden({
    isDocumentVisible: document.visibilityState === 'visible',
    isBorrowedCard: uiState.snapshot().borrowedCardId === sessionId,
    isTerminalFaceShown: ui.face === 'terminal',
  });
}

const deepHistoryLinesFromBottomBySessionUi = new WeakMap<SessionUi, number>();
const restoredLinesFromBottomBySessionUi = new WeakMap<SessionUi, number>();
const sessionUisWithDeepHistory = new WeakSet<SessionUi>();
const sessionUisReattachingQuietly = new WeakSet<SessionUi>();

type TerminalNoticeKind = 'keys' | 'upload' | 'clipboard';
type TerminalNoticeTone = 'busy' | 'ok' | 'error';

interface TerminalNotices {
  status: ActionStatus;
  shownKind: TerminalNoticeKind | null;
  clearTimerId: ReturnType<typeof setTimeout> | null;
  clipboardPrompt: HTMLElement;
  pendingClipboardText: string | null;
  jumpToLatestButton: HTMLButtonElement;
}

const terminalNoticesBySessionUi = new WeakMap<SessionUi, TerminalNotices>();
const OK_NOTICE_CLEAR_MS = 5000;
const ERROR_NOTICE_CLEAR_MS = 15000;
const HELD_KEYS_TEXT = 'Keys you type now are held and sent once the terminal reconnects.';
const DROPPED_KEYS_TEXT = 'The terminal is still reconnecting and its key buffer is full, so new keys are dropped.';
const CLIPBOARD_PROMPT_TEXT = 'The agent copied text. The browser needs a click before it can reach your clipboard.';
const CLIPBOARD_UNAVAILABLE_TEXT = 'The clipboard is unavailable in this browser.';

function showTerminalNotice(ui: SessionUi, kind: TerminalNoticeKind, tone: TerminalNoticeTone, text: string) {
  const notices = terminalNoticesBySessionUi.get(ui);
  if (!notices) return;
  if (notices.clearTimerId !== null) clearTimeout(notices.clearTimerId);
  notices.clearTimerId = null;
  notices.shownKind = kind;
  notices.status.show(tone, text);
  if (tone === 'busy') return;
  notices.clearTimerId = setTimeout(() => clearTerminalNotice(ui, kind), tone === 'ok' ? OK_NOTICE_CLEAR_MS : ERROR_NOTICE_CLEAR_MS);
}

function clearTerminalNotice(ui: SessionUi, kind: TerminalNoticeKind) {
  const notices = terminalNoticesBySessionUi.get(ui);
  if (!notices || notices.shownKind !== kind) return;
  if (notices.clearTimerId !== null) clearTimeout(notices.clearTimerId);
  notices.clearTimerId = null;
  notices.shownKind = null;
  notices.status.clear();
}

function isScrolledAwayFromLatest(term: Terminal) {
  const buffer = term.buffer.active;
  return buffer.viewportY < buffer.baseY;
}

function refreshJumpToLatest(ui: SessionUi, term: Terminal, { hasNewOutput = false }: { hasNewOutput?: boolean } = {}) {
  const button = terminalNoticesBySessionUi.get(ui)?.jumpToLatestButton;
  if (!button) return;
  const isScrolledAway = isScrolledAwayFromLatest(term);
  button.hidden = !isScrolledAway;
  if (!isScrolledAway) {
    delete button.dataset.hasNewOutput;
    return;
  }
  if (hasNewOutput) button.dataset.hasNewOutput = 'true';
}

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

function reattachIfMissedWhileHidden(ui: SessionUi, sessionId: string) {
  if (!ui._hasMissedOutputWhileHidden) return;
  if (isCardTerminalHiddenNow(ui, sessionId)) return;
  ui._hasMissedOutputWhileHidden = false;
  reconnectDataWs(sessionId);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const borrowedCardId = uiState.snapshot().borrowedCardId;
  if (!borrowedCardId) return;
  const borrowedUi = sessionUIs.get(borrowedCardId);
  if (!borrowedUi) return;
  reattachIfMissedWhileHidden(borrowedUi, borrowedCardId);
});

function decodeOsc52Payload(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function reportClipboardFailure(ui: SessionUi, source: string, err: unknown) {
  const msg = (err instanceof Error ? err.message : '') || String(err);
  console.error(`[clipboard:${source}]`, err);
  showTerminalNotice(ui, 'clipboard', 'error', `Clipboard ${source} failed: ${msg}`);
}

function copyTextToClipboard(ui: SessionUi, text: string, source: string, successText?: string) {
  const write = writeClipboardText(text);
  if (!write) {
    showTerminalNotice(ui, 'clipboard', 'error', CLIPBOARD_UNAVAILABLE_TEXT);
    return;
  }
  write
    .then(() => {
      if (successText) showTerminalNotice(ui, 'clipboard', 'ok', successText);
    })
    .catch((err) => reportClipboardFailure(ui, source, err));
}

function offerClipboardCopy(ui: SessionUi, text: string) {
  const notices = terminalNoticesBySessionUi.get(ui);
  if (!notices) return;
  notices.pendingClipboardText = text;
  notices.clipboardPrompt.hidden = false;
}

function copyOfferedClipboardText(ui: SessionUi) {
  const notices = terminalNoticesBySessionUi.get(ui);
  const text = notices?.pendingClipboardText;
  if (!notices || text == null) return;
  notices.pendingClipboardText = null;
  notices.clipboardPrompt.hidden = true;
  copyTextToClipboard(ui, text, 'osc52 write', 'Copied to the clipboard.');
}

function buildTerminalNotices(termWrap: HTMLElement, ui: SessionUi, term: Terminal) {
  const status = createActionStatus('terminal-notice');
  const clipboardPrompt = el('div', 'terminal-clipboard-prompt');
  clipboardPrompt.hidden = true;
  const copyButton = el('button', 'btn-dialog btn-dialog-confirm', 'Copy to clipboard');
  copyButton.type = 'button';
  copyButton.addEventListener('click', () => copyOfferedClipboardText(ui));
  clipboardPrompt.append(el('span', 'terminal-clipboard-prompt-text', CLIPBOARD_PROMPT_TEXT), copyButton);
  const noticeStack = el('div', 'terminal-notices');
  noticeStack.append(clipboardPrompt, status.element);

  const jumpToLatestButton = el('button', 'terminal-jump-latest btn-dialog btn-dialog-ghost', 'Jump to latest');
  jumpToLatestButton.type = 'button';
  jumpToLatestButton.hidden = true;
  jumpToLatestButton.addEventListener('click', () => {
    term.scrollToBottom();
    term.focus();
  });

  const dropZone = el('div', 'terminal-drop-zone');
  dropZone.setAttribute('aria-hidden', 'true');
  dropZone.append(el('span', 'terminal-drop-zone-label', 'Drop to upload to this session'));

  termWrap.append(noticeStack, jumpToLatestButton, dropZone);
  terminalNoticesBySessionUi.set(ui, { status, shownKind: null, clearTimerId: null, clipboardPrompt, pendingClipboardText: null, jumpToLatestButton });
}


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

export function onTerminalLinkChange(notify: () => void) {
  terminalLinkSubscribers.add(notify);
  return () => terminalLinkSubscribers.delete(notify);
}

export function countConnectingTerminals() {
  let connectingTerminalCount = 0;
  for (const ui of sessionUIs.values()) {
    if (ui.card.dataset.link === 'connecting') connectingTerminalCount++;
  }
  return connectingTerminalCount;
}

function refreshTerminalLink(ui: SessionUi) {
  const decidedLinkState = decideTerminalLinkState({
    hasTerminal: ui.term !== null,
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

function detachThenReconnect(sessionId: string, ui: SessionUi, term: Terminal, delayMs: number) {
  rememberScrollOffsetForReattach(ui, term);
  renderScheduler.unregister(sessionId);
  ui.dataWs = null;
  refreshTerminalLink(ui);
  ui._resetGridClaim?.();
  setTimeout(() => {
    if (!isStillCurrentAndDetached(sessionId, ui)) return;
    void loadPageToken().catch(() => {}).then(() => {
      if (!isStillCurrentAndDetached(sessionId, ui)) return;
      connectDataWs(sessionId, ui, term);
    });
  }, delayMs);
}

function connectDataWs(sessionId: string, ui: SessionUi, term: Terminal) {
  const deepHistoryLinesFromBottom = deepHistoryLinesFromBottomBySessionUi.get(ui);
  deepHistoryLinesFromBottomBySessionUi.delete(ui);
  const restoredLinesFromBottom = restoredLinesFromBottomBySessionUi.get(ui);
  restoredLinesFromBottomBySessionUi.delete(ui);
  const isDeepAttach = deepHistoryLinesFromBottom !== undefined;
  const linesFromBottomToRestore = deepHistoryLinesFromBottom ?? restoredLinesFromBottom;
  let isAwaitingSnapshotScroll = false;
  const url = buildWebSocketUrl(location, withPageToken(dataAttachPath(sessionId, isDeepAttach)));
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ui.dataWs = ws;
  refreshTerminalLink(ui);
  let hasEverOpened = false;
  const frameState: DataFrameState = { hasSeenSize: false, lastSeq: 0 };

  renderScheduler.register(sessionId, (data, cb) => term.write(data, cb));

  ws.addEventListener('message', (event) => {
    if (ui.dataWs !== ws) return;
    const frame = readDataFrame(event.data, frameState);
    if (frame.kind === 'bytes') {
      noteSessionOutput(ui);
      const isSnapshotToScroll = isAwaitingSnapshotScroll;
      isAwaitingSnapshotScroll = false;
      if (isCardTerminalHiddenNow(ui, sessionId)) {
        ui._hasMissedOutputWhileHidden = true;
        return;
      }
      renderScheduler.enqueue(sessionId, frame.data);
      if (!isSnapshotToScroll) return;
      const linesFromBottom = linesFromBottomToRestore ?? 0;
      renderScheduler.enqueueAction(sessionId, () => {
        term.scrollToLine(Math.max(0, term.buffer.active.length - linesFromBottom));
      });
      return;
    }
    if (frame.kind === 'attach-size') {
      ui._hasMissedOutputWhileHidden = false;
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
  });

  ws.addEventListener('close', () => {
    if (ui.dataWs !== ws) return;
    sessionUisReattachingQuietly.delete(ui);
    if (!hasEverOpened) clearPageToken();
    const retryDelayMs = nextReconnectDelayMs(ui._dataWsRetryAttempt || 0);
    ui._dataWsRetryAttempt = (ui._dataWsRetryAttempt || 0) + 1;
    detachThenReconnect(sessionId, ui, term, retryDelayMs);
  });

  ws.addEventListener('open', () => {
    hasEverOpened = true;
    ui._dataWsRetryAttempt = 0;
    sessionUisReattachingQuietly.delete(ui);
    refreshTerminalLink(ui);

    ui._syncGrid?.({ isActivationEdge: true });
    ui._retryOwedGridClaim?.();

    if (!ui._inputQueue?.length) return;
    setTimeout(() => {
      if (ui.dataWs !== ws) return;
      sendQueuedInput(ui);
    }, 50);
  });
}

let isInputHeldForWakeCheck = false;

function sendQueuedInput(ui: SessionUi) {
  const queued = ui._inputQueue;
  const ws = ui.dataWs;
  if (isInputHeldForWakeCheck || !queued?.length || ws?.readyState !== WebSocket.OPEN) return;
  for (const data of queued) ws.send(JSON.stringify({ type: 'input', data }));
  queued.length = 0;
  clearTerminalNotice(ui, 'keys');
}

export function holdTerminalInputDuringWakeCheck() {
  isInputHeldForWakeCheck = true;
  for (const ui of sessionUIs.values()) refreshTerminalLink(ui);
}

export function releaseHeldTerminalInput() {
  isInputHeldForWakeCheck = false;
  for (const ui of sessionUIs.values()) {
    refreshTerminalLink(ui);
    sendQueuedInput(ui);
  }
}

export function reconnectDataWs(id: unknown) {
  const ui = findSessionUi(id);
  if (typeof id !== 'string' || !ui?.term) return;
  const abandonedSocket = ui.dataWs;
  ui._dataWsRetryAttempt = 0;
  detachThenReconnect(id, ui, ui.term, 0);
  abandonedSocket?.close();
}

export function closeDataWs(ui: SessionUi, sessionId: string) {
  const closingSocket = ui.dataWs;
  ui.dataWs = null;
  renderScheduler.unregister(sessionId);
  if (closingSocket && closingSocket.readyState <= WebSocket.OPEN) closingSocket.close();
}

export function sendTerminalInput(ui: SessionUi | null | undefined, data: string | null | undefined, options?: { fromSoftKeyboard?: boolean }) {
  if (!ui || data == null || data === '') return false;
  if (!options?.fromSoftKeyboard) ui._resetSoftKeyboardBuffer?.();
  if (!isInputHeldForWakeCheck && !ui._inputQueue?.length && ui.dataWs?.readyState === WebSocket.OPEN) {
    ui.dataWs.send(JSON.stringify({ type: 'input', data }));
    return true;
  }
  if (!ui._inputQueue) return false;
  const isReconnecting = ui.dataWs?.readyState !== WebSocket.OPEN;
  if (ui._inputQueue.length >= INPUT_QUEUE_MAX) {
    showTerminalNotice(ui, 'keys', 'error', DROPPED_KEYS_TEXT);
    return false;
  }
  ui._inputQueue.push(data);
  if (isReconnecting) showTerminalNotice(ui, 'keys', 'busy', HELD_KEYS_TEXT);
  return true;
}


export function setupTerminal(termWrap: HTMLElement, ui: SessionUi) {
  const fontSize = window.matchMedia?.(MOBILE_WIDTH_QUERY).matches ? MOBILE_FONT_SIZE : DESKTOP_FONT_SIZE;
  const term = new Terminal({
    cursorBlink: _terminalCursorBlink,
    fontSize,
    fontFamily: currentTerminalFontFamily(),
    theme: getTerminalTheme(),
    scrollback: TERMINAL_SCROLLBACK,
    allowProposedApi: true,
    linkHandler: osc8LinkHandler(),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  ensureConnectingOverlay(termWrap);
  term.open(termWrap);
  buildTerminalNotices(termWrap, ui, term);
  registerUrlLinkProvider(term);
  installTerminalSecretMask(term, ui.abortController.signal);

  ui.term = term;
  ui.fitAddon = fitAddon;
  releaseWebgl(ui);

  let gridRafId: number | null = null;
  let settleTimerId: ReturnType<typeof setTimeout> | null = null;
  let isActiveViewer = false;
  let lastClaim: TerminalGrid | null = null;
  let owedClaim: TerminalGrid | null = null;

  function cancelSettle() {
    if (settleTimerId === null) return;
    clearTimeout(settleTimerId);
    settleTimerId = null;
  }

  function measureProposal(): TerminalGrid | null {
    if (!isActiveViewer) return null;
    const liveFitAddon = ui.fitAddon;
    if (!liveFitAddon) return null;
    const proposed = liveFitAddon.proposeDimensions();
    if (!proposed) return null;
    return { cols: proposed.cols, rows: proposed.rows };
  }

  function sendGridClaim(grid: TerminalGrid): boolean {
    if (!isActiveViewer) return false;
    if (!isViewerEngagedAt(ui.card)) return false;
    if (ui.dataWs?.readyState !== WebSocket.OPEN) return false;
    ui.dataWs.send(JSON.stringify({ type: 'claim', cols: grid.cols, rows: grid.rows }));
    lastClaim = grid;
    owedClaim = null;
    const following = isFollowingGrid({ authoritative: ui.ptySize ?? null, isActiveViewer, lastClaim });
    ui.card.dataset.grid = following ? 'following' : 'exact';
    return true;
  }

  function settleThenClaim(grid: TerminalGrid) {
    cancelSettle();
    owedClaim = grid;
    settleTimerId = setTimeout(() => {
      settleTimerId = null;
      sendGridClaim(grid);
    }, GRID_SETTLE_MS);
  }

  function retryOwedClaim() {
    if (!owedClaim) return;
    if (settleTimerId !== null) return;
    sendGridClaim(owedClaim);
  }

  function syncGrid({ isActivationEdge = false }: { isActivationEdge?: boolean } = {}) {
    const liveTerm = ui.term;
    if (!liveTerm) return;
    const actions = decideGridActions({
      authoritative: ui.ptySize ?? null,
      applied: { cols: liveTerm.cols, rows: liveTerm.rows },
      proposal: measureProposal(),
      isActiveViewer,
      isDataWsOpen: ui.dataWs?.readyState === WebSocket.OPEN,
      lastClaim,
    });
    if (actions.resizeTo) liveTerm.resize(actions.resizeTo.cols, actions.resizeTo.rows);
    ui.card.dataset.grid = actions.isFollowing ? 'following' : 'exact';
    if (!actions.keepsPendingSettle) {
      cancelSettle();
      owedClaim = null;
    }
    if (actions.sendUnview) {
      lastClaim = null;
      ui.dataWs?.send(JSON.stringify({ type: 'unview' }));
      return;
    }
    if (!actions.owedClaim) return;
    if (isActivationEdge && sendGridClaim(actions.owedClaim)) return;
    settleThenClaim(actions.owedClaim);
  }

  function handleEngagementEdge() {
    const edge = decideGridEngagementEdge({
      authoritative: ui.ptySize ?? null,
      isActiveViewer,
      isDocumentEngaged: isViewerEngagedAt(ui.card),
      isDataWsOpen: ui.dataWs?.readyState === WebSocket.OPEN,
      lastClaim,
    });
    if (edge === 'none') return;
    cancelSettle();
    if (edge === 'rebid') lastClaim = null;
    syncGrid({ isActivationEdge: true });
  }

  const resizeObserver = new ResizeObserver(() => {
    if (gridRafId !== null) return;
    gridRafId = requestAnimationFrame(() => {
      gridRafId = null;
      syncGrid();
    });
  });
  resizeObserver.observe(termWrap);
  ui.resizeObserver = resizeObserver;
  ui._syncGrid = syncGrid;
  ui._resetGridClaim = () => {
    cancelSettle();
    owedClaim = retainGridClaimForReconnect({ isActiveViewer, lastClaim, owedClaim });
    lastClaim = null;
  };
  ui._retryOwedGridClaim = retryOwedClaim;
  ui._syncGridOnEngagementEdge = handleEngagementEdge;
  ui._isActiveViewer = () => isActiveViewer;
  ui._setActiveViewer = (isActive: boolean) => {
    if (isActiveViewer === isActive) return;
    isActiveViewer = isActive;
    cancelSettle();
    owedClaim = null;
    if (isActive) reacquireWebglIfStale(ui);
    syncGrid({ isActivationEdge: true });
  };
  ui.card.addEventListener('focusin', () => {
    _hasWindowBlurredSinceFocus = false;
    handleEngagementEdge();
  }, { signal: ui.abortController.signal });

  tryLoadWebGL(ui);

  let scrollRafId: number | null = null;
  term.onScroll(() => {
    if (scrollRafId !== null) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      if (!ui.term) return;
      ui.term.refresh(0, ui.term.rows - 1);
      refreshJumpToLatest(ui, ui.term);
    });
  });
  term.onWriteParsed(() => refreshJumpToLatest(ui, term, { hasNewOutput: true }));

  term.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(';');
    if (semi < 0) return true;
    const payload = data.slice(semi + 1);
    if (payload === '' || payload === '?') return true;
    let text: string;
    try {
      text = decodeOsc52Payload(payload);
    } catch (err) {
      reportClipboardFailure(ui, 'osc52 decode', err);
      return true;
    }
    const hasActivation = document.hasFocus()
      && navigator.userActivation?.isActive !== false;
    if (!hasActivation) {
      offerClipboardCopy(ui, text);
      return true;
    }
    copyTextToClipboard(ui, text, 'osc52 write');
    return true;
  });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (document.body.dataset.activeView === 'focus' && resolveDashboardShortcut(ev, SHORTCUT_PLATFORM, { isTerminalFocused: true })) return false;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key === 'c' && term.hasSelection()) {
      const selection = term.getSelection();
      term.clearSelection();
      copyTextToClipboard(ui, selection, 'copy');
      return false;
    }
    if (ctrl && ev.key === 'v') {
      return false;
    }
    if (ctrl && ev.key === 'Backspace') {
      sendTerminalInput(ui, '\x1b\x7f');
      return false;
    }
    return true;
  });

  wireSoftKeyboardInput(termWrap, term, ui);
  wireTouchScroll(termWrap, term);
}

function wireSoftKeyboardInput(termWrap: HTMLElement, term: Terminal, ui: SessionUi) {
  const textarea = term.textarea;
  if (!textarea) return;

  let alreadySentText = '';

  const resyncBaseline = () => { alreadySentText = textarea.value; };

  const resetSoftKeyboardBuffer = () => {
    alreadySentText = '';
    if (!isPhoneLayout()) return;
    if (textarea.value === '') return;
    textarea.value = '';
  };
  ui._resetSoftKeyboardBuffer = resetSoftKeyboardBuffer;

  const sendTypedText = () => {
    const bytes = bytesForSoftKeyboardEdit(alreadySentText, textarea.value);
    alreadySentText = textarea.value;
    if (bytes === '') return false;
    sendTerminalInput(ui, bytes, { fromSoftKeyboard: true });
    term.scrollToBottom();
    return true;
  };

  const listenBeforeXterm = <EventName extends keyof HTMLElementEventMap>(
    type: EventName,
    handler: (event: HTMLElementEventMap[EventName]) => void,
  ) => {
    termWrap.addEventListener(type, (event) => {
      if (!isPhoneLayout()) {
        resyncBaseline();
        return;
      }
      handler(event);
    }, true);
  };

  listenBeforeXterm('keydown', (event) => {
    if (isImeProcessingKeydown(event)) {
      event.stopPropagation();
      return;
    }
    sendTypedText();
    queueMicrotask(resetSoftKeyboardBuffer);
  });

  listenBeforeXterm('compositionstart', (event) => {
    event.stopPropagation();
  });

  listenBeforeXterm('compositionupdate', (event) => {
    event.stopPropagation();
  });

  listenBeforeXterm('compositionend', (event) => {
    event.stopPropagation();
    setTimeout(sendTypedText, 0);
  });

  listenBeforeXterm('input', (event) => {
    if (!isTypedInputType(event.inputType)) {
      queueMicrotask(resetSoftKeyboardBuffer);
      return;
    }
    event.stopPropagation();
    if (sendTypedText()) return;
    const deletion = bytesForBackwardDeletion(event.inputType);
    if (deletion === '') return;
    sendTerminalInput(ui, deletion, { fromSoftKeyboard: true });
    term.scrollToBottom();
  });
}

export function wireTerminalIO(ui: SessionUi, sessionId: string) {
  ui._inputQueue = [];

  const term = ui.term;
  if (!term) return;
  term.onData((data) => { sendTerminalInput(ui, data); });
  term.onScroll((viewportTopLine) => { requestDeepHistoryAtTop(ui, sessionId, viewportTopLine); });

  registerUploadReporter(sessionId, (tone, text) => {
    const isTerminalVisible = !ui.termWrap.hidden && ui.face === 'terminal';
    if (!isTerminalVisible) return false;
    showTerminalNotice(ui, 'upload', tone, text);
    return true;
  }, ui.abortController.signal);
  wireFileTransfer(ui.termWrap, sessionId, ui.abortController.signal);
  connectDataWs(sessionId, ui, term);
}

function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return !!transfer && Array.from(transfer.types).includes('Files');
}

function wireFileTransfer(termWrap: HTMLElement, sessionId: string, signal: AbortSignal) {
  termWrap.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard || clipboard.files.length === 0) return;
    if (clipboard.getData('text/plain') !== '') return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFilesToSession(sessionId, Array.from(clipboard.files));
  }, { capture: true, signal });

  termWrap.addEventListener('dragover', (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    termWrap.dataset.dropTarget = 'true';
  }, { signal });

  termWrap.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && termWrap.contains(event.relatedTarget)) return;
    delete termWrap.dataset.dropTarget;
  }, { signal });

  termWrap.addEventListener('drop', (event) => {
    delete termWrap.dataset.dropTarget;
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFilesToSession(sessionId, Array.from(event.dataTransfer.files));
  }, { capture: true, signal });
}

export function ensureTerminalSetup(ui: SessionUi, sessionId: string) {
  if (ui.term) return;
  setupTerminal(ui.termWrap, ui);
  wireTerminalIO(ui, sessionId);
}

export function syncGridOnEngagementEdge(ui: SessionUi | null | undefined) {
  ui?._syncGridOnEngagementEdge?.();
}

export function ensureTerminalReady(ui: SessionUi | null | undefined, sessionId: string) {
  if (!ui) return;
  ensureTerminalSetup(ui, sessionId);
  reattachIfMissedWhileHidden(ui, sessionId);
  reacquireWebglIfStale(ui);
  const term = ui.term;
  if (!term) return;
  term.refresh(0, term.rows - 1);
  syncGridOnEngagementEdge(ui);
}

export function setTerminalActiveViewer(ui: SessionUi | null | undefined, sessionId: string, isActive: boolean) {
  if (!ui) return;
  if (isActive) ensureTerminalSetup(ui, sessionId);
  ui._setActiveViewer?.(isActive);
}
