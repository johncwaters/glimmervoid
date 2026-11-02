import { clearHeaderError, reportHeaderError } from '../../action-status.ts';
import { setChangeMap, noteWorktreeChanged, setSessionDiff, setSessionDiffError } from '../../review/review-store.ts';
import { setSessionEffectiveBase } from '../../session-card/lifecycle.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const WORKTREE_ERROR_SOURCE = 'Worktree';
const WORKTREE_WARNING_SOURCE = 'Worktree warning';

const messageHandlers = {
  'session-worktree-blocked': (msg) => { reportHeaderError({ source: WORKTREE_ERROR_SOURCE, sessionId: msg.id, message: `${msg.session}: ${msg.notice || 'The integration branch was not found. Check the integration branch in Settings, then restart the session.'}` }); },
  'session-worktree-warning': (msg) => { reportHeaderError({ source: WORKTREE_WARNING_SOURCE, sessionId: msg.id, message: `${msg.session}: ${msg.notice || 'The base branch could not be synced. The session keeps working on its current base.'}` }); },
  'session-worktree-ready': (msg) => { clearHeaderError(WORKTREE_ERROR_SOURCE, msg.id); setSessionEffectiveBase(msg.id, msg.base); },
  'session-diff':       (msg) => { setSessionDiff(msg.id, msg); },
  'session-diff-error': (msg) => { setSessionDiffError(msg.id, msg.message); },
  'change-map':         (msg) => setChangeMap(msg.id, msg.map),
  'session-changed':    (msg) => noteWorktreeChanged(msg.id),
} satisfies DashboardHandlerTable;

export { messageHandlers as worktreeHandlers };
