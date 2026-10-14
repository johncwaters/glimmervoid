export const GITHUB_CLOCK_INTERVAL_MINUTES = 5;

export function runsEveryTicks(intervalMs: number, baseIntervalMs: number): number {
  if (!Number.isFinite(intervalMs) || !Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) return 1;
  return Math.max(1, Math.round(intervalMs / baseIntervalMs));
}
