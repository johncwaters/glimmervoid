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

export const PrFlowHandled = z.strictObject({
  itemKey: z.string().min(1), dismissalKeys: z.array(z.string().min(1)).min(1), action: PrFlowDisposition, location: z.string(), reason: z.string().nullable(), at: z.number().finite(),
});
export type PrFlowHandled = z.infer<typeof PrFlowHandled>;

export const PrFlowsState = z.strictObject({ handledByPr: z.record(z.string(), z.array(PrFlowHandled)) });
export type PrFlowsState = z.infer<typeof PrFlowsState>;

export const PrFlowsStatus = z.looseObject({ type: z.literal('pr-flows-status'), handledByPr: PrFlowsState.shape.handledByPr });
export type PrFlowsStatus = z.infer<typeof PrFlowsStatus>;

export const PrFlowDisposeRequest = z.strictObject({
  prKey: z.string().min(1), itemKey: z.string().min(1), action: PrFlowDisposition, reason: z.string().trim().min(1).max(2000).optional(),
}).refine((request) => request.action !== 'dismiss' || request.reason !== undefined, { message: 'a dismissal needs a reason', path: ['reason'] });
export type PrFlowDisposeRequest = z.infer<typeof PrFlowDisposeRequest>;

export const PrFlowDisposeResult = z.object({ ok: z.boolean(), error: z.string().optional(), isPending: z.boolean().optional() });
export type PrFlowDisposeResult = z.infer<typeof PrFlowDisposeResult>;

export const PrThreadReplyResponse = z.object({
  data: z.object({ addPullRequestReviewThreadReply: z.object({ comment: z.object({ id: z.string().min(1) }) }) }).nullable(),
  errors: z.array(z.unknown()).optional(),
});
