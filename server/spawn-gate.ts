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

export { createKeyedSerialQueue, createMemoryAdmission, createSerialQueue, createSpawnGate, isQueueAdmissionTimeout, queueAdmissionTimeoutError };
export type { MemoryAdmission, MemoryGateStatus };
