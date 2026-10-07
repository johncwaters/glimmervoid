import '@xterm/xterm/css/xterm.css';
import './tailwind.css';
import { activateCalmView, clearQueueOrigin, deactivateCalmView, mountCalmView, mountNowPeek, openNextQueuePanel, openSelectedPanelTerminal, refreshCalmView, refreshNowPeek, applyCalmSessionDiff, applyCalmTraceResponse, applyCalmError } from './calm/calm-view.ts';

import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { shouldShowServerAction } from '#shared/client-trust.ts';
import { STATES } from '#shared/states.ts';
import { getBorrowedCardId } from './card-host.ts';
import { createClientErrorReporter } from './client-error-core.ts';
import { checkControlLiveness, connectControl, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.ts';
import { createAddSessionDialog } from './dialogs.ts';
import { observeHeaderHeight, queryTag, writeClipboardText } from './dom-helpers.ts';
import { routeExternalAnchorsThroughHost } from './external-link.ts';
import { availableSurfacesFromSettings } from './feature-surfaces-core.ts';
import { refreshFavicon } from './favicon.ts';
import { activateFocusView, centerSessionQuietly, deactivateFocusView, focusAdjacentInRail, focusNextAttention, focusNthInRail, getFocusedSessionId, getFocusHeaderAccessorySlot, isFocusActive, mountFocusView, openPlanInFocus, refreshFocusRoster, restoreFocusedSession, setFocusMergeStatus, setFocusRailShown } from './focus-view/focus-view.ts';
import { initFormFactor, isPhoneLayout, onLayoutChange } from './form-factor.ts';
import type { HealthSnapshot } from './health-monitor.ts';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.ts';
import { acknowledgeVisionsAttention, applyIngestActivity, applyIngestSnapshot, applyVisionsComments, applyVisionsFindings, applyVisionsFix, applyVisionsHand, applyVisionsIntent, applyVisionsSettings, applyVisionsSnapshot, mountVisionsView, refreshVisionsView, setVisionsActivityCallback, setVisionsProjectNames } from './visions-panel.ts';
import { applyDeleteHookResult, applyHooksReport, applySaveHookResult, mountHooksView, refreshHooksView, requestHooksReport, setHooksRequestSender } from './hooks-panel.ts';
import { initNotifications, showDesktopNotification } from './notifications.ts';
import { activatePhoneShell, deactivatePhoneShell, getPhoneSessionId, isPhoneScreenActive, isPhoneShellActive, mountPhoneShell, refreshPhoneBoard, setPhoneCalmAvailable, setPhoneScreenAttention, setPhoneScreenAvailable, showPhonePlan, showPhoneScreen } from './phone/phone-shell.ts';
import { noteKnownProjectPath } from './project-registry.ts';
import { applyTeamReviewActionResult, applyTeamReviewStatus, setTeamReviewActivityCallback } from './team-review-panel.ts';
import { applyMyPrMergeResult, applyMyPrsStatus } from './my-prs-panel.ts';
import { applyBenchmarkActionResult, applyBenchmarkConnectionState, applyBenchmarkStatus, mountBenchmarkView, setBenchmarkRequestSender } from './benchmark-panel.ts';
import { applyIssuesConnectionState, applyIssuesProjects, applyIssuesReport, applyOpenIssueSessionResult, mountIssuesView, setIssuesRequestSender } from './issues-panel.ts';

import { UPDATES_ACTIONS_SETTING_ID, UPDATES_SECTION_ID, updateBannerText } from './radar-core.ts';
import { acknowledgePrsViewAttention, mountPrsView } from './prs-view.ts';
import { acknowledgeRadarAttention, applyInvestigationActivity, applyInvestigationFinished, applyPosthogStatus, mountRadarView, setRadarActivityCallback, setRadarTraceOpener } from './radar-panel.ts';
import { handleDebugStateRefresh, handleDebugStateResponse, onDebugModeChanged, setSessionSaneYolo } from './session-card/card-dom.ts';
import { findSessionUi, sessionName, sessionUIs } from './session-card/card-registry.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { applyPlanConnectionState, applySessionPlanChanged, applySessionPlanDraft, applySessionPlanError, applySessionPlanResponse, applyState, applyTerminalSettings, createSessionCard, getSessionCount, getSessionIds, hasSession, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setSessionTaskTitle, setSessionAgent, setSessionAgents, setSessionDiff, setSessionEffectiveBase, setSessionEndedTurn, setSessionHasPlan, setSessionMergeStatus, setSessionPostTurn, setSessionPrompt, setSessionUsage, setSessionWakeup, setSessionWorktree, updateAggregateStatus } from './session-card/lifecycle.ts';
import { resolvePlanTarget } from './plan/plan-link.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { reconnectDataWs, syncGridOnEngagementEdge } from './session-card/terminal.ts';
import { showErrorToast } from './session-card/toast.ts';
import { rebuildWebglGlyphAtlases } from './session-card/webgl-pool.ts';
import { activateSettingsSection, applySettingsBroadcast, applySettingsProjects, applySettingsUpdateProgress, applySettingsUpdateStatus, clearSettingsUpdateRequest, mountSettingsView, refreshSettingsStatus, resolveSettingsTarget } from './settings-panel.ts';
import { forgetReviewSession, mergeSelectedSession, mountReviewSidebar, notifyWorktreeChanged, refreshReviewSidebar, resolveSelectedSession, resyncSelectedSession, setReviewBranchSync, setSessionChangeMap } from './sidebar/review-sidebar.ts';
import { decideReloadOnBuild } from './server-build-core.ts';
import { createSettingsLink } from './settings-link.ts';
import { currentShortcutContext, SHORTCUT_PLATFORM, setShortcutContextProvider } from './shortcuts.ts';
import { resolveDashboardShortcut } from './shortcuts-core.ts';
import type { ResolvedDashboardShortcut } from './shortcuts-core.ts';
import { applyFlyingAnimals } from './flying-animals.ts';
import { applyCompactStatusLabels, applySessionUsageChips, applyTheme } from './theme.ts';
import { applyTraceChanged, applyTraceConnectionState, applyTraceError, applyTraceResponse, mountTraceView, openTraceForSession, refreshTraceView, setTraceNavigate, setTraceRequestSender, setTraceSessions } from './trace-panel.ts';
import { shouldShowTelemetryNotice } from './telemetry-notice-core.ts';
import { getActiveView as getSavedActiveView, getDismissedUpdate, getThemeId, isCompactStatusLabels, isFlyingAnimalsEnabled, isSessionUsageChips, isSoundEnabled, isTelemetryNoticeDismissed, setActiveView, setDismissedUpdate, setSoundEnabled, setTelemetryNoticeDismissed } from './ui-prefs.ts';
import { getActiveView, uiState } from './ui-state-core.ts';
import { updateBannerMode } from './updates-view-core.ts';
import { acknowledgeUsageAttention, applyPlanLimits, applyUsageReport, applyUsageSessions, mountUsageView, refreshUsageView, requestUsageReport, setUsageActivityCallback, setUsageRequestSender } from './usage-panel.ts';

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

function revealApp() {
  if (appRevealed) return;
  appRevealed = true;
  document.body.classList.add('app-ready');
  loadingScreen.classList.add('fade-out');

  const removeLoading = () => loadingScreen.remove();
  loadingScreen.addEventListener('transitionend', removeLoading, { once: true });
  setTimeout(removeLoading, 1000);
}

type SessionUsageChip = Pick<ServerMessageOf<'usage-sessions'>['sessions'][number], 'tokens' | 'costUSD' | 'officialCostUSD'>;

function showShutdownOverlay(message?: string) {
  if (message) shutdownStatus.textContent = message;
  shutdownScreen.classList.add('active');
}

setConnectionStateCallback((state, label) => {
  connectionEl.dataset.state = state;
  connectionLabel.textContent = label;
  connectionEl.title = label;
  applyTraceConnectionState(state === 'connected');
  applyPlanConnectionState(state === 'connected');
  applyIssuesConnectionState(state === 'connected');
  applyBenchmarkConnectionState(state === 'connected');

  if (state === 'connected') {
    if (shutdownScreen.classList.contains('active')) {

      location.reload();
      return;
    }
    revealApp();
    sendFocusState();

    requestUsageReportIfVisible();
    requestHooksReportIfVisible();

    sendControlRequest('get-settings', {})
      .then((msg) => {
        if (!msg.settings) return;
        applyTerminalSettings(msg.settings);
        applySettingsBroadcast(msg.settings);
        applyVisionsSettings(msg.settings);
        applySurfaceSettings(msg.settings);
        syncTelemetryBanner(msg.settings);
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
  refreshPhoneBoard();
  refreshCalmView();
  refreshFocusNowPeek();
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
  applyIssuesProjects(rows.filter((session) => !session.ephemeral).map((session) => ({ id: session.id, name: session.name })));
  for (const s of rows) {
    if (!s.ephemeral) noteKnownProjectPath(s.path);
    const exists = hasSession(s.id);
    if (exists) applyState(s.id, s.state, s.stateSince);
    if (exists) setSessionSaneYolo(s.id, !!s.saneYolo);
    if (!exists) createSessionCard(s.id, s.name, s.state, { skipPerms: !!s.dangerouslySkipPermissions, saneYolo: !!s.saneYolo, worktree: !!s.isWorktree, workspace: !!s.isWorkspace, path: s.path, stateSince: s.stateSince });

    setSessionTaskTitle(s.id, s.taskTitle, s.taskTitleIsCustom);
    setSessionAgent(s.id, s.agent);


    seedSessionMergeStatus(s.id, s.mergeStatus, s.mergeReason);
    setSessionEffectiveBase(s.id, s.effectiveBase);

    setSessionAgents(s.id, s.activeAgents, s.awaitingBackgroundTasks);
    setSessionEndedTurn(s.id, s.hasEndedTurn);

    setSessionWakeup(s.id, s.pendingWakeup);

    setSessionPrompt(s.id, s.pendingPromptKind, s.pendingPromptDetail);

    setSessionHasPlan(s.id, s.hasPlan);

    restoreUsageChip(s.id);
  }
  updateAggregateStatus();
  refreshFavicon(sessionUIs);

  if (isFocusActive()) { refreshFocusRoster(); restoreFocusedSession(); }

  refreshAttentionSurfaces();
  syncTraceSessionsFromCards();
  activatePlanHash(location.hash);
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
    createSessionCard(msg.id, msg.session, msg.to, { skipPerms: !!msg.skipPerms, saneYolo: !!msg.saneYolo, stateSince: msg.timestamp });
    refreshFavicon(sessionUIs);
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
    createSessionCard(msg.id, msg.session, STATES.DORMANT, { skipPerms, saneYolo, path, stateSince: msg.timestamp, taskTitle: previousUi?.taskTitle, taskTitleIsCustom: previousUi?.taskTitleIsCustom });
    setSessionAgent(msg.id, previousUi?.agent);
    carryOverClientSessionFields(msg.id, previousUi);
    if (isFocusActive()) refreshFocusRoster();
    refreshAttentionSurfaces();
    refreshReviewSidebar(msg.id);
    refreshFavicon(sessionUIs);
    return;
  }

  applyState(msg.id, msg.to, msg.timestamp);
  if (msg.hasEndedTurn !== undefined) setSessionEndedTurn(msg.id, msg.hasEndedTurn);
  if (msg.saneYolo !== undefined) setSessionSaneYolo(msg.id, msg.saneYolo);
  refreshFavicon(sessionUIs);

  refreshReviewSidebar(msg.id);
  if (isFocusActive()) refreshFocusRoster();
  refreshAttentionSurfaces();

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

function isHooksSurfaceVisible() {
  if (isPhoneShellActive()) return isPhoneScreenActive('hooks');
  return getActiveView() === 'hooks';
}

function requestHooksReportIfVisible() {
  if (!isHooksSurfaceVisible()) return;
  requestHooksReport();
}

function isUsageSurfaceVisible() {
  if (isPhoneShellActive()) return isPhoneScreenActive('usage');
  return getActiveView() === 'usage';
}

function requestUsageReportIfVisible() {
  if (!isUsageSurfaceVisible()) return;
  requestUsageReport();
}

const messageHandlers = {
  'snapshot':           (msg) => { noteServerBuild(msg.serverBuild); handleSnapshot(msg.sessions); },

  'hooks-report':       (msg) => applyHooksReport(msg),
  'save-hook-result':   (msg) => applySaveHookResult(msg),
  'delete-hook-result': (msg) => applyDeleteHookResult(msg),
  'hooks-updated':      () => requestHooksReportIfVisible(),

  'state-change':       (msg) => handleStateChange(msg),
  'session-added':      (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, saneYolo: !!msg.saneYolo, worktree: !!msg.worktree, workspace: !!msg.workspace, path: msg.path, stateSince: msg.stateSince, taskTitle: typeof msg.taskTitle === 'string' ? msg.taskTitle : null, taskTitleIsCustom: msg.taskTitleIsCustom === true }); setSessionAgent(msg.id, msg.agent); restoreUsageChip(msg.id); } refreshFavicon(sessionUIs); if (isFocusActive()) refreshFocusRoster(); refreshAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-removed':    (msg) => { removeSessionCard(msg.id); forgetReviewSession(msg.id); refreshFavicon(sessionUIs); if (isFocusActive()) refreshFocusRoster(); refreshAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-title': (msg) => { setSessionTaskTitle(msg.id, msg.taskTitle, msg.isCustom); if (isFocusActive()) refreshFocusRoster(); refreshAttentionSurfaces(); },
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-modified':   (msg) => {
    if (!msg.ephemeral) noteKnownProjectPath(msg.path);
    const previousUi = sessionUIs.get(String(msg.id));
    removeSessionCard(msg.id);
    forgetReviewSession(msg.id);
    createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, saneYolo: !!msg.saneYolo, worktree: !!msg.worktree, workspace: !!msg.workspace, path: msg.path, stateSince: msg.stateSince, taskTitle: typeof msg.taskTitle === 'string' ? msg.taskTitle : null, taskTitleIsCustom: msg.taskTitleIsCustom === true });
    setSessionAgent(msg.id, msg.agent);
    carryOverClientSessionFields(msg.id, previousUi);
    refreshFavicon(sessionUIs);
    if (isFocusActive()) refreshFocusRoster();
    refreshAttentionSurfaces();
    syncTraceSessionsFromCards();
  },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),

  'session-agents':     (msg) => { setSessionAgents(msg.id, msg.activeAgents, msg.awaitingBackgroundTasks); if (isFocusActive()) refreshFocusRoster(); refreshAttentionSurfaces(); handleDebugStateRefresh(msg.id); },
  'session-wakeup':     (msg) => setSessionWakeup(msg.id, msg.pendingWakeup),
  'session-prompt':     (msg) => { setSessionPrompt(msg.id, msg.pendingPromptKind, msg.pendingPromptDetail ?? null); refreshAttentionSurfaces(); },
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus, msg.reason); setFocusMergeStatus(msg.id, msg.mergeStatus); refreshAttentionSurfaces(); },
  'session-worktree-blocked': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'integration branch not found'}`, { persist: true }); },
  'session-worktree-warning': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'base branch warning'}`); },
  'session-worktree-ready': (msg) => { setSessionEffectiveBase(msg.id, msg.base); },
  'session-diff':       (msg) => { applyCalmSessionDiff(msg); setSessionDiff(msg.id, { committed: msg.committed, uncommitted: msg.uncommitted, hasCommits: msg.hasCommits }); },
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
  'settings-updated':   (msg) => { if (msg.settings) { applyTerminalSettings(msg.settings); applySettingsBroadcast(msg.settings); applyVisionsSettings(msg.settings); applySurfaceSettings(msg.settings, { isLiveSettingsChange: true }); syncTelemetryBanner(msg.settings); } },
  'health-snapshot':    (msg) => { if (msg.stats) applyHealthSnapshot(msg.stats as HealthSnapshot & ServerMessageOf<'health-snapshot'>['stats']); },
  'posthog-status':     (msg) => applyPosthogStatus(msg),
  'posthog-investigation-activity': (msg) => applyInvestigationActivity(msg),
  'posthog-investigation-finished': (msg) => applyInvestigationFinished(msg),
  'team-review-status': (msg) => applyTeamReviewStatus(msg),
  'my-prs-status': (msg) => applyMyPrsStatus(msg),
  'benchmark-status': (msg) => applyBenchmarkStatus(msg),
  'benchmark-action-result': (msg) => applyBenchmarkActionResult(msg),
  'my-pr-merge-result': (msg) => applyMyPrMergeResult(msg),
  'team-review-action-result': (msg) => applyTeamReviewActionResult(msg),
  'issues-report':      (msg) => applyIssuesReport(msg),
  'open-issue-session-result': (msg) => applyOpenIssueSessionResult(msg),
  'usage-sessions':     (msg) => { applyUsageSessionChips(msg.sessions); applyUsageSessions(msg); requestUsageReportIfVisible(); },
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
  'shutting-down':      () => {
    connectionEl.dataset.state = 'shutdown';
    connectionLabel.textContent = 'Shutting down...';
    connectionEl.title = 'Shutting down...';
    queryTag(document, '#btn-power', 'button').disabled = true;
    showShutdownOverlay('Shutting down sessions...');
  },
  'restarting':         () => {
    connectionEl.dataset.state = 'shutdown';
    connectionLabel.textContent = 'Restarting...';
    connectionEl.title = 'Restarting...';
    queryTag(document, '#btn-power', 'button').disabled = true;
    showShutdownOverlay('Restarting server...');
  },
} satisfies { [Type in ServerMessage['type']]?: (message: ServerMessageOf<Type>) => void };

const handlersByType: { [Type in ServerMessage['type']]?: (message: ServerMessageOf<Type>) => void } = messageHandlers;

function dispatchControlMessage<Type extends ServerMessage['type']>(message: { [Variant in ServerMessage['type']]: ServerMessageOf<Variant> }[Type]) {
  const handler = handlersByType[message.type];
  if (handler) handler(message);
}

onControlMessage((msg) => {
  dispatchControlMessage(msg);
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

function syncMuteButton() {
  btnMute.setAttribute('aria-pressed', String(!isSoundEnabled()));
}
syncMuteButton();

btnMute.addEventListener('click', () => {
  setSoundEnabled(!isSoundEnabled());
  syncMuteButton();
});

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
  const target = resolveSettingsTarget(hash);
  return activateSettingsTarget(target);
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

queryTag(document, '#btn-help', 'button').addEventListener('click', () => {
  openSettings('browser-shortcuts');
});

const viewCalmEl = queryTag(document, '#view-calm', 'section');
const tabCalm = queryTag(document, '#tab-calm', 'button');
const viewFocusEl = queryTag(document, '#view-focus', 'section');
const viewRadarEl = queryTag(document, '#view-radar', 'section');
const viewPrsEl = queryTag(document, '#view-prs', 'section');
const viewIssuesEl = queryTag(document, '#view-issues', 'section');
const viewUsageEl = queryTag(document, '#view-usage', 'section');
const viewVisionsEl = queryTag(document, '#view-visions', 'section');
const viewHooksEl = queryTag(document, '#view-hooks', 'section');
const viewTraceEl = queryTag(document, '#view-trace', 'section');
const viewBenchmarksEl = queryTag(document, '#view-benchmarks', 'section');
const viewSettingsEl = queryTag(document, '#view-settings', 'section');
const tabFocus = queryTag(document, '#tab-focus', 'button');
const tabRadar = queryTag(document, '#tab-radar', 'button');
const tabPrs = queryTag(document, '#tab-prs', 'button');
const tabIssues = queryTag(document, '#tab-issues', 'button');
const tabUsage = queryTag(document, '#tab-usage', 'button');
const tabVisions = queryTag(document, '#tab-visions', 'button');
const tabHooks = queryTag(document, '#tab-hooks', 'button');
const tabTrace = queryTag(document, '#tab-trace', 'button');
const tabBenchmarks = queryTag(document, '#tab-benchmarks', 'button');
const tabSettings = queryTag(document, '#tab-settings', 'button');
const tabRadarActivityEl = queryTag(document, '#tab-radar-activity', 'span');
const tabPrsActivityEl = queryTag(document, '#tab-prs-activity', 'span');
const tabUsageActivityEl = queryTag(document, '#tab-usage-activity', 'span');
const tabVisionsActivityEl = queryTag(document, '#tab-visions-activity', 'span');

setRadarActivityCallback((active) => {
  tabRadarActivityEl.classList.toggle('active', active);
  setPhoneScreenAttention('radar', active);
});
setTeamReviewActivityCallback((active) => {
  tabPrsActivityEl.classList.toggle('active', active);
  setPhoneScreenAttention('prs', active);
});
setUsageActivityCallback((active) => {
  tabUsageActivityEl.classList.toggle('active', active);
  setPhoneScreenAttention('usage', active);
});
setVisionsActivityCallback((level) => {
  const active = level !== null;
  tabVisionsActivityEl.classList.toggle('active', active);

  if (!active) tabVisionsActivityEl.removeAttribute('data-attention');
  if (active) tabVisionsActivityEl.setAttribute('data-attention', level);
  setPhoneScreenAttention('visions', level);
});

mountFocusView({
  rail: document.getElementById('focus-rail'),
  center: document.getElementById('focus-center'),
  resizer: document.getElementById('focus-rail-resizer'),
});

mountReviewSidebar({ panel: document.getElementById('review-sidebar') });

mountRadarView(viewRadarEl);

mountPrsView(viewPrsEl);

mountIssuesView(viewIssuesEl);

mountUsageView(viewUsageEl);

mountVisionsView(viewVisionsEl);

mountHooksView(viewHooksEl);

mountTraceView(viewTraceEl);

mountBenchmarkView(viewBenchmarksEl);

mountSettingsView(viewSettingsEl, { onRestart: confirmServerRestart, onConfirmUpdateAndRestart: confirmUpdateAndRestart });

mountCalmView(viewCalmEl, { openTerminal: (id) => { activateView('focus'); centerSessionQuietly(id); }, openPlan: (id) => { activateView('focus'); openPlanInFocus(id); }, openCalm: () => activateView('calm') });
const focusHeaderAccessorySlot = getFocusHeaderAccessorySlot();
if (focusHeaderAccessorySlot) mountNowPeek(focusHeaderAccessorySlot);
uiState.subscribe((_state, changedKeys) => {
  if (changedKeys.includes('focusedSessionId')) refreshFocusNowPeek();
});

const VIEW_TABS = [
  { view: 'calm', tab: tabCalm, el: viewCalmEl },
  { view: 'focus', tab: tabFocus, el: viewFocusEl },
  { view: 'prs', tab: tabPrs, el: viewPrsEl },
  { view: 'issues', tab: tabIssues, el: viewIssuesEl },
  { view: 'usage', tab: tabUsage, el: viewUsageEl },
  { view: 'radar', tab: tabRadar, el: viewRadarEl },
  { view: 'visions', tab: tabVisions, el: viewVisionsEl },
  { view: 'hooks', tab: tabHooks, el: viewHooksEl },
  { view: 'trace', tab: tabTrace, el: viewTraceEl },
  { view: 'benchmarks', tab: tabBenchmarks, el: viewBenchmarksEl },
  { view: 'settings', tab: tabSettings, el: viewSettingsEl },
];

function isViewAvailable(view: string) {
  return VIEW_TABS.some((viewTab) => viewTab.view === view && !viewTab.tab.hidden);
}

let shouldPersistActiveView = true;
let savedViewAwaitingSurface: string | null = null;
function acknowledgeViewAttention(view: string) {
  if (view === 'radar') acknowledgeRadarAttention();
  if (view === 'prs') acknowledgePrsViewAttention();
  if (view === 'usage') acknowledgeUsageAttention();
  if (view === 'visions') {
    acknowledgeVisionsAttention();
    refreshVisionsView();
  }
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

  if (persist) setActiveView(view);
  for (const v of VIEW_TABS) {
    const selected = v.view === view;
    if (v.el) v.el.hidden = !selected;
    v.tab.setAttribute('aria-selected', String(selected));
    v.tab.tabIndex = selected ? 0 : -1;
  }

  if (prev === 'focus' && view !== 'focus') deactivateFocusView();
  if (view === 'focus') activateFocusView();
  if (prev === 'calm' && view !== 'calm') deactivateCalmView();
  if (view === 'calm') activateCalmView();

  if (view === 'usage') {
    refreshUsageView();
    requestUsageReport();
  }
  if (view === 'hooks') {
    refreshHooksView();
    requestHooksReport();
  }
  if (view === 'trace') refreshTraceView();
  if (prev === 'settings' && view !== 'settings') clearSettingsHash();
  if (view === 'settings' && section) activateSettingsSection(section, setting ?? null);
  acknowledgeViewAttention(view);
  refreshFocusNowPeek();
}

let isTraceSurfaceAvailable = false;
function setSurfaceAvailable(view: string, isAvailable: boolean) {
  const viewTab = VIEW_TABS.find((entry) => entry.view === view);
  if (!viewTab) return;
  viewTab.tab.hidden = !isAvailable;
  setPhoneScreenAvailable(view, isAvailable);
  if (view === 'trace') {
    isTraceSurfaceAvailable = isAvailable;
    setRadarTraceOpener(isAvailable ? openTraceForSession : null);
  }
  if (isPhoneShellActive()) return;
  if (!isAvailable && getActiveView() === view) activateView('focus');
  if (!isAvailable) return;
  if (savedViewAwaitingSurface !== view) return;
  activateView(view);
}

let lastAppliedCalmSurface: boolean | null = null;
function applySurfaceSettings(settings: Parameters<typeof availableSurfacesFromSettings>[0], { isLiveSettingsChange = false } = {}) {
  const surfaces = availableSurfacesFromSettings(settings);
  const hasOperatorTurnedCalmOn = isLiveSettingsChange && lastAppliedCalmSurface === false && surfaces.calm;
  lastAppliedCalmSurface = surfaces.calm;
  isCalmSurfaceAvailable = surfaces.calm;
  setPhoneCalmAvailable(surfaces.calm);
  setFocusRailShown(!surfaces.calm);
  refreshFocusNowPeek();
  for (const [view, isAvailable] of Object.entries(surfaces)) setSurfaceAvailable(view, isAvailable);
  if (!hasOperatorTurnedCalmOn || getActiveView() !== 'focus' || isPhoneLayout() || resolvePlanTarget(location.hash)) return;
  activateView('calm');
}

for (const view of Object.keys(availableSurfacesFromSettings(null))) setSurfaceAvailable(view, false);
onDebugModeChanged((isDebugModeEnabled) => setSurfaceAvailable('trace', isDebugModeEnabled));
setSurfaceAvailable('trace', false);

setTraceNavigate(() => {
  if (!isTraceSurfaceAvailable) return;
  if (showPhoneScreen('trace')) return;
  activateView('trace');
});

for (let i = 0; i < VIEW_TABS.length; i++) {
  const { view, tab } = VIEW_TABS[i];
  tab.addEventListener('click', () => activateView(view));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const availableTabs = VIEW_TABS.filter((viewTab) => !viewTab.tab.hidden);
    const availableIndex = availableTabs.findIndex((viewTab) => viewTab.tab === tab);
    const next = (availableIndex + dir + availableTabs.length) % availableTabs.length;
    activateView(availableTabs[next].view);
    availableTabs[next].tab.focus();
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
  radarPanelEl: viewRadarEl,
  prsPanelEl: viewPrsEl,
  issuesPanelEl: viewIssuesEl,
  usagePanelEl: viewUsageEl,
  visionsPanelEl: viewVisionsEl,
  hooksPanelEl: viewHooksEl,
  tracePanelEl: viewTraceEl,
  settingsPanelEl: viewSettingsEl,

  onScreenShown: (screenId: string) => {
    if (screenId === 'usage') { refreshUsageView(); requestUsageReport(); }
    if (screenId === 'hooks') { refreshHooksView(); requestHooksReport(); }
    if (screenId === 'trace') refreshTraceView();
    if (screenId !== 'settings') clearSettingsHash();
    if (screenId === 'settings' && !location.hash.startsWith('#settings/')) activateSettingsSection();
    acknowledgeViewAttention(screenId);
  },

  headerControls: [
    queryTag(document, '#status-indicator', 'div'),
    queryTag(document, '#btn-add-session-header', 'button'),
    queryTag(document, '#btn-help', 'button'),
    btnMute,
    powerMenu,
  ],
});

function applyFormFactorLayout(layout: string) {
  if (layout === 'phone') {
    const carriedSessionId = getFocusedSessionId();
    deactivateFocusView();
    deactivateCalmView();
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

function confirmServerRestart() {
  powerMenu.classList.remove('open');
  syncPowerMenuAria();
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0
    ? `Kill ${count} session${suffix} and restart the server?`
    : 'Restart the server?';
  openConfirmDialog({
    title: 'Restart Server',
    message,
    confirmLabel: 'Restart',
    danger: false,
    onConfirm: () => sendControlMsg({ type: 'restart-server' }),
  });
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
  powerMenu.classList.remove('open');
  syncPowerMenuAria();
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0
    ? `Kill ${count} session${suffix} and shut down the server?`
    : 'Shut down the server?';
  openConfirmDialog({
    title: 'Shut Down Server',
    message,
    confirmLabel: 'Shut Down',
    danger: true,
    onConfirm: () => sendControlMsg({ type: 'shutdown' }),
  });
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

let _focusDebounce: number | null = null;

function sendFocusState() {
  if (_focusDebounce !== null) clearTimeout(_focusDebounce);
  _focusDebounce = setTimeout(() => {
    sendControlMsg({ type: 'focus-change', focused: document.hasFocus() });
  }, 150);
}

function noteViewerFocusEdge() {
  sendFocusState();
  syncGridOnEngagementEdge(findSessionUi(getBorrowedCardId()));
}

window.addEventListener('focus', noteViewerFocusEdge);
window.addEventListener('blur', noteViewerFocusEdge);
document.addEventListener('visibilitychange', noteViewerFocusEdge);

let _wakeLivenessCheckRunning = false;

async function checkWakeLiveness() {
  if (_wakeLivenessCheckRunning) return;
  _wakeLivenessCheckRunning = true;
  try {
    const state = await checkControlLiveness();
    if (state !== 'dead') return;
    for (const id of sessionUIs.keys()) reconnectDataWs(id);
  } finally {
    _wakeLivenessCheckRunning = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
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

connectControl();
