import '@xterm/xterm/css/xterm.css';
import './tailwind.css';
import { clearQueueOrigin, mountNowPeek, openNextQueuePanel, openSelectedPanelTerminal, refreshCalmView, refreshNowPeek, applyCalmSessionDiff, applyCalmSessionDiffError, applyCalmTraceResponse, applyCalmError } from './calm/calm-view.ts';

import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { shouldShowServerAction } from '#shared/client-trust.ts';
import { createCoalescedTimer } from '#shared/coalesce-timer.ts';
import { STATES } from '#shared/states.ts';
import { getBorrowedCardId } from './card-host.ts';
import { createClientErrorReporter } from './client-error-core.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from './flying-animal-preview.ts';
import { checkControlLiveness, connectControl, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.ts';
import { createAddSessionDialog } from './dialogs.ts';
import { observeHeaderHeight, queryTag, writeClipboardText } from './dom-helpers.ts';
import { routeExternalAnchorsThroughHost } from './external-link.ts';
import type { FeatureSurfaceSettings } from './feature-surfaces-core.ts';
import { refreshFavicon } from './favicon.ts';
import { centerSessionQuietly, focusAdjacentInRail, focusNextAttention, focusNthInRail, getFocusedSessionId, getFocusHeaderAccessorySlot, isFocusActive, openPlanInFocus, refreshFocusRoster, restoreFocusedSession, setFocusMergeStatus, setFocusRailShown } from './focus-view/focus-view.ts';
import { initFormFactor, isPhoneLayout, onLayoutChange } from './form-factor.ts';
import type { HealthSnapshot } from './health-monitor.ts';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.ts';
import { applyIngestActivity, applyIngestSnapshot, applyVisionsComments, applyVisionsFindings, applyVisionsFix, applyVisionsHand, applyVisionsIntent, applyVisionsSettings, applyVisionsSnapshot, setVisionsProjectNames } from './visions-panel.ts';
import { applyDeleteHookResult, applyHooksReport, applySaveHookResult, setHooksRequestSender } from './hooks-panel.ts';
import { initNotifications, showDesktopNotification } from './notifications.ts';
import { phonePanelsFromDesktopViews } from './phone/phone-panels-core.ts';
import { activatePhoneShell, deactivatePhoneShell, getPhoneSessionId, isPhoneShellActive, mountPhoneShell, refreshPhoneBoard, setPhoneCalmAvailable, setPhoneScreenAttention, setPhoneScreenAvailable, showPhonePlan, showPhoneScreen } from './phone/phone-shell.ts';
import { noteKnownProjectPath } from './project-registry.ts';
import { applyTeamReviewActionResult, applyTeamReviewStatus } from './team-review-panel.ts';
import { applyMyPrMergeResult, applyMyPrsStatus } from './my-prs-panel.ts';
import { mountCelebrationTray } from './merge-celebration.ts';
import { mountMuteButton } from './mute-button.ts';
import { applyFactoryControlResult, applyFactoryQueueIntentResult, applyFactoryState, setFactoryRequestSender } from './factory/factory-view.ts';
import { applyBenchmarkActionResult, applyBenchmarkStatus, setBenchmarkRequestSender } from './benchmark-panel.ts';
import { applyIssueDetailResult, refreshIssuesSessionState, applyIssuesStatus, applyOpenIssueSessionResult, setIssuesRequestSender } from './issues-panel.ts';

import { UPDATES_ACTIONS_SETTING_ID, UPDATES_SECTION_ID, updateBannerText } from './radar-core.ts';
import { applyInvestigationActivity, applyInvestigationFinished, applyPosthogStatus } from './radar-panel.ts';
import { handleDebugStateRefresh, handleDebugStateResponse, setSessionSaneYolo } from './session-card/card-dom.ts';
import { findSessionUi, sessionName, sessionUIs } from './session-card/card-registry.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { buildSessionCardOptions } from './session-card/card-options-core.ts';
import { applyPlanConnectionState, applySessionPlanChanged, applySessionPlanDraft, applySessionPlanError, applySessionPlanResponse, applyState, applyTerminalSettings, createSessionCard, refreshTerminalFonts, getSessionCount, getSessionIds, hasSession, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setSessionTaskTitle, setSessionAgent, setSessionAgents, setSessionDiff, setSessionEffectiveBase, setSessionEndedTurn, setSessionHasPlan, setSessionMergeStatus, setSessionPostTurn, setSessionPrompt, setSessionUsage, setSessionWakeup, setSessionWorktree, updateAggregateStatus } from './session-card/lifecycle.ts';
import { resolvePlanTarget } from './plan/plan-link.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { countConnectingTerminals, holdTerminalInputDuringWakeCheck, onTerminalLinkChange, reconnectDataWs, releaseHeldTerminalInput, syncGridOnEngagementEdge } from './session-card/terminal.ts';
import { showErrorToast } from './session-card/toast.ts';
import { rebuildWebglGlyphAtlases } from './session-card/webgl-pool.ts';
import { activateSettingsSection, applySettingsBroadcast, applySettingsProjects, applySettingsUpdateProgress, applySettingsUpdateStatus, clearSettingsUpdateRequest, refreshSettingsStatus, resolveSettingsTarget } from './settings-panel.ts';
import { forgetReviewSession, mergeSelectedSession, mountReviewSidebar, notifyWorktreeChanged, refreshReviewSidebar, resolveSelectedSession, resyncSelectedSession, setReviewBranchSync, setReviewDiffError, setSessionChangeMap } from './sidebar/review-sidebar.ts';
import { decideReloadOnBuild } from './server-build-core.ts';
import { createSettingsLink } from './settings-link.ts';
import { currentShortcutContext, SHORTCUT_PLATFORM, setShortcutContextProvider } from './shortcuts.ts';
import { resolveDashboardShortcut } from './shortcuts-core.ts';
import type { ResolvedDashboardShortcut } from './shortcuts-core.ts';
import { applyFlyingAnimals } from './flying-animals.ts';
import { applyCompactStatusLabels, applySessionUsageChips, applyTheme } from './theme.ts';
import { applyTraceChanged, applyTraceError, applyTraceResponse, setTraceNavigate, setTraceRequestSender, setTraceSessions } from './trace-panel.ts';
import { shouldShowTelemetryNotice } from './telemetry-notice-core.ts';
import { getActiveView as getSavedActiveView, getDismissedUpdate, getThemeId, isCompactStatusLabels, isFlyingAnimalsEnabled, isSessionUsageChips, isTelemetryNoticeDismissed, setActiveView, setDismissedUpdate, setTelemetryNoticeDismissed } from './ui-prefs.ts';
import { getActiveView, uiState } from './ui-state-core.ts';
import { updateBannerMode } from './updates-view-core.ts';
import { decideAppReveal, MAX_REVEAL_WAIT_MS } from './app-reveal-core.ts';
import { whenBundledMonoFontLoads } from './mono-font.ts';
import { applyPlanLimits, applyUsageReport, applyUsageSessions, setUsageRequestSender } from './usage-panel.ts';
import { createDashboardViews } from './view-registry.ts';
import type { DashboardView } from './view-registry.ts';
import { refreshViewOnReason, refreshVisibleViews, viewAvailabilityFromSettings, viewsInTabOrder } from './view-registry-core.ts';
import type { ViewRefreshReason } from './view-registry-core.ts';

applyTheme(getThemeId());
applyCompactStatusLabels(isCompactStatusLabels());
applySessionUsageChips(isSessionUsageChips());
applyFlyingAnimals(isFlyingAnimalsEnabled());

initFormFactor();
routeExternalAnchorsThroughHost(document);

const connectionEl = queryTag(document, '#connection-status', 'span');
const connectionLabel = queryTag(connectionEl, '.connection-label', 'span');

const loadingScreen = queryTag(document, '#loading-screen', 'div');
const loadingStatus = queryTag(document, '#loading-status', 'div');
const shutdownScreen = queryTag(document, '#shutdown-screen', 'div');
const shutdownStatus = queryTag(document, '#shutdown-status', 'div');
let appRevealed = false;
let controlConnectedAt: number | null = null;
let hasReceivedSnapshot = false;

function showLoadingAnimal() {
  const animal = pickRandomIncludedAnimal();
  const spinner = loadingScreen.querySelector('.loading-spinner');
  if (!animal || !spinner) return;
  spinner.replaceWith(buildFlyingAnimalPreview(animal, 'loading-animal'));
}

showLoadingAnimal();

function revealAppWhenTerminalsLive() {
  if (appRevealed || controlConnectedAt === null) return;
  const decision = decideAppReveal({
    hasSnapshot: hasReceivedSnapshot,
    connectingTerminalCount: countConnectingTerminals(),
    msSinceConnected: performance.now() - controlConnectedAt,
  });
  if (decision === 'reveal') revealApp();
}

onTerminalLinkChange(revealAppWhenTerminalsLive);

function revealApp() {
  if (appRevealed) return;
  appRevealed = true;
  loadingScreen.classList.add('fade-out');

  const removeLoading = () => loadingScreen.remove();
  loadingScreen.addEventListener('transitionend', removeLoading, { once: true });
  setTimeout(removeLoading, 1000);
}

type SessionUsageChip = Pick<ServerMessageOf<'usage-sessions'>['sessions'][number], 'tokens' | 'costUSD' | 'officialCostUSD'>;

function showServerGoingDown(connectionText: string, overlayText: string) {
  connectionEl.dataset.state = 'shutdown';
  connectionLabel.textContent = connectionText;
  connectionEl.title = connectionText;
  btnPower.disabled = true;
  shutdownStatus.textContent = overlayText;
  shutdownScreen.classList.add('active');
}

const RECOVERING_CONNECTION_STATES = new Set(['disconnected', 'connecting']);

function renderConnectionHeader(state: string, label: string, isReconnect: boolean) {
  connectionEl.dataset.state = state;
  connectionEl.toggleAttribute('data-reconnected', isReconnect);
  connectionLabel.textContent = label;
  connectionEl.title = label;
}

function showConnectionState(state: string, label: string) {
  const isReconnect = state === 'connected' && RECOVERING_CONNECTION_STATES.has(connectionEl.dataset.state ?? '');
  renderConnectionHeader(state, label, isReconnect);
}

function showLivenessProbeState(state: string, label: string) {
  if (connectionEl.dataset.state === 'shutdown') return;
  const headerState = state === 'verified' ? 'connected' : state;
  renderConnectionHeader(headerState, label, false);
}

setConnectionStateCallback((state, label) => {
  if (state === 'connecting' || state === 'verified') {
    showLivenessProbeState(state, label);
    return;
  }
  showConnectionState(state, label);
  applyPlanConnectionState(state === 'connected');
  for (const viewTab of VIEW_TABS) viewTab.onConnectionChange?.(state === 'connected');

  if (state === 'connected') {
    if (shutdownScreen.classList.contains('active')) {
      location.reload();
      return;
    }
    document.body.classList.add('app-ready');
    if (!appRevealed && controlConnectedAt === null) {
      controlConnectedAt = performance.now();
      loadingStatus.textContent = 'Connecting to sessions...';
      setTimeout(revealApp, MAX_REVEAL_WAIT_MS);
    }
    revealAppWhenTerminalsLive();
    sendFocusState();

    refreshViewsIfVisible('connected');

    sendControlRequest('get-settings', {})
      .then((msg) => {
        if (!msg.settings) return;
        applyDashboardSettings(msg.settings);
        if (getActiveView() === 'settings') activateSettingsHash(location.hash);
      })
      .catch(() => {});
    return;
  }
  if (state === 'disconnected' && shutdownScreen.classList.contains('active')) {
    shutdownStatus.textContent = 'Waiting for server...';
    return;
  }
  if (!appRevealed) loadingStatus.textContent = 'Reconnecting to server...';
});

function refreshAttentionSurfaces() {
  refreshIssuesSessionState();
  refreshPhoneBoard();
  refreshCalmView();
  refreshFocusNowPeek();
}

function refreshRosterAndAttentionSurfaces() {
  refreshFocusRoster();
  refreshAttentionSurfaces();
}

let isCalmSurfaceAvailable = false;
function refreshFocusNowPeek() {
  refreshNowPeek(isCalmSurfaceAvailable && isFocusActive() && !isPhoneLayout(), getFocusedSessionId());
}

let knownServerBuild: string | null | undefined = null;

function noteServerBuild(serverBuild: unknown) {
  const decision = decideReloadOnBuild(knownServerBuild, serverBuild);
  knownServerBuild = decision.knownBuild;
  if (decision.reload) location.reload();
}

function handleSnapshot(rows: ServerMessageOf<'snapshot'>['sessions']) {
  setVisionsProjectNames(new Map(rows.filter((s) => !s.ephemeral).map((s): [string, string] => [s.id, s.name])));
  applySettingsProjects(rows.filter((session) => !session.ephemeral).map((session) => ({
    id: session.id,
    name: session.name,
    agent: session.agent,
    permissionMode: session.dangerouslySkipPermissions ? 'Skip permissions' : 'Default',
  })));
  for (const s of rows) {
    if (!s.ephemeral) noteKnownProjectPath(s.path);
    const exists = hasSession(s.id);
    if (exists) applyState(s.id, s.state, s.stateSince);
    if (exists) setSessionSaneYolo(s.id, !!s.saneYolo);
    if (!exists) createSessionCard(s.id, s.name, s.state, buildSessionCardOptions(s));

    setSessionTaskTitle(s.id, s.taskTitle, s.taskTitleIsCustom);
    setSessionAgent(s.id, s.agent);

    seedSessionMergeStatus(s.id, s.mergeStatus, s.mergeReason);
    setSessionEffectiveBase(s.id, s.effectiveBase);

    setSessionAgents(s.id, s.activeAgents, s.awaitingBackgroundTasks);
    setSessionEndedTurn(s.id, s.hasEndedTurn);

    setSessionWakeup(s.id, s.pendingWakeup);

    setSessionPrompt(s.id, s.pendingPromptKind, s.pendingPromptDetail, s.isCompacting);

    setSessionHasPlan(s.id, s.hasPlan);

    restoreUsageChip(s.id);
  }
  updateAggregateStatus();
  refreshFavicon(sessionUIs);

  refreshFocusRoster();
  restoreFocusedSession();
  refreshAttentionSurfaces();
  syncTraceSessionsFromCards();
  activatePlanHash(location.hash);
  hasReceivedSnapshot = true;
  revealAppWhenTerminalsLive();
}

function syncTraceSessionsFromCards() {
  setTraceSessions([...sessionUIs].map(([id, sessionUi]) => ({
    id,
    name: sessionName(sessionUi) || id,
  })));
}

function carryOverClientSessionFields(sessionId: string, previousUi: SessionUi | undefined) {
  setSessionHasPlan(sessionId, previousUi?.hasPlan === true);
  restoreUsageChip(sessionId);
}

function handleStateChange(msg: ServerMessageOf<'state-change'>) {
  if (!hasSession(msg.id)) {
    createSessionCard(msg.id, msg.session, msg.to, buildSessionCardOptions({ skipPerms: msg.skipPerms, saneYolo: msg.saneYolo, stateSince: msg.timestamp }));
    refreshFavicon(sessionUIs);
    refreshIssuesSessionState();
    return;
  }

  if (msg.to === STATES.DORMANT && msg.from !== STATES.DORMANT) {
    const previousUi = sessionUIs.get(String(msg.id));
    const matchedCard = document.querySelector(`.session-card[data-id="${CSS.escape(String(msg.id))}"]`);
    const card = matchedCard instanceof HTMLElement ? matchedCard : null;
    const skipPerms = card ? card.dataset.skipPerms !== undefined : false;
    const saneYolo = msg.saneYolo ?? (card ? card.dataset.saneYolo !== undefined : false);

    const path = card ? card.dataset.path : undefined;
    removeSessionCard(msg.id);
    createSessionCard(msg.id, msg.session, STATES.DORMANT, buildSessionCardOptions({ skipPerms, saneYolo, worktree: card?.dataset.worktree !== undefined, workspace: card?.dataset.workspace !== undefined, path, stateSince: msg.timestamp, taskTitle: previousUi?.taskTitle, taskTitleIsCustom: previousUi?.taskTitleIsCustom }));
    setSessionAgent(msg.id, previousUi?.agent);
    carryOverClientSessionFields(msg.id, previousUi);
    refreshRosterAndAttentionSurfaces();
    refreshReviewSidebar(msg.id);
    refreshFavicon(sessionUIs);
    return;
  }

  applyState(msg.id, msg.to, msg.timestamp, msg.event);
  if (msg.hasEndedTurn !== undefined) setSessionEndedTurn(msg.id, msg.hasEndedTurn);
  if (msg.saneYolo !== undefined) setSessionSaneYolo(msg.id, msg.saneYolo);
  refreshFavicon(sessionUIs);

  refreshReviewSidebar(msg.id);
  refreshRosterAndAttentionSurfaces();

  handleDebugStateRefresh(msg.id);

  if (msg.to === STATES.INITIALIZING && (msg.from === STATES.DONE || msg.from === STATES.FAILED)) {
    reconnectDataWs(msg.id);
  }
}

const usageBySessionId = new Map<string, SessionUsageChip>();

function applyUsageSessionChips(rows: ServerMessageOf<'usage-sessions'>['sessions']) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row?.id) continue;
    seen.add(row.id);
    const usage = { tokens: row.tokens, costUSD: row.costUSD, officialCostUSD: row.officialCostUSD };
    usageBySessionId.set(row.id, usage);
    setSessionUsage(row.id, usage);
  }

  for (const id of [...usageBySessionId.keys()]) {
    if (seen.has(id)) continue;
    usageBySessionId.delete(id);
    setSessionUsage(id, null);
  }
}

function restoreUsageChip(sessionId: string) {
  const usage = usageBySessionId.get(sessionId);
  if (!usage) return;
  setSessionUsage(sessionId, usage);
}

setUsageRequestSender(sendControlMsg);
setHooksRequestSender(sendControlMsg);
setTraceRequestSender(sendControlMsg);
setIssuesRequestSender(sendControlMsg);
setBenchmarkRequestSender(sendControlMsg);
setFactoryRequestSender(sendControlMsg);

function refreshViewsIfVisible(reason: ViewRefreshReason) {
  refreshVisibleViews(VIEW_TABS, { isPhoneShellActive: isPhoneShellActive(), activeView: getActiveView(), phoneScreen: uiState.snapshot().phoneScreen }, reason);
}

const messageHandlers = {
  'snapshot':           (msg) => { noteServerBuild(msg.serverBuild); handleSnapshot(msg.sessions); },

  'hooks-report':       (msg) => applyHooksReport(msg),
  'save-hook-result':   (msg) => applySaveHookResult(msg),
  'delete-hook-result': (msg) => applyDeleteHookResult(msg),

  'state-change':       (msg) => handleStateChange(msg),
  'session-added':      (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg)); setSessionAgent(msg.id, msg.agent); restoreUsageChip(msg.id); } refreshFavicon(sessionUIs); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-removed':    (msg) => { removeSessionCard(msg.id); forgetReviewSession(msg.id); refreshFavicon(sessionUIs); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-title': (msg) => { setSessionTaskTitle(msg.id, msg.taskTitle, msg.isCustom); refreshRosterAndAttentionSurfaces(); },
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-modified':   (msg) => {
    if (!msg.ephemeral) noteKnownProjectPath(msg.path);
    const previousUi = sessionUIs.get(String(msg.id));
    removeSessionCard(msg.id);
    forgetReviewSession(msg.id);
    createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg));
    setSessionAgent(msg.id, msg.agent);
    carryOverClientSessionFields(msg.id, previousUi);
    refreshFavicon(sessionUIs);
    refreshRosterAndAttentionSurfaces();
    syncTraceSessionsFromCards();
  },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),

  'session-agents':     (msg) => { setSessionAgents(msg.id, msg.activeAgents, msg.awaitingBackgroundTasks); refreshRosterAndAttentionSurfaces(); handleDebugStateRefresh(msg.id); },
  'session-wakeup':     (msg) => setSessionWakeup(msg.id, msg.pendingWakeup),
  'session-prompt':     (msg) => { setSessionPrompt(msg.id, msg.pendingPromptKind, msg.pendingPromptDetail ?? null, msg.isCompacting === true); refreshAttentionSurfaces(); },
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus, msg.reason); setFocusMergeStatus(msg.id, msg.mergeStatus); refreshAttentionSurfaces(); },
  'session-worktree-blocked': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'integration branch not found'}`, { persist: true }); },
  'session-worktree-warning': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'base branch warning'}`); },
  'session-worktree-ready': (msg) => { setSessionEffectiveBase(msg.id, msg.base); },
  'session-diff':       (msg) => { applyCalmSessionDiff(msg); setSessionDiff(msg.id, { committed: msg.committed, uncommitted: msg.uncommitted, hasCommits: msg.hasCommits }); },
  'session-diff-error': (msg) => { applyCalmSessionDiffError(msg); setReviewDiffError(msg.id, msg.message); },
  'change-map':         (msg) => setSessionChangeMap(msg.id, msg.map),
  'branch-sync-status': (msg) => setReviewBranchSync(msg.id, msg),
  'session-changed':    (msg) => notifyWorktreeChanged(msg.id),
  'post-turn-result':   (msg) => setSessionPostTurn(msg.id, msg),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  'session-trace-response': (msg) => { applyCalmTraceResponse(msg); applyTraceResponse(msg); },
  'session-trace-changed': (msg) => applyTraceChanged(msg),
  'session-plan-changed': (msg) => { applySessionPlanChanged(msg); refreshAttentionSurfaces(); },
  'session-plan-draft': (msg) => { applySessionPlanDraft(msg); },
  'session-plan-response': (msg) => { applySessionPlanResponse(msg); },

  'notify':             (msg) => { showDesktopNotification(msg); handleDebugStateRefresh(msg.session); },
  'update-status':      (msg) => { showUpdateBanner(msg); applySettingsUpdateStatus(msg); },
  'update-progress':    (msg) => applySettingsUpdateProgress(msg.journal),
  'error':              (msg) => { applyCalmError(msg); clearSettingsUpdateRequest(); applyTraceError(msg); applySessionPlanError(msg); showErrorToast(msg.message, { persist: true }); },
  'session-error':      (msg) => { applySessionPlanError(msg); showErrorToast(`${msg.session}: ${msg.message}`, { persist: true }); },
  'settings-updated':   (msg) => { if (msg.settings) applyDashboardSettings(msg.settings, { isLiveSettingsChange: true }); },
  'health-snapshot':    (msg) => { if (msg.stats) applyHealthSnapshot(msg.stats as HealthSnapshot & ServerMessageOf<'health-snapshot'>['stats']); },
  'posthog-status':     (msg) => applyPosthogStatus(msg),
  'posthog-investigation-activity': (msg) => applyInvestigationActivity(msg),
  'posthog-investigation-finished': (msg) => applyInvestigationFinished(msg),
  'team-review-status': (msg) => applyTeamReviewStatus(msg),
  'my-prs-status': (msg) => applyMyPrsStatus(msg),
  'factory-state': (msg) => applyFactoryState(msg),
  'factory-queue-intent-result': (msg) => applyFactoryQueueIntentResult(msg),
  'factory-control-result': (msg) => applyFactoryControlResult(msg),
  'benchmark-status': (msg) => applyBenchmarkStatus(msg),
  'benchmark-action-result': (msg) => applyBenchmarkActionResult(msg),
  'my-pr-merge-result': (msg) => applyMyPrMergeResult(msg),
  'team-review-action-result': (msg) => applyTeamReviewActionResult(msg),
  'issues-status':      (msg) => applyIssuesStatus(msg),
  'issue-detail-result': (msg) => applyIssueDetailResult(msg),
  'open-issue-session-result': (msg) => applyOpenIssueSessionResult(msg),
  'usage-sessions':     (msg) => { applyUsageSessionChips(msg.sessions); applyUsageSessions(msg); },
  'usage-report':       (msg) => { applyUsageReport(msg); refreshSettingsStatus(); },

  'plan-limits':        (msg) => applyPlanLimits(msg),

  'usage-budget-alert': (msg) => showDesktopNotification({
    session: `budget-${msg.scope}-${msg.periodKey}`,
    category: `threshold-${msg.threshold}`,
    message: msg.text,
    ignoreFocus: true,
  }),

  'visions-findings': (msg) => applyVisionsFindings(msg),

  'visions-comments': (msg) => applyVisionsComments(msg),
  'visions-hand':     (msg) => applyVisionsHand(msg),

  'visions-intent':   (msg) => applyVisionsIntent(msg),

  'visions-fix':      (msg) => applyVisionsFix(msg),
  'visions-snapshot': (msg) => applyVisionsSnapshot(msg),

  'ingest-activity':    (msg) => applyIngestActivity(msg),
  'ingest-snapshot':    (msg) => applyIngestSnapshot(msg),
  'client-trust':       (msg) => applyClientTrust(msg.trust),
  'shutting-down':      () => showServerGoingDown('Shutting down...', 'Shutting down sessions...'),
  'restarting':         () => showServerGoingDown('Restarting...', 'Restarting server...'),
} satisfies { [Type in ServerMessage['type']]?: (message: ServerMessageOf<Type>) => void };

const handlersByType: { [Type in ServerMessage['type']]?: (message: ServerMessageOf<Type>) => void } = messageHandlers;

function dispatchControlMessage<Type extends ServerMessage['type']>(message: { [Variant in ServerMessage['type']]: ServerMessageOf<Variant> }[Type]) {
  const handler = handlersByType[message.type];
  if (handler) handler(message);
}

onControlMessage((msg) => {
  dispatchControlMessage(msg);
  refreshViewsIfVisible(msg.type);
});

let updateBannerDismissed = false;

const UPDATES_SECTION_HREF = createSettingsLink(UPDATES_SECTION_ID, UPDATES_ACTIONS_SETTING_ID, 'Update').href;

function updateIdentity(msg: ServerMessageOf<'update-status'>) {
  const { latestSha, latest } = msg;
  if (typeof latest === 'string' && latest) return latest;
  if (typeof latestSha === 'string' && latestSha) return latestSha;
  return null;
}

function showUpdateBanner(msg: ServerMessageOf<'update-status'>) {
  const banner = queryTag(document, '#update-banner', 'div');
  if (!msg.updateAvailable) {
    banner.hidden = true;
    return;
  }
  if (updateBannerDismissed) return;
  const identity = updateIdentity(msg);
  if (identity && getDismissedUpdate() === identity) return;
  const command = String(msg.command ?? '');
  queryTag(document, '#update-banner-text', 'span').textContent = updateBannerText(msg);
  queryTag(document, '#update-banner-cmd', 'code').textContent = command;
  const mode = updateBannerMode(msg);
  const updateLink = queryTag(document, '#update-banner-update', 'a');
  updateLink.href = UPDATES_SECTION_HREF;
  updateLink.hidden = mode !== 'link';
  const commandEl = queryTag(document, '#update-banner-cmd', 'code');
  commandEl.hidden = mode !== 'command';
  const copyBtn = queryTag(document, '#update-banner-copy', 'button');
  copyBtn.hidden = mode !== 'command';
  const copyStatus = queryTag(document, '#update-banner-copy-status', 'span');
  copyStatus.hidden = mode !== 'command';
  copyStatus.textContent = '';
  const link = queryTag(document, '#update-banner-link', 'a');
  link.hidden = !msg.releaseUrl;
  link.href = typeof msg.releaseUrl === 'string' ? msg.releaseUrl : '';
  banner.hidden = false;

  copyBtn.onclick = () => {
    const write = writeClipboardText(command);
    if (!write) {
      copyStatus.textContent = 'Copy failed';
      return;
    }
    write
      .then(() => { copyStatus.textContent = 'Copied'; })
      .catch(() => { copyStatus.textContent = 'Copy failed'; });
  };
  queryTag(document, '#update-banner-dismiss', 'button').onclick = () => {
    updateBannerDismissed = true;
    setDismissedUpdate(identity);
    banner.hidden = true;
  };
}

const telemetryBanner = queryTag(document, '#telemetry-banner', 'div');

function dismissTelemetryBanner() {
  setTelemetryNoticeDismissed(true);
  telemetryBanner.hidden = true;
}

function syncTelemetryBanner(settings: unknown) {
  telemetryBanner.hidden = !shouldShowTelemetryNotice(settings, isTelemetryNoticeDismissed());
}

const telemetrySettingsLink = queryTag(document, '#telemetry-banner-settings', 'a');
telemetrySettingsLink.href = createSettingsLink('privacy', 'telemetry-enabled', 'Open settings').href;
telemetrySettingsLink.addEventListener('click', dismissTelemetryBanner);
queryTag(document, '#telemetry-banner-dismiss', 'button').addEventListener('click', dismissTelemetryBanner);

queryTag(document, '#btn-add-session-header', 'button').addEventListener('click', createAddSessionDialog);

const btnMute = queryTag(document, '#btn-mute', 'button');
mountMuteButton(btnMute);

const powerMenu = queryTag(document, '#power-menu', 'div');
const btnPower = queryTag(document, '#btn-power', 'button');

function syncPowerMenuAria() {
  btnPower.setAttribute('aria-expanded', powerMenu.classList.contains('open') ? 'true' : 'false');
}

btnPower.addEventListener('click', (e) => {
  e.stopPropagation();
  powerMenu.classList.toggle('open');
  syncPowerMenuAria();
});

document.addEventListener('click', (e) => {
  if (!(e.target instanceof Node)) return;
  if (!powerMenu.contains(e.target)) {
    powerMenu.classList.remove('open');
    syncPowerMenuAria();
  }
});

observeHeaderHeight(document.querySelector('.header'));

function openSettings(section?: string) {
  if (section) activateSettingsSection(section);
  if (showPhoneScreen('settings')) return;
  activateView('settings', { section });
}

function clearSettingsHash() {
  if (!location.hash.startsWith('#settings/')) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}

function activateSettingsTarget(target: { sectionId: string; settingId: string | null } | null) {
  if (!target) return false;
  activateSettingsSection(target.sectionId, target.settingId);
  if (showPhoneScreen('settings')) return true;
  activateView('settings', { section: target.sectionId, setting: target.settingId, persist: false });
  return true;
}

function activateSettingsHash(hash: string) {
  return activateSettingsTarget(resolveSettingsTarget(hash));
}

function activatePlanHash(hash: string) {
  const sessionId = resolvePlanTarget(hash);
  if (!sessionId) return false;
  if (!hasSession(sessionId)) return true;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  if (isPhoneShellActive()) {
    if (!showPhonePlan(sessionId)) showErrorToast('No plan is stored for this session yet');
    return true;
  }
  activateView('focus', { persist: false });
  if (!openPlanInFocus(sessionId)) showErrorToast('No plan is stored for this session yet');
  return true;
}

function activateHash(hash: string) {
  if (activatePlanHash(hash)) return true;
  return activateSettingsHash(hash);
}

function activateLocationHash() {
  return activateHash(location.hash);
}

document.addEventListener('click', (event) => {
  if (!isPhoneShellActive() || event.defaultPrevented) return;
  const anchor = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (!activateHash(anchor.hash)) return;
  event.preventDefault();
});

mountCelebrationTray(
  queryTag(document, '#celebration-tray', 'div'),
  queryTag(document, '#btn-celebrations', 'button'),
  queryTag(document, '#celebration-tray-count', 'span'),
);

queryTag(document, '#btn-help', 'button').addEventListener('click', () => {
  openSettings('browser-shortcuts');
});

const VIEW_TABS = createDashboardViews({
  onRestart: confirmServerRestart,
  onConfirmUpdateAndRestart: confirmUpdateAndRestart,
  openTerminal: (id) => { activateView('focus'); centerSessionQuietly(id); },
  openPlan: (id) => { activateView('focus'); openPlanInFocus(id); },
  openCalm: () => activateView('calm'),
  setPhoneAttention: setPhoneScreenAttention,
});

mountReviewSidebar({ panel: document.getElementById('review-sidebar') });
for (const viewTab of VIEW_TABS) viewTab.mount(viewTab.el);

const focusHeaderAccessorySlot = getFocusHeaderAccessorySlot();
if (focusHeaderAccessorySlot) mountNowPeek(focusHeaderAccessorySlot);
uiState.subscribe((_state, changedKeys) => {
  if (changedKeys.includes('focusedSessionId')) refreshFocusNowPeek();
});

function findViewTab(view: string) {
  return VIEW_TABS.find((viewTab) => viewTab.view === view);
}

function isViewAvailable(view: string) {
  return VIEW_TABS.some((viewTab) => viewTab.view === view && !viewTab.tab.hidden);
}

let shouldPersistActiveView = true;
let savedViewAwaitingSurface: string | null = null;
function acknowledgeViewAttention(view: string) {
  findViewTab(view)?.attention?.acknowledge();
}

function refreshViewOnShow(view: string) {
  refreshViewOnReason(findViewTab(view), 'shown');
}

interface ActivateViewOptions {
  section?: string;
  setting?: string | null;
  persist?: boolean;
}

function activateView(view: string, { section, setting, persist = true }: ActivateViewOptions = {}) {
  if (!isViewAvailable(view)) return;
  const prev = getActiveView();
  uiState.dispatch('setActiveView', view);
  shouldPersistActiveView = persist;
  if (persist) savedViewAwaitingSurface = null;

  document.body.dataset.activeView = view;
  document.body.dataset.reviewSidebarHidden = String(findViewTab(view)?.hasReviewSidebar !== true);

  if (persist) setActiveView(view);
  for (const v of VIEW_TABS) {
    const selected = v.view === view;
    if (v.el) v.el.hidden = !selected;
    v.tab.setAttribute('aria-selected', String(selected));
    v.tab.tabIndex = selected ? 0 : -1;
  }

  if (prev !== view) findViewTab(prev)?.deactivate?.();
  findViewTab(view)?.activate?.();

  refreshViewOnShow(view);
  if (prev === 'settings' && view !== 'settings') clearSettingsHash();
  if (view === 'settings' && section) activateSettingsSection(section, setting ?? null);
  acknowledgeViewAttention(view);
  refreshFocusNowPeek();
}

function setSurfaceAvailable(viewTab: DashboardView, isAvailable: boolean) {
  const { view } = viewTab;
  viewTab.tab.hidden = !isAvailable;
  setPhoneScreenAvailable(view, isAvailable);
  viewTab.onAvailabilityChange?.(isAvailable);
  if (isPhoneShellActive()) return;
  if (!isAvailable && getActiveView() === view) activateView('focus');
  if (!isAvailable) return;
  if (savedViewAwaitingSurface !== view) return;
  activateView(view);
}

let lastAppliedCalmSurface: boolean | null = null;
function applySurfaceSettings(settings: FeatureSurfaceSettings, { isLiveSettingsChange = false } = {}) {
  const surfaces = viewAvailabilityFromSettings(VIEW_TABS, settings);
  const isCalmAvailable = surfaces.find((surface) => surface.view.view === 'calm')?.isAvailable === true;
  const hasOperatorTurnedCalmOn = isLiveSettingsChange && lastAppliedCalmSurface === false && isCalmAvailable;
  lastAppliedCalmSurface = isCalmAvailable;
  isCalmSurfaceAvailable = isCalmAvailable;
  setPhoneCalmAvailable(isCalmAvailable);
  setFocusRailShown(!isCalmAvailable);
  refreshFocusNowPeek();
  for (const { view, isAvailable } of surfaces) setSurfaceAvailable(view, isAvailable);
  if (!hasOperatorTurnedCalmOn || getActiveView() !== 'focus' || isPhoneLayout() || resolvePlanTarget(location.hash)) return;
  activateView('calm');
}

function applyDashboardSettings(settings: FeatureSurfaceSettings, { isLiveSettingsChange = false } = {}) {
  applyTerminalSettings(settings);
  applySettingsBroadcast(settings);
  applyVisionsSettings(settings);
  applySurfaceSettings(settings, { isLiveSettingsChange });
  syncTelemetryBanner(settings);
}

for (const viewTab of VIEW_TABS) {
  if (!viewTab.gate) continue;
  setSurfaceAvailable(viewTab, false);
  if ('subscribe' in viewTab.gate) viewTab.gate.subscribe((isAvailable) => setSurfaceAvailable(viewTab, isAvailable));
}

setTraceNavigate(() => {
  if (!isViewAvailable('trace')) return;
  if (showPhoneScreen('trace')) return;
  activateView('trace');
});

function stepViewTab(fromView: string, direction: number) {
  const availableTabs = VIEW_TABS.filter((viewTab) => !viewTab.tab.hidden);
  const fromIndex = availableTabs.findIndex((viewTab) => viewTab.view === fromView);
  const nextTab = availableTabs[(fromIndex + direction + availableTabs.length) % availableTabs.length];
  activateView(nextTab.view);
  return nextTab.tab;
}

function focusViewTabIfFocused(tab: HTMLElement) {
  if (!VIEW_TABS.some((viewTab) => viewTab.tab === document.activeElement)) return;
  tab.focus();
}

for (let i = 0; i < VIEW_TABS.length; i++) {
  const { view, tab } = VIEW_TABS[i];
  tab.addEventListener('click', () => activateView(view));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    stepViewTab(getActiveView(), e.key === 'ArrowRight' ? 1 : -1).focus();
  });
}

const savedView = getSavedActiveView();
const initialSettingsTarget = resolveSettingsTarget(location.hash);
const initialPlanTarget = resolvePlanTarget(location.hash);
if (initialSettingsTarget) {
  activateView('settings', {
    section: initialSettingsTarget.sectionId,
    setting: initialSettingsTarget.settingId,
    persist: false,
  });
}
if (initialPlanTarget) activateView('focus', { persist: false });
if (!initialSettingsTarget && !initialPlanTarget) {
  const canRestoreSavedView = isViewAvailable(savedView);
  if (!canRestoreSavedView) savedViewAwaitingSurface = savedView;
  activateView(canRestoreSavedView ? savedView : 'focus', { persist: canRestoreSavedView });
}

mountPhoneShell({
  panels: phonePanelsFromDesktopViews(VIEW_TABS),

  onScreenShown: (screenId: string) => {
    refreshViewOnShow(screenId);
    if (screenId !== 'settings') clearSettingsHash();
    if (screenId === 'settings' && !location.hash.startsWith('#settings/')) activateSettingsSection();
    acknowledgeViewAttention(screenId);
  },

  headerControls: [
    queryTag(document, '.header-title', 'h1'),
    queryTag(document, '#status-indicator', 'div'),
    queryTag(document, '#celebration-tray', 'div'),
    queryTag(document, '#btn-add-session-header', 'button'),
    queryTag(document, '#btn-help', 'button'),
    btnMute,
    powerMenu,
  ],
});

function applyFormFactorLayout(layout: string) {
  if (layout === 'phone') {
    const carriedSessionId = getFocusedSessionId();
    for (const viewTab of viewsInTabOrder(VIEW_TABS)) viewTab.deactivate?.();
    clearQueueOrigin();
    refreshFocusNowPeek();
    activatePhoneShell({ sessionId: carriedSessionId ?? undefined });
    return;
  }
  const carriedSessionId = getPhoneSessionId();
  deactivatePhoneShell();
  const restoredView = getActiveView();
  activateView(isViewAvailable(restoredView) ? restoredView : 'focus', { persist: shouldPersistActiveView });

  if (carriedSessionId) centerSessionQuietly(carriedSessionId);
}

if (isPhoneLayout()) applyFormFactorLayout('phone');
onLayoutChange(applyFormFactorLayout);
window.addEventListener('hashchange', activateLocationHash);

interface ServerPowerAction {
  type: 'restart-server' | 'shutdown';
  title: string;
  confirmLabel: string;
  danger: boolean;
  idleMessage: string;
  actionAfterKillingSessions: string;
}

function confirmServerPowerAction({ type, title, confirmLabel, danger, idleMessage, actionAfterKillingSessions }: ServerPowerAction) {
  powerMenu.classList.remove('open');
  syncPowerMenuAria();
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0 ? `Kill ${count} session${suffix} and ${actionAfterKillingSessions}?` : idleMessage;
  openConfirmDialog({ title, message, confirmLabel, danger, onConfirm: () => sendControlMsg({ type }) });
}

function confirmServerRestart() {
  confirmServerPowerAction({ type: 'restart-server', title: 'Restart Server', confirmLabel: 'Restart', danger: false, idleMessage: 'Restart the server?', actionAfterKillingSessions: 'restart the server' });
}

function confirmUpdateAndRestart(proceed: (confirmedSessionIds: string[]) => void) {
  const confirmableSessionIds = getSessionIds();
  const count = confirmableSessionIds.length;
  if (count === 0) {
    proceed(confirmableSessionIds);
    return;
  }
  const suffix = count > 1 ? 's' : '';
  openConfirmDialog({
    title: 'Update and restart',
    message: `Glimmervoid restarts once the update is staged, which kills ${count} running session${suffix}. Continue?`,
    confirmLabel: 'Update and restart',
    danger: false,
    onConfirm: () => proceed(confirmableSessionIds),
  });
}

queryTag(document, '#btn-restart', 'button').addEventListener('click', confirmServerRestart);

function applyClientTrust(trust: unknown) {
  const showShutdown = shouldShowServerAction('shutdown', trust);
  queryTag(document, '#btn-shutdown', 'button').hidden = !showShutdown;
  queryTag(document, '#menu-divider-shutdown', 'div').hidden = !showShutdown;
}

queryTag(document, '#btn-shutdown', 'button').addEventListener('click', () => {
  confirmServerPowerAction({ type: 'shutdown', title: 'Shut Down Server', confirmLabel: 'Shut Down', danger: true, idleMessage: 'Shut down the server?', actionAfterKillingSessions: 'shut down the server' });
});

function isRealInputFocused() {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement)) return false;
  if (a.isContentEditable) return true;
  return (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
    && !a.classList.contains('xterm-helper-textarea');
}

function runDashboardShortcut({ action, step }: ResolvedDashboardShortcut) {
  switch (action) {
    case 'merge':
      mergeSelectedSession();
      return true;
    case 'resolve-or-resync':
      if (!resolveSelectedSession()) resyncSelectedSession();
      return true;
    case 'new-session':
      document.getElementById('btn-add-session-header')?.click();
      return true;
    case 'next-attention':
      if (getActiveView() === 'calm') return openNextQueuePanel();
      if (!isFocusActive()) return false;
      focusNextAttention();
      return true;
    case 'rail-step':
      if (!isFocusActive()) return false;
      focusAdjacentInRail(step);
      return true;
    case 'view-step':
      if (isPhoneLayout()) return false;
      focusViewTabIfFocused(stepViewTab(getActiveView(), step));
      return true;
    case 'session-nth':
      if (!isFocusActive()) return false;
      focusNthInRail(step);
      return true;
    case 'calm-home':
      if (isPhoneLayout()) return false;
      activateView('calm');
      return true;
    case 'calm-terminal':
      return openSelectedPanelTerminal();
  }
}

setShortcutContextProvider(() => ({ isCalmAvailable: isCalmSurfaceAvailable, isCalmViewActive: getActiveView() === 'calm' }));

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (isRealInputFocused()) return;
  const shortcut = resolveDashboardShortcut(e, SHORTCUT_PLATFORM, currentShortcutContext());
  if (!shortcut) return;
  if (runDashboardShortcut(shortcut)) e.preventDefault();
});

const focusStateTimer = createCoalescedTimer({
  mode: 'trailing',
  delayMs: 150,
  run: () => {
    sendControlMsg({ type: 'focus-change', focused: document.hasFocus() });
  },
});

function sendFocusState() {
  focusStateTimer.schedule();
}

function noteViewerFocusEdge() {
  sendFocusState();
  syncGridOnEngagementEdge(findSessionUi(getBorrowedCardId()));
}

window.addEventListener('focus', noteViewerFocusEdge);
window.addEventListener('blur', noteViewerFocusEdge);
document.addEventListener('visibilitychange', noteViewerFocusEdge);

let _wakeLivenessCheckRunning = false;
let _hiddenSinceMs: number | null = null;

function takeHiddenForMs() {
  if (document.visibilityState !== 'visible') return 0;
  const hiddenSinceMs = _hiddenSinceMs;
  _hiddenSinceMs = null;
  if (hiddenSinceMs === null) return 0;
  return Date.now() - hiddenSinceMs;
}

async function checkWakeLiveness() {
  const hiddenForMs = takeHiddenForMs();
  if (_wakeLivenessCheckRunning) return;
  _wakeLivenessCheckRunning = true;
  holdTerminalInputDuringWakeCheck();
  try {
    const state = await checkControlLiveness(hiddenForMs);
    if (state === 'ok') return;
    for (const id of sessionUIs.keys()) reconnectDataWs(id);
  } finally {
    releaseHeldTerminalInput();
    _wakeLivenessCheckRunning = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    _hiddenSinceMs ??= Date.now();
    return;
  }
  rebuildWebglGlyphAtlases();
  checkWakeLiveness();
});
window.addEventListener('online', checkWakeLiveness);
const reportClientError = createClientErrorReporter(sendControlMsg);
window.addEventListener('error', (event) => reportClientError(event.error));
window.addEventListener('unhandledrejection', (event) => reportClientError(event.reason));
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  rebuildWebglGlyphAtlases();
  checkWakeLiveness();
});

mountHealthMonitor(queryTag(document, '#health-footer-mount', 'div'));

initNotifications();

whenBundledMonoFontLoads(refreshTerminalFonts);

connectControl();
