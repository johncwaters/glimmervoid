import { z } from 'zod';

const QUESTION_MANAGER_RULES_MAX = 100;
const QUESTION_MANAGER_REPOS_MAX = 100;
export const QUESTION_ANSWERED_NOTIFY_CATEGORY = 'answered';
export const QUESTION_TOOL_HOLD_HOOK_EVENT = 'pretooluse-question';
export const QUESTION_TOOL_HOLD_TIMEOUT_MS = 90_000;

const RULE_SHAPE_ERROR = 'questionManager.rules entries must be a plain-language rule or an object with name, question and pick';

export const QuestionMatchRule = z.object({
  name: z.string({ error: 'questionManager.rules[].name must be a string' }).trim().min(1).max(80),
  question: z.string({ error: 'questionManager.rules[].question must be a string' }).trim().min(1).max(500),
  pick: z.array(z.string().trim().min(1).max(200), { error: 'questionManager.rules[].pick must list option labels' }).min(1).max(8),
}, { error: RULE_SHAPE_ERROR });

const PlainLanguageRule = z.string().trim().min(1).max(1000);

export const QuestionRule = z.union([PlainLanguageRule, QuestionMatchRule], { error: RULE_SHAPE_ERROR });

export const QuestionManagerSettings = z.object({
  enabled: z.boolean({ error: 'questionManager.enabled must be a boolean' }).optional(),
  repos: z.array(
    z.string({ error: 'questionManager.repos must list repository paths or owner/name slugs' }).trim().min(1),
    { error: 'questionManager.repos must list repository paths or owner/name slugs' },
  ).max(QUESTION_MANAGER_REPOS_MAX).optional(),
  rules: z.array(QuestionRule, { error: 'questionManager.rules must be an array' }).max(QUESTION_MANAGER_RULES_MAX).optional(),
  model: z.string({ error: 'questionManager.model must be a model name' }).trim().min(1).max(100).optional(),
}, { error: 'questionManager must be an object' });

export type QuestionMatchRule = z.infer<typeof QuestionMatchRule>;
export type QuestionRule = z.infer<typeof QuestionRule>;
export type QuestionManagerSettings = z.infer<typeof QuestionManagerSettings>;

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
