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

export interface AgentWaitsState {
  isClosed: boolean;
  generation: number;
  isResettingPlan: boolean;
}

export const INITIAL_AGENT_WAITS_STATE: AgentWaitsState = {
  isClosed: false,
  generation: 0,
  isResettingPlan: false,
};

export type WaitsRollbackKind = 'none' | 'clear-approval' | 'reset-plan';

interface WaitsFailureDecision {
  shouldShow: boolean;
  message: string | null;
}

interface WaitsDispatchStart {
  dispatch: WaitsActionDispatch | null;
  generation: number;
  shouldShowFailure: boolean;
  failureText: string | null;
}

interface WaitsDispatchSettledDecision {
  rollback: WaitsRollbackKind;
  shouldShowFailure: boolean;
  failureText: string | null;
}

export function beginWaitsSync(state: AgentWaitsState): AgentWaitsState {
  return { ...state, isClosed: false };
}

export function closeWaitsState(state: AgentWaitsState): AgentWaitsState {
  return {
    isClosed: true,
    generation: state.generation + 1,
    isResettingPlan: false,
  };
}

export function shouldExposePlanGate(state: AgentWaitsState): boolean {
  return !state.isResettingPlan;
}

export function withPlanGateReset(state: AgentWaitsState, isResettingPlan: boolean): AgentWaitsState {
  return { ...state, isResettingPlan };
}

export function decideWaitsFailureDisplay(
  state: AgentWaitsState,
  failureText: string | null,
): WaitsFailureDecision {
  if (state.isClosed || failureText === null) return { shouldShow: false, message: null };
  return { shouldShow: true, message: failureText };
}

export function decideWaitsOutgoingDispatch(
  state: AgentWaitsState,
  message: Record<string, unknown>,
): WaitsDispatchStart {
  const dispatch = classifyWaitsOutgoingMessage(message);
  if (dispatch === null) {
    return {
      dispatch: null,
      generation: state.generation,
      shouldShowFailure: !state.isClosed,
      failureText: state.isClosed ? null : NOT_SENT_TEXT,
    };
  }
  return {
    dispatch,
    generation: state.generation,
    shouldShowFailure: false,
    failureText: null,
  };
}

export function decideWaitsDispatchSettled(
  state: AgentWaitsState,
  dispatchKind: WaitsActionDispatch['kind'],
  dispatchGeneration: number,
  isOk: boolean,
  errorMessage: string | null,
): WaitsDispatchSettledDecision {
  if (isOk || state.isClosed || state.generation !== dispatchGeneration) {
    return { rollback: 'none', shouldShowFailure: false, failureText: null };
  }
  const rollback: WaitsRollbackKind = dispatchKind === 'plan-decision' ? 'reset-plan' : 'clear-approval';
  const failureText = errorMessage !== null && errorMessage.length > 0 ? errorMessage : NOT_SENT_TEXT;
  return { rollback, shouldShowFailure: true, failureText };
}

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
