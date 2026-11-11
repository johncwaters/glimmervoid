import { z } from 'zod';

export const GITHUB_USAGE_RESOURCES = ['graphql', 'core', 'search'] as const;
export const GithubUsageResource = z.enum(GITHUB_USAGE_RESOURCES);
export type GithubUsageResource = z.infer<typeof GithubUsageResource>;

export const GithubOperationUsage = z.object({
  operation: z.string(),
  resource: GithubUsageResource,
  calls: z.number().int().nonnegative(),
  points: z.number().nonnegative(),
  failures: z.number().int().nonnegative(),
});
export type GithubOperationUsage = z.infer<typeof GithubOperationUsage>;

export const GithubResourceUsage = z.object({
  resource: GithubUsageResource,
  glimmervoidPoints: z.number().nonnegative(),
  windowStartMs: z.number(),
  accountUsed: z.number().nullable(),
  accountLimit: z.number().nullable(),
  resetAtMs: z.number().nullable(),
});
export type GithubResourceUsage = z.infer<typeof GithubResourceUsage>;

export const GithubUsageSnapshot = z.object({
  writtenAtMs: z.number(),
  windowMs: z.number(),
  recordingSinceMs: z.number(),
  operations: z.array(GithubOperationUsage),
  resources: z.array(GithubResourceUsage),
});
export type GithubUsageSnapshot = z.infer<typeof GithubUsageSnapshot>;
