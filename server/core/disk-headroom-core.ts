const BYTES_PER_GIGABYTE = 1024 * 1024 * 1024;

export const DEFAULT_WORKTREE_DISK_RESERVE_GB = 15;

export type DiskReading =
  | { ok: true; freeBytes: number; totalBytes: number; filesystemId: string }
  | { ok: false; reason: string };

interface DiskReserveConfig {
  worktreeDiskReserveGB?: number;
}

export function diskReserveBytes(config: DiskReserveConfig): number {
  return (config.worktreeDiskReserveGB ?? DEFAULT_WORKTREE_DISK_RESERVE_GB) * BYTES_PER_GIGABYTE;
}

export function isDiskShort(reading: DiskReading, reserveBytes: number): boolean {
  if (!reading.ok) return false;
  return reading.freeBytes < reserveBytes;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_GIGABYTE).toFixed(1)} GB`;
}

export function diskShortNotice(path: string, freeBytes: number, reserveBytes: number): string {
  return `Only ${formatGigabytes(freeBytes)} free on the disk holding ${path}, under the ${formatGigabytes(reserveBytes)} worktree disk reserve. Free space before starting more sessions there.`;
}

export const CACHEDIR_TAG_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

export function hasCacheDirSignature(tagFileHead: string): boolean {
  return tagFileHead.startsWith(CACHEDIR_TAG_SIGNATURE);
}

export function orderIdleWorktrees(worktrees: { path: string; lastActivityMs: number; isLive: boolean }[]): string[] {
  return worktrees
    .filter((worktree) => !worktree.isLive)
    .sort((older, newer) => older.lastActivityMs - newer.lastActivityMs)
    .map((worktree) => worktree.path);
}

export function isReclaimDue(isNewlyShort: boolean, lastReclaimAtMs: number | null, nowMs: number, cooldownMs: number): boolean {
  if (isNewlyShort || lastReclaimAtMs === null) return true;
  return nowMs - lastReclaimAtMs >= cooldownMs;
}

export function reclaimNotice(freedBytes: number, reclaimedFolderCount: number): string {
  return `Freed ${formatGigabytes(Math.max(0, freedBytes))} by deleting ${reclaimedFolderCount} build cache folder${reclaimedFolderCount === 1 ? '' : 's'} in worktrees no session is using.`;
}

export interface SessionTempUse {
  sessionId: string;
  bytes: number;
  isCapped: boolean;
}

export function largestSessionTempNotice(sessionTempUses: readonly SessionTempUse[], maxListed: number): string | null {
  const largest = [...sessionTempUses].sort((smaller, larger) => larger.bytes - smaller.bytes).slice(0, maxListed).filter((use) => use.bytes > 0);
  if (largest.length === 0) return null;
  const listed = largest.map((use) => `${use.sessionId} ${use.isCapped ? 'at least ' : ''}${formatGigabytes(use.bytes)}`);
  return `Largest session temp folders: ${listed.join(', ')}.`;
}

export function diskAlertStep(path: string, reading: DiskReading, reserveBytes: number, wasShort: boolean): { isShort: boolean; message: string | null } {
  if (!reading.ok) return { isShort: wasShort, message: null };
  const isShort = isDiskShort(reading, reserveBytes);
  if (!isShort || wasShort) return { isShort, message: null };
  return { isShort, message: diskShortNotice(path, reading.freeBytes, reserveBytes) };
}
