import { currentTerminalFontFamily } from '../mono-font.ts';
import type { SessionUi } from './card-registry.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { currentNextAttentionKeyCode, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { escapesFocusedTerminal, resolveDashboardShortcut } from '../shortcuts-core.ts';
import { getTerminalTheme } from '../theme.ts';
import type { TerminalGrid } from './grid-core.ts';
import { decideGridActions, decideGridEngagementEdge, retainGridClaimForReconnect, isFollowingGrid, isViewerEngaged } from './grid-core.ts';
import { osc8LinkHandler, registerUrlLinkProvider } from './terminal-links.ts';
import { installTerminalSecretMask } from './terminal-secret-mask.ts';
import { wireTouchScroll } from './touch-scroll.ts';
import { reacquireWebglIfStale, releaseWebgl, tryLoadWebGL } from './webgl-pool.ts';
import type { XtermRuntime } from './xterm-runtime.ts';
import { buildTerminalNotices, copyTextToClipboard, decodeOsc52Payload, offerClipboardCopy, refreshJumpToLatest, reportClipboardFailure } from './terminal-notices.ts';
import { sendTerminalInput, wireSoftKeyboardInput } from './terminal-input.ts';
import { ensureConnectingOverlay } from './terminal-data-socket.ts';

function isDashboardShortcutInActiveView(ev: KeyboardEvent) {
  const shortcut = resolveDashboardShortcut(ev, SHORTCUT_PLATFORM, { isTerminalFocused: true }, currentNextAttentionKeyCode());
  if (!shortcut) return false;
  return escapesFocusedTerminal(shortcut, document.body.dataset.activeView);
}

const GRID_SETTLE_MS = 250;

const MOBILE_WIDTH_QUERY = '(max-width: 768px)';

const MOBILE_FONT_SIZE = 12;

const DESKTOP_FONT_SIZE = 14;

const TERMINAL_SCROLLBACK = 50000;

let _terminalCursorBlink = false;

function setTerminalCursorBlink(v: boolean) {
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

function setupTerminal(termWrap: HTMLElement, ui: SessionUi, xtermRuntime: XtermRuntime) {
  const fontSize = window.matchMedia?.(MOBILE_WIDTH_QUERY).matches ? MOBILE_FONT_SIZE : DESKTOP_FONT_SIZE;
  const term = new xtermRuntime.Terminal({
    cursorBlink: _terminalCursorBlink,
    fontSize,
    fontFamily: currentTerminalFontFamily(),
    theme: getTerminalTheme(),
    scrollback: TERMINAL_SCROLLBACK,
    allowProposedApi: true,
    linkHandler: osc8LinkHandler(),
  });

  const fitAddon = new xtermRuntime.FitAddon();
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
    if (ev.shiftKey && ev.key === 'Enter') {
      if (ev.type === 'keydown') sendTerminalInput(ui, '\x1b\r');
      return false;
    }
    if (ev.type !== 'keydown') return true;
    if (isDashboardShortcutInActiveView(ev)) return false;
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

export { setTerminalCursorBlink, setupTerminal };
