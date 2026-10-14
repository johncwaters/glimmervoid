import { z } from 'zod';

const RateLimitResource = z.object({ remaining: z.number(), reset: z.number() });
export const GithubRateLimitResources = z.record(z.string(), RateLimitResource);
export type GithubRateLimitResources = z.infer<typeof GithubRateLimitResources>;

export const GITHUB_RATE_LIMIT_WINDOW_MS = 60 * 60_000;

export function githubRateLimitWaitMs(resources: GithubRateLimitResources, nowMs: number, resourceNames: readonly string[]): number | null {
  const exhaustedResetsMs = resourceNames
    .flatMap((resourceName) => resources[resourceName] ?? [])
    .filter((resource) => resource.remaining <= 0)
    .map((resource) => resource.reset * 1000 - nowMs)
    .filter((waitMs) => waitMs > 0);
  if (exhaustedResetsMs.length === 0) return null;
  return Math.max(...exhaustedResetsMs);
}
