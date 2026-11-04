import { z } from 'zod';

export const PrFlowPriority = z.enum(['blocker', 'high', 'medium', 'low', 'unknown']);
export type PrFlowPriority = z.infer<typeof PrFlowPriority>;

export const PrFlowSource = z.strictObject({
  kind: z.enum(['own', 'thread', 'configured']), name: z.string().min(1), threadId: z.string().optional(), url: z.url().nullable(),
  excerpt: z.string(), dismissalKey: z.string().min(1),
});
export type PrFlowSource = z.infer<typeof PrFlowSource>;

export const PrFlowItem = z.strictObject({
  key: z.string().min(1), path: z.string(), lineStart: z.number().int().positive().nullable(), lineEnd: z.number().int().positive().nullable(),
  priority: PrFlowPriority, sources: z.array(PrFlowSource).min(1), excerpt: z.string(), url: z.url().nullable(),
});
export type PrFlowItem = z.infer<typeof PrFlowItem>;

const PrFlowDisposition = z.enum(['dismiss', 'fix-local']);
const PR_FLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PrFlowActionRef = z.union([
  z.enum(['ask', 'fix-local', 'dismiss']),
  z.templateLiteral(['run:', z.string().regex(PR_FLOW_ID)]),
], { error: 'a pr flows rule action must be ask, fix-local, dismiss or run:<action id>' });
export type PrFlowActionRef = z.infer<typeof PrFlowActionRef>;

export const PrFlowRule = z.strictObject({
  name: z.string({ error: 'a pr flows rule needs a name' }).trim().min(1, { error: 'a pr flows rule needs a name' }).max(80, { error: 'a pr flows rule name must be at most 80 characters' }),
  source: z.string().min(1).optional(),
  priority: z.array(PrFlowPriority).min(1).optional(),
  paths: z.array(z.string().min(1)).min(1).optional(),
  text: z.string().min(1).optional(),
  scope: z.enum(['mine', 'team', 'both']).default('mine'),
  action: PrFlowActionRef,
  reason: z.string().trim().min(1).max(2000).optional(),
}).refine((rule) => rule.action !== 'dismiss' || rule.reason !== undefined, { message: 'a dismiss rule needs a reason', path: ['reason'] });
export type PrFlowRule = z.infer<typeof PrFlowRule>;

export const PrFlowsSettings = z.looseObject({
  rules: z.array(z.unknown(), { error: 'prFlows.rules must be an array' }).optional(),
  repoRules: z.record(z.string(), z.unknown(), { error: 'prFlows.repoRules must be an object of repository names' }).optional(),
});

export const PrFlowHandled = z.strictObject({
  itemKey: z.string().min(1), dismissalKeys: z.array(z.string().min(1)).min(1), action: PrFlowDisposition, location: z.string(), reason: z.string().nullable(), at: z.number().finite(),
  ruleName: z.string().nullable(), threadIds: z.array(z.string().min(1)),
});
export type PrFlowHandled = z.infer<typeof PrFlowHandled>;

export const PrFlowsState = z.strictObject({
  handledByPr: z.record(z.string(), z.array(PrFlowHandled)),
  reopenedByPr: z.record(z.string(), z.array(z.string().min(1))),
});
export type PrFlowsState = z.infer<typeof PrFlowsState>;

export const PrFlowsStatus = z.looseObject({ type: z.literal('pr-flows-status'), handledByPr: PrFlowsState.shape.handledByPr, warnings: z.array(z.string()) });
export type PrFlowsStatus = z.infer<typeof PrFlowsStatus>;

export const PrFlowItemRequest = z.strictObject({ prKey: z.string().min(1), itemKey: z.string().min(1) });
export type PrFlowItemRequest = z.infer<typeof PrFlowItemRequest>;

export const PrFlowSaveRuleRequest = z.strictObject({ ...PrFlowItemRequest.shape, reason: z.string().trim().min(1).max(2000) });
export type PrFlowSaveRuleRequest = z.infer<typeof PrFlowSaveRuleRequest>;

export const PrFlowDisposeRequest = z.strictObject({
  prKey: z.string().min(1), itemKey: z.string().min(1), action: PrFlowDisposition, reason: z.string().trim().min(1).max(2000).optional(),
}).refine((request) => request.action !== 'dismiss' || request.reason !== undefined, { message: 'a dismissal needs a reason', path: ['reason'] });
export type PrFlowDisposeRequest = z.infer<typeof PrFlowDisposeRequest>;

export const PrFlowDisposeResult = z.object({ ok: z.boolean(), error: z.string().optional(), isPending: z.boolean().optional() });
export type PrFlowDisposeResult = z.infer<typeof PrFlowDisposeResult>;

export const PrThreadUnresolveResponse = z.object({
  data: z.object({ unresolveReviewThread: z.object({ thread: z.object({ id: z.string().min(1), isResolved: z.literal(false) }) }) }).nullable(),
  errors: z.array(z.unknown()).optional(),
});

export const PrThreadReplyResponse = z.object({
  data: z.object({ addPullRequestReviewThreadReply: z.object({ comment: z.object({ id: z.string().min(1) }) }) }).nullable(),
  errors: z.array(z.unknown()).optional(),
});
