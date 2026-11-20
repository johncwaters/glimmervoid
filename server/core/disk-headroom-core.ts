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

export function diskAlertStep(path: string, reading: DiskReading, reserveBytes: number, wasShort: boolean): { isShort: boolean; message: string | null } {
  if (!reading.ok) return { isShort: wasShort, message: null };
  const isShort = isDiskShort(reading, reserveBytes);
  if (!isShort || wasShort) return { isShort, message: null };
  return { isShort, message: diskShortNotice(path, reading.freeBytes, reserveBytes) };
}
