export const BOOT_STAGGER_MIN_MS = 30_000;
export const BOOT_STAGGER_MAX_MS = 5 * 60_000;

export function bootStaggerDelayMs(uptimeMs: number, random: number): number {
  const clampedRandom = Math.min(Math.max(Number.isFinite(random) ? random : 0, 0), 1);
  const targetMs = BOOT_STAGGER_MIN_MS + clampedRandom * (BOOT_STAGGER_MAX_MS - BOOT_STAGGER_MIN_MS);
  const elapsedMs = Number.isFinite(uptimeMs) ? Math.max(uptimeMs, 0) : BOOT_STAGGER_MAX_MS;
  return Math.max(0, Math.round(targetMs - elapsedMs));
}
