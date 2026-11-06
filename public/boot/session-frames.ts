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
import { setSessionSaneYolo } from '../session-card/card-dom.ts';
import { handleDebugStateRefresh } from '../session-card/card-debug.ts';
import { buildSessionCardOptions } from '../session-card/card-options-core.ts';
import { attentionTally, sessionName, sessionUIs } from '../session-card/card-registry.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { applyState, createSessionCard, hasSession, removeSessionCard, seedSessionMergeStatus, setSessionAgent, setSessionAgents, setSessionEffectiveBase, setSessionPrompt, setSessionTaskTitle, setSessionUnseenOutcome, updateAttentionTitle } from '../session-card/lifecycle.ts';
import { forgetManagerDecisions, seedManagerDecisions, setManagerSeenSeq, setSessionFailureReason } from '../session-card/card-problems.ts';
import { setSessionHasPlan } from '../session-card/card-faces.ts';
import { reconnectDataWs } from '../session-card/terminal-data-socket.ts';
import { applySettingsProjects } from '../settings/settings-store.ts';
import { forgetReview, refreshReview } from '../review/review-store.ts';
import { markStatusDirty, setStatusPainter } from '../status-paint.ts';
import { setTraceSessions } from '../trace-store.ts';
import { noteSnapshotReceived } from './connection-screen.ts';
import { activatePlanHash } from './hash-routes.ts';
import { markShownPhoneSessionSeen } from './viewer-focus.ts';


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
    seedManagerDecisions(s.id, s.auditLog, s.managerSeenSeq);

    setSessionHasPlan(s.id, s.hasPlan);

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
  if (msg.unseenOutcome !== undefined) updateAttentionTitle();
  refreshFavicon(attentionTally.counts);
  markStatusDirty(msg.id);
  handleDebugStateRefresh(msg.id);
}

export {
  carryOverClientSessionFields,
  forgetSession,
  handleSessionStatus,
  handleSnapshot,
  noteServerBuild,
  refreshAttentionSurfaces,
  refreshRosterAndAttentionSurfaces,
  syncTraceSessionsFromCards,
  wireStatusPainters,
};
