import { isCompactionRestoreEvent } from '#shared/compaction-restore-events.ts';
import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { PlanDraftPush } from '#shared/contracts/plan-review.ts';
import type { ConversationApproval, UnseenOutcome } from '#shared/contracts/session.ts';
import { isConversationAgent } from '../conversation/conversation-core.ts';
import { createConversationFace } from '../conversation/conversation-face.ts';
import type { SessionState } from '#shared/states.ts';
import { KILLABLE_STATES, RESTARTABLE_STATES, STATES } from '#shared/states.ts';
import { playAlertSound } from '../alert-sound.ts';
import { hasSessionDocs, openDocEditor } from '../doc-editor.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, isMonitoringState } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { setHealthMonitorDebugMode } from '../health-monitor.ts';
import { refreshHoverTip } from '../hover-tip.ts';
import type { PlanResponse } from '../plan/plan-face.ts';
import { createPlanHash } from '../plan/plan-link.ts';
import { isApprovedReview, mergePlanChanged } from '../plan/plan-view-core.ts';
import type { PlanChangedMessage } from '../plan/plan-view-core.ts';
import { isCompletionWatchedByOperator } from '../session-actions-core.ts';
import { seedReviewMergeStatus, setReviewDiff, setReviewMergeStatus } from '../sidebar/review-sidebar.ts';
import { setSelectedId } from '../sidebar/selection.ts';
import { getSoundId, isSoundEnabled } from '../ui-prefs.ts';
import { openTraceForSession } from '../trace-store.ts';
import type { UsageSessionUsage } from '../usage/usage-store-core.ts';
import { sessionChipText, sessionChipTitle } from '../usage/usage-store-core.ts';
import { setRunningActivity } from './activity.ts';
import type { CardOptions } from './card-dom.ts';
import { buildCardDOM, closeDebugOverlay, isDebugModeEnabled, isRenameInProgress, makeTitleEditable, openDebugOverlay, paintGuardrailsToggle, paintTaskTitle, sendSessionAction, sessionActionStatus, setDebugMode, startInlineRename, startInlineTitleEdit } from './card-dom.ts';
import type { SessionUi } from './card-registry.ts';
import { container, findSessionUi, sessionIdOf, sessionUIs } from './card-registry.ts';
import { decidePlanHeaderAction, preferredBorrowedFace } from './face-core.ts';
import type { SessionCardFace } from './face-core.ts';
import { openConfirmDialog } from './modal.ts';
import { requestSessionRemoval } from '../session-actions.ts';
import { openRestartDialog } from './resume-dialog.ts';
import { openWorkspaceReposDialog } from './workspace-repos-dialog.ts';
import { reportHeaderError } from '../action-status.ts';
import { countAttentionByKind, needsAttention, sessionAttentionTier, titleAlertCount } from '../focus-view/attention-core.ts';
import { canShowDesktopNotification, closeSessionNotifications } from '../notifications.ts';

import {
  closeDataWs,
  ensureTerminalReady,
  ensureTerminalSetup,
  setTerminalCursorBlink,
  syncTerminalOutputFlow,
} from './terminal.ts';
import { releaseWebgl } from './webgl-pool.ts';
import { currentTerminalFontFamily } from '../mono-font.ts';
import { applyTerminalFontFamily } from '../mono-font-core.ts';
import { wirePopupMenuKeys } from '../menu.ts';


const asText = (value: unknown) => (value == null ? '' : String(value));

const isKillable = (state: string) => KILLABLE_STATES.includes(state as SessionState);
const isRestartable = (state: string) => RESTARTABLE_STATES.includes(state as SessionState);


let isConversationViewEnabled = false;

type PlanFaceModule = typeof import('../plan/plan-face.ts');
type PlanFaceController = ReturnType<PlanFaceModule['createPlanFace']>;
type PlanFaceDeps = Parameters<PlanFaceModule['createPlanFace']>[0];
type PlanFaceUpdate = Parameters<PlanFaceController['update']>[0];

let loadedPlanFaceModule: PlanFaceModule | null = null;
let planFaceModuleLoad: Promise<PlanFaceModule | null> | null = null;

function loadPlanFaceModule(): Promise<PlanFaceModule | null> {
  planFaceModuleLoad ??= import('../plan/plan-face.ts').then(
    (planFaceModule) => {
      loadedPlanFaceModule = planFaceModule;
      return planFaceModule;
    },
    () => {
      planFaceModuleLoad = null;
      return null;
    },
  );
  return planFaceModuleLoad;
}

function createDeferredPlanFace(deps: PlanFaceDeps): PlanFaceController {
  const placeholder = el('section', 'plan-face');
  placeholder.hidden = true;
  let face: PlanFaceController | null = null;
  let isLoading = false;
  let shownSessionId: string | null = null;
  const pendingUpdate: PlanFaceUpdate = {};
  const pendingDraftsByAgent = new Map<PlanDraftPush['agentId'], PlanDraftPush>();

  function adoptLoadedModule(planFaceModule: PlanFaceModule | null) {
    isLoading = false;
    if (deps.signal?.aborted) return;
    if (!planFaceModule) {
      deps.reportProblem('The plan view did not load. Open the plan again to retry.');
      if (shownSessionId !== null) deps.showTerminal();
      shownSessionId = null;
      return;
    }
    const loadedFace = planFaceModule.createPlanFace(deps);
    placeholder.replaceWith(loadedFace.el);
    loadedFace.update(pendingUpdate);
    for (const draft of pendingDraftsByAgent.values()) loadedFace.update({ draft });
    pendingDraftsByAgent.clear();
    face = loadedFace;
    if (shownSessionId !== null) loadedFace.show(shownSessionId);
  }

  return {
    get el() {
      return face?.el ?? placeholder;
    },
    show(id: string) {
      if (face) {
        face.show(id);
        return;
      }
      shownSessionId = id;
      if (isLoading) return;
      isLoading = true;
      void loadPlanFaceModule().then(adoptLoadedModule);
    },
    hide() {
      shownSessionId = null;
      face?.hide();
    },
    update(next: PlanFaceUpdate) {
      if (face) {
        face.update(next);
        return;
      }
      if (next.state) pendingUpdate.state = next.state;
      if (typeof next.isConnected === 'boolean') pendingUpdate.isConnected = next.isConnected;
      if (next.draft) pendingDraftsByAgent.set(next.draft.agentId, next.draft);
    },
  };
}

function canUseConversationView(ui: SessionUi) {
  return isConversationViewEnabled && isConversationAgent(ui.agent) && ui.card.dataset.ephemeral === undefined;
}

function isConversationFaceAvailable(ui: SessionUi) {
  return canUseConversationView(ui) && ui.isConversationViewOn && ui.isBorrowed;
}

function paintConversationViewItem(ui: SessionUi) {
  ui.btnConversationView.classList.toggle('visible', canUseConversationView(ui));
  ui.btnConversationView.setAttribute('aria-checked', String(ui.isConversationViewOn));
}

export function setConversationViewEnabled(isEnabled: boolean) {
  isConversationViewEnabled = isEnabled;
  for (const ui of sessionUIs.values()) {
    if (!isEnabled && ui.face === 'conversation') ui._showTerminalFace?.();
    updateButtonVisibility(ui);
  }
}

function showSessionConversationFace(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui || !isConversationFaceAvailable(ui)) return false;
  ui.face = 'conversation';
  ui.card.dataset.face = 'conversation';
  ui.termWrap.hidden = true;
  ui.planFace.hide();
  ui.conversationFace.show(sessionIdOf(sessionId));
  updateButtonVisibility(ui);
  syncTerminalOutputFlow(ui, sessionIdOf(sessionId));
  return true;
}

interface SessionConversationUpdate {
  hasConversationBridge: boolean;
  isConversationViewOn: boolean;
  conversationApproval: ConversationApproval | null;
}

export function setSessionConversation(sessionId: unknown, update: SessionConversationUpdate) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const wasConversationViewOn = ui.isConversationViewOn;
  ui.hasConversationBridge = update.hasConversationBridge;
  ui.conversationApproval = update.conversationApproval;
  ui.isConversationViewOn = update.isConversationViewOn;
  updateButtonVisibility(ui);
  ui.conversationFace.refresh();
  if (wasConversationViewOn === update.isConversationViewOn) return;
  if (update.isConversationViewOn) {
    showSessionConversationFace(sessionId);
    return;
  }
  if (ui.face === 'conversation') ui._showTerminalFace?.();
}

export function applyConversationTraceResponse(reply: ServerMessageOf<'session-trace-response'>) {
  const ui = findSessionUi(reply.id);
  return ui?.conversationFace.applyTraceResponse(reply) === true;
}

export function applyConversationTraceError(error: ServerMessageOf<'error'>) {
  findSessionUi(error.id)?.conversationFace.applyTraceError(error);
}

export function applyConversationTraceChanged(sessionId: unknown) {
  findSessionUi(sessionId)?.conversationFace.applyTraceChanged(sessionIdOf(sessionId));
}

function updateButtonVisibility(ui: SessionUi) {
  paintConversationViewItem(ui);
  const state = ui.currentState;
  ui.btnRestart.classList.toggle('visible', isKillable(state) || isRestartable(state) || state === STATES.DORMANT);
  ui.btnWorkspaceRepos.classList.toggle('visible', ui.card.dataset.workspace !== undefined);
  ui.btnTrace.classList.toggle('visible', isDebugModeEnabled());
  ui.btnPlan.classList.toggle('visible', decidePlanHeaderAction(ui) !== 'hidden');
  ui.btnRemove.classList.add('visible');
}

function closeSessionMenu(ui: SessionUi) {
  ui.sessionMenu.classList.remove('open');
  ui.btnSessionMenu.setAttribute('aria-expanded', 'false');
}

function wireCardEvents(ui: SessionUi, sessionId: string) {
  makeTitleEditable(ui.taskTitleEl, () => startInlineTitleEdit(ui, sessionId));
  ui.nameEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startInlineRename(ui, sessionId);
  });

  ui.nameEl.addEventListener('click', () => {
    if (isRenameInProgress(ui.nameEl)) return;
    setSelectedId(sessionId);
  });

  ui.nameEl.addEventListener('keydown', (event) => {
    if (event.target !== ui.nameEl) return;
    if (event.key !== 'F2' && event.key !== 'Enter') return;
    event.preventDefault();
    startInlineRename(ui, sessionId);
  });

  ui.btnRestart.addEventListener('click', () => {
    closeSessionMenu(ui);
    openRestartDialog(sessionId, { readState: () => ui.currentState, canListEarlier: ui.card.dataset.ephemeral === undefined });
  });

  ui.btnWorkspaceRepos.addEventListener('click', () => {
    closeSessionMenu(ui);
    openWorkspaceReposDialog(sessionId);
  });

  ui.btnTrace.addEventListener('click', () => {
    closeSessionMenu(ui);
    openTraceForSession(sessionId);
  });

  ui.btnDocs.addEventListener('click', () => {
    closeSessionMenu(ui);
    openDocEditor(sessionId);
  });

  ui.btnConversationView.addEventListener('click', () => {
    closeSessionMenu(ui);
    sendSessionAction(ui, { type: 'set-session-conversation-view', id: sessionId, isOn: !ui.isConversationViewOn });
  });

  ui.btnGuardrails.addEventListener('click', () => {
    if (ui.btnGuardrails.getAttribute('aria-disabled') === 'true') return;
    const sendGuardrails = (isOn: boolean) => () => { sendSessionAction(ui, { type: 'set-session-guardrails', id: sessionId, isOn }); };
    if (ui.card.dataset.guarded === undefined) {
      openConfirmDialog({
        title: 'Restore guardrails',
        message: 'This session restarts with guardrails on, interrupting any turn in progress.',
        confirmLabel: 'Restore guardrails',
        danger: false,
        onConfirm: sendGuardrails(true),
      });
      return;
    }
    openConfirmDialog({
      title: 'Release guardrails',
      message: 'This session restarts without guardrails, interrupting any turn in progress. It can then read, write and reach anything your account can, including credentials and Glimmervoid itself.',
      confirmLabel: 'Release guardrails',
      danger: true,
      onConfirm: sendGuardrails(false),
    });
  });

  ui.btnPlan.addEventListener('click', () => {
    const action = decidePlanHeaderAction(ui);
    if (action === 'hidden') return;
    if (action === 'face') { showSessionPlanFace(sessionId); return; }
    location.hash = createPlanHash(sessionId);
  });

  ui.btnRemove.addEventListener('click', () => {
    closeSessionMenu(ui);
    requestSessionRemoval(sessionId);
  });

  function openSessionMenu() {
    for (const [, other] of sessionUIs) {
      if (other !== ui) closeSessionMenu(other);
    }
    ui.sessionMenu.classList.add('open');
    ui.btnSessionMenu.setAttribute('aria-expanded', 'true');
  }

  ui.btnSessionMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    if (ui.sessionMenu.classList.contains('open')) {
      closeSessionMenu(ui);
      return;
    }
    openSessionMenu();
  });

  wirePopupMenuKeys({
    trigger: ui.btnSessionMenu,
    menu: ui.sessionMenu,
    menuItems: () => [...ui.sessionMenu.querySelectorAll<HTMLElement>('.popup-menu-item.visible')],
    isOpen: () => ui.sessionMenu.classList.contains('open'),
    open: openSessionMenu,
    close: () => closeSessionMenu(ui),
    signal: ui.abortController.signal,
  });

  document.addEventListener('click', (event) => {
    const clicked = event.target instanceof Node ? event.target : null;
    if (!ui.sessionMenu.contains(clicked) && clicked !== ui.btnSessionMenu) closeSessionMenu(ui);
  }, { signal: ui.abortController.signal });

  ui.btnDebug.addEventListener('click', (e) => {
    e.stopPropagation();
    openDebugOverlay(ui, sessionId);
  });

  document.addEventListener('click', (e) => {
    const clicked = e.target instanceof Node ? e.target : null;
    if (ui.debugOpen && !ui.card.contains(clicked)) {
      closeDebugOverlay(ui);
    }
  }, { signal: ui.abortController.signal });
}

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

  const terminalSettings = (settings || {}) as { cursorBlink?: boolean; debugMode?: boolean };
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

export function updateAttentionTitle() {
  const counts = countAttentionByKind([...sessionUIs.values()].map((ui) => ({ state: ui.currentState, unseenOutcome: ui.unseenOutcome })));
  const alertCount = titleAlertCount(counts);
  document.title = alertCount > 0 ? `(${alertCount}) Glimmervoid` : 'Glimmervoid';
}

export function createSessionCard(sessionId: unknown, sessionName: unknown, initialState: unknown, options: CardOptions = {}) {
  if (!container) return;
  const id = sessionIdOf(sessionId);
  const state = asText(initialState) || STATES.DORMANT;
  const dom = buildCardDOM(id, asText(sessionName), state, options);

  const isDormant = state === STATES.DORMANT;

  container.appendChild(dom.card);

  let sessionUi: SessionUi;
  function showTerminalFace() {
    sessionUi.face = 'terminal';
    sessionUi.card.dataset.face = 'terminal';
    sessionUi.termWrap.hidden = false;
    sessionUi.planFace.hide();
    sessionUi.conversationFace.hide();
    updateButtonVisibility(sessionUi);
    ensureTerminalReady(sessionUi, id);
  }
  function showConversationOrTerminalFace() {
    if (showSessionConversationFace(id)) return;
    showTerminalFace();
  }
  const abortController = new AbortController();
  const planFace = createDeferredPlanFace({
    signal: abortController.signal,
    requestPlan: (requestedId, agentId, revision) => sendControlMsg({ type: 'session-plan', id: requestedId, agentId, revision }),
    requestDraft: (requestedId, agentId) => sendControlMsg({ type: 'session-plan', id: requestedId, agentId, draft: true }),
    showTerminal: showConversationOrTerminalFace,
    sendDecision: (requestedId, request) => sendControlMsg({ type: 'plan-decision', id: requestedId, ...request }),
    reportProblem: (message: string) => reportSessionProblem(id, message),
  });
  const conversationFace = createConversationFace({
    signal: abortController.signal,
    sendControl: (message) => sendControlMsg(message),
    showTerminal: showTerminalFace,
  });
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

    stateSince: typeof options.stateSince === 'number' && Number.isFinite(options.stateSince) ? options.stateSince : Date.now(),
    sessionMenu: dom.sessionMenu,
    termWrap: dom.termWrap,
    btnDebug: dom.btnDebug,
    btnRestart: dom.btnRestart,
    btnSessionMenu: dom.btnSessionMenu,
    btnWorkspaceRepos: dom.btnWorkspaceRepos,
    btnConversationView: dom.btnConversationView,
    btnGuardrails: dom.btnGuardrails,
    btnTrace: dom.btnTrace,
    btnPlan: dom.btnPlan,
    btnDocs: dom.btnDocs,
    btnRemove: dom.btnRemove,
    debugOverlay: null,
    debugOpen: false,
    abortController,
    currentState: state,
    face: 'terminal',
    isBorrowed: false,
    hasPlan: false,
    pendingPromptKind: null,
    planReviewState: { reviews: [] },
    planFace,
    conversationFace,
    conversationApproval: null,
    hasConversationBridge: false,
    isConversationViewOn: false,
  };
  sessionUi._ensureTerminalReady = () => ensureTerminalReady(sessionUi, id);
  sessionUi._showTerminalFace = showTerminalFace;
  sessionUi._showPreferredFace = () => {
    if (preferredFaceFor(sessionUi) === 'plan') {
      showSessionPlanFace(id);
      return;
    }
    if (showSessionConversationFace(id)) return;
    showTerminalFace();
  };
  sessionUi._setBorrowed = (isBorrowed) => {
    sessionUi.isBorrowed = isBorrowed;
    updateButtonVisibility(sessionUi);
  };
  dom.card.append(planFace.el, conversationFace.el);
  sessionUIs.set(id, sessionUi);

  wireCardEvents(sessionUi, id);
  updateButtonVisibility(sessionUi);
  sessionUi.btnDocs.classList.toggle('visible', hasSessionDocs(id));

  if (state === STATES.RUNNING) setRunningActivity(sessionUi, true);

  if (!isDormant) {
    ensureTerminalSetup(sessionUi, id);
  }

  updateAttentionTitle();
  return sessionUi;
}

type SessionPlanChangedMessage = PlanChangedMessage;
type SessionPlanDraftMessage = PlanDraftPush;

function preferredFaceFor(ui: SessionUi): SessionCardFace {
  const hasOpenReview = ui.planReviewState.reviews.some((review) => review.state === 'open');
  const hasApprovedReview = ui.planReviewState.reviews.some(isApprovedReview);
  return preferredBorrowedFace({ hasPlan: ui.hasPlan, pendingPromptKind: ui.pendingPromptKind, hasOpenReview, hasApprovedReview });
}

function showPlanFaceWhenPreferred(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui?.isBorrowed) return false;
  if (preferredFaceFor(ui) !== 'plan') return false;
  return showSessionPlanFace(sessionId);
}

export function showSessionPlanFace(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui?.isBorrowed || !ui.hasPlan) return false;
  ui.face = 'plan';
  ui.card.dataset.face = 'plan';
  ui.termWrap.hidden = true;
  ui.conversationFace.hide();
  ui.planFace.show(sessionIdOf(sessionId));
  updateButtonVisibility(ui);
  syncTerminalOutputFlow(ui, sessionIdOf(sessionId));
  return true;
}

export function setSessionHasPlan(sessionId: unknown, hasPlan: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.hasPlan = hasPlan === true;
  updateButtonVisibility(ui);
  showPlanFaceWhenPreferred(sessionId);
}

export function applySessionPlanChanged(message: SessionPlanChangedMessage) {
  const ui = findSessionUi(message.id);
  if (!ui) return;
  ui.planReviewState = mergePlanChanged(ui.planReviewState, message);
  ui.hasPlan = message.hasPlan;
  ui.planFace.update({ state: ui.planReviewState });
  updateButtonVisibility(ui);
  showPlanFaceWhenPreferred(message.id);
}

export function applySessionPlanDraft(notice: SessionPlanDraftMessage) {
  const ui = findSessionUi(notice.id);
  if (!ui) return;
  ui.planFace.update({ draft: notice });
}

export function applySessionPlanResponse(response: PlanResponse) {
  const ui = findSessionUi(response.id);
  if (!ui) return;
  ui.planReviewState = { reviews: response.reviews };
  ui.hasPlan = true;
  ui.planFace.update({ response });
  updateButtonVisibility(ui);
}

export function applySessionPlanError(message: ServerMessage): boolean {
  if (message.type !== 'error' && message.type !== 'session-error') return false;
  if (message.scope !== 'plan' && message.scope !== 'plan-decision') return false;
  const ui = findSessionUi(message.id);
  if (!ui) return false;
  if (message.scope === 'plan') {
    ui.planFace.update({ requestFailed: true });
    return true;
  }
  ui.planFace.update({ decisionRefused: true, refusalText: message.message });
  return true;
}

export function applyPlanConnectionState(isConnected: boolean) {
  for (const [, ui] of sessionUIs) ui.planFace.update({ isConnected });
}

export function setSessionEffectiveBase(sessionId: unknown, base: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.effectiveBase = typeof base === 'string' ? base : undefined;
}

export function setSessionAgent(sessionId: unknown, agent: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.agent = typeof agent === 'string' ? agent : null;
  updateButtonVisibility(ui);
}

export function setSessionWorktree(sessionId: unknown, worktree: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  if (worktree) { ui.card.dataset.worktree = ''; return; }
  delete ui.card.dataset.worktree;
}

export function setSessionGuarded(sessionId: unknown, isGuarded: boolean, isGuardrailsReleased: boolean) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  toggleCardFlag(ui.card, 'guarded', isGuarded);
  toggleCardFlag(ui.card, 'guardrailsReleased', isGuardrailsReleased);
  paintGuardrailsToggle(ui.btnGuardrails, ui.card);
}

function toggleCardFlag(card: HTMLElement, datasetKey: string, isOn: boolean) {
  if (isOn) { card.dataset[datasetKey] = ''; return; }
  delete card.dataset[datasetKey];
}

export function setSessionAgents(sessionId: unknown, activeAgents: unknown, awaitingBackgroundTasks: unknown = false) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const n = Math.max(0, Number(activeAgents) || 0);
  ui.activeAgents = n;
  ui.awaitingBackgroundTasks = isMonitoringState(ui.currentState, awaitingBackgroundTasks === true);
  ui.card.toggleAttribute('data-monitoring', ui.awaitingBackgroundTasks);
}

export function setSessionUsage(sessionId: unknown, usage: UsageSessionUsage | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const usageText = sessionChipText(usage);
  const usageBadge = ui.card.querySelector<HTMLElement>('.usage-badge');
  if (!usageText) {
    delete ui.card.dataset.usage;
    if (!usageBadge) return;
    delete usageBadge.dataset.tipLabel;
    refreshHoverTip(usageBadge);
    return;
  }
  ui.card.dataset.usage = '';
  if (!usageBadge) return;
  usageBadge.dataset.tipLabel = usageText;
  usageBadge.dataset.tipDetail = sessionChipTitle(usage);
  refreshHoverTip(usageBadge);
}

export function setSessionPrompt(sessionId: unknown, kind: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.pendingPromptKind = typeof kind === 'string' ? kind : null;
  ui.conversationFace.refresh();
  if (showPlanFaceWhenPreferred(sessionId)) return;
  const hasPendingPrompt = typeof kind === 'string' && kind !== '';
  if (!hasPendingPrompt && ui.face === 'terminal') showSessionConversationFace(sessionId);
}

export function setSessionUnseenOutcome(sessionId: unknown, unseenOutcome: UnseenOutcome | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.unseenOutcome = unseenOutcome ?? null;
}

function applyMergeDataset(card: HTMLElement, ms: string) {
  if (ms === 'pending-review' || ms === 'parked' || ms === 'merging') { card.dataset.merge = ms; return; }
  delete card.dataset.merge;
}

export function setSessionMergeStatus(sessionId: unknown, mergeStatus: unknown, reason: unknown = null) {
  const ui = findSessionUi(sessionId);
  const ms = asText(mergeStatus) || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  setReviewMergeStatus(sessionIdOf(sessionId), ms, asText(reason) || null);
}

export function seedSessionMergeStatus(sessionId: unknown, mergeStatus: unknown, reason: unknown = null) {
  const ui = findSessionUi(sessionId);
  const ms = asText(mergeStatus) || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  seedReviewMergeStatus(sessionIdOf(sessionId), ms, asText(reason) || null);
}

export function setSessionDiff(sessionId: unknown, payload: Pick<ServerMessageOf<'session-diff'>, 'committed' | 'uncommitted' | 'hasCommits'> | null) {
  setReviewDiff(sessionIdOf(sessionId), payload);
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
  sessionUIs.delete(sessionIdOf(sessionId));
  loadedPlanFaceModule?.dropPlanBodyCache(sessionIdOf(sessionId));

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

export function reportSessionProblem(sessionId: unknown, message: string) {
  const ui = findSessionUi(sessionId);
  if (!ui) { reportHeaderError({ source: 'Session', sessionId: typeof sessionId === 'string' ? sessionId : undefined, message }); return; }
  sessionActionStatus(ui).show('error', message);
}

export function setSessionFailureReason(sessionId: unknown, failureReason: string | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const existingLine = ui.card.querySelector<HTMLElement>(':scope > .session-failure-reason');
  const shouldShow = ui.currentState === STATES.FAILED && !!failureReason;
  if (!shouldShow) {
    existingLine?.remove();
    return;
  }
  const reasonLine = existingLine ?? el('p', 'session-failure-reason');
  reasonLine.setAttribute('role', 'status');
  reasonLine.textContent = failureReason;
  if (!existingLine) ui.termWrap.before(reasonLine);
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
  if (!ui || !needsAttention({ state: ui.currentState, unseenOutcome: ui.unseenOutcome })) return;
  if (document.visibilityState !== 'visible') return;
  if (!isPhoneLayout() && !document.hasFocus()) return;
  sendControlMsg({ type: 'dismiss', id: sessionId, expectedState: ui.currentState });
}

function isCompletionWatchedAt(ui: SessionUi, previousState: string, nextState: string) {
  const activeElement = document.activeElement;
  return isCompletionWatchedByOperator({
    previousState,
    nextState,
    isPhoneLayout: isPhoneLayout(),
    isDocumentVisible: document.visibilityState === 'visible',
    isDocumentFocused: document.hasFocus(),
    isActiveViewer: ui._isActiveViewer?.() === true,
    hasFocusInsideTerminal: activeElement instanceof Node && ui.termWrap.contains(activeElement),
  });
}

function shouldPlayAlertChime() {
  return isSoundEnabled() && !canShowDesktopNotification();
}

export function applyState(sessionId: unknown, nextState: unknown, stateSince: unknown, event = "") {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  const state = asText(nextState);
  const prevState = ui.currentState;
  ui.currentState = state;
  if (state !== STATES.RUNNING) ui.awaitingBackgroundTasks = false;
  ui.conversationFace.refresh();

  if (state !== prevState) {
    ui.stateSince = typeof stateSince === 'number' && Number.isFinite(stateSince) ? stateSince : Date.now();
    setRunningActivity(ui, state === STATES.RUNNING);
  }

  if (prevState === STATES.DORMANT && state !== STATES.DORMANT) {
    ensureTerminalSetup(ui, sessionIdOf(sessionId));
  }

  if (sessionAttentionTier({ state }) === 'resting') closeSessionNotifications(sessionIdOf(sessionId));

  ui.card.dataset.state = state;
  ui.card.toggleAttribute('data-monitoring', isMonitoringState(state, ui.awaitingBackgroundTasks));

  updateButtonVisibility(ui);

  if ((state === STATES.WAITING && prevState !== STATES.WAITING)
      || (state === STATES.COMPLETE && prevState !== STATES.COMPLETE)) {
    if (!isCompactionRestoreEvent(event) && shouldPlayAlertChime()) playAlertSound(getSoundId());
  }

  if (isCompletionWatchedAt(ui, prevState, state)) sendControlMsg({ type: 'dismiss', id: sessionIdOf(sessionId), expectedState: STATES.COMPLETE });

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
    if (shouldPlayAlertChime()) playAlertSound(getSoundId());
  }

  if (state === STATES.DONE || state === STATES.FAILED) {
    _handleEndedTransition(ui, wasActive, state);
  }

  if (state === STATES.INITIALIZING) {
    _handleRestartTransition(ui, prevState);
  }

  updateAttentionTitle();
}
