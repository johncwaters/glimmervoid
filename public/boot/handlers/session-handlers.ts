import { setSessionCoherenceHooks } from '../../coherence/journal-drawer.ts';
import { refreshFavicon } from '../../favicon.ts';
import { setFocusMergeStatus } from '../../focus-view/focus-view.ts';
import { setSessionLinkedPrs } from '../../github/session-pr-chips.ts';
import { alertFromNotify } from '../../notifications.ts';
import { noteKnownProjectPath } from '../../project-registry.ts';
import { requestSessionRemoval } from '../../session-actions.ts';
import { handleDebugStateRefresh, handleDebugStateResponse } from '../../session-card/card-dom.ts';
import { buildSessionCardOptions } from '../../session-card/card-options-core.ts';
import { attentionTally, sessionUIs } from '../../session-card/card-registry.ts';
import { applySessionPlanError, createSessionCard, hasSession, removeSessionCard, renameSessionCard, reportSessionProblem, setSessionAgent, setSessionMergeStatus, setSessionTaskTitle, setSessionWorktree } from '../../session-card/lifecycle.ts';
import { applySessionSetupResponse } from '../../session-setup/setup-dialog.ts';
import { forgetReviewSession, releaseReviewMergeRequest } from '../../sidebar/review-sidebar.ts';
import { getSelectedId, setSelectedId } from '../../sidebar/selection.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { carryOverClientSessionFields, forgetSession, handleSessionStatus, refreshAttentionSurfaces, refreshRosterAndAttentionSurfaces, restoreUsageChip, syncTraceSessionsFromCards } from '../session-frames.ts';

const messageHandlers = {
  'session-status':     (msg) => handleSessionStatus(msg),
  'session-added':      (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); setSessionLinkedPrs(msg.id, msg.linkedPrs); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg)); setSessionAgent(msg.id, msg.agent); restoreUsageChip(msg.id); } refreshFavicon(attentionTally.counts); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-close-confirm': (msg) => { requestSessionRemoval(msg.id); },
  'session-removed':    (msg) => { forgetSession(msg.id); refreshFavicon(attentionTally.counts); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-title': (msg) => { setSessionTaskTitle(msg.id, msg.taskTitle, msg.isCustom); refreshRosterAndAttentionSurfaces(); },
  'session-prs': (msg) => setSessionLinkedPrs(msg.id, msg.linkedPrs),
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-modified':   (msg) => {
    if (!msg.ephemeral) noteKnownProjectPath(msg.path);

    const previousUi = sessionUIs.get(String(msg.id));
    const wasSelected = getSelectedId() === String(msg.id);
    setSessionCoherenceHooks(msg.id, null);
    removeSessionCard(msg.id);
    forgetReviewSession(msg.id);
    setSessionLinkedPrs(msg.id, msg.linkedPrs);
    createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg));
    if (wasSelected) setSelectedId(String(msg.id));
    setSessionAgent(msg.id, msg.agent);
    carryOverClientSessionFields(msg.id, previousUi);
    refreshFavicon(attentionTally.counts);
    refreshRosterAndAttentionSurfaces();
    syncTraceSessionsFromCards();
  },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),

  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus, msg.reason); setFocusMergeStatus(msg.id, msg.mergeStatus); refreshAttentionSurfaces(); },
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  'session-setup-response': (msg) => applySessionSetupResponse(msg),

  'notify':             (msg) => { alertFromNotify(msg); handleDebugStateRefresh(msg.session); },
  'session-error':      (msg) => {
    releaseReviewMergeRequest(msg.id);
    if (applySessionPlanError(msg)) return;
    reportSessionProblem(msg.id, msg.message);
  },
} satisfies DashboardHandlerTable;

export { messageHandlers as sessionHandlers };
