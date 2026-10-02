import type { ReviewsRetry } from '../../shared/contracts/reviews.ts';

export const QUICK_RETRY_DELAYS_MS = Object.freeze([10_000, 30_000, 90_000]);

export function nextRetrySchedule({ failureStreak, quickRetryCount, quickRetries, retryAfterMs, baseMs, maxMs, random }: {
  failureStreak: number; quickRetryCount: number; quickRetries: boolean; retryAfterMs?: number; baseMs: number; maxMs: number; random: () => number;
}): { waitMs: number; retry: ReviewsRetry | null } {
  const hasRateLimitWait = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0;
  const quickRetryDelayMs = quickRetries && !hasRateLimitWait ? QUICK_RETRY_DELAYS_MS[quickRetryCount] : undefined;
  if (quickRetryDelayMs !== undefined) return { waitMs: quickRetryDelayMs, retry: { attempt: quickRetryCount + 1, limit: QUICK_RETRY_DELAYS_MS.length } };
  return { waitMs: nextBackoffMs({ attempt: Math.max(1, failureStreak - quickRetryCount), baseMs, maxMs, retryAfterMs, random }), retry: null };
}

const DEFAULT_BASE_MS = 60_000;
const DEFAULT_MAX_MS = 30 * 60_000;

function nextBackoffMs({
  attempt = 1,
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_MS,
  retryAfterMs = null,
  random = Math.random,
}: {
  attempt?: number;
  baseMs?: number;
  maxMs?: number;
  retryAfterMs?: number | null;
  random?: () => number;
} = {}): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, maxMs);
  const exponent = Math.max(0, Math.min(attempt, 20) - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(random() * ceiling);
}

function shouldSkipTick({ now = 0, backoffUntil = 0 }: { now?: number; backoffUntil?: number } = {}): boolean {
  return backoffUntil > now;
}

const SECONDARY_RATE_LIMIT_MIN_WAIT_MS = 60_000;
const SECONDARY_RATE_LIMIT_WORDING = /secondary rate limit|abuse detection|abuse rate limit/i;
const RETRY_AFTER_SECONDS = /retry[- ]after\W*(\d+)/i;

function secondaryRateLimitWaitMs(errorText: string | null | undefined): number | null {
  if (!errorText) return null;
  const retryAfterMatch = RETRY_AFTER_SECONDS.exec(errorText);
  const retryAfterMs = retryAfterMatch ? Number.parseInt(retryAfterMatch[1] ?? '0', 10) * 1000 : 0;
  if (!retryAfterMatch && !SECONDARY_RATE_LIMIT_WORDING.test(errorText)) return null;
  return Math.max(SECONDARY_RATE_LIMIT_MIN_WAIT_MS, retryAfterMs);
}

function parseRetryAfterMs(header: unknown, now: number = Date.now()): number | null {
  if (header == null) return null;
  const raw = String(header).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  if (delta > 0) return delta;
  return null;
}

export {
  nextBackoffMs, parseRetryAfterMs, secondaryRateLimitWaitMs, shouldSkipTick, SECONDARY_RATE_LIMIT_MIN_WAIT_MS, DEFAULT_BASE_MS, DEFAULT_MAX_MS,
};
