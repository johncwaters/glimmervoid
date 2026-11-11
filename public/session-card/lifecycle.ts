import { paintSecretRequest } from './secret-request-face.ts';
import type { UnseenOutcome } from '#shared/contracts/session.ts';
import { STATES } from '#shared/states.ts';
import { hasSessionDocs } from '../doc-editor/doc-editor.ts';
import { sendControlMsg } from '../control-ws.ts';
import { isMonitoringState } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { setHealthMonitorDebugMode } from '../health-monitor.ts';
import { seedMergeStatus, setMergeStatus } from '../review/review-store.ts';
import { setRunningActivity } from './activity.ts';
import type { CardOptions } from './card-dom.ts';
import { buildCardDOM } from './card-dom.ts';
import { paintTaskTitle } from './card-titles.ts';
import { closeDebugOverlay, setDebugMode } from './card-debug.ts';
import type { SessionUi } from './card-registry.ts';
import { syncLiveSession } from './session-tick.ts';
import { attentionTally, container, findSessionUi, sessionIdOf, sessionUIs } from './card-registry.ts';
import { needsAttention, sessionAttentionTier, tallyAdd, tallyRemove, titleAlertCount } from '../focus-view/attention-core.ts';
import { closeSessionNotifications } from '../notifications.ts';
import { ensureTerminalReady, ensureTerminalSetup } from './terminal.ts';
import { closeDataWs } from './terminal-data-socket.ts';
import { setLinkPreviewsEnabled } from './terminal-link-popup.ts';
import { setTerminalCursorBlink } from './terminal-setup.ts';
import { releaseWebgl } from './webgl-pool.ts';
import { currentTerminalFontFamily } from '../mono-font.ts';
import { applyTerminalFontFamily } from '../mono-font-core.ts';
import { openManagerDecisionLine } from './card-problems.ts';
import { updateButtonVisibility } from './card-faces.ts';
import { wireCardEvents } from './card-events.ts';
import { cancelWatchedCompletionDismiss, holdThenDismissWatchedCompletion, isCompletionWatchedAt } from './watched-completion.ts';
import { paintAgentMark } from './agent-mark.ts';
import { clock } from '#shared/clock.ts';

const asText = (value: unknown) => (value == null ? '' : String(value));

export function setSessionTaskTitle(id: unknown, title: unknown, isCustom: unknown) {
  const ui = findSessionUi(id);
  if (!ui) return;
  ui.taskTitle = typeof title === 'string' ? title : null;
  ui.taskTitleIsCustom = isCustom === true;
  for (const target of [ui.taskTitleEl, ui.titleTargetEl]) {
    if (!target) continue;
    paintTaskTitle(target, ui.taskTitle);
  }
}

export function hasSession(id: unknown) {
  return typeof id === 'string' && sessionUIs.has(id);
}

export function getSessionCount() {
  return sessionUIs.size;
}

export function applyTerminalSettings(settings: unknown) {

  const terminalSettings = (settings || {}) as { cursorBlink?: boolean; debugMode?: boolean; linkPreviews?: boolean };
  if (terminalSettings.linkPreviews != null) setLinkPreviewsEnabled(terminalSettings.linkPreviews);
  if (terminalSettings.cursorBlink != null) setTerminalCursorBlink(terminalSettings.cursorBlink);
  if (terminalSettings.debugMode != null) {
    setDebugMode(terminalSettings.debugMode);
    setHealthMonitorDebugMode(terminalSettings.debugMode);
  }
  for (const [, ui] of sessionUIs) {
    if (!ui.term) continue;
    if (terminalSettings.cursorBlink != null) ui.term.options.cursorBlink = terminalSettings.cursorBlink;
  }
}

export function refreshTerminalFonts() {
  applyTerminalFontFamily(sessionUIs.values(), currentTerminalFontFamily());
}

function tallyRowOf(ui: SessionUi) {
  return { state: ui.currentState, unseenOutcome: ui.unseenOutcome, ownerId: ui.ownerId };
}

export function updateAttentionTitle() {
  const alertCount = titleAlertCount(attentionTally.counts);
  const title = alertCount > 0 ? `(${alertCount}) Glimmervoid` : 'Glimmervoid';
  if (document.title !== title) document.title = title;
}

export function createSessionCard(sessionId: unknown, sessionName: unknown, initialState: unknown, options: CardOptions = {}) {
  if (!container) return;
  const id = sessionIdOf(sessionId);
  const state = asText(initialState) || STATES.DORMANT;
  const dom = buildCardDOM(id, asText(sessionName), state, options);

  const isDormant = state === STATES.DORMANT;

  container.appendChild(dom.card);

  let sessionUi: SessionUi;
  const abortController = new AbortController();
  sessionUi = {
    term: null,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    webglAttachedWithoutLayout: false,
    dataWs: null,
    card: dom.card,
    nameEl: dom.nameEl,
    taskTitleEl: dom.taskTitleEl,
    taskTitle: options.taskTitle ?? null,
    taskTitleIsCustom: options.taskTitleIsCustom ?? false,

    path: asText(options.path),
    ownerId: options.ownerId ?? null,

    stateSince: typeof options.stateSince === 'number' && Number.isFinite(options.stateSince) ? options.stateSince : clock.nowMs(),
    sessionMenu: dom.sessionMenu,
    termWrap: dom.termWrap,
    btnDebug: dom.btnDebug,
    btnRename: dom.btnRename,
    btnRestart: dom.btnRestart,
    btnSessionMenu: dom.btnSessionMenu,
    btnWorkspaceRepos: dom.btnWorkspaceRepos,
    tags: dom.tags,
    btnTrace: dom.btnTrace,
    btnDocs: dom.btnDocs,
    btnRemove: dom.btnRemove,
    debugOverlay: null,
    debugOpen: false,
    abortController,
    currentState: state,
    isBorrowed: false,
    pendingPromptKind: null,
  };
  sessionUi._ensureTerminalReady = () => ensureTerminalReady(sessionUi, id);
  sessionUi._setBorrowed = (isBorrowed) => {
    sessionUi.isBorrowed = isBorrowed;
    dom.card.toggleAttribute('data-borrowed', isBorrowed);
    updateButtonVisibility(sessionUi);
  };
  const replacedUi = sessionUIs.get(id);
  if (replacedUi) tallyRemove(attentionTally, tallyRowOf(replacedUi));
  sessionUIs.set(id, sessionUi);
  tallyAdd(attentionTally, tallyRowOf(sessionUi));
  syncLiveSession(id, sessionUi);

  wireCardEvents(sessionUi, id);
  updateButtonVisibility(sessionUi);
  sessionUi.btnDocs.hidden = !hasSessionDocs(id);
  paintSecretRequest(id);

  if (state === STATES.RUNNING) setRunningActivity(sessionUi, true);

  if (!isDormant) {
    ensureTerminalSetup(sessionUi, id);
  }

  updateAttentionTitle();
  return sessionUi;
}

export function setSessionAgent(sessionId: unknown, agent: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.agent = typeof agent === 'string' ? agent : null;
  const agentMarkEl = ui.card.querySelector<HTMLElement>('.session-agent-mark');
  if (agentMarkEl) paintAgentMark(agentMarkEl, ui.agent);
  updateButtonVisibility(ui);
}

export function setSessionWorktree(sessionId: unknown, worktree: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  if (worktree) { ui.card.dataset.worktree = ''; return; }
  delete ui.card.dataset.worktree;
}

export function setSessionAgents(sessionId: unknown, activeAgents: unknown, awaitingBackgroundTasks: unknown = false) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const n = Math.max(0, Number(activeAgents) || 0);
  ui.activeAgents = n;
  ui.awaitingBackgroundTasks = isMonitoringState(ui.currentState, awaitingBackgroundTasks === true);
  ui.card.toggleAttribute('data-monitoring', ui.awaitingBackgroundTasks);
}

export function setSessionPrompt(sessionId: unknown, kind: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.pendingPromptKind = typeof kind === 'string' ? kind : null;
}

export function setSessionUnseenOutcome(sessionId: unknown, unseenOutcome: UnseenOutcome | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  tallyRemove(attentionTally, tallyRowOf(ui));
  ui.unseenOutcome = unseenOutcome ?? null;
  tallyAdd(attentionTally, tallyRowOf(ui));
}

function applyMergeDataset(card: HTMLElement, ms: string) {
  if (ms === 'pending-review' || ms === 'parked' || ms === 'merging') { card.dataset.merge = ms; return; }
  delete card.dataset.merge;
}

export function setSessionMergeStatus(sessionId: unknown, mergeStatus: unknown, reason: unknown = null) {
  const ui = findSessionUi(sessionId);
  const ms = asText(mergeStatus) || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  setMergeStatus(sessionIdOf(sessionId), ms, asText(reason) || null);
}

export function seedSessionMergeStatus(sessionId: unknown, mergeStatus: unknown, reason: unknown = null) {
  const ui = findSessionUi(sessionId);
  const ms = asText(mergeStatus) || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  seedMergeStatus(sessionIdOf(sessionId), ms, asText(reason) || null);
}

export function renameSessionCard(sessionId: unknown, newName: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  const name = asText(newName);
  ui.card.dataset.session = name;
  ui.nameEl.textContent = name;
}

export function removeSessionCard(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  closeDebugOverlay(ui);
  tallyRemove(attentionTally, tallyRowOf(ui));
  sessionUIs.delete(sessionIdOf(sessionId));
  syncLiveSession(sessionIdOf(sessionId), undefined);

  if (ui.resizeObserver) ui.resizeObserver.disconnect();
  if (ui.abortController) ui.abortController.abort();
  closeDataWs(ui, sessionIdOf(sessionId));
  releaseWebgl(ui);
  if (ui.term) ui.term.dispose();

  ui.term = null;
  ui.fitAddon = null;
  if (ui.card) ui.card.remove();
  updateAttentionTitle();
}

function _handleEndedTransition(ui: SessionUi, wasActive: boolean, state: string) {
  if (!wasActive || !ui.term) return;
  const label = state === STATES.DONE ? 'Session complete' : 'Session failed';
  const color = state === STATES.DONE ? '\x1b[34m' : '\x1b[31m';
  ui.term.write(`\r\n\r\n\x1b[2m${color}  ${label}\x1b[0m\r\n\r\n\x1b[2m  Open the session actions menu and choose Restart to start a new session.\x1b[0m\r\n`);
}

function _handleRestartTransition(ui: SessionUi, prevState: string) {
  if (!ui.term) return;
  if (prevState === STATES.DONE || prevState === STATES.FAILED) {
    ui.term.clear();
    ui.term.reset();
  }
}

export function markSessionSeen(sessionId: string) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  if (document.visibilityState !== 'visible') return;
  if (!isPhoneLayout() && !document.hasFocus()) return;
  openManagerDecisionLine(sessionId);
  if (!needsAttention({ state: ui.currentState, unseenOutcome: ui.unseenOutcome })) return;
  sendControlMsg({ type: 'dismiss', id: sessionId, expectedState: ui.currentState });
}

export function applyState(sessionId: unknown, nextState: unknown, stateSince: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  const state = asText(nextState);
  const prevState = ui.currentState;
  tallyRemove(attentionTally, tallyRowOf(ui));
  ui.currentState = state;
  tallyAdd(attentionTally, tallyRowOf(ui));
  syncLiveSession(sessionIdOf(sessionId), ui);
  if (state !== STATES.RUNNING) ui.awaitingBackgroundTasks = false;

  if (state !== prevState) {
    cancelWatchedCompletionDismiss(ui);
    ui.stateSince = typeof stateSince === 'number' && Number.isFinite(stateSince) ? stateSince : clock.nowMs();
    setRunningActivity(ui, state === STATES.RUNNING);
  }

  if (prevState === STATES.DORMANT && state !== STATES.DORMANT) {
    ensureTerminalSetup(ui, sessionIdOf(sessionId));
  }

  if (sessionAttentionTier({ state }) === 'resting') closeSessionNotifications(sessionIdOf(sessionId));

  ui.card.dataset.state = state;
  ui.card.toggleAttribute('data-monitoring', isMonitoringState(state, ui.awaitingBackgroundTasks));

  updateButtonVisibility(ui);

  if (isCompletionWatchedAt(ui, prevState, state)) holdThenDismissWatchedCompletion(ui, sessionIdOf(sessionId));

  const isEnding = state === STATES.DONE || state === STATES.FAILED;
  const wasActive = prevState !== STATES.DONE && prevState !== STATES.FAILED && prevState !== STATES.INITIALIZING;
  if (isEnding && wasActive) {
    ui.card.classList.remove('completion-flash');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ui.card.classList.add('completion-flash');
        ui.card.addEventListener('animationend', () => ui.card.classList.remove('completion-flash'), { once: true });
      });
    });
  }

  if (state === STATES.DONE || state === STATES.FAILED) {
    _handleEndedTransition(ui, wasActive, state);
  }

  if (state === STATES.INITIALIZING) {
    _handleRestartTransition(ui, prevState);
  }

  updateAttentionTitle();
}
