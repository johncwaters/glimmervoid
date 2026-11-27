import type { PermissionDecision } from '#shared/contracts/session.ts';
import { defineAction } from '../define-action.ts';
import sessionsCollection, { applyApprovalDecisionReply } from '../collections/sessions.ts';
import { applyOptimisticApprovalDecision } from '../sessions-core.ts';

interface DecideApprovalInput {
  id: string;
  approvalRequestId: string;
  decision: PermissionDecision;
  message?: string;
}

const decideApprovalAction = defineAction<DecideApprovalInput>({
  type: 'decide-approval',
  payload: ({ id, approvalRequestId, decision, message }) => (
    message === undefined
      ? { id, approvalRequestId, decision }
      : { id, approvalRequestId, decision, message }
  ),
  optimistic: ({ id }, apply) => {
    apply(sessionsCollection, (draft) => {
      applyOptimisticApprovalDecision(draft, id);
    });
  },
  isReplyOk: (reply) => reply.type === 'session-action-result' && reply.ok,
  onReply: (reply, { id }) => {
    if (reply.type === 'session-action-result' && reply.ok) {
      applyApprovalDecisionReply(reply, id);
    }
  },
  noticeSource: 'Approval',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not send approval decision: ${detail}`;
  },
});

export default decideApprovalAction;
