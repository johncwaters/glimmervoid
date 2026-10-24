import { applyGithubPrsFrame } from './github/github-prs-store.ts';
import './tailwind.css';

import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { BrowserConfig } from '#shared/contracts/browser-config.ts';
import { shouldShowServerAction } from '#shared/client-trust.ts';
import { createCoalescedTimer } from '#shared/coalesce-timer.ts';
import { STATES } from '#shared/states.ts';
import { trackedReportNoticeText } from '#shared/post-turn-leftovers.ts';
import { getBorrowedCardId } from './card-host.ts';
import { createClientErrorReporter } from './client-error-core.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from './flying-animal-preview.ts';
import { checkControlLiveness, connectControl, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.ts';
import { applyAgentLogins, createAddSessionDialog } from './dialogs.ts';
import { refreshFirstRunChecklist } from './onboarding/first-run-checklist.ts';
import { applySessionDocsChanged, applySessionDocsSnapshot } from './doc-editor.ts';
import { applyCoherenceJournalResponse, applySessionCoherence, applySessionCoherenceSnapshot, forgetSessionCoherence, isSessionJournalReadable, openCoherenceJournal, sessionRowCoherenceSignals, setSessionCoherenceHooks } from './coherence/journal-drawer.ts';
import { observeHeaderHeight, queryTag, writeClipboardText } from './dom-helpers.ts';
import { routeExternalAnchorsThroughHost } from './external-link.ts';
import type { FeatureSurfaceSettings } from './feature-surfaces-core.ts';
import { refreshFavicon } from './favicon.ts';
import { activateFocusOnNextAttention, centerSessionQuietly, focusAdjacentInRail, focusNextAttention, focusNthInRail, getFocusedSessionId, isFocusActive, openPlanInFocus, refreshFocusRoster, restoreFocusedSession, setFocusMergeStatus } from './focus-view/focus-view.ts';
import { initFormFactor, isPhoneLayout, onLayoutChange } from './form-factor.ts';
import type { HealthSnapshot } from './health-monitor.ts';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.ts';
import { applyIngestActivity, applyIngestSnapshot, applyVisionsComments, applyVisionsFindings, applyVisionsFix, applyVisionsHand, applyVisionsIntent, applyVisionsSettings, applyVisionsSnapshot, setVisionsProjectNames } from './visions/visions-panel.ts';
import { applyHooksReport, applyLateHookResult, setHooksRequestSender } from './hooks-panel.ts';
import { showDesktopNotification } from './notifications.ts';
import { clearUnsourcedError, reportUnsourcedError } from './action-status.ts';
import { phonePanelsFromDesktopViews } from './phone/phone-panels-core.ts';
import { activatePhoneShell, deactivatePhoneShell, getPhoneSessionId, isPhoneShellActive, mountPhoneShell, orderPhonePanels, refreshPhoneBoard, setPhoneScreenAttention, setPhoneScreenAvailable, showPhonePlan, showPhoneScreen, showPhoneSession, syncPhoneHistory } from './phone/phone-shell.ts';
import { noteKnownProjectPath } from './project-registry.ts';
import { applyOpenTeamReviewSessionResult, applyTeamReviewActionResult, applyTeamReviewStatus } from './github/team-review-panel.ts';
import { applyMyPrMergeResult, applyMyPrsStatus, refreshMyPrsSessionState } from './github/my-prs-panel.ts';
import { forgetSessionLinkedPrs, paintSessionPrChips, sessionRowPrSignals, setSessionLinkedPrs } from './github/session-pr-chips.ts';
import { addSessionRowSignalSource } from './session-row.ts';
import { mountCelebrationTray } from './merge-celebration.ts';
import { mountMuteButton } from './mute-button.ts';
import { applyBenchmarkActionResult, applyBenchmarkStatus, setBenchmarkRequestSender } from './benchmark-panel.ts';
import { applyIssueDetailResult, refreshIssuesSessionState, applyIssuesStatus, applyOpenIssueSessionResult, setIssuesRequestSender } from './github/issues-panel.ts';

import { UPDATES_ACTIONS_SETTING_ID, UPDATES_SECTION_ID } from './radar/radar-core.ts';
import { applyInvestigationActivity, applyInvestigationFinished, applyRadarStatus } from './radar/radar-panel.ts';
import { handleDebugStateRefresh, handleDebugStateResponse, setCardCoherenceJournal, setLinkedPrsPainter, setCardSessionSetup, setSessionSaneYolo } from './session-card/card-dom.ts';
import { applySessionSetupResponse, openSessionSetup } from './session-setup/setup-dialog.ts';
import { findSessionUi, sessionName, sessionUIs } from './session-card/card-registry.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { buildSessionCardOptions } from './session-card/card-options-core.ts';
import { applyConversationTraceChanged, applyConversationTraceError, applyConversationTraceResponse, applyPlanConnectionState, applySessionPlanChanged, applySessionPlanDraft, applySessionPlanError, reportSessionProblem, applySessionPlanResponse, applyState, applyTerminalSettings, createSessionCard, refreshTerminalFonts, getSessionCount, hasSession, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setSessionTaskTitle, setSessionAgent, setSessionAgents, setSessionConversation, setConversationViewEnabled, setSessionDiff, setSessionEffectiveBase, setSessionFailureReason, setSessionHasPlan, setSessionMergeStatus, setSessionPostTurn, setSessionPrompt, setSessionUnseenOutcome, setSessionUsage, setSessionGuarded, setSessionWakeup, setSessionWorktree, updateAttentionTitle } from './session-card/lifecycle.ts';
import { resolvePlanTarget } from './plan/plan-link.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { countConnectingTerminals, holdTerminalInputDuringWakeCheck, onTerminalLinkChange, reconnectDataWs, releaseHeldTerminalInput, syncGridOnEngagementEdge } from './session-card/terminal.ts';
import { rebuildWebglGlyphAtlases } from './session-card/webgl-pool.ts';
import { activateSettingsSection, applySettingsBroadcast, applySettingsProjects, applySettingsUpdateProgress, applySettingsUpdateStatus, canReturnToSettingsList, applySettingsUpdateError, onPhoneSettingsScreenChanged, refreshSettingsStatus, resolveSettingsTarget, returnToSettingsList, setFeatureTabViews } from './settings/settings-panel.ts';
import { forgetReviewSession, mergeSelectedSession, mountReviewSidebar, notifyWorktreeChanged, refreshReviewSidebar, releaseReviewMergeRequest, resolveSelectedSession, resyncSelectedSession, setReviewBranchSync, setReviewDiffError, setSessionChangeMap } from './sidebar/review-sidebar.ts';
import { decideReloadOnBuild } from './server-build-core.ts';
import { createSettingsLink, isSettingsHash } from './settings/settings-link.ts';
import { currentNextAttentionKeyCode, SHORTCUT_PLATFORM } from './shortcuts.ts';
import { resolveDashboardShortcut } from './shortcuts-core.ts';
import type { ResolvedDashboardShortcut } from './shortcuts-core.ts';
import { applyFlyingAnimals } from './flying-animals.ts';
import { mountStreamerToggle, onStreamerModeChanged, setStreamerMode, toggleStreamerMode } from './streamer-mode.ts';
import { mountStreamerTextMask } from './streamer-text-mask.ts';
import { applyPhoneArrowPad, applySessionUsageChips, applyTheme } from './theme.ts';
import { applyTraceChanged, applyTraceError, applyTraceResponse, setTraceNavigate, setTraceRequestSender, setTraceSessions } from './trace-panel.ts';
import { shouldShowTelemetryNotice } from './telemetry-notice-core.ts';
import { getActiveView as getSavedActiveView, getDismissedUpdate, getThemeId, isFlyingAnimalsEnabled, isPhoneArrowPad, isSessionUsageChips, isTelemetryNoticeDismissed, setActiveView, setDismissedUpdate, setTelemetryNoticeDismissed } from './ui-prefs.ts';
import { getActiveView, uiState } from './ui-state-core.ts';
import { updateBanner } from './updates-view-core.ts';
import { decideAppReveal, MAX_REVEAL_WAIT_MS } from './app-reveal-core.ts';
import { whenBundledMonoFontLoads } from './mono-font.ts';
import { applyPlanLimits, applyUsageReport, applyUsageSessions, setUsageRequestSender } from './usage/usage-panel.ts';
import { createDashboardViews } from './view-registry.ts';
import { isZenActive, refreshZenView, stageNextAttention } from './zen-view/zen-view.ts';
import type { DashboardView } from './view-registry.ts';
import { moveViewId, orderViewIds, refreshViewOnReason, refreshVisibleViews, viewAvailabilityFromSettings } from './view-registry-core.ts';
import type { ViewRefreshReason } from './view-registry-core.ts';

applyTheme(getThemeId());
applySessionUsageChips(isSessionUsageChips());
applyPhoneArrowPad(isPhoneArrowPad());
applyFlyingAnimals(isFlyingAnimalsEnabled());

initFormFactor();
routeExternalAnchorsThroughHost(document);

const connectionEl = queryTag(document, '#connection-status', 'span');
const connectionLabel = queryTag(connectionEl, '.connection-label', 'span');

const loadingScreen = queryTag(document, '#loading-screen', 'div');
const loadingStatus = queryTag(document, '#loading-status', 'div');
const loadingDetail = queryTag(document, '#loading-detail', 'div');
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

const SERVER_UNREACHABLE_HINT_DELAY_MS = 10000;
const SERVER_UNREACHABLE_TEXT = 'The server is not answering. Check the terminal running Glimmervoid for errors, or start it again with glimmervoid. This page reconnects on its own.';
const SERVER_UNREACHABLE_LOADING_DETAIL = 'Server not answering. Check the Glimmervoid terminal for errors, or run glimmervoid. This page retries on its own.';
let serverUnreachableHintTimer: number | null = null;
let isServerUnreachableHintShown = false;

function showReconnectingLoadingStatus() {
  loadingStatus.textContent = 'Reconnecting to server...';
  loadingDetail.textContent = SERVER_UNREACHABLE_LOADING_DETAIL;
  loadingDetail.hidden = !isServerUnreachableHintShown;
}

function showServerUnreachableHint() {
  serverUnreachableHintTimer = null;
  isServerUnreachableHintShown = true;
  if (!appRevealed) {
    showReconnectingLoadingStatus();
    return;
  }
  reportUnsourcedError(SERVER_UNREACHABLE_TEXT, { hidesInStreamerMode: false });
}

function scheduleServerUnreachableHint() {
  if (serverUnreachableHintTimer !== null || isServerUnreachableHintShown) return;
  serverUnreachableHintTimer = window.setTimeout(showServerUnreachableHint, SERVER_UNREACHABLE_HINT_DELAY_MS);
}

function clearServerUnreachableHint() {
  if (serverUnreachableHintTimer !== null) window.clearTimeout(serverUnreachableHintTimer);
  serverUnreachableHintTimer = null;
  isServerUnreachableHintShown = false;
  loadingDetail.hidden = true;
  clearUnsourcedError(SERVER_UNREACHABLE_TEXT);
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
    clearServerUnreachableHint();
    if (unsentShownView) reportViewShown(unsentShownView);
    if (shutdownScreen.classList.contains('active')) {
      location.reload();
      return;
    }
    refreshFirstRunChecklist();
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
  scheduleServerUnreachableHint();
  if (!appRevealed) showReconnectingLoadingStatus();
});

function refreshAttentionSurfaces() {
  refreshZenView();
  refreshIssuesSessionState();
  refreshMyPrsSessionState();
  refreshPhoneBoard();
}

function refreshRosterAndAttentionSurfaces() {
  refreshFocusRoster();
  refreshAttentionSurfaces();
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
    setSessionCoherenceHooks(s.id, s.coherenceHooks);
    if (!s.ephemeral) noteKnownProjectPath(s.path);
    setSessionLinkedPrs(s.id, s.linkedPrs);
    const exists = hasSession(s.id);
    if (exists) applyState(s.id, s.state, s.stateSince);
    if (exists) setSessionSaneYolo(s.id, !!s.saneYolo);
    if (exists) setSessionGuarded(s.id, s.isGuarded, s.isGuardrailsReleased);
    if (!exists) createSessionCard(s.id, s.name, s.state, buildSessionCardOptions(s));
    setSessionFailureReason(s.id, s.failureReason);

    setSessionTaskTitle(s.id, s.taskTitle, s.taskTitleIsCustom);
    setSessionAgent(s.id, s.agent);

    seedSessionMergeStatus(s.id, s.mergeStatus, s.mergeReason);
    setSessionEffectiveBase(s.id, s.effectiveBase);

    setSessionAgents(s.id, s.activeAgents, s.awaitingBackgroundTasks);
    setSessionWakeup(s.id, s.pendingWakeup);

    setSessionPrompt(s.id, s.pendingPromptKind, s.isCompacting, s.isWaitingForMemory);
    setSessionUnseenOutcome(s.id, s.unseenOutcome);
    setSessionConversation(s.id, s);

    setSessionHasPlan(s.id, s.hasPlan);

    restoreUsageChip(s.id);
  }
  updateAttentionTitle();
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
  setSessionUnseenOutcome(sessionId, previousUi?.unseenOutcome);
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
    createSessionCard(msg.id, msg.session, STATES.DORMANT, buildSessionCardOptions({ skipPerms, saneYolo, worktree: card?.dataset.worktree !== undefined, workspace: card?.dataset.workspace !== undefined, remoteWorkspace: card?.dataset.remoteWorkspace ?? null, guarded: card?.dataset.guarded !== undefined, guardrailsReleased: card?.dataset.guardrailsReleased !== undefined, ephemeral: card?.dataset.ephemeral !== undefined, path, stateSince: msg.timestamp, taskTitle: previousUi?.taskTitle, taskTitleIsCustom: previousUi?.taskTitleIsCustom }));
    setSessionAgent(msg.id, previousUi?.agent);
    carryOverClientSessionFields(msg.id, previousUi);
    refreshRosterAndAttentionSurfaces();
    refreshReviewSidebar(msg.id);
    refreshFavicon(sessionUIs);
    return;
  }

  applyState(msg.id, msg.to, msg.timestamp, msg.event);
  setSessionFailureReason(msg.id, msg.failureReason);
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
setLinkedPrsPainter(paintSessionPrChips);
addSessionRowSignalSource(sessionRowCoherenceSignals);
addSessionRowSignalSource(sessionRowPrSignals);
setCardCoherenceJournal({ isReadable: isSessionJournalReadable, open: openCoherenceJournal });
setCardSessionSetup(openSessionSetup);

function refreshViewsIfVisible(reason: ViewRefreshReason) {
  refreshVisibleViews(VIEW_TABS, { isPhoneShellActive: isPhoneShellActive(), activeView: getActiveView(), phoneScreen: uiState.snapshot().phoneScreen }, reason);
}

onStreamerModeChanged(() => refreshViewsIfVisible('settings-updated'));

const messageHandlers = {
  'snapshot':           (msg) => { noteServerBuild(msg.serverBuild); handleSnapshot(msg.sessions); },

  'hooks-report':       (msg) => applyHooksReport(msg),
  'save-hook-result':   () => applyLateHookResult(),
  'delete-hook-result': () => applyLateHookResult(),

  'state-change':       (msg) => handleStateChange(msg),
  'session-added':      (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); setSessionLinkedPrs(msg.id, msg.linkedPrs); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg)); setSessionAgent(msg.id, msg.agent); restoreUsageChip(msg.id); } refreshFavicon(sessionUIs); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-removed':    (msg) => { removeSessionCard(msg.id); forgetSessionCoherence(msg.id); forgetReviewSession(msg.id); forgetSessionLinkedPrs(msg.id); refreshFavicon(sessionUIs); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-title': (msg) => { setSessionTaskTitle(msg.id, msg.taskTitle, msg.isCustom); refreshRosterAndAttentionSurfaces(); },
  'session-prs': (msg) => setSessionLinkedPrs(msg.id, msg.linkedPrs),
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-modified':   (msg) => {
    if (!msg.ephemeral) noteKnownProjectPath(msg.path);

    const previousUi = sessionUIs.get(String(msg.id));
    setSessionCoherenceHooks(msg.id, null);
    removeSessionCard(msg.id);
    forgetReviewSession(msg.id);
    setSessionLinkedPrs(msg.id, msg.linkedPrs);
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
  'session-unseen':     (msg) => { setSessionUnseenOutcome(msg.id, msg.unseenOutcome); updateAttentionTitle(); refreshFavicon(sessionUIs); refreshRosterAndAttentionSurfaces(); },
  'session-prompt':     (msg) => { setSessionPrompt(msg.id, msg.pendingPromptKind, msg.isCompacting === true, msg.isWaitingForMemory === true); refreshAttentionSurfaces(); },
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus, msg.reason); setFocusMergeStatus(msg.id, msg.mergeStatus); refreshAttentionSurfaces(); },
  'session-worktree-blocked': (msg) => { reportUnsourcedError(`${msg.session}: ${msg.notice || 'integration branch not found'}`); },
  'session-worktree-warning': (msg) => { reportUnsourcedError(`${msg.session}: ${msg.notice || 'base branch warning'}`); },
  'session-worktree-ready': (msg) => { setSessionEffectiveBase(msg.id, msg.base); },
  'session-diff':       (msg) => { setSessionDiff(msg.id, { committed: msg.committed, uncommitted: msg.uncommitted, hasCommits: msg.hasCommits }); },
  'session-diff-error': (msg) => { setReviewDiffError(msg.id, msg.message); },
  'change-map':         (msg) => setSessionChangeMap(msg.id, msg.map),
  'branch-sync-status': (msg) => setReviewBranchSync(msg.id, msg),
  'session-changed':    (msg) => notifyWorktreeChanged(msg.id),
  'post-turn-result':   (msg) => setSessionPostTurn(msg.id, msg),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  'session-trace-response': (msg) => { if (applyConversationTraceResponse(msg)) return; applyTraceResponse(msg); },
  'session-trace-changed': (msg) => { applyConversationTraceChanged(msg.id); applyTraceChanged(msg); },
  'session-conversation': (msg) => { setSessionConversation(msg.id, msg); refreshAttentionSurfaces(); },
  'session-plan-changed': (msg) => { applySessionPlanChanged(msg); refreshAttentionSurfaces(); },
  'session-plan-draft': (msg) => { applySessionPlanDraft(msg); },
  'session-plan-response': (msg) => { applySessionPlanResponse(msg); },
  'session-docs-changed': (msg) => applySessionDocsChanged(msg),
  'session-docs-snapshot': (msg) => applySessionDocsSnapshot(msg),
  'session-coherence-hooks': (msg) => { setSessionCoherenceHooks(msg.id, msg.coherenceHooks); refreshRosterAndAttentionSurfaces(); },
  'session-coherence': (msg) => { applySessionCoherence(msg); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-snapshot': (msg) => { applySessionCoherenceSnapshot(msg); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-journal-response': (msg) => applyCoherenceJournalResponse(msg),
  'session-setup-response': (msg) => applySessionSetupResponse(msg),

  'notify':             (msg) => { showDesktopNotification(msg); handleDebugStateRefresh(msg.session); },
  'update-status':      (msg) => { showUpdateBanner(msg); applySettingsUpdateStatus(msg); },
  'update-progress':    (msg) => applySettingsUpdateProgress(msg.journal),
  'post-turn-leftovers': (msg) => showPostTurnLeftoversBanner(msg),
  'error':              (msg) => {
    const isUpdateErrorShownInline = applySettingsUpdateError(msg);
    const isTraceErrorShownInline = applyTraceError(msg);
    applyConversationTraceError(msg);
    const isPlanErrorShownInline = applySessionPlanError(msg);
    if (isUpdateErrorShownInline || isTraceErrorShownInline || isPlanErrorShownInline) return;
    reportUnsourcedError(msg.message);
  },
  'session-error':      (msg) => {
    releaseReviewMergeRequest(msg.id);
    if (applySessionPlanError(msg)) return;
    reportSessionProblem(msg.id, msg.message);
  },
  'settings-updated':   (msg) => {
    if (msg.settings) applyDashboardSettings(msg.settings);
    refreshFirstRunChecklist();
  },
  'agent-logins':       (msg) => applyAgentLogins(msg.logins),
  'health-snapshot':    (msg) => { if (msg.stats) applyHealthSnapshot(msg.stats as HealthSnapshot & ServerMessageOf<'health-snapshot'>['stats']); },
  'radar-status':     (msg) => applyRadarStatus(msg),
  'radar-investigation-activity': (msg) => applyInvestigationActivity(msg),
  'radar-investigation-finished': (msg) => applyInvestigationFinished(msg),
  'team-review-status': (msg) => applyTeamReviewStatus(msg),
  'github-prs': (msg) => applyGithubPrsFrame(msg),
  'my-prs-status': applyMyPrsStatus,
  'benchmark-status': (msg) => applyBenchmarkStatus(msg),
  'benchmark-action-result': (msg) => applyBenchmarkActionResult(msg),
  'my-pr-merge-result': (msg) => applyMyPrMergeResult(msg),
  'team-review-action-result': (msg) => applyTeamReviewActionResult(msg),
  'open-team-review-session-result': (msg) => applyOpenTeamReviewSessionResult(msg),
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

let dismissedUpdateBannerIdentity: string | null | undefined;
let dismissedSecurityNoticeText: string | null = null;

function bindBannerCopy(copyButton: HTMLButtonElement, copyStatus: HTMLSpanElement, text: string) {
  copyButton.onclick = () => {
    const write = writeClipboardText(text);
    if (!write) {
      copyStatus.textContent = 'Copy failed';
      return;
    }
    write
      .then(() => { copyStatus.textContent = 'Copied'; })
      .catch(() => { copyStatus.textContent = 'Copy failed'; });
  };
}

const UPDATES_SECTION_HREF = createSettingsLink(UPDATES_SECTION_ID, UPDATES_ACTIONS_SETTING_ID, 'Update').href;

function updateIdentity(msg: ServerMessageOf<'update-status'>) {
  const { latestSha, latest } = msg;
  if (typeof latest === 'string' && latest) return latest;
  if (typeof latestSha === 'string' && latestSha) return latestSha;
  return null;
}

function showUpdateBanner(msg: ServerMessageOf<'update-status'>) {
  const banner = queryTag(document, '#update-banner', 'div');
  const { mode, tone, text } = updateBanner(msg);
  const isSecurityNotice = tone === 'security';
  if (!msg.updateAvailable && !isSecurityNotice) {
    banner.hidden = true;
    return;
  }
  const updateId = updateIdentity(msg);
  const identity = updateId && mode === 'restart' ? `${updateId}:ready` : updateId;
  if (isSecurityNotice && text === dismissedSecurityNoticeText) return;
  if (!isSecurityNotice && dismissedUpdateBannerIdentity !== undefined && identity === dismissedUpdateBannerIdentity) return;
  if (!isSecurityNotice && identity && getDismissedUpdate() === identity) return;
  banner.classList.toggle('update-banner-security', isSecurityNotice);
  const command = String(msg.command ?? '');
  queryTag(document, '#update-banner-text', 'span').textContent = text;
  queryTag(document, '#update-banner-cmd', 'code').textContent = command;
  const updateLink = queryTag(document, '#update-banner-update', 'a');
  updateLink.href = UPDATES_SECTION_HREF;
  updateLink.hidden = mode !== 'link';
  const restartButton = queryTag(document, '#update-banner-restart', 'button');
  restartButton.hidden = mode !== 'restart';
  restartButton.onclick = confirmServerRestart;
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

  bindBannerCopy(copyBtn, copyStatus, command);
  queryTag(document, '#update-banner-dismiss', 'button').onclick = () => {
    banner.hidden = true;
    if (isSecurityNotice) {
      dismissedSecurityNoticeText = text;
      return;
    }
    dismissedUpdateBannerIdentity = identity;
    setDismissedUpdate(identity);
  };
}

let isPostTurnLeftoversBannerDismissed = false;

function showPostTurnLeftoversBanner({ repositories, command }: ServerMessageOf<'post-turn-leftovers'>) {
  const banner = queryTag(document, '#post-turn-leftovers-banner', 'div');
  if (repositories.length === 0) {
    banner.hidden = true;
    return;
  }
  if (isPostTurnLeftoversBannerDismissed) return;
  const copyStatus = queryTag(document, '#post-turn-leftovers-copy-status', 'span');
  queryTag(document, '#post-turn-leftovers-text', 'span').textContent = trackedReportNoticeText(repositories.length);
  queryTag(document, '#post-turn-leftovers-cmd', 'code').textContent = command;
  copyStatus.textContent = '';
  banner.hidden = false;
  bindBannerCopy(queryTag(document, '#post-turn-leftovers-copy', 'button'), copyStatus, command);
  queryTag(document, '#post-turn-leftovers-dismiss', 'button').onclick = () => {
    isPostTurnLeftoversBannerDismissed = true;
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
const btnStreamer = queryTag(document, '#btn-streamer', 'button');
mountStreamerToggle(btnStreamer);
mountStreamerTextMask();

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
  if (!isSettingsHash(location.hash)) return;
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

const NO_STORED_PLAN_TEXT = 'No plan is stored for this session yet.';

function activatePlanHash(hash: string) {
  const sessionId = resolvePlanTarget(hash);
  if (!sessionId) return false;
  if (!hasSession(sessionId)) return true;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  if (isPhoneShellActive()) {
    if (!showPhonePlan(sessionId)) reportUnsourcedError(NO_STORED_PLAN_TEXT);
    return true;
  }
  activateView('focus', { persist: false });
  if (!openPlanInFocus(sessionId)) reportUnsourcedError(NO_STORED_PLAN_TEXT);
  return true;
}

function activateHash(hash: string) {
  if (activatePlanHash(hash)) return true;
  return activateSettingsHash(hash);
}

function activateLocationHash(event: HashChangeEvent) {
  if (event.newURL !== location.href) return;
  activateHash(location.hash);
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
  openTerminal: (id) => {
    if (showPhoneSession(id)) return;
    activateView('focus');
    centerSessionQuietly(id);
  },
  openPlan: (id) => { activateView('focus'); openPlanInFocus(id); },
  openReviews: () => {
    if (!isViewAvailable('prs')) return false;
    if (showPhoneScreen('prs')) return true;
    activateView('prs');
    return true;
  },
  setPhoneAttention: setPhoneScreenAttention,
});

function currentViewOrder() {
  return VIEW_TABS.map((viewTab) => viewTab.view);
}

const DEFAULT_VIEW_ORDER = currentViewOrder();
setFeatureTabViews(VIEW_TABS);
mountReviewSidebar({ panel: document.getElementById('review-sidebar') });
for (const viewTab of VIEW_TABS) viewTab.mount(viewTab.el);


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

let unsentShownView: string | null = null;

function reportViewShown(view: string) {
  const isSent = sendControlMsg({ type: 'dashboard-telemetry', event: 'view_shown', properties: { view } });
  unsentShownView = isSent ? null : view;
}

function refreshViewOnShow(view: string) {
  const viewTab = findViewTab(view);
  refreshViewOnReason(viewTab, 'shown');
  if (viewTab) reportViewShown(view);
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

function applySurfaceSettings(settings: FeatureSurfaceSettings) {
  for (const { view, isAvailable } of viewAvailabilityFromSettings(VIEW_TABS, settings)) setSurfaceAvailable(view, isAvailable);
}

function applyTabOrder(savedViewOrder: readonly string[] | undefined) {
  const orderedViewIds = orderViewIds(DEFAULT_VIEW_ORDER, savedViewOrder);
  const isAlreadyOrdered = VIEW_TABS.every((viewTab, index) => viewTab.view === orderedViewIds[index]);
  if (isAlreadyOrdered) return;
  VIEW_TABS.sort((first, second) => orderedViewIds.indexOf(first.view) - orderedViewIds.indexOf(second.view));
  queryTag(document, '#header-tabs', 'div').append(...VIEW_TABS.map((viewTab) => viewTab.tab));
  orderPhonePanels(orderedViewIds);
}

function applyDashboardSettings(settings: FeatureSurfaceSettings & Pick<BrowserConfig, 'coherence' | 'viewTabOrder'> & { streamerMode?: boolean; conversationView?: boolean }) {
  applyTerminalSettings(settings);
  applySettingsBroadcast(settings);
  applyVisionsSettings(settings);
  applySurfaceSettings(settings);
  syncTelemetryBanner(settings);
  applyTabOrder(settings.viewTabOrder);
  setStreamerMode(settings.streamerMode === true);
  setConversationViewEnabled(settings.conversationView === true);
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

let draggedViewId: string | null = null;

function saveTabOrder(nextViewOrder: string[]) {
  const previousViewOrder = currentViewOrder();
  applyTabOrder(nextViewOrder);
  sendControlRequest('update-settings', { settings: { viewTabOrder: nextViewOrder } })
    .then((message) => {
      if (message.type === 'settings-error') applyTabOrder(previousViewOrder);
    })
    .catch(() => applyTabOrder(previousViewOrder));
}

function dropDraggedTabOn(targetView: string) {
  const movedView = draggedViewId;
  draggedViewId = null;
  if (!movedView || movedView === targetView) return;
  const viewOrder = currentViewOrder();
  saveTabOrder(moveViewId(viewOrder, movedView, viewOrder.indexOf(targetView)));
}

for (let i = 0; i < VIEW_TABS.length; i++) {
  const { view, tab } = VIEW_TABS[i];
  tab.addEventListener('click', () => activateView(view));
  tab.addEventListener('dragstart', (e) => {
    draggedViewId = view;
    e.dataTransfer?.setData('text/plain', view);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  tab.addEventListener('dragover', (e) => {
    if (!draggedViewId || draggedViewId === view) return;
    e.preventDefault();
    tab.dataset.dropTarget = 'true';
  });
  tab.addEventListener('dragleave', () => delete tab.dataset.dropTarget);
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    delete tab.dataset.dropTarget;
    dropDraggedTabOn(view);
  });
  tab.addEventListener('dragend', () => { draggedViewId = null; });
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
    if (screenId === 'settings' && !isSettingsHash(location.hash)) activateSettingsSection();
    acknowledgeViewAttention(screenId);
  },

  canGoBack: (screenId) => screenId === 'settings' && canReturnToSettingsList(),

  onBack: (screenId) => {
    if (screenId === 'settings') returnToSettingsList();
  },

  headerControls: [
    queryTag(document, '.header-title', 'h1'),
    queryTag(document, '#status-indicator', 'div'),
    queryTag(document, '#celebration-tray', 'div'),
    queryTag(document, '#btn-add-session-header', 'button'),
    queryTag(document, '#btn-help', 'button'),
    btnMute,
    btnStreamer,
    powerMenu,
  ],
});
onPhoneSettingsScreenChanged(syncPhoneHistory);

function applyFormFactorLayout(layout: string) {
  if (layout === 'phone') {
    const carriedSessionId = getFocusedSessionId();
    for (const viewTab of VIEW_TABS) viewTab.deactivate?.();
    const settingsTarget = resolveSettingsTarget(location.hash);
    activatePhoneShell({
      sessionId: carriedSessionId ?? undefined,
      linkedScreenId: settingsTarget ? 'settings' : undefined,
    });
    if (settingsTarget) activateSettingsSection(settingsTarget.sectionId, settingsTarget.settingId);
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
  openConfirmDialog({ title, message, confirmLabel, danger: danger || count > 0, onConfirm: () => sendControlMsg({ type }) });
}

function confirmServerRestart() {
  confirmServerPowerAction({ type: 'restart-server', title: 'Restart Server', confirmLabel: 'Restart', danger: false, idleMessage: 'Restart the server?', actionAfterKillingSessions: 'restart the server' });
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

const CURSOR_MOVEMENT_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

function isComposerOwningKey(composer: HTMLTextAreaElement, event: KeyboardEvent) {
  return composer.value !== '' && CURSOR_MOVEMENT_KEYS.has(event.key);
}

function isRealInputOwningKey(event: KeyboardEvent) {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement)) return false;
  if (a.isContentEditable) return true;
  if (a instanceof HTMLTextAreaElement && a.dataset.dashboardShortcuts === 'allowed') return isComposerOwningKey(a, event);
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
      if (isPhoneLayout()) return false;
      if (isZenActive()) {
        stageNextAttention();
        return true;
      }
      if (isFocusActive()) {
        focusNextAttention();
        return true;
      }
      activateFocusOnNextAttention(() => activateView('focus'));
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
    case 'streamer-mode':
      toggleStreamerMode();
      return true;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (isRealInputOwningKey(e)) return;
  const isTerminalFocused = document.activeElement?.classList.contains('xterm-helper-textarea') ?? false;
  const shortcut = resolveDashboardShortcut(e, SHORTCUT_PLATFORM, { isTerminalFocused }, currentNextAttentionKeyCode());
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

async function checkWakeLiveness() {
  if (_wakeLivenessCheckRunning) return;
  _wakeLivenessCheckRunning = true;
  holdTerminalInputDuringWakeCheck();
  try {
    const state = await checkControlLiveness();
    if (state === 'ok') return;
    for (const id of sessionUIs.keys()) reconnectDataWs(id);
  } finally {
    releaseHeldTerminalInput();
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

whenBundledMonoFontLoads(refreshTerminalFonts);

scheduleServerUnreachableHint();
connectControl();
