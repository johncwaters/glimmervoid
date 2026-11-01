import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { STATES } from '#shared/states.ts';
import { clearHeaderErrorsForSession } from '../action-status.ts';
import { forgetSessionCoherence, setSessionCoherenceHooks } from '../coherence/journal-drawer.ts';
import { refreshFavicon } from '../favicon.ts';
import { refreshFocusRoster, restoreFocusedSession } from '../focus-view/focus-view.ts';
import { refreshIssuesSessionState } from '../github/issues-store.ts';
import { refreshMyPrsSessionState } from '../github/my-prs-store.ts';
import { forgetSessionLinkedPrs, setSessionLinkedPrs } from '../github/session-pr-chips.ts';
import { refreshPhoneBoard } from '../phone/phone-shell-gate.ts';
import { noteKnownProjectPath } from '../project-registry.ts';
import { decideReloadOnBuild } from '../server-build-core.ts';
import { handleDebugStateRefresh, setSessionSaneYolo } from '../session-card/card-dom.ts';
import { buildSessionCardOptions } from '../session-card/card-options-core.ts';
import { attentionTally, sessionName, sessionUIs } from '../session-card/card-registry.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { applyState, createSessionCard, hasSession, removeSessionCard, seedSessionMergeStatus, setSessionAgent, setSessionAgents, setSessionEffectiveBase, setSessionFailureReason, setSessionHasPlan, setSessionPrompt, setSessionTaskTitle, setSessionUnseenOutcome, setSessionUsage, updateAttentionTitle } from '../session-card/lifecycle.ts';
import { reconnectDataWs } from '../session-card/terminal.ts';
import { refreshBoardAttention } from '../whiteboard/board-attention.ts';
import { applySettingsProjects } from '../settings/settings-store.ts';
import { onShownFilesChanged } from '../shown-files.ts';
import { forgetReviewSession, refreshReviewSidebar } from '../sidebar/review-sidebar.ts';
import { markStatusDirty, setStatusPainter } from '../status-paint.ts';
import { setTraceSessions } from '../trace-store.ts';
import { noteSnapshotReceived } from './connection-screen.ts';
import { activatePlanHash } from './hash-routes.ts';
import { markShownPhoneSessionSeen } from './viewer-focus.ts';

type SessionUsageChip = Pick<ServerMessageOf<'usage-sessions'>['sessions'][number], 'tokens' | 'costUSD' | 'officialCostUSD'>;

function refreshAttentionSurfaces() {
  refreshIssuesSessionState();
  refreshMyPrsSessionState();
  refreshPhoneBoard();
  refreshBoardAttention();
}

function refreshRosterAndAttentionSurfaces() {
  refreshFocusRoster();
  refreshAttentionSurfaces();
}

function wireStatusPainters() {
  onShownFilesChanged(() => refreshFocusRoster());

  setStatusPainter((dirtySessionIds) => {
    refreshFocusRoster(dirtySessionIds);
    refreshAttentionSurfaces();
  });
}

let knownServerBuild: string | null | undefined = null;

function noteServerBuild(serverBuild: unknown) {
  const decision = decideReloadOnBuild(knownServerBuild, serverBuild);
  knownServerBuild = decision.knownBuild;
  if (decision.reload) location.reload();
}

function forgetSession(sessionId: string) {
  clearHeaderErrorsForSession(sessionId);
  removeSessionCard(sessionId);
  forgetSessionCoherence(sessionId);
  forgetReviewSession(sessionId);
  forgetSessionLinkedPrs(sessionId);
}

function forgetSessionsMissingFromSnapshot(rows: ServerMessageOf<'snapshot'>['sessions']) {
  const liveSessionIds = new Set(rows.map((row) => row.id));
  for (const cachedSessionId of [...sessionUIs.keys()]) {
    if (!liveSessionIds.has(cachedSessionId)) forgetSession(cachedSessionId);
  }
}

function handleSnapshot(rows: ServerMessageOf<'snapshot'>['sessions']) {
  forgetSessionsMissingFromSnapshot(rows);
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
    if (!exists) createSessionCard(s.id, s.name, s.state, buildSessionCardOptions(s));
    setSessionFailureReason(s.id, s.failureReason);

    setSessionTaskTitle(s.id, s.taskTitle, s.taskTitleIsCustom);
    setSessionAgent(s.id, s.agent);

    seedSessionMergeStatus(s.id, s.mergeStatus, s.mergeReason);
    setSessionEffectiveBase(s.id, s.effectiveBase);

    setSessionAgents(s.id, s.activeAgents, s.awaitingBackgroundTasks);

    setSessionPrompt(s.id, s.pendingPromptKind);
    setSessionUnseenOutcome(s.id, s.unseenOutcome);

    setSessionHasPlan(s.id, s.hasPlan);

    restoreUsageChip(s.id);
  }
  updateAttentionTitle();
  refreshFavicon(attentionTally.counts);

  refreshFocusRoster();
  restoreFocusedSession();
  refreshAttentionSurfaces();
  syncTraceSessionsFromCards();
  activatePlanHash(location.hash);
  markShownPhoneSessionSeen();
  noteSnapshotReceived();
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

type SessionStatusMessage = ServerMessageOf<'session-status'>;
type SessionTransition = NonNullable<SessionStatusMessage['transition']>;

const ENDED_STATES = new Set<string>([STATES.DONE, STATES.FAILED]);

function isLeavingEndedState(previousState: string | undefined, nextState: string) {
  return previousState !== undefined && ENDED_STATES.has(previousState) && !ENDED_STATES.has(nextState) && nextState !== STATES.DORMANT;
}

function rebuildAsDormantCard(msg: SessionStatusMessage) {
  const previousUi = sessionUIs.get(String(msg.id));
  const matchedCard = document.querySelector(`.session-card[data-id="${CSS.escape(String(msg.id))}"]`);
  const card = matchedCard instanceof HTMLElement ? matchedCard : null;
  const skipPerms = card ? card.dataset.skipPerms !== undefined : false;
  const saneYolo = msg.saneYolo ?? (card ? card.dataset.saneYolo !== undefined : false);

  const path = card ? card.dataset.path : undefined;
  removeSessionCard(msg.id);
  createSessionCard(msg.id, msg.session, STATES.DORMANT, buildSessionCardOptions({ skipPerms, saneYolo, worktree: card?.dataset.worktree !== undefined, workspace: card?.dataset.workspace !== undefined, remoteWorkspace: card?.dataset.remoteWorkspace ?? null, ephemeral: card?.dataset.ephemeral !== undefined, path, stateSince: msg.timestamp, taskTitle: previousUi?.taskTitle, taskTitleIsCustom: previousUi?.taskTitleIsCustom }));
  setSessionAgent(msg.id, previousUi?.agent);
  carryOverClientSessionFields(msg.id, previousUi);
}

function applySessionTransition(msg: SessionStatusMessage, transition: SessionTransition) {
  const previousState = sessionUIs.get(String(msg.id))?.currentState;
  if (transition.to === STATES.DORMANT && previousState !== STATES.DORMANT) {
    rebuildAsDormantCard(msg);
    refreshReviewSidebar(msg.id);
    return;
  }
  applyState(msg.id, transition.to, msg.timestamp);
  setSessionFailureReason(msg.id, msg.failureReason);
  if (msg.saneYolo !== undefined) setSessionSaneYolo(msg.id, msg.saneYolo);
  refreshReviewSidebar(msg.id);
  if (isLeavingEndedState(previousState, transition.to)) reconnectDataWs(msg.id);
}

function handleSessionStatus(msg: SessionStatusMessage) {
  if (!hasSession(msg.id)) {
    if (!msg.transition) return;
    createSessionCard(msg.id, msg.session, msg.transition.to, buildSessionCardOptions({ skipPerms: msg.skipPerms, saneYolo: msg.saneYolo, stateSince: msg.timestamp }));
    refreshFavicon(attentionTally.counts);
    refreshIssuesSessionState();
    return;
  }
  if (msg.transition) applySessionTransition(msg, msg.transition);
  if (msg.activeAgents !== undefined) setSessionAgents(msg.id, msg.activeAgents, msg.awaitingBackgroundTasks);
  if (msg.unseenOutcome !== undefined) setSessionUnseenOutcome(msg.id, msg.unseenOutcome);
  if (msg.pendingPromptKind !== undefined) setSessionPrompt(msg.id, msg.pendingPromptKind);
  if (msg.unseenOutcome !== undefined) updateAttentionTitle();
  refreshFavicon(attentionTally.counts);
  markStatusDirty(msg.id);
  handleDebugStateRefresh(msg.id);
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

export {
  applyUsageSessionChips,
  carryOverClientSessionFields,
  forgetSession,
  handleSessionStatus,
  handleSnapshot,
  noteServerBuild,
  refreshAttentionSurfaces,
  refreshRosterAndAttentionSurfaces,
  restoreUsageChip,
  syncTraceSessionsFromCards,
  wireStatusPainters,
};
