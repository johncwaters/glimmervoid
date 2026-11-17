import { EXIT_PLAN_MODE_TOOL_NAME, PLAN_GATE_FEEDBACK_MAX_CHARS, PLAN_GATE_TEXT_MAX_CHARS } from '../../shared/contracts/plan-gate.ts';
import type { PlanDecision, PlanGate } from '../../shared/contracts/plan-gate.ts';
import type { ClaudeHookReply } from './claude-approval-core.ts';

const REJECTED_PLAN_MESSAGE = 'The operator rejected this plan. Revise it and propose it again.';
const CODEX_APPROVAL_TEXT = 'Approved. Implement the plan.';

type PlanGateEvent =
  | { kind: 'plan-proposed'; planText: string }
  | { kind: 'decided'; decision: Exclude<PlanDecision, 'terminal'>; feedback: string | null }
  | { kind: 'cleared' };

function isPlanGateEnabled(rawPlanGateConfig: unknown): boolean {
  return typeof rawPlanGateConfig === 'object' && rawPlanGateConfig !== null && 'enabled' in rawPlanGateConfig && rawPlanGateConfig.enabled === true;
}

function boundedFeedback(feedback: string | null | undefined): string | null {
  const trimmed = (feedback ?? '').trim().slice(0, PLAN_GATE_FEEDBACK_MAX_CHARS);
  return trimmed.length > 0 ? trimmed : null;
}

function nextPlanGate(current: PlanGate | null, event: PlanGateEvent): PlanGate | null {
  if (event.kind === 'cleared') return null;
  if (event.kind === 'plan-proposed') {
    const planText = event.planText.trim();
    return { planText: planText.slice(0, PLAN_GATE_TEXT_MAX_CHARS), isPlanTruncated: planText.length > PLAN_GATE_TEXT_MAX_CHARS, status: 'pending', feedback: null, decidedFromDashboard: false };
  }
  if (current?.status !== 'pending') return current;
  return { ...current, status: event.decision === 'approve' ? 'approved' : 'rejected', feedback: boundedFeedback(event.feedback), decidedFromDashboard: true };
}

function shouldClearPlanGate(planGate: PlanGate | null, isHeld: boolean, hookEvent: string): boolean {
  if (planGate === null || isHeld) return false;
  if (hookEvent === 'userpromptsubmit' || hookEvent === 'sessionend') return true;
  return hookEvent === 'stop' && planGate.status !== 'pending';
}

function planTextOfToolInput(toolInput: Record<string, unknown>): string {
  return typeof toolInput.plan === 'string' ? toolInput.plan : '';
}

function isExitPlanModeTool(toolName: string): boolean {
  return toolName === EXIT_PLAN_MODE_TOOL_NAME;
}

function claudePlanDecisionReply(decision: Exclude<PlanDecision, 'terminal'>, feedback: string | null): ClaudeHookReply {
  if (decision === 'approve') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  const message = feedback ? `${REJECTED_PLAN_MESSAGE} Their feedback: ${feedback}` : REJECTED_PLAN_MESSAGE;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
}

function codexPlanDecisionText(decision: Exclude<PlanDecision, 'terminal'>, feedback: string | null): string {
  if (decision === 'approve') return feedback ? `${CODEX_APPROVAL_TEXT} ${feedback}` : CODEX_APPROVAL_TEXT;
  return feedback ? `${REJECTED_PLAN_MESSAGE} Feedback: ${feedback}` : REJECTED_PLAN_MESSAGE;
}

export { claudePlanDecisionReply, codexPlanDecisionText, isExitPlanModeTool, isPlanGateEnabled, nextPlanGate, planTextOfToolInput, shouldClearPlanGate };
export type { PlanGateEvent };
