import { z } from 'zod';

const QUESTION_MANAGER_RULES_MAX = 100;
export const QUESTION_ANSWERED_NOTIFY_CATEGORY = 'answered';
export { QUESTION_TOOL_HOLD_HOOK_EVENT, QUESTION_TOOL_HOLD_TIMEOUT_MS } from '../question-tool-hold.ts';

const RULE_SHAPE_ERROR = 'questionManager.rules entries must be a plain-language rule, an object with name, question and pick, or an object with name and pick "recommended"';
export const RECOMMENDED_PICK = 'recommended';
const RECOMMENDED_LABEL_SUFFIX = '(recommended)';

export function isRecommendedOptionLabel(label: string): boolean {
  return label.trim().toLowerCase().endsWith(RECOMMENDED_LABEL_SUFFIX);
}

const RuleName = z.string({ error: 'questionManager.rules[].name must be a string' }).trim().min(1).max(80);

export const QuestionMatchRule = z.object({
  name: RuleName,
  question: z.string({ error: 'questionManager.rules[].question must be a string' }).trim().min(1).max(500),
  pick: z.array(z.string().trim().min(1).max(200), { error: 'questionManager.rules[].pick must list option labels' }).min(1).max(8),
}, { error: RULE_SHAPE_ERROR });

const PlainLanguageRule = z.string().trim().min(1).max(1000);

export const QuestionRecommendedRule = z.strictObject({ name: RuleName, pick: z.literal(RECOMMENDED_PICK) }, { error: RULE_SHAPE_ERROR });

export const QuestionRule = z.union([PlainLanguageRule, QuestionMatchRule, QuestionRecommendedRule], { error: RULE_SHAPE_ERROR });

export const QuestionManagerSettings = z.object({
  rules: z.array(QuestionRule, { error: 'questionManager.rules must be an array' }).max(QUESTION_MANAGER_RULES_MAX).optional(),
  model: z.string({ error: 'questionManager.model must be a model name' }).trim().min(1).max(100).optional(),
}, { error: 'questionManager must be an object' });

export type QuestionMatchRule = z.infer<typeof QuestionMatchRule>;
export type QuestionRecommendedRule = z.infer<typeof QuestionRecommendedRule>;
export type QuestionRule = z.infer<typeof QuestionRule>;
export type QuestionManagerSettings = z.infer<typeof QuestionManagerSettings>;

export const DEFAULT_QUESTION_RULES: readonly QuestionRule[] = Object.freeze([{ name: 'Take recommended', pick: RECOMMENDED_PICK }]);

export const ManagerVerdict = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answer'),
    answers: z.record(z.string(), z.string()),
    ruleName: z.string().min(1),
    by: z.enum(['rule', 'manager']),
  }),
  z.object({ kind: z.literal('escalate'), reason: z.string().min(1) }),
]);

export type ManagerVerdict = z.infer<typeof ManagerVerdict>;

export const ManagerLaneResult = z.union([
  z.strictObject({
    rule: z.number().int().min(1),
    answers: z.array(z.strictObject({ question: z.string().min(1), labels: z.array(z.string().min(1)).min(1).max(8) })).min(1).max(8),
  }),
  z.strictObject({ escalate: z.string().min(1) }),
]);
export type ManagerAnswer = Extract<ManagerVerdict, { kind: 'answer' }>;

export const MANAGER_DECISION_EVENT = 'manager-decision';
export const MANAGER_DECISION_AUDIT_KIND = 'question-manager';

const ManagerDecisionBase = {
  kind: z.literal(MANAGER_DECISION_AUDIT_KIND),
  seq: z.number().int().min(1),
  ts: z.number(),
};

export const ManagerDecision = z.discriminatedUnion('outcome', [
  z.object({
    ...ManagerDecisionBase,
    outcome: z.literal('answered'),
    by: z.enum(['rule', 'manager']),
    rule: z.string().min(1),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({
    ...ManagerDecisionBase,
    outcome: z.literal('escalated'),
    questions: z.array(z.string()),
    reason: z.string().min(1),
  }),
]);

export type ManagerDecision = z.infer<typeof ManagerDecision>;
