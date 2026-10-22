import { z } from 'zod';

export const GithubPollingRetry = z.object({ attempt: z.number().int().positive(), limit: z.number().int().positive() }).refine((retry) => retry.attempt <= retry.limit);
export type GithubPollingRetry = z.infer<typeof GithubPollingRetry>;

export const githubPollingShape = {
  error: z.string().nullable().optional(),
  lastRefreshedAt: z.number().finite().nonnegative().nullable().optional(),
  incident: z.string().nullable().optional(),
  nextAttemptAt: z.number().finite().nonnegative().nullable().optional(),
  retry: GithubPollingRetry.nullable().optional(),
  isRefreshing: z.boolean().optional(),
  refreshNotice: z.string().nullable().optional(),
};

export const GithubPrsFreshness = z.strictObject({ lastRefreshedAt: z.number().finite().nonnegative().nullable(), error: z.string().nullable() });
export type GithubPrsFreshness = z.infer<typeof GithubPrsFreshness>;

export const GithubPollingRefreshRequest = z.object({ lane: z.enum(['my-prs', 'team-review', 'issues']) });
export type GithubPollingRefreshRequest = z.infer<typeof GithubPollingRefreshRequest>;
export const GithubPollingRefreshResult = z.object({
  ok: z.boolean(), error: z.string().optional(),
  freshness: GithubPrsFreshness.optional(),
});
export type GithubPollingRefreshResult = z.infer<typeof GithubPollingRefreshResult>;
