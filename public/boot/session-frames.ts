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
import { decideReloadOnBuild } from '../server-build-core.ts';
import { sessionQuestionManagerOf, setSessionQuestionManager, setSessionSaneYolo } from '../session-card/card-dom.ts';
import { handleDebugStateRefresh } from '../session-card/card-debug.ts';
import { buildSessionCardOptions } from '../session-card/card-options-core.ts';
import { attentionTally, sessionName, sessionUIs } from '../session-card/card-registry.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { applyState, createSessionCard, hasSession, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setSessionAgent, setSessionAgents, setSessionPrompt, setSessionTaskTitle, setSessionUnseenOutcome, setSessionWorktree, updateAttentionTitle } from '../session-card/lifecycle.ts';
import { forgetAttentionNotes, forgetManagerDecisions, seedManagerDecisions, setManagerSeenSeq, setSessionAttentionNotes, setSessionFailureReason } from '../session-card/card-problems.ts';
import { reconnectDataWs } from '../session-card/terminal-data-socket.ts';
import { applySettingsProjects } from '../settings/settings-store.ts';
import { forgetReview, refreshReview } from '../review/review-store.ts';
import { getSelectedId, setSelectedId } from '../review/selection.ts';
import { markStatusDirty, setStatusPainter } from '../status-paint.ts';
import { setTraceSessions } from '../trace-store.ts';
import { noteSnapshotReceived } from './connection-screen.ts';
import { markShownPhoneSessionSeen } from './viewer-focus.ts';
import { forgetSessionHost, hostOfSession, rememberSessionHost, sessionsOfHost } from '../hosts/session-hosts.ts';


function refreshAttentionSurfaces() {
  refreshIssuesSessionState();
  refreshMyPrsSessionState();
  refreshPhoneBoard();
}

function refreshRosterAndAttentionSurfaces() {
  refreshFocusRoster();
  refreshAttentionSurfaces();
}

function wireStatusPainters() {
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
  forgetReview(sessionId);
  forgetSessionLinkedPrs(sessionId);
  forgetManagerDecisions(sessionId);
  forgetAttentionNotes(sessionId);
  forgetSessionHost(sessionId);
}

function forgetHostSessions(hostId: string) {
  for (const sessionId of sessionsOfHost(hostId)) forgetSession(sessionId);
}

function forgetSessionsMissingFromSnapshot(rows: ServerMessageOf<'snapshot'>['sessions'], hostId: string | null) {
  const liveSessionIds = new Set(rows.map((row) => row.id));
  for (const cachedSessionId of [...sessionUIs.keys()]) {
    if (hostOfSession(cachedSessionId) !== hostId) continue;
    if (!liveSessionIds.has(cachedSessionId)) forgetSession(cachedSessionId);
  }
}

function handleSnapshot(rows: ServerMessageOf<'snapshot'>['sessions'], hostId: string | null = null) {
  if (hostId) for (const row of rows) rememberSessionHost(row.id, hostId);
  forgetSessionsMissingFromSnapshot(rows, hostId);
  if (!hostId) {
    applySettingsProjects(rows.filter((session) => !session.ephemeral).map((session) => ({
      id: session.id,
      name: session.name,
      agent: session.agent,
      permissionMode: session.dangerouslySkipPermissions ? 'Skip permissions' : 'Default',
    })));
  }
  for (const s of rows) {
    if (hasSession(s.id)) catchUpExistingCard(s);
    if (!hasSession(s.id)) createSessionCard(s.id, s.name, s.state, buildSessionCardOptions(s));
    setSessionCoherenceHooks(s.id, s.coherenceHooks);
    setSessionLinkedPrs(s.id, s.linkedPrs);
    setSessionFailureReason(s.id, s.failureReason);
    setSessionAttentionNotes(s.id, s.attentionNotes);

    setSessionTaskTitle(s.id, s.taskTitle, s.taskTitleIsCustom);
    setSessionAgent(s.id, s.agent, s.agentDrawsAlternateScreen);

    seedSessionMergeStatus(s.id, s.mergeStatus, s.mergeReason);

    setSessionAgents(s.id, s.activeAgents, s.awaitingBackgroundTasks);

    setSessionPrompt(s.id, s.pendingPromptKind);
    setSessionUnseenOutcome(s.id, s.unseenOutcome);
    seedManagerDecisions(s.id, s.auditLog, s.managerSeenSeq);

  }
  updateAttentionTitle();
  refreshFavicon(attentionTally.counts);

  refreshFocusRoster();
  restoreFocusedSession();
  refreshAttentionSurfaces();
  syncTraceSessionsFromCards();
  markShownPhoneSessionSeen();
  noteSnapshotReceived();
}

type SnapshotSessionRow = ServerMessageOf<'snapshot'>['sessions'][number];

function snapshotChangesCardIdentity(card: HTMLElement, row: SnapshotSessionRow) {
  const cardSkipsPermissions = card.dataset.skipPerms !== undefined;
  return (card.dataset.path ?? '') !== row.path || cardSkipsPermissions !== row.dangerouslySkipPermissions;
}

function catchUpExistingCard(row: SnapshotSessionRow) {
  const card = sessionUIs.get(row.id)?.card;
  if (card && snapshotChangesCardIdentity(card, row)) {
    rebuildSessionCard(row.id, row.name, row.state, row, row.linkedPrs);
    return;
  }
  applyState(row.id, row.state, row.stateSince);
  setSessionSaneYolo(row.id, !!row.saneYolo);
  setSessionQuestionManager(row.id, row.isQuestionManagerOn);
  if (card && card.dataset.session !== row.name) renameSessionCard(row.id, row.name);
  setSessionWorktree(row.id, row.isWorktree);
}

function rebuildSessionCard(sessionId: string, sessionName: string, state: string, cardFields: Parameters<typeof buildSessionCardOptions>[0], linkedPrs: unknown) {
  const previousUi = sessionUIs.get(sessionId);
  const wasSelected = getSelectedId() === sessionId;
  setSessionCoherenceHooks(sessionId, null);
  removeSessionCard(sessionId);
  forgetReview(sessionId);
  forgetManagerDecisions(sessionId);
  forgetAttentionNotes(sessionId);
  setSessionLinkedPrs(sessionId, linkedPrs);
  createSessionCard(sessionId, sessionName, state, buildSessionCardOptions(cardFields));
  if (wasSelected) setSelectedId(sessionId);
  carryOverClientSessionFields(sessionId, previousUi);
}

function syncTraceSessionsFromCards() {
  setTraceSessions([...sessionUIs].map(([id, sessionUi]) => ({
    id,
    name: sessionName(sessionUi) || id,
  })));
}

function carryOverClientSessionFields(sessionId: string, previousUi: SessionUi | undefined) {
  setSessionUnseenOutcome(sessionId, previousUi?.unseenOutcome);
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
  createSessionCard(msg.id, msg.session, STATES.DORMANT, buildSessionCardOptions({ skipPerms, saneYolo, isQuestionManagerOn: msg.isQuestionManagerOn ?? sessionQuestionManagerOf(card), worktree: card?.dataset.worktree !== undefined, workspace: card?.dataset.workspace !== undefined, remoteWorkspace: card?.dataset.remoteWorkspace ?? null, ephemeral: card?.dataset.ephemeral !== undefined, path, stateSince: msg.timestamp, taskTitle: previousUi?.taskTitle, taskTitleIsCustom: previousUi?.taskTitleIsCustom }));
  setSessionAgent(msg.id, previousUi?.agent, previousUi?.agentDrawsAlternateScreen);
  carryOverClientSessionFields(msg.id, previousUi);
}

function applySessionTransition(msg: SessionStatusMessage, transition: SessionTransition) {
  const previousState = sessionUIs.get(String(msg.id))?.currentState;
  if (transition.to === STATES.DORMANT && previousState !== STATES.DORMANT) {
    rebuildAsDormantCard(msg);
    refreshReview(msg.id);
    return;
  }
  applyState(msg.id, transition.to, msg.timestamp);
  setSessionFailureReason(msg.id, msg.failureReason);
  if (msg.saneYolo !== undefined) setSessionSaneYolo(msg.id, msg.saneYolo);
  refreshReview(msg.id);
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
  if (msg.managerSeenSeq !== undefined) setManagerSeenSeq(msg.id, msg.managerSeenSeq);
  if (msg.attentionNotes !== undefined) setSessionAttentionNotes(msg.id, msg.attentionNotes);
  if (msg.isQuestionManagerOn !== undefined) setSessionQuestionManager(msg.id, msg.isQuestionManagerOn);
  if (msg.unseenOutcome !== undefined) updateAttentionTitle();
  refreshFavicon(attentionTally.counts);
  markStatusDirty(msg.id);
  handleDebugStateRefresh(msg.id);
}

export {
  forgetHostSessions,
  forgetSession,
  handleSessionStatus,
  handleSnapshot,
  noteServerBuild,
  rebuildSessionCard,
  refreshAttentionSurfaces,
  refreshRosterAndAttentionSurfaces,
  syncTraceSessionsFromCards,
  wireStatusPainters,
};
