import { z } from 'zod';

export const DirectorDigest = z.object({
  openedAt: z.number().int().nonnegative(),
  chatLine: z.string().min(1).nullable().default(null),
  digest: z.string().min(1).nullable(),
  points: z.array(z.string().min(1)).default([]),
});
export type DirectorDigest = z.infer<typeof DirectorDigest>;

export const ProgressAnswer = z.object({
  askedAt: z.number().int().nonnegative(),
  question: z.string().min(1),
  answer: z.string().min(1),
});
export type ProgressAnswer = z.infer<typeof ProgressAnswer>;

export const SessionProgressAnswer = ProgressAnswer.extend({ sessionId: z.string() });
export type SessionProgressAnswer = z.infer<typeof SessionProgressAnswer>;

export const DirectorDigestState = z.looseObject({
  digestsBySessionId: z.record(z.string().min(1), z.array(DirectorDigest)).default({}),
  progressAnswersBySessionId: z.record(z.string().min(1), z.array(ProgressAnswer)).default({}),
  hasSweptLeftoverCards: z.boolean().default(false),
});
export type DirectorDigestState = z.infer<typeof DirectorDigestState>;
