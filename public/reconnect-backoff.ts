import { nextBackoffMs } from '#shared/backoff.ts';

export const BASE_RECONNECT_DELAY_MS = 500;
export const MAX_RECONNECT_DELAY_MS = 30000;

export function nextReconnectDelayMs(attempt: unknown, random: () => number = Math.random) {
  const attemptsSoFar = typeof attempt === 'number' && Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return nextBackoffMs({ attempt: attemptsSoFar + 1, baseMs: BASE_RECONNECT_DELAY_MS, maxMs: MAX_RECONNECT_DELAY_MS, random, jitter: 'half' });
}
