const BYTES_PER_MEGABYTE = 1024 * 1024;

export const MEMORY_RECHECK_MS = 5_000;
const MEMORY_RESERVATION_SETTLE_MS = 30_000;
export const DEFAULT_SESSION_MEMORY_RESERVE_MB = 600;

export type MemoryStartKind = 'session';

export type MemoryReading =
  | { ok: true; headroomBytes: number }
  | { ok: false; reason: string };

export interface MemoryReservation {
  bytes: number;
  admittedAtMs: number;
}

export interface CgroupLevel {
  limitBytes: number | null;
  currentBytes: number | null;
  inactiveFileBytes: number | null;
}

interface MemoryReserveConfig {
  sessionMemoryReserveMB?: number;
}

export function memoryReserveBytes(config: MemoryReserveConfig, _kind: MemoryStartKind): number {
  const reserveMegabytes = config.sessionMemoryReserveMB ?? DEFAULT_SESSION_MEMORY_RESERVE_MB;
  return reserveMegabytes * BYTES_PER_MEGABYTE;
}

export function parseCgroupV2Path(procSelfCgroupText: string): string | null {
  const unifiedLine = procSelfCgroupText.split('\n').find((line) => line.startsWith('0::'));
  if (unifiedLine === undefined) return null;
  const cgroupPath = unifiedLine.slice(3).trim();
  return cgroupPath.startsWith('/') ? cgroupPath : null;
}

export function cgroupAncestorPaths(cgroupPath: string): string[] {
  const segments = cgroupPath.split('/').filter((segment) => segment.length > 0);
  return segments.map((_segment, depthFromLeaf) => `/${segments.slice(0, segments.length - depthFromLeaf).join('/')}`);
}

export function parseCgroupBytes(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

export function cgroupLimitBytes(memoryHighText: string | null, memoryMaxText: string | null): number | null {
  return parseCgroupBytes(memoryHighText) ?? parseCgroupBytes(memoryMaxText);
}

export function parseInactiveFileBytes(memoryStatText: string | null): number | null {
  if (memoryStatText === null) return null;
  const match = /^inactive_file (\d+)$/m.exec(memoryStatText);
  return match ? Number(match[1]) : null;
}

export function parseMemAvailableBytes(meminfoText: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfoText);
  return match ? Number(match[1]) * 1024 : null;
}

export function headroomFromReadings({ cgroupLevels, hostAvailableBytes }: {
  cgroupLevels: readonly CgroupLevel[];
  hostAvailableBytes: number | null;
}): number | null {
  const candidates = cgroupLevels.flatMap(({ limitBytes, currentBytes, inactiveFileBytes }) => {
    if (limitBytes === null || currentBytes === null) return [];
    const workingSetBytes = Math.max(0, currentBytes - (inactiveFileBytes ?? 0));
    return [Math.max(0, limitBytes - workingSetBytes)];
  });
  if (hostAvailableBytes !== null) candidates.push(hostAvailableBytes);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

export function liveReservations(reservations: readonly MemoryReservation[], nowMs: number): MemoryReservation[] {
  return reservations.filter((reservation) => nowMs - reservation.admittedAtMs < MEMORY_RESERVATION_SETTLE_MS);
}

export function shouldAdmitStart({ reading, reserveBytes, reservations, nowMs }: {
  reading: MemoryReading;
  reserveBytes: number;
  reservations: readonly MemoryReservation[];
  nowMs: number;
}): boolean {
  if (!reading.ok) return true;
  const reservedBytes = liveReservations(reservations, nowMs).reduce((total, reservation) => total + reservation.bytes, 0);
  return reading.headroomBytes - reservedBytes >= reserveBytes;
}
