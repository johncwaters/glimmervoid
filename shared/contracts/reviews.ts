import { z } from 'zod';

export const ReviewsRetry = z.object({ attempt: z.number().int().positive(), limit: z.number().int().positive() }).refine((retry) => retry.attempt <= retry.limit);
export type ReviewsRetry = z.infer<typeof ReviewsRetry>;

export const reviewsPollingShape = {
  error: z.string().nullable().optional(),
  nextAttemptAt: z.number().finite().nonnegative().nullable().optional(),
  retry: ReviewsRetry.nullable().optional(),
  isRefreshing: z.boolean().optional(),
  refreshNotice: z.string().nullable().optional(),
};

export const ReviewsRefreshRequest = z.object({ lane: z.enum(['my-prs', 'team-review']) });
export type ReviewsRefreshRequest = z.infer<typeof ReviewsRefreshRequest>;
export const ReviewsRefreshResult = z.object({ ok: z.boolean(), error: z.string().optional() });
export type ReviewsRefreshResult = z.infer<typeof ReviewsRefreshResult>;
