const BYTES_PER_MEGABYTE = 1024 * 1024;
const BYTES_PER_GIGABYTE = 1024 * BYTES_PER_MEGABYTE;
const COMPACT_HOST_MAX_BYTES = 16 * BYTES_PER_GIGABYTE;
const STANDARD_HOST_MAX_BYTES = 32 * BYTES_PER_GIGABYTE;
const DEFAULT_HEADROOM_FLOOR_BYTES = 2 * BYTES_PER_GIGABYTE;
const DEFAULT_PRETOOL_HOLD_MS = 25_000;
const DEFAULT_HEAVY_LEASE_TTL_MS = 5 * 60 * 1000;
const COMPACT_IDLE_HIBERNATE_MS = 10 * 60 * 1000;
const STANDARD_IDLE_HIBERNATE_MS = 20 * 60 * 1000;

export const MEMORY_RECHECK_MS = 5_000;
const HIBERNATION_GRACE_MS = 60_000;
const MEMORY_RESERVATION_SETTLE_MS = 30_000;
export const DEFAULT_SESSION_MEMORY_RESERVE_MB = 600;

export interface DataSocketViewerState {
  isClaimed: boolean;
  isOutputPaused: boolean;
}

export function hasOpenSessionViewer(viewers: readonly DataSocketViewerState[]): boolean {
  return viewers.some((viewer) => viewer.isClaimed || !viewer.isOutputPaused);
}

export function isWithinHibernationGrace({
  stateSinceMs,
  lastViewerLeftAtMs,
  nowMs,
  graceMs = HIBERNATION_GRACE_MS,
}: {
  stateSinceMs: number;
  lastViewerLeftAtMs: number | null | undefined;
  nowMs: number;
  graceMs?: number;
}): boolean {
  const hasViewerLeft = lastViewerLeftAtMs != null && Number.isFinite(lastViewerLeftAtMs);
  const latestActivityAtMs = hasViewerLeft ? Math.max(stateSinceMs, lastViewerLeftAtMs) : stateSinceMs;
  if (!Number.isFinite(latestActivityAtMs)) return false;
  return nowMs - latestActivityAtMs < graceMs;
}

type ResourceTier = 'compact' | 'standard' | 'workstation';

export interface HostResourceProfile {
  tier: ResourceTier;
  heavyCommandSlots: number;
  testConcurrency: number | null;
  playwrightWorkers: number | null;
  threadPoolSize: number | null;
  idleHibernateMs: number | null;
  headroomFloorBytes: number;
  preToolHoldMs: number;
  leaseTtlMs: number;
}

export function resolveHostResourceProfile(totalMemBytes: number): HostResourceProfile {
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= COMPACT_HOST_MAX_BYTES) {
    return {
      tier: 'compact',
      heavyCommandSlots: 1,
      testConcurrency: 2,
      playwrightWorkers: 1,
      threadPoolSize: 4,
      idleHibernateMs: COMPACT_IDLE_HIBERNATE_MS,
      headroomFloorBytes: DEFAULT_HEADROOM_FLOOR_BYTES,
      preToolHoldMs: DEFAULT_PRETOOL_HOLD_MS,
      leaseTtlMs: DEFAULT_HEAVY_LEASE_TTL_MS,
    };
  }
  if (totalMemBytes <= STANDARD_HOST_MAX_BYTES) {
    return {
      tier: 'standard',
      heavyCommandSlots: 2,
      testConcurrency: 4,
      playwrightWorkers: 2,
      threadPoolSize: 6,
      idleHibernateMs: STANDARD_IDLE_HIBERNATE_MS,
      headroomFloorBytes: DEFAULT_HEADROOM_FLOOR_BYTES,
      preToolHoldMs: DEFAULT_PRETOOL_HOLD_MS,
      leaseTtlMs: DEFAULT_HEAVY_LEASE_TTL_MS,
    };
  }
  return {
    tier: 'workstation',
    heavyCommandSlots: 4,
    testConcurrency: null,
    playwrightWorkers: null,
    threadPoolSize: null,
    idleHibernateMs: null,
    headroomFloorBytes: DEFAULT_HEADROOM_FLOOR_BYTES,
    preToolHoldMs: DEFAULT_PRETOOL_HOLD_MS,
    leaseTtlMs: DEFAULT_HEAVY_LEASE_TTL_MS,
  };
}

export function runnerConcurrencyEnv(
  profile: HostResourceProfile,
  existingEnv: Record<string, string | undefined>,
): Record<string, string> {
  const existingKeys = new Set<string>();
  for (const [existingKey, existingValue] of Object.entries(existingEnv)) {
    if (existingValue !== undefined && existingValue !== '') existingKeys.add(existingKey.toUpperCase());
  }
  const defaults: Record<string, string> = {};
  const assignIfUnset = (key: string, value: number | null) => {
    if (value === null || existingKeys.has(key)) return;
    defaults[key] = String(value);
  };
  assignIfUnset('PLAYWRIGHT_WORKERS', profile.playwrightWorkers);
  assignIfUnset('UV_THREADPOOL_SIZE', profile.threadPoolSize);
  assignIfUnset('RAYON_NUM_THREADS', profile.threadPoolSize);
  assignIfUnset('GOMAXPROCS', profile.threadPoolSize);
  assignIfUnset('GLIMMERVOID_TEST_CONCURRENCY', profile.testConcurrency);
  return defaults;
}

export type MemoryStartKind = 'session';

export type MemoryReading =
  | { ok: true; headroomBytes: number }
  | { ok: false; reason: string };

export interface MemoryReservation {
  bytes: number;
  admittedAtMs: number;
  measuredBytes: number | null;
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

export function outstandingBytes(reservation: MemoryReservation, nowMs: number): number {
  if (reservation.measuredBytes !== null) return Math.max(0, reservation.bytes - reservation.measuredBytes);
  return nowMs - reservation.admittedAtMs < MEMORY_RESERVATION_SETTLE_MS ? reservation.bytes : 0;
}

export function liveReservations(reservations: readonly MemoryReservation[], nowMs: number): MemoryReservation[] {
  return reservations.filter((reservation) => outstandingBytes(reservation, nowMs) > 0);
}

export function shouldAdmitStart({ reading, reserveBytes, reservations, nowMs }: {
  reading: MemoryReading;
  reserveBytes: number;
  reservations: readonly MemoryReservation[];
  nowMs: number;
}): boolean {
  if (!reading.ok) return true;
  const reservedBytes = reservations.reduce((total, reservation) => total + outstandingBytes(reservation, nowMs), 0);
  return reading.headroomBytes - reservedBytes >= reserveBytes;
}
