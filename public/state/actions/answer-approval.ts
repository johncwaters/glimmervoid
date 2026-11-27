import type { ConversationAnswers } from '#shared/contracts/session.ts';
import { defineAction } from '../define-action.ts';
import sessionsCollection, { applyApprovalDecisionReply } from '../collections/sessions.ts';
import { applyOptimisticApprovalDecision } from '../sessions-core.ts';

interface AnswerApprovalInput {
  id: string;
  approvalRequestId: string;
  answers: ConversationAnswers;
}

const answerApprovalAction = defineAction<AnswerApprovalInput>({
  type: 'answer-approval',
  payload: ({ id, approvalRequestId, answers }) => ({ id, approvalRequestId, answers }),
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
    return `Could not send approval answers: ${detail}`;
  },
});

export default answerApprovalAction;
