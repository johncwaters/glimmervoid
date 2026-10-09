const DEFAULT_BASE_MS = 60_000;
const DEFAULT_MAX_MS = 30 * 60_000;
const MAX_DOUBLING_ATTEMPT = 20;

type BackoffJitter = 'full' | 'half' | 'none';

function nextBackoffMs({
  attempt = 1,
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_MS,
  retryAfterMs = null,
  random = Math.random,
  jitter = 'full',
}: {
  attempt?: number;
  baseMs?: number;
  maxMs?: number;
  retryAfterMs?: number | null;
  random?: () => number;
  jitter?: BackoffJitter;
} = {}): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, maxMs);
  const exponent = Math.max(0, Math.min(attempt, MAX_DOUBLING_ATTEMPT) - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  if (jitter === 'none') return ceiling;
  if (jitter === 'half') return Math.round(ceiling * (0.5 + 0.5 * random()));
  return Math.round(random() * ceiling);
}

export { DEFAULT_BASE_MS, DEFAULT_MAX_MS, nextBackoffMs };
export type { BackoffJitter };
