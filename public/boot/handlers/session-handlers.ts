import { refreshFavicon } from '../../favicon.ts';
import { setFocusMergeStatus } from '../../focus-view/focus-view.ts';
import { setSessionLinkedPrs } from '../../github/session-pr-chips.ts';
import { alertFromNotify } from '../../notifications.ts';
import { requestSessionRemovalNow } from '../../session-actions.ts';
import { handleDebugStateRefresh, handleDebugStateResponse } from '../../session-card/card-debug.ts';
import { buildSessionCardOptions } from '../../session-card/card-options-core.ts';
import { attentionTally } from '../../session-card/card-registry.ts';
import { createSessionCard, hasSession, renameSessionCard, setSessionAgent, setSessionMergeStatus, setSessionTaskTitle, setSessionWorktree } from '../../session-card/lifecycle.ts';
import { applySessionPlanError } from '../../session-card/card-faces.ts';
import { reportSessionProblem } from '../../session-card/card-problems.ts';
import { applySessionSetupResponse } from '../../session-setup/setup-dialog.ts';
import { releaseMergeRequest } from '../../review/review-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { forgetSession, handleSessionStatus, rebuildSessionCard, refreshAttentionSurfaces, refreshRosterAndAttentionSurfaces, syncTraceSessionsFromCards } from '../session-frames.ts';

const messageHandlers = {
  'session-status':     (msg) => handleSessionStatus(msg),
  'session-added':      (msg) => { setSessionLinkedPrs(msg.id, msg.linkedPrs); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg)); setSessionAgent(msg.id, msg.agent); } refreshFavicon(attentionTally.counts); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-close-confirm': (msg) => { requestSessionRemovalNow(msg.id); },
  'session-removed':    (msg) => { forgetSession(msg.id); refreshFavicon(attentionTally.counts); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-title': (msg) => { setSessionTaskTitle(msg.id, msg.taskTitle, msg.isCustom); refreshRosterAndAttentionSurfaces(); },
  'session-prs': (msg) => setSessionLinkedPrs(msg.id, msg.linkedPrs),
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-modified':   (msg) => {
    rebuildSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg), msg.linkedPrs);
    setSessionAgent(msg.id, msg.agent);
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
    releaseMergeRequest(msg.id);
    if (applySessionPlanError(msg)) return;
    reportSessionProblem(msg.id, msg.message);
  },
} satisfies DashboardHandlerTable;

export { messageHandlers as sessionHandlers };
