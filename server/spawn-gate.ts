import { MEMORY_RECHECK_MS, liveReservations, outstandingBytes, shouldAdmitStart } from './core/memory-admission-core.ts';
import type { MemoryReading, MemoryReservation, MemoryStartKind } from './core/memory-admission-core.ts';
import { clock } from '../shared/clock.ts';

const BYTES_PER_MEGABYTE = 1024 * 1024;
const QUEUE_ADMISSION_TIMED_OUT = 'serial-queue-admission-timed-out';
const QUEUE_ADMISSION_ABANDONED = 'serial-queue-admission-abandoned';

interface MemoryClaimant {
  readonly hasLivePty: boolean;
  measureResidentBytes(): Promise<number | null>;
  on(event: 'exit' | 'teardown', listener: () => void): unknown;
  off(event: 'exit' | 'teardown', listener: () => void): unknown;
}

interface SerialQueueRunOptions {
  admissionTimeoutMs?: number;
  isStillWanted?: () => boolean;
  signal?: AbortSignal;
  claimant?: MemoryClaimant;
}

interface SerialQueue {
  run<T>(fn: () => T | Promise<T>, options?: SerialQueueRunOptions): Promise<T>;
  idle(): Promise<void>;
}

interface KeyedSerialQueue {
  run<T>(key: string, fn: () => T | Promise<T>, options?: SerialQueueRunOptions): Promise<T>;
}

function queueAdmissionTimeoutError(): Error {
  return new Error(QUEUE_ADMISSION_TIMED_OUT);
}

function isQueueAdmissionTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === QUEUE_ADMISSION_TIMED_OUT;
}

function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  function run<T>(fn: () => T | Promise<T>, options: SerialQueueRunOptions = {}): Promise<T> {
    let abandoned = false;
    let started = false;
    const result = tail.then(() => {
      if (abandoned) throw queueAdmissionTimeoutError();
      started = true;
      return fn();
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    const { admissionTimeoutMs, signal } = options;
    if (admissionTimeoutMs === undefined && signal === undefined) return result;
    return new Promise<T>((resolve, reject) => {
      const leaveUnlessStarted = (reason: string) => {
        if (started) return;
        abandoned = true;
        reject(new Error(reason));
      };
      const admissionTimer = admissionTimeoutMs === undefined ? undefined : setTimeout(() => leaveUnlessStarted(QUEUE_ADMISSION_TIMED_OUT), admissionTimeoutMs);
      const leaveOnAbort = () => leaveUnlessStarted(QUEUE_ADMISSION_ABANDONED);
      signal?.addEventListener('abort', leaveOnAbort, { once: true });
      if (signal?.aborted) leaveOnAbort();
      const stopWatching = () => {
        clearTimeout(admissionTimer);
        signal?.removeEventListener('abort', leaveOnAbort);
      };
      result.then(
        (value) => { stopWatching(); resolve(value); },
        (error: unknown) => { stopWatching(); reject(error); },
      );
    });
  }

  return { run, idle: () => tail };
}

function createKeyedSerialQueue(): KeyedSerialQueue {
  const queuesByKey = new Map<string, { queue: SerialQueue; pendingCount: number }>();

  function run<T>(key: string, fn: () => T | Promise<T>, options?: SerialQueueRunOptions): Promise<T> {
    const entry = queuesByKey.get(key) ?? { queue: createSerialQueue(), pendingCount: 0 };
    queuesByKey.set(key, entry);
    entry.pendingCount += 1;
    const result = entry.queue.run(fn, options);
    result.then(() => undefined, () => undefined).then(() => {
      entry.pendingCount -= 1;
      if (entry.pendingCount === 0 && queuesByKey.get(key) === entry) queuesByKey.delete(key);
    });
    return result;
  }

  return { run };
}

interface MemoryWaitOptions {
  isStillWanted?: () => boolean;
  onMemoryWait?: (isWaiting: boolean) => void;
}

interface MemoryGateStatus {
  headroomBytes: number | null;
  headroomReadAtMs: number | null;
  heldStartCount: number;
}

interface MemoryAdmission {
  waitForHeadroom(kind: MemoryStartKind, options?: MemoryWaitOptions): Promise<MemoryReservation | null>;
  claim(reservation: MemoryReservation | null, claimant: MemoryClaimant | undefined): void;
  noteStartHeld(isHeld: boolean): void;
  gateStatus(): MemoryGateStatus;
  describeShortfallNow(kind: MemoryStartKind): Promise<HeadroomShortfall | null>;
}

interface HeadroomShortfall {
  headroomBytes: number;
  heldBytes: number;
  reserveBytes: number;
  waitingStartCount: number;
}

interface MemoryAdmissionOptions {
  readHeadroom: () => Promise<MemoryReading>;
  reserveBytesFor: (kind: MemoryStartKind) => number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

function toMegabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MEGABYTE);
}

function createMemoryAdmission({
  readHeadroom, reserveBytesFor, nowMs = clock.nowMs,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  warn = (message) => console.warn(message),
}: MemoryAdmissionOptions): MemoryAdmission {
  let reservations: MemoryReservation[] = [];
  const claimantByReservation = new Map<MemoryReservation, MemoryClaimant>();
  let isInProbeFailureStreak = false;
  let heldStartCount = 0;
  let latestHeadroomBytes: number | null = null;
  let latestHeadroomReadAtMs: number | null = null;

  function noteReading(reading: MemoryReading, readAtMs: number): void {
    latestHeadroomReadAtMs = readAtMs;
    latestHeadroomBytes = reading.ok ? reading.headroomBytes : null;
    if (reading.ok) {
      isInProbeFailureStreak = false;
      return;
    }
    if (isInProbeFailureStreak) return;
    isInProbeFailureStreak = true;
    warn(`[memory] could not read memory headroom, so starts go ahead unchecked: ${reading.reason}`);
  }

  async function measureClaimedReservations(): Promise<void> {
    await Promise.all([...claimantByReservation].map(async ([reservation, claimant]) => {
      reservation.measuredBytes = await claimant.measureResidentBytes() ?? reservation.measuredBytes;
    }));
  }

  async function admitOrDescribeShortfall(kind: MemoryStartKind, { isDryRun = false }: { isDryRun?: boolean } = {}): Promise<{ admitted: MemoryReservation | null; shortfall: HeadroomShortfall | null }> {
    const reserveBytes = reserveBytesFor(kind);
    if (reserveBytes <= 0) return { admitted: null, shortfall: null };
    const [reading] = await Promise.all([readHeadroom(), measureClaimedReservations()]);
    const admittedAtMs = nowMs();
    const liveUnclaimed = liveReservations(reservations.filter((reservation) => !claimantByReservation.has(reservation)), admittedAtMs);
    reservations = [...claimantByReservation.keys(), ...liveUnclaimed];
    noteReading(reading, admittedAtMs);
    const isQueuedBehindHeldStart = isDryRun && reading.ok && heldStartCount > 0;
    if (!isQueuedBehindHeldStart && shouldAdmitStart({ reading, reserveBytes, reservations, nowMs: admittedAtMs })) {
      if (isDryRun) return { admitted: null, shortfall: null };
      const admitted: MemoryReservation = { bytes: reserveBytes, admittedAtMs, measuredBytes: null };
      reservations.push(admitted);
      return { admitted, shortfall: null };
    }
    const heldBytes = reservations.reduce((total, reservation) => total + outstandingBytes(reservation, admittedAtMs), 0);
    return { admitted: null, shortfall: { headroomBytes: reading.ok ? reading.headroomBytes : 0, heldBytes, reserveBytes, waitingStartCount: heldStartCount } };
  }

  function releaseReservation(reservation: MemoryReservation): void {
    claimantByReservation.delete(reservation);
    reservations = reservations.filter((candidate) => candidate !== reservation);
  }

  function claim(reservation: MemoryReservation | null, claimant: MemoryClaimant | undefined): void {
    if (reservation === null || claimant === undefined) return;
    if (!claimant.hasLivePty) {
      releaseReservation(reservation);
      return;
    }
    claimantByReservation.set(reservation, claimant);
    const release = () => {
      claimant.off('exit', release);
      claimant.off('teardown', release);
      releaseReservation(reservation);
    };
    claimant.on('exit', release);
    claimant.on('teardown', release);
  }

  async function recheckUntilAdmitted(kind: MemoryStartKind, isStillWanted: () => boolean): Promise<{ isAdmitted: boolean; admitted: MemoryReservation | null }> {
    for (;;) {
      await sleep(MEMORY_RECHECK_MS);
      if (!isStillWanted()) return { isAdmitted: false, admitted: null };
      const { admitted, shortfall } = await admitOrDescribeShortfall(kind);
      if (shortfall === null) return { isAdmitted: true, admitted };
    }
  }

  async function waitForHeadroom(kind: MemoryStartKind, { isStillWanted = () => true, onMemoryWait = () => {} }: MemoryWaitOptions = {}): Promise<MemoryReservation | null> {
    if (!isStillWanted()) return null;
    const { admitted, shortfall } = await admitOrDescribeShortfall(kind);
    if (shortfall === null) return admitted;
    if (!isStillWanted()) return null;
    const waitStartedAtMs = nowMs();
    warn(`[memory] holding a ${kind} start: ${toMegabytes(shortfall.headroomBytes)} MB headroom, ${toMegabytes(shortfall.heldBytes)} MB held for recent starts, ${toMegabytes(shortfall.reserveBytes)} MB reserve needed`);
    onMemoryWait(true);
    const recheck = await recheckUntilAdmitted(kind, isStillWanted).finally(() => onMemoryWait(false));
    if (!recheck.isAdmitted) return null;
    warn(`[memory] admitted a ${kind} start after waiting ${Math.round((nowMs() - waitStartedAtMs) / 1000)} s`);
    return recheck.admitted;
  }

  return {
    waitForHeadroom,
    claim,
    noteStartHeld: (isHeld) => { heldStartCount += isHeld ? 1 : -1; },
    gateStatus: () => ({ headroomBytes: latestHeadroomBytes, headroomReadAtMs: latestHeadroomReadAtMs, heldStartCount }),
    describeShortfallNow: async (kind) => (await admitOrDescribeShortfall(kind, { isDryRun: true })).shortfall,
  };
}

interface QueuedStart {
  isStillWanted: () => boolean;
}

function createSpawnGate({ memoryAdmission = null, kind = 'session' }: { memoryAdmission?: MemoryAdmission | null; kind?: MemoryStartKind } = {}): SerialQueue {
  const queue = createSerialQueue();
  if (!memoryAdmission) return queue;
  const admission = memoryAdmission;
  const queuedStarts = new Set<QueuedStart>();
  const flaggedStarts = new Set<QueuedStart>();
  let isHeadStartHeld = false;

  function flagWaitingForMemory(queuedStart: QueuedStart): void {
    if (flaggedStarts.has(queuedStart) || !queuedStart.isStillWanted()) return;
    flaggedStarts.add(queuedStart);
    admission.noteStartHeld(true);
  }

  function leaveQueue(queuedStart: QueuedStart): void {
    queuedStarts.delete(queuedStart);
    if (!flaggedStarts.delete(queuedStart)) return;
    admission.noteStartHeld(false);
  }

  function noteHeadStartHeld(isHeld: boolean): void {
    isHeadStartHeld = isHeld;
    if (!isHeld) return;
    for (const queuedStart of queuedStarts) flagWaitingForMemory(queuedStart);
  }

  function run<T>(fn: () => T | Promise<T>, options: SerialQueueRunOptions = {}): Promise<T> {
    const { isStillWanted = () => true, claimant } = options;
    const queuedStart: QueuedStart = { isStillWanted };
    queuedStarts.add(queuedStart);
    if (isHeadStartHeld) flagWaitingForMemory(queuedStart);
    const release = () => leaveQueue(queuedStart);
    const startClaimingMemory = async (): Promise<T> => {
      const reservation = await admission.waitForHeadroom(kind, { isStillWanted, onMemoryWait: noteHeadStartHeld }).finally(release);
      try {
        return await fn();
      } finally {
        admission.claim(reservation, claimant);
      }
    };
    const result = queue.run(startClaimingMemory, options);
    result.then(release, release);
    return result;
  }

  return { run, idle: queue.idle };
}

type HeavyCommandClass = 'typecheck' | 'test' | 'browser-test' | 'build' | 'install' | 'lint';

interface HeavyLease {
  id: string;
  sessionId: string;
  toolUseId: string | null;
  commandClass: HeavyCommandClass;
  acquiredAtMs: number;
}

interface HeavyAcquireRequest {
  sessionId: string;
  toolUseId?: string | null;
  commandClass: HeavyCommandClass;
  maxWaitMs?: number;
  signal?: AbortSignal;
}

type HeavyAcquireOutcome =
  | { status: 'granted'; lease: HeavyLease }
  | { status: 'timeout' | 'aborted' };

export interface HeavyCommandGate {
  acquire(request: HeavyAcquireRequest): Promise<HeavyAcquireOutcome>;
  release(leaseId: string): void;
  releaseByToolUse(sessionId: string, toolUseId: string | null): void;
  releaseSession(sessionId: string): void;
  snapshot(): { active: HeavyLease[]; queuedCount: number; maxSlots: number };
  stop(): void;
}

const DEFAULT_HEAVY_LEASE_TTL_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const GLIMMERVOID_COORDINATION_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*glimmervoid\s+(?:spawn|send|read|sessions|whiteboard|codemap|memory|claim|wake|attention|answer|close|limits)\b/i;
const SHELL_SEGMENT_SEPARATOR = /\s*(?:&&|\|\||[;|\n])\s*/;
const HEAVY_SEGMENT_PATTERNS: readonly [HeavyCommandClass, RegExp][] = [
  ['browser-test', /\b(?:playwright|test:browser)\b|harness\/browser\b/i],
  ['typecheck', /\b(?:tsc|typecheck)\b/i],
  ['test', /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?\b|\b(?:vitest|jest|pytest)\b|\b(?:cargo|go)\s+test\b/i],
  ['build', /\b(?:vite|webpack|esbuild|rollup|cargo|go)\s+build\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i],
  ['install', /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install)\b/i],
  ['lint', /\bbiome\s+(?:check|ci|lint)\b|\beslint\b/i],
];

function classifyHeavySegment(segment: string): HeavyCommandClass | null {
  if (!segment || GLIMMERVOID_COORDINATION_SEGMENT.test(segment)) return null;
  for (const [commandClass, pattern] of HEAVY_SEGMENT_PATTERNS) {
    if (pattern.test(segment)) return commandClass;
  }
  if (/\bnode\b/i.test(segment) && /--test\b/i.test(segment)) return 'test';
  return null;
}

function classifyHeavyCommand(command: string): HeavyCommandClass | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  for (const segment of trimmed.split(SHELL_SEGMENT_SEPARATOR)) {
    const matched = classifyHeavySegment(segment.trim());
    if (matched !== null) return matched;
  }
  return null;
}

interface HeavyWaiter {
  request: HeavyAcquireRequest;
  state: 'queued' | 'done';
  waitTimer: ReturnType<typeof setTimeout> | undefined;
  onAbort: (() => void) | null;
  resolve: (outcome: HeavyAcquireOutcome) => void;
}

interface ActiveHeavyLease {
  lease: HeavyLease;
  ttlTimer: ReturnType<typeof setTimeout> | undefined;
}

function createHeavyCommandGate({
  maxSlots,
  defaultLeaseTtlMs = DEFAULT_HEAVY_LEASE_TTL_MS,
  nowMs = clock.nowMs,
}: {
  maxSlots: number;
  defaultLeaseTtlMs?: number;
  nowMs?: () => number;
}): HeavyCommandGate {
  const slotLimit = Math.max(1, Math.floor(Number.isFinite(maxSlots) ? maxSlots : 1));
  const clampedLeaseTtlMs = Number.isFinite(defaultLeaseTtlMs) && defaultLeaseTtlMs > 0
    ? Math.min(defaultLeaseTtlMs, MAX_TIMEOUT_MS)
    : null;
  const activeById = new Map<string, ActiveHeavyLease>();
  const waiters: HeavyWaiter[] = [];
  let gateState: 'open' | 'stopped' = 'open';
  let nextLeaseSequence = 0;

  function grant(request: HeavyAcquireRequest): HeavyLease {
    nextLeaseSequence += 1;
    const lease: HeavyLease = {
      id: `heavy-${nextLeaseSequence}`,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId ?? null,
      commandClass: request.commandClass,
      acquiredAtMs: nowMs(),
    };
    const ttlTimer = clampedLeaseTtlMs !== null
      ? setTimeout(() => { release(lease.id); }, clampedLeaseTtlMs)
      : undefined;
    ttlTimer?.unref?.();
    activeById.set(lease.id, { lease, ttlTimer });
    return lease;
  }

  function cleanupWaiter(waiter: HeavyWaiter): void {
    if (waiter.waitTimer !== undefined) clearTimeout(waiter.waitTimer);
    if (waiter.onAbort) waiter.request.signal?.removeEventListener('abort', waiter.onAbort);
  }

  function abortMatchingWaiters(predicate: (waiter: HeavyWaiter) => boolean): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || !predicate(waiter)) continue;
      waiters.splice(index, 1);
      if (waiter.state !== 'queued') continue;
      waiter.state = 'done';
      cleanupWaiter(waiter);
      waiter.resolve({ status: 'aborted' });
    }
  }

  function drainQueue(): void {
    if (gateState === 'stopped') return;
    while (activeById.size < slotLimit && waiters.length > 0) {
      const next = waiters.shift();
      if (!next || next.state !== 'queued') continue;
      next.state = 'done';
      cleanupWaiter(next);
      next.resolve({ status: 'granted', lease: grant(next.request) });
    }
  }

  function release(leaseId: string): void {
    const active = activeById.get(leaseId);
    if (!active) return;
    if (active.ttlTimer !== undefined) clearTimeout(active.ttlTimer);
    activeById.delete(leaseId);
    drainQueue();
  }

  function releaseByToolUse(sessionId: string, toolUseId: string | null): void {
    if (toolUseId !== null) {
      abortMatchingWaiters((waiter) => waiter.request.sessionId === sessionId && (waiter.request.toolUseId ?? null) === toolUseId);
      for (const [leaseId, active] of activeById) {
        if (active.lease.sessionId === sessionId && active.lease.toolUseId === toolUseId) {
          release(leaseId);
          return;
        }
      }
      return;
    }
    for (const [leaseId, active] of activeById) {
      if (active.lease.sessionId === sessionId && active.lease.toolUseId === null) {
        release(leaseId);
        return;
      }
    }
  }

  function releaseSession(sessionId: string): void {
    abortMatchingWaiters((waiter) => waiter.request.sessionId === sessionId);
    const matchingLeaseIds = [...activeById.entries()]
      .filter(([, active]) => active.lease.sessionId === sessionId)
      .map(([leaseId]) => leaseId);
    for (const leaseId of matchingLeaseIds) release(leaseId);
  }

  function acquire(request: HeavyAcquireRequest): Promise<HeavyAcquireOutcome> {
    if (gateState === 'stopped' || request.signal?.aborted) return Promise.resolve({ status: 'aborted' });
    if (activeById.size < slotLimit && waiters.length === 0) {
      return Promise.resolve({ status: 'granted', lease: grant(request) });
    }
    return new Promise<HeavyAcquireOutcome>((resolve) => {
      const waiter: HeavyWaiter = {
        request,
        state: 'queued',
        waitTimer: undefined,
        onAbort: null,
        resolve,
      };
      const failWaiter = (status: 'timeout' | 'aborted') => {
        if (waiter.state !== 'queued') return;
        waiter.state = 'done';
        cleanupWaiter(waiter);
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve({ status });
      };
      if (request.maxWaitMs !== undefined && Number.isFinite(request.maxWaitMs)) {
        const clampedWaitMs = Math.min(Math.max(0, request.maxWaitMs), MAX_TIMEOUT_MS);
        waiter.waitTimer = setTimeout(() => failWaiter('timeout'), clampedWaitMs);
      }
      if (request.signal) {
        waiter.onAbort = () => failWaiter('aborted');
        request.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  function stop(): void {
    gateState = 'stopped';
    for (const active of activeById.values()) {
      if (active.ttlTimer !== undefined) clearTimeout(active.ttlTimer);
    }
    activeById.clear();
    abortMatchingWaiters(() => true);
  }

  return {
    acquire,
    release,
    releaseByToolUse,
    releaseSession,
    snapshot: () => ({
      active: [...activeById.values()].map((active) => active.lease),
      queuedCount: waiters.length,
      maxSlots: slotLimit,
    }),
    stop,
  };
}

export { classifyHeavyCommand, createHeavyCommandGate, createKeyedSerialQueue, createMemoryAdmission, createSerialQueue, createSpawnGate, isQueueAdmissionTimeout, queueAdmissionTimeoutError };
export type { MemoryAdmission, MemoryGateStatus };
