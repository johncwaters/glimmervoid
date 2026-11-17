import { z } from 'zod';
import { ReviewFinding, ReviewVerdict } from './team-review.ts';

export const SESSION_REVIEW_AGENTS = ['claude-code', 'codex'] as const;
export const SessionReviewAgent = z.enum(SESSION_REVIEW_AGENTS);
export type SessionReviewAgent = z.infer<typeof SessionReviewAgent>;

export const SessionReviewResult = z.strictObject({
  sessionId: z.string().min(1),
  sig: z.string(),
  reviewer: z.strictObject({ agent: SessionReviewAgent, model: z.string().min(1).nullable() }),
  status: z.enum(['running', 'done', 'failed']),
  verdict: ReviewVerdict.nullable(),
  summary: z.string(),
  findings: z.array(ReviewFinding),
  error: z.string().nullable(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
});
export type SessionReviewResult = z.infer<typeof SessionReviewResult>;
