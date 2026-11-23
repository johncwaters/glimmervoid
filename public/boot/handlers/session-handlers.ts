import { applyChatSessionStatus, noteChatAgentDoneLines, noteChatApproval, noteChatOutbox } from '../../chat/chat-page.ts';
import { noteBoardSessionStatusChanged } from '../../board-session/board-session-signals.ts';
import { setSessionAccountId, setSessionWorkingDirectory, setSessionModelSelection } from '../../session-card/card-model.ts';
import { refreshFavicon } from '../../favicon.ts';
import { forgetSessionInSavedOrder, setFocusMergeStatus } from '../../focus-view/focus-view.ts';
import { setSessionLinkedPrs } from '../../github/session-pr-chips.ts';
import { setSessionWakes } from '../../session-card/session-wakes.ts';
import { alertFromNotify } from '../../notifications.ts';
import { requestSessionRemovalNow } from '../../session-actions.ts';
import { handleDebugStateRefresh, handleDebugStateResponse } from '../../session-card/card-debug.ts';
import { buildSessionCardOptions } from '../../session-card/card-options-core.ts';
import { attentionTally } from '../../session-card/card-registry.ts';
import { createSessionCard, hasSession, renameSessionCard, setSessionAgent, setSessionMergeStatus, setSessionTaskTitle, setSessionWorktree } from '../../session-card/lifecycle.ts';
import { reportSessionProblem } from '../../session-card/card-problems.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { forgetSession, handleSessionStatus, rebuildSessionCard, refreshAttentionSurfaces, refreshRosterAndAttentionSurfaces, syncTraceSessionsFromCards } from '../session-frames.ts';

const messageHandlers = {
  'session-status':     (msg) => {
    handleSessionStatus(msg);
    if (msg.conversationApproval !== undefined) noteChatApproval(msg.id, msg.conversationApproval);
    if (msg.chatOutbox !== undefined) noteChatOutbox(msg.id, msg.chatOutbox);
    applyChatSessionStatus(msg.id);
    noteBoardSessionStatusChanged(msg.id);
  },
  'session-added':      (msg) => { setSessionLinkedPrs(msg.id, msg.linkedPrs); noteChatAgentDoneLines(msg.id, msg.agentDoneLines ?? []); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, buildSessionCardOptions(msg)); setSessionAgent(msg.id, msg.agent, msg.agentDrawsAlternateScreen); } setSessionModelSelection(msg.id, msg.modelSelection ?? null); setSessionAccountId(msg.id, msg.accountId ?? null); setSessionWorkingDirectory(msg.id, msg.workingDirectory); refreshFavicon(attentionTally.counts); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-close-confirm': (msg) => { requestSessionRemovalNow(msg.id); },
  'session-removed':    (msg) => { forgetSession(msg.id); forgetSessionInSavedOrder(msg.id); refreshFavicon(attentionTally.counts); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-title': (msg) => { setSessionTaskTitle(msg.id, msg.taskTitle, msg.isCustom); refreshRosterAndAttentionSurfaces(); },
  'session-prs': (msg) => setSessionLinkedPrs(msg.id, msg.linkedPrs),
  'session-done-lines': (msg) => noteChatAgentDoneLines(msg.id, msg.agentDoneLines),
  'session-wakes': (msg) => setSessionWakes(msg.id, msg.wakes),
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshRosterAndAttentionSurfaces(); syncTraceSessionsFromCards(); },
  'session-modified':   (msg) => {
    rebuildSessionCard(msg.id, msg.session, msg.state, msg, msg.linkedPrs);
    setSessionAgent(msg.id, msg.agent, msg.agentDrawsAlternateScreen);
    refreshFavicon(attentionTally.counts);
    refreshRosterAndAttentionSurfaces();
    syncTraceSessionsFromCards();
    setSessionModelSelection(msg.id, msg.modelSelection ?? null); setSessionAccountId(msg.id, msg.accountId ?? null); setSessionWorkingDirectory(msg.id, msg.workingDirectory);
  },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),

  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus, msg.reason); setFocusMergeStatus(msg.id, msg.mergeStatus); refreshAttentionSurfaces(); },
  'debug-state-response': (msg) => handleDebugStateResponse(msg),

  'notify':             (msg) => { alertFromNotify(msg); handleDebugStateRefresh(msg.session); },
  'session-error':      (msg) => {
    reportSessionProblem(msg.id, msg.message);
  },
} satisfies DashboardHandlerTable;

export { messageHandlers as sessionHandlers };
