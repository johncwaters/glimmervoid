import { DEFAULT_REPLY_TIMEOUT_MS } from '../../action-status.ts';
import { defineAction } from '../define-action.ts';
import sessionsCollection from '../collections/sessions.ts';
import { applyOptimisticPendingLaunch } from '../sessions-core.ts';

interface OpenIssueSessionInput {
  path: string;
  issueNumber: number;
  agent?: string;
  dangerouslySkipPermissions?: boolean;
  saneYolo?: boolean;
  accountId?: string | null;
  setup?: unknown;
  timeoutMs?: number;
}

const openIssueSessionAction = defineAction<OpenIssueSessionInput>({
  type: 'open-issue-session',
  timeoutMs: (input) => input.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
  payload: ({ timeoutMs: _timeoutMs, ...wirePayload }) => wirePayload,
  optimistic: ({ path, issueNumber }, apply) => {
    apply(sessionsCollection, (draft) => {
      applyOptimisticPendingLaunch(draft, `issue:${path}#${issueNumber}`);
    });
  },
  isReplyOk: (reply) => reply.type === 'add-session-result' && reply.ok,
  noticeSource: 'Add session',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `The session was not added: ${detail}`;
  },
});

export default openIssueSessionAction;
