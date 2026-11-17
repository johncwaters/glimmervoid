import { z } from 'zod';

export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';
export const PROPOSED_PLAN_TEXT_FIELD = 'glimmervoid_plan_text';
export const PLAN_GATE_HOOK_EVENT = 'permissionrequest-plangate';
export const PLAN_GATE_TEXT_MAX_CHARS = 20_000;
export const PLAN_GATE_FEEDBACK_MAX_CHARS = 4000;

const PlanGateStatus = z.enum(['pending', 'approved', 'rejected']);

export const PlanGate = z.strictObject({
  planText: z.string().max(PLAN_GATE_TEXT_MAX_CHARS),
  isPlanTruncated: z.boolean(),
  status: PlanGateStatus,
  feedback: z.string().max(PLAN_GATE_FEEDBACK_MAX_CHARS).nullable(),
  decidedFromDashboard: z.boolean(),
});
export type PlanGate = z.infer<typeof PlanGate>;

export const PlanDecision = z.enum(['approve', 'reject', 'terminal']);
export type PlanDecision = z.infer<typeof PlanDecision>;
