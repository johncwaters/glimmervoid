import { z } from 'zod';

export const PrFlowPriority = z.enum(['blocker', 'high', 'medium', 'low', 'unknown']);
export type PrFlowPriority = z.infer<typeof PrFlowPriority>;

export const PrFlowSource = z.strictObject({
  kind: z.enum(['own', 'thread', 'configured']), name: z.string().min(1), threadId: z.string().optional(), url: z.url().nullable(),
});
export type PrFlowSource = z.infer<typeof PrFlowSource>;

export const PrFlowItem = z.strictObject({
  key: z.string().min(1), path: z.string(), lineStart: z.number().int().positive().nullable(), lineEnd: z.number().int().positive().nullable(),
  priority: PrFlowPriority, sources: z.array(PrFlowSource).min(1), excerpt: z.string(), url: z.url().nullable(),
});
export type PrFlowItem = z.infer<typeof PrFlowItem>;
