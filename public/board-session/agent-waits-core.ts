import { PlanDecision } from '#shared/contracts/plan-gate.ts';
import { ConversationAnswers, PermissionDecision } from '#shared/contracts/session.ts';

export const NOT_SENT_TEXT = 'Not connected to the server, so the answer was not sent.';
export const OPEN_CARD_SELECTOR = '.chat-card[data-resolved="false"]';

export type WaitsActionDispatch =
  | {
      kind: 'decide-approval';
      input: { id: string; approvalRequestId: string; decision: PermissionDecision; message?: string };
    }
  | {
      kind: 'answer-approval';
      input: { id: string; approvalRequestId: string; answers: ConversationAnswers };
    }
  | {
      kind: 'plan-decision';
      input: { id: string; decision: PlanDecision; feedback?: string };
    };

export function classifyWaitsOutgoingMessage(message: Record<string, unknown>): WaitsActionDispatch | null {
  const id = typeof message.id === 'string' && message.id.length > 0 ? message.id : null;
  if (id === null) return null;

  if (message.type === 'decide-approval') {
    const approvalRequestId = typeof message.approvalRequestId === 'string' && message.approvalRequestId.length > 0
      ? message.approvalRequestId
      : null;
    const parsedDecision = PermissionDecision.safeParse(message.decision);
    if (approvalRequestId === null || !parsedDecision.success) return null;
    const note = typeof message.message === 'string' ? message.message : undefined;
    return {
      kind: 'decide-approval',
      input: note === undefined
        ? { id, approvalRequestId, decision: parsedDecision.data }
        : { id, approvalRequestId, decision: parsedDecision.data, message: note },
    };
  }

  if (message.type === 'answer-approval') {
    const approvalRequestId = typeof message.approvalRequestId === 'string' && message.approvalRequestId.length > 0
      ? message.approvalRequestId
      : null;
    const parsedAnswers = ConversationAnswers.safeParse(message.answers);
    if (approvalRequestId === null || !parsedAnswers.success) return null;
    return {
      kind: 'answer-approval',
      input: { id, approvalRequestId, answers: parsedAnswers.data },
    };
  }

  if (message.type === 'plan-decision') {
    const parsedDecision = PlanDecision.safeParse(message.decision);
    if (!parsedDecision.success) return null;
    const feedback = typeof message.feedback === 'string' ? message.feedback : undefined;
    return {
      kind: 'plan-decision',
      input: feedback === undefined
        ? { id, decision: parsedDecision.data }
        : { id, decision: parsedDecision.data, feedback },
    };
  }

  return null;
}
