import { z } from 'zod';
import { parseJsonOrNull } from '../../core/json-core.ts';
import { nextBackoffMs } from '../../../shared/backoff.ts';

const RateLimitResource = z.object({ remaining: z.number(), reset: z.number(), used: z.number().optional(), limit: z.number().optional() });
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

const REFUSAL_RETRY_BASE_MS = 2_000;
const REFUSAL_RETRY_CAP_MS = 15_000;
export const REFUSAL_RETRY_ATTEMPTS = 2;

const RATE_LIMIT_WORDING = /rate limit/i;
const MUTATION_OPENING = /^\s*mutation\b/;
const GraphqlErrorsBody = z.object({ errors: z.array(z.object({ type: z.string().optional(), message: z.string().optional() })) });
const RestErrorBody = z.object({ message: z.string() });

export type GithubRefusal = { used: number | null; resetAtMs: number | null; retryAfterSeconds: number | null };

function headerNumber(headers: ReadonlyMap<string, string>, name: string): number | null {
  const value = headers.get(name);
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function isRateLimitedBody(body: string): boolean {
  const parsed = GraphqlErrorsBody.safeParse(parseJsonOrNull(body));
  if (!parsed.success) return false;
  return parsed.data.errors.some((error) => error.type === 'RATE_LIMITED' || RATE_LIMIT_WORDING.test(error.message ?? ''));
}

function isRateLimitedMessage(body: string): boolean {
  const parsed = RestErrorBody.safeParse(parseJsonOrNull(body));
  return parsed.success && RATE_LIMIT_WORDING.test(parsed.data.message);
}

export function githubRefusalOf(status: number, headers: ReadonlyMap<string, string>, body: string): GithubRefusal | null {
  const isRefusedStatus = (status === 403 || status === 429) && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || isRateLimitedMessage(body));
  if (!isRefusedStatus && !isRateLimitedBody(body)) return null;
  const resetSeconds = headerNumber(headers, 'x-ratelimit-reset');
  return { used: headerNumber(headers, 'x-ratelimit-used'), resetAtMs: resetSeconds === null ? null : resetSeconds * 1000, retryAfterSeconds: headerNumber(headers, 'retry-after') };
}

export function refusalRetryDelayMs(refusal: GithubRefusal, attempt: number, random: () => number = Math.random): number | null {
  if (refusal.retryAfterSeconds === null) return nextBackoffMs({ attempt, baseMs: REFUSAL_RETRY_BASE_MS, maxMs: REFUSAL_RETRY_CAP_MS, jitter: 'full', random });
  const retryAfterMs = refusal.retryAfterSeconds * 1000;
  return retryAfterMs > REFUSAL_RETRY_CAP_MS ? null : retryAfterMs;
}

export function isGraphqlMutation(query: string): boolean {
  return MUTATION_OPENING.test(query);
}

export function utcClockText(atMs: number): string {
  return new Date(atMs).toISOString().slice(11, 16);
}

export function refusingReadsText(nextTryAtMs: number | null): string {
  const base = 'GitHub is refusing reads (rate limit).';
  return nextTryAtMs === null ? base : `${base} Next try ${utcClockText(nextTryAtMs)} UTC.`;
}

export function isRateLimitText(text: string | null | undefined): boolean {
  return RATE_LIMIT_WORDING.test(text ?? '');
}
