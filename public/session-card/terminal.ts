import type { SessionUi } from './card-registry.ts';
import { sessionUIs } from './card-registry.ts';
import { sendControlMsg } from '../control-ws.ts';
import { reacquireWebglIfStale } from './webgl-pool.ts';
import { loadXtermRuntime, readLoadedXtermRuntime } from './xterm-runtime.ts';
import type { XtermRuntime } from './xterm-runtime.ts';
import { sendQueuedInput, sendTerminalInput, setInputHeldForWakeCheck, wireFileTransfer } from './terminal-input.ts';
import { connectDataWs, ensureConnectingOverlay, isStillCurrentAndDetached, refreshTerminalLink, requestDeepHistoryAtTop, sessionUisAwaitingXterm, syncTerminalOutputFlow } from './terminal-data-socket.ts';
import { setupTerminal } from './terminal-setup.ts';

function holdTerminalInputDuringWakeCheck() {
  setInputHeldForWakeCheck(true);
  for (const ui of sessionUIs.values()) refreshTerminalLink(ui);
}

function releaseHeldTerminalInput() {
  setInputHeldForWakeCheck(false);
  for (const ui of sessionUIs.values()) {
    refreshTerminalLink(ui);
    sendQueuedInput(ui);
  }
}

function wireTerminalIO(ui: SessionUi, sessionId: string) {
  ui._inputQueue = [];

  const term = ui.term;
  if (!term) return;
  term.onData((data) => {
    sendTerminalInput(ui, data);
    if (ui.unseenOutcome) sendControlMsg({ type: 'dismiss', id: sessionId, expectedState: ui.currentState });
  });
  term.onScroll((viewportTopLine) => { requestDeepHistoryAtTop(ui, sessionId, viewportTopLine); });

  wireFileTransfer(ui.termWrap, sessionId, ui.abortController.signal);
  refreshTerminalLink(ui);
  queueMicrotask(() => {
    if (!isStillCurrentAndDetached(sessionId, ui)) return;
    connectDataWs(sessionId, ui, term);
  });
}

function ensureTerminalSetup(ui: SessionUi, sessionId: string) {
  if (ui.term || sessionUisAwaitingXterm.has(ui)) return;
  const loadedRuntime = readLoadedXtermRuntime();
  if (loadedRuntime) {
    attachTerminal(ui, sessionId, loadedRuntime);
    return;
  }
  sessionUisAwaitingXterm.add(ui);
  let isActiveViewerRequested = ui._isActiveViewer?.() === true;
  ui._isActiveViewer = () => isActiveViewerRequested;
  ui._setActiveViewer = (isActive: boolean) => { isActiveViewerRequested = isActive; };
  ensureConnectingOverlay(ui.termWrap);
  refreshTerminalLink(ui);
  loadXtermRuntime().then((xtermRuntime) => {
    sessionUisAwaitingXterm.delete(ui);
    if (ui.term || ui.abortController.signal.aborted || sessionUIs.get(sessionId) !== ui) return;
    attachTerminal(ui, sessionId, xtermRuntime);
    ui._setActiveViewer?.(isActiveViewerRequested);
  }, () => {
    sessionUisAwaitingXterm.delete(ui);
    refreshTerminalLink(ui);
  });
}

function attachTerminal(ui: SessionUi, sessionId: string, xtermRuntime: XtermRuntime) {
  setupTerminal(ui.termWrap, ui, xtermRuntime);
  wireTerminalIO(ui, sessionId);
}

function syncGridOnEngagementEdge(ui: SessionUi | null | undefined) {
  ui?._syncGridOnEngagementEdge?.();
}

function ensureTerminalReady(ui: SessionUi | null | undefined, sessionId: string) {
  if (!ui) return;
  ensureTerminalSetup(ui, sessionId);
  syncTerminalOutputFlow(ui, sessionId);
  reacquireWebglIfStale(ui);
  const term = ui.term;
  if (!term) return;
  term.refresh(0, term.rows - 1);
  syncGridOnEngagementEdge(ui);
}

function setTerminalActiveViewer(ui: SessionUi | null | undefined, sessionId: string, isActive: boolean) {
  if (!ui) return;
  if (isActive) ensureTerminalSetup(ui, sessionId);
  ui._setActiveViewer?.(isActive);
}

export { ensureTerminalReady, ensureTerminalSetup, holdTerminalInputDuringWakeCheck, releaseHeldTerminalInput, setTerminalActiveViewer, syncGridOnEngagementEdge };
