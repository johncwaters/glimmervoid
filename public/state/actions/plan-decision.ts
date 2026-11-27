import type { PlanDecision } from '#shared/contracts/plan-gate.ts';
import { defineAction } from '../define-action.ts';
import sessionsCollection, { applyApprovalDecisionReply } from '../collections/sessions.ts';
import { applyOptimisticApprovalDecision } from '../sessions-core.ts';

interface PlanDecisionInput {
  id: string;
  decision: PlanDecision;
  feedback?: string;
}

const planDecisionAction = defineAction<PlanDecisionInput>({
  type: 'plan-decision',
  payload: ({ id, decision, feedback }) => (
    feedback === undefined
      ? { id, decision }
      : { id, decision, feedback }
  ),
  optimistic: ({ id, decision }, apply) => {
    if (decision === 'terminal') return;
    apply(sessionsCollection, (draft) => {
      applyOptimisticApprovalDecision(draft, id);
    });
  },
  isReplyOk: (reply) => reply.type === 'session-action-result' && reply.ok,
  onReply: (reply, { id, decision }) => {
    if (decision !== 'terminal' && reply.type === 'session-action-result' && reply.ok) {
      applyApprovalDecisionReply(reply, id);
    }
  },
  noticeSource: 'Plan',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not send plan decision: ${detail}`;
  },
});

export default planDecisionAction;
