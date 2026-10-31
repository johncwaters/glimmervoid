import { clearHeaderError, reportHeaderError } from '../../action-status.ts';
import { setSessionDiff, setSessionEffectiveBase } from '../../session-card/lifecycle.ts';
import { notifyWorktreeChanged, notifyWorktreeReady, setReviewBranchSync, setReviewDiffError, setSessionChangeMap } from '../../sidebar/review-sidebar.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const WORKTREE_ERROR_SOURCE = 'Worktree';
const WORKTREE_WARNING_SOURCE = 'Worktree warning';

const messageHandlers = {
  'session-worktree-blocked': (msg) => { reportHeaderError({ source: WORKTREE_ERROR_SOURCE, sessionId: msg.id, message: `${msg.session}: ${msg.notice || 'The integration branch was not found. Check the integration branch in Settings, then restart the session.'}` }); },
  'session-worktree-warning': (msg) => { reportHeaderError({ source: WORKTREE_WARNING_SOURCE, sessionId: msg.id, message: `${msg.session}: ${msg.notice || 'The base branch could not be synced. The session keeps working on its current base.'}` }); },
  'session-worktree-ready': (msg) => { clearHeaderError(WORKTREE_ERROR_SOURCE, msg.id); setSessionEffectiveBase(msg.id, msg.base); notifyWorktreeReady(msg.id); },
  'session-diff':       (msg) => { setSessionDiff(msg.id, msg); },
  'session-diff-error': (msg) => { setReviewDiffError(msg.id, msg.message); },
  'change-map':         (msg) => setSessionChangeMap(msg.id, msg.map),
  'branch-sync-status': (msg) => setReviewBranchSync(msg.id, msg),
  'session-changed':    (msg) => notifyWorktreeChanged(msg.id),
} satisfies DashboardHandlerTable;

export { messageHandlers as worktreeHandlers };
