import { createEffect, createRoot, runWithOwner } from 'solid-js';
import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { setSessionPlanGate } from '../plan/plan-gate-panel.ts';
import { STATES } from '#shared/states.ts';
import { SessionState } from '#shared/contracts/session.ts';
import { applyChatSessionStatus, applyChatSnapshot, noteChatAgentDoneLines, noteChatApproval, noteChatOutbox, noteChatPlanGate } from '../chat/chat-page.ts';
import { forgetChatDraft } from '../chat/chat-session-state.ts';
import { noteBoardSessionStatusChanged } from '../board-session/board-session-signals.ts';
import { clearHeaderError, clearHeaderErrorsForSession, reportHeaderError } from '../action-status.ts';
import { openInstallDetailsDialog } from '../dialogs.ts';
import { refreshFavicon } from '../favicon.ts';
import { forgetSessionInSavedOrder, refreshFocusRoster, restoreFocusedSession, setFocusMergeStatus } from '../focus-view/focus-view.ts';
import { refreshMyPrsSessionState } from '../github/my-prs-store.ts';
import { forgetSessionLinkedPrs, setSessionLinkedPrs } from '../github/session-pr-chips.ts';
import { forgetSessionWakes, setSessionWakes } from '../session-card/session-wakes.ts';
import { refreshPhoneBoard } from '../phone/phone-shell-gate.ts';
import { decideReloadOnBuild } from '../server-build-core.ts';
import { sessionQuestionManagerOf, setSessionQuestionManager, setSessionSaneYolo } from '../session-card/card-dom.ts';
import { handleDebugStateRefresh } from '../session-card/card-debug.ts';
import { resetSessionModelSelections, setSessionAccountId, setSessionModelSelection, setSessionWorkingDirectory } from '../session-card/card-model.ts';
import { buildSessionCardOptions } from '../session-card/card-options-core.ts';
import { attentionTally, sessionName, sessionUIs } from '../session-card/card-registry.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { applyState, createSessionCard, hasSession, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setSessionAgent, setSessionAgents, setSessionMergeStatus, setSessionPrompt, setSessionTaskTitle, setSessionUnseenOutcome, setSessionUsageLimit, setSessionWorktree, updateAttentionTitle } from '../session-card/lifecycle.ts';
import { setSessionAccount } from '../session-card/card-account.ts';
import { addManagerDecision, forgetAttentionNotes, closeAnsweredPassedLine, forgetManagerDecisions, seedManagerDecisions, setManagerSeenSeq, setSessionAttentionNotes, setSessionFailureReason } from '../session-card/card-problems.ts';
import { reconnectDataWs } from '../session-card/terminal-data-socket.ts';
import { applySettingsProjects } from '../settings/settings-store.ts';
import { forgetReview, refreshReview } from '../review/review-store.ts';
import { getSelectedId, setSelectedId } from '../review/selection.ts';
import { markStatusDirty, setStatusPainter } from '../status-paint.ts';
import { setTraceSessions } from '../trace-store.ts';
import { showBoardSessionFeed } from '../whiteboard/board-session-feed.ts';
import sessionsCollection, { onSessionsServerMessage } from '../state/collections/sessions.ts';
import { noteSnapshotReceived } from './connection-screen.ts';
import { markShownPhoneSessionSeen } from './viewer-focus.ts';


function refreshAttentionSurfaces() {
  refreshMyPrsSessionState();
  refreshPhoneBoard();
  showBoardSessionFeed([...sessionUIs.entries()].flatMap(([sessionId, sessionUi]) => {
    const parsedState = SessionState.safeParse(sessionUi.currentState);
    return parsedState.success ? [{ id: sessionId, name: sessionName(sessionUi), agent: sessionUi.agent ?? '', state: parsedState.data }] : [];
  }));
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
  forgetReview(sessionId);
  forgetSessionLinkedPrs(sessionId);
  forgetSessionWakes(sessionId);
  forgetManagerDecisions(sessionId);
  forgetAttentionNotes(sessionId);
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
    if (hasSession(s.id)) catchUpExistingCard(s);
    if (!hasSession(s.id)) createSessionCard(s.id, s.name, s.state, buildSessionCardOptions(s));
    setSessionLinkedPrs(s.id, s.linkedPrs);
    setSessionWakes(s.id, []);
    setSessionFailureReason(s.id, s.failureReason);
    setSessionAttentionNotes(s.id, s.attentionNotes);
    setSessionPlanGate(s.id, s.planGate);
    noteChatPlanGate(s.id, s.planGate);

    setSessionTaskTitle(s.id, s.taskTitle, s.taskTitleIsCustom);
    setSessionAgent(s.id, s.agent, s.agentDrawsAlternateScreen, s.hasTerminal);

    seedSessionMergeStatus(s.id, s.mergeStatus, s.mergeReason);

    setSessionAgents(s.id, s.activeAgents, s.awaitingBackgroundTasks);

    setSessionPrompt(s.id, s.pendingPromptKind);
    setSessionUsageLimit(s.id, s.usageLimit);
    setSessionUnseenOutcome(s.id, s.unseenOutcome);
    seedManagerDecisions(s.id, s.auditLog, s.managerSeenSeq);
    if (s.passedQuestionSeq === 0) closeAnsweredPassedLine(s.id);

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
  setSessionAccount(row.id, row.accountId);
  if (card && card.dataset.session !== row.name) renameSessionCard(row.id, row.name);
  setSessionWorktree(row.id, row.isWorktree);
}

function rebuildSessionCard(sessionId: string, sessionName: string, state: string, cardFields: Parameters<typeof buildSessionCardOptions>[0], linkedPrs: unknown) {
  const previousUi = sessionUIs.get(sessionId);
  const wasSelected = getSelectedId() === sessionId;
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
  createSessionCard(msg.id, msg.session, STATES.DORMANT, buildSessionCardOptions({ skipPerms, saneYolo, isQuestionManagerOn: msg.isQuestionManagerOn ?? sessionQuestionManagerOf(card), worktree: card?.dataset.worktree !== undefined, workspace: card?.dataset.workspace !== undefined, ephemeral: card?.dataset.ephemeral !== undefined, accountId: card?.dataset.accountId ?? null, path, stateSince: msg.timestamp, taskTitle: previousUi?.taskTitle, taskTitleIsCustom: previousUi?.taskTitleIsCustom, parent: previousUi?.parent, isStudioMain: previousUi?.isStudioMain, attentionOwner: previousUi?.attentionOwner }));
  setSessionAgent(msg.id, previousUi?.agent, previousUi?.agentDrawsAlternateScreen, previousUi?.hasTerminal);
  carryOverClientSessionFields(msg.id, previousUi);
}

function applySessionTransition(msg: SessionStatusMessage, transition: SessionTransition) {
  const uiPreviousState = sessionUIs.get(String(msg.id))?.currentState;
  const authoritativePreviousState = transition.from ?? uiPreviousState;
  if (transition.to === STATES.DORMANT && uiPreviousState !== STATES.DORMANT) {
    rebuildAsDormantCard(msg);
    refreshReview(msg.id);
    return;
  }
  applyState(msg.id, transition.to, msg.stateSince ?? msg.timestamp);
  setSessionFailureReason(msg.id, msg.failureReason);
  if (msg.saneYolo !== undefined) setSessionSaneYolo(msg.id, msg.saneYolo);
  refreshReview(msg.id);
  if (isLeavingEndedState(uiPreviousState, transition.to) || isLeavingEndedState(authoritativePreviousState, transition.to)) {
    reconnectDataWs(msg.id);
  }
}

function handleSessionStatus(msg: SessionStatusMessage) {
  if (!hasSession(msg.id)) {
    if (!msg.transition) return;
    createSessionCard(msg.id, msg.session, msg.transition.to, buildSessionCardOptions({ skipPerms: msg.skipPerms, saneYolo: msg.saneYolo, stateSince: msg.stateSince ?? msg.timestamp }));
    refreshFavicon(attentionTally.counts);
    return;
  }
  if (msg.transition) applySessionTransition(msg, msg.transition);
  if (msg.activeAgents !== undefined) setSessionAgents(msg.id, msg.activeAgents, msg.awaitingBackgroundTasks);
  if (msg.unseenOutcome !== undefined) setSessionUnseenOutcome(msg.id, msg.unseenOutcome);
  if (msg.pendingPromptKind !== undefined) setSessionPrompt(msg.id, msg.pendingPromptKind);
  if (msg.usageLimit !== undefined) setSessionUsageLimit(msg.id, msg.usageLimit);
  if (msg.managerSeenSeq !== undefined) setManagerSeenSeq(msg.id, msg.managerSeenSeq);
  if (msg.passedQuestionSeq === 0) closeAnsweredPassedLine(msg.id);
  if (msg.attentionNotes !== undefined) setSessionAttentionNotes(msg.id, msg.attentionNotes);
  if (msg.planGate !== undefined) {
    setSessionPlanGate(msg.id, msg.planGate);
    noteChatPlanGate(msg.id, msg.planGate);
  }
  if (msg.isQuestionManagerOn !== undefined) setSessionQuestionManager(msg.id, msg.isQuestionManagerOn);
  if (msg.accountId !== undefined) setSessionAccount(msg.id, msg.accountId);
  if (msg.unseenOutcome !== undefined) updateAttentionTitle();
  refreshFavicon(attentionTally.counts);
  markStatusDirty(msg.id);
  handleDebugStateRefresh(msg.id);
}

const WORKTREE_ERROR_SOURCE = 'Worktree';
const WORKTREE_WARNING_SOURCE = 'Worktree warning';

function handleSessionsCollectionMessage(msg: ServerMessage) {
  if (msg.type === 'snapshot') {
    noteServerBuild(msg.serverBuild);
    handleSnapshot(msg.sessions);
    applyChatSnapshot(msg.sessions);
    resetSessionModelSelections(msg.sessions);
    return;
  }
  if (msg.type === 'session-status') {
    handleSessionStatus(msg);
    if (msg.conversationApproval !== undefined) noteChatApproval(msg.id, msg.conversationApproval);
    if (msg.chatOutbox !== undefined) noteChatOutbox(msg.id, msg.chatOutbox);
    applyChatSessionStatus(msg.id);
    noteBoardSessionStatusChanged(msg.id);
    return;
  }
  if (msg.type === 'session-added') {
    setSessionLinkedPrs(msg.id, msg.linkedPrs);
    noteChatAgentDoneLines(msg.id, msg.agentDoneLines ?? []);
    if (!hasSession(msg.id)) {
      createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg));
      setSessionAgent(msg.id, msg.agent, msg.agentDrawsAlternateScreen, msg.hasTerminal);
    }
    setSessionModelSelection(msg.id, msg.modelSelection ?? null);
    setSessionAccountId(msg.id, msg.accountId ?? null);
    setSessionWorkingDirectory(msg.id, msg.workingDirectory);
    refreshFavicon(attentionTally.counts);
    refreshRosterAndAttentionSurfaces();
    syncTraceSessionsFromCards();
    return;
  }
  if (msg.type === 'session-removed') {
    forgetSession(msg.id);
    forgetSessionInSavedOrder(msg.id);
    refreshFavicon(attentionTally.counts);
    refreshRosterAndAttentionSurfaces();
    forgetChatDraft(msg.id);
    syncTraceSessionsFromCards();
    return;
  }
  if (msg.type === 'session-title') {
    setSessionTaskTitle(msg.id, msg.taskTitle, msg.isCustom);
    refreshRosterAndAttentionSurfaces();
    return;
  }
  if (msg.type === 'session-prs') {
    setSessionLinkedPrs(msg.id, msg.linkedPrs);
    return;
  }
  if (msg.type === 'session-done-lines') {
    noteChatAgentDoneLines(msg.id, msg.agentDoneLines);
    return;
  }
  if (msg.type === 'session-renamed') {
    renameSessionCard(msg.id, msg.newName);
    refreshRosterAndAttentionSurfaces();
    syncTraceSessionsFromCards();
    return;
  }
  if (msg.type === 'session-modified') {
    rebuildSessionCard(msg.id, msg.session, msg.state, msg, msg.linkedPrs);
    setSessionAgent(msg.id, msg.agent, msg.agentDrawsAlternateScreen, msg.hasTerminal);
    refreshFavicon(attentionTally.counts);
    refreshRosterAndAttentionSurfaces();
    syncTraceSessionsFromCards();
    setSessionModelSelection(msg.id, msg.modelSelection ?? null);
    setSessionAccountId(msg.id, msg.accountId ?? null);
    setSessionWorkingDirectory(msg.id, msg.workingDirectory);
    return;
  }
  if (msg.type === 'session-git') {
    setSessionWorktree(msg.id, Boolean(msg.worktree));
    return;
  }
  if (msg.type === 'session-merge-status') {
    setSessionMergeStatus(msg.id, msg.mergeStatus, msg.reason);
    setFocusMergeStatus(msg.id, msg.mergeStatus);
    refreshAttentionSurfaces();
    return;
  }
  if (msg.type === 'session-manager-decision') {
    addManagerDecision(msg.id, msg.decision);
    refreshRosterAndAttentionSurfaces();
    return;
  }
  if (msg.type === 'session-worktree-blocked') {
    reportHeaderError({
      source: WORKTREE_ERROR_SOURCE,
      sessionId: msg.id,
      message: `${msg.session}: ${msg.notice || 'The integration branch was not found. Check the integration branch in Settings, then restart the session.'}`,
    });
    return;
  }
  if (msg.type === 'session-worktree-warning') {
    reportHeaderError({
      source: WORKTREE_WARNING_SOURCE,
      sessionId: msg.id,
      message: `${msg.session}: ${msg.notice || 'The base branch could not be synced. The session keeps working on its current base.'}`,
      tone: 'warning',
      ...(msg.failureKind ? { kind: msg.failureKind } : {}),
      ...(msg.installDetails?.length ? { action: { label: 'Details', run: () => openInstallDetailsDialog(msg.session, msg.installDetails ?? []) } } : {}),
    });
    return;
  }
  if (msg.type === 'session-worktree-ready') {
    clearHeaderError(WORKTREE_ERROR_SOURCE, msg.id);
  }
}

interface ProjectedSessionSnapshot {
  orderKey: string;
  entries: Array<{ id: string; name: string; state: string; stateSince: number }>;
}

let isSessionsCollectionWired = false;

function wireSessionsCollection() {
  if (isSessionsCollectionWired) return;
  isSessionsCollectionWired = true;
  onSessionsServerMessage(handleSessionsCollectionMessage);

  let previousOrderKey = '';
  runWithOwner(null, () => {
    createRoot(() => {
      createEffect<ProjectedSessionSnapshot>(
        () => {
          const order = sessionsCollection.state.order;
          const entries: ProjectedSessionSnapshot['entries'] = [];
          for (const sessionId of order) {
            const record = sessionsCollection.state.byId[sessionId];
            if (!record) continue;
            entries.push({
              id: record.id,
              name: record.name,
              state: record.state,
              stateSince: record.stateSince,
            });
          }
          return { orderKey: order.join('\0'), entries };
        },
        (snapshot) => {
          let changedCount = 0;
          let traceSyncCount = 0;
          for (const entry of snapshot.entries) {
            const ui = sessionUIs.get(entry.id);
            if (!ui) continue;
            if (sessionName(ui) !== entry.name) {
              renameSessionCard(entry.id, entry.name);
              changedCount += 1;
              traceSyncCount += 1;
            }
            if (ui.currentState !== entry.state) {
              applyState(entry.id, entry.state, entry.stateSince);
              changedCount += 1;
            }
          }
          if (snapshot.orderKey !== previousOrderKey) {
            previousOrderKey = snapshot.orderKey;
            changedCount += 1;
            traceSyncCount += 1;
          }
          if (changedCount === 0) return;
          refreshRosterAndAttentionSurfaces();
          if (traceSyncCount > 0) syncTraceSessionsFromCards();
        },
      );
    });
  });
}

export {
  wireSessionsCollection,
  wireStatusPainters,
};
