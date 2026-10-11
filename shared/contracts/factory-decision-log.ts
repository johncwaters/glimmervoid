import { z } from 'zod';
import type { FactoryCheck, FactoryFence } from '../../server/core/factory-core.ts';
import { FactoryReviewVerdict, isSingleFactoryPathSegment } from './factory.ts';

export const FACTORY_DECISION_OUTPUT_MAX_BYTES = 16 * 1024;

export const FactoryDecisionKind = z.enum(['admission', 'closeout', 'merge', 'watch', 'verification', 'exception', 'landing']);
export const FactoryDecisionOutcome = z.enum(['refused', 'available', 'dispatched', 'ended', 'retry', 'block', 'merge', 'merged', 'breach', 'verified', 'verified-unwatched', 'failed', 'stale', 'passed', 'raised', 'stalled', 'recovered']);
export const FactoryDecisionFailureClass = z.enum(['admission', 'worker', 'fence', 'check', 'review', 'closeout', 'breach', 'verification', 'stale', 'exception', 'stall', 'landing']);

const decisionCheck: z.ZodType<FactoryCheck> = z.strictObject({ command: z.string(), pass: z.boolean(), output: z.string() });
const decisionFence: z.ZodType<FactoryFence> = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), outside: z.array(z.string()), protected: z.array(z.string()), unsupportedProtectedPaths: z.array(z.string()) }),
]);

const decisionFields = {
  timestamp: z.iso.datetime(),
  projectId: z.string().min(1).max(128).refine(isSingleFactoryPathSegment),
  outcome: FactoryDecisionOutcome,
  workId: z.string().min(1).nullable(),
  intentId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  attempt: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  failureClass: FactoryDecisionFailureClass.nullable(),
  reason: z.string().max(1000).nullable(),
};

export const FactoryDecisionLogLine = z.discriminatedUnion('kind', [
  z.strictObject({ ...decisionFields, kind: z.literal('admission'), outcome: z.enum(['refused', 'available', 'dispatched', 'ended', 'block']) }),
  z.strictObject({ ...decisionFields, kind: z.literal('closeout'), outcome: z.enum(['retry', 'block', 'merge']),
    attempt: z.number().int().positive(), durationMs: z.number().int().nonnegative(),
    fence: decisionFence.nullable(), checks: z.array(decisionCheck).refine((checks) => checks.reduce((totalBytes, check) => totalBytes + new TextEncoder().encode(check.output).length, 0) <= FACTORY_DECISION_OUTPUT_MAX_BYTES),
    review: FactoryReviewVerdict.nullable() }),
  z.strictObject({ ...decisionFields, kind: z.literal('merge'), outcome: z.literal('merged'), mergedSha: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  z.strictObject({ ...decisionFields, kind: z.literal('watch'), outcome: z.enum(['breach', 'verified', 'verified-unwatched']) }),
  z.strictObject({ ...decisionFields, kind: z.literal('verification'), outcome: z.enum(['failed', 'stale', 'passed']) }),
  z.strictObject({ ...decisionFields, kind: z.literal('exception'), outcome: z.enum(['raised', 'stalled']) }),
  z.strictObject({ ...decisionFields, kind: z.literal('landing'), outcome: z.enum(['failed', 'recovered']) }),
]).superRefine((line, context) => {
  const isFailure = ['refused', 'retry', 'block', 'breach', 'failed', 'stale', 'raised', 'stalled'].includes(line.outcome);
  if (isFailure && line.failureClass === null) context.addIssue({ code: 'custom', path: ['failureClass'], message: 'Failure requires a failure class' });
  if (!isFailure && line.outcome !== 'ended' && line.failureClass !== null) context.addIssue({ code: 'custom', path: ['failureClass'], message: 'Success requires a null failure class' });
});
export type FactoryDecisionLogLine = z.infer<typeof FactoryDecisionLogLine>;
