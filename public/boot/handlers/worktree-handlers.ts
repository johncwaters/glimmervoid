import { setChangeMap, setReviewState, setSessionReviewResult, setVerificationRun, noteWorktreeChanged, setSessionDiff, setSessionDiffError } from '../../review/review-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const messageHandlers = {
  'session-diff':       (msg) => { setSessionDiff(msg.id, msg); },
  'session-diff-error': (msg) => { setSessionDiffError(msg.id, msg.message); },
  'change-map':         (msg) => setChangeMap(msg.id, msg.map),
  'verification-run':   (msg) => setVerificationRun(msg.id, msg.run),
  'session-review':     (msg) => setSessionReviewResult(msg.id, msg.result),
  'review-state':       (msg) => setReviewState(msg.id, msg.state),
  'session-changed':    (msg) => noteWorktreeChanged(msg.id),
} satisfies DashboardHandlerTable;

export { messageHandlers as worktreeHandlers };
