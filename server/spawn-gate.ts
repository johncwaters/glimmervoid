import { MEMORY_RECHECK_MS, shouldAdmitStart, liveReservations } from './core/memory-admission-core.ts';
import type { MemoryReading, MemoryReservation, MemoryStartKind } from './core/memory-admission-core.ts';

const BYTES_PER_MEGABYTE = 1024 * 1024;
const QUEUE_ADMISSION_TIMED_OUT = 'serial-queue-admission-timed-out';
const QUEUE_ADMISSION_ABANDONED = 'serial-queue-admission-abandoned';

interface SerialQueueRunOptions {
  admissionTimeoutMs?: number;
  isStillWanted?: () => boolean;
  onMemoryWait?: (isWaiting: boolean) => void;
  signal?: AbortSignal;
}

interface SerialQueue {
  run<T>(fn: () => T | Promise<T>, options?: SerialQueueRunOptions): Promise<T>;
  idle(): Promise<void>;
}

interface KeyedSerialQueue {
  run<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
}

function isQueueAdmissionTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === QUEUE_ADMISSION_TIMED_OUT;
}

function isQueueAdmissionAbandoned(error: unknown): boolean {
  return error instanceof Error && error.message === QUEUE_ADMISSION_ABANDONED;
}

function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  function run<T>(fn: () => T | Promise<T>, options: SerialQueueRunOptions = {}): Promise<T> {
    let abandoned = false;
    let started = false;
    const result = tail.then(() => {
      if (abandoned) throw new Error(QUEUE_ADMISSION_TIMED_OUT);
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

  function run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const entry = queuesByKey.get(key) ?? { queue: createSerialQueue(), pendingCount: 0 };
    queuesByKey.set(key, entry);
    entry.pendingCount += 1;
    const result = entry.queue.run(fn);
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
  waitForHeadroom(kind: MemoryStartKind, options?: MemoryWaitOptions): Promise<void>;
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
  readHeadroom, reserveBytesFor, nowMs = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  warn = (message) => console.warn(message),
}: MemoryAdmissionOptions): MemoryAdmission {
  let reservations: MemoryReservation[] = [];
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

  async function admitOrDescribeShortfall(kind: MemoryStartKind, { isDryRun = false }: { isDryRun?: boolean } = {}): Promise<HeadroomShortfall | null> {
    const reserveBytes = reserveBytesFor(kind);
    if (reserveBytes <= 0) return null;
    const reading = await readHeadroom();
    const admittedAtMs = nowMs();
    reservations = liveReservations(reservations, admittedAtMs);
    noteReading(reading, admittedAtMs);
    const isQueuedBehindHeldStart = isDryRun && reading.ok && heldStartCount > 0;
    if (!isQueuedBehindHeldStart && shouldAdmitStart({ reading, reserveBytes, reservations, nowMs: admittedAtMs })) {
      if (!isDryRun) reservations.push({ bytes: reserveBytes, admittedAtMs });
      return null;
    }
    const heldBytes = reservations.reduce((total, reservation) => total + reservation.bytes, 0);
    return { headroomBytes: reading.ok ? reading.headroomBytes : 0, heldBytes, reserveBytes, waitingStartCount: heldStartCount };
  }

  async function recheckUntilAdmitted(kind: MemoryStartKind, isStillWanted: () => boolean): Promise<boolean> {
    do {
      await sleep(MEMORY_RECHECK_MS);
      if (!isStillWanted()) return false;
    } while ((await admitOrDescribeShortfall(kind)) !== null);
    return true;
  }

  async function waitForHeadroom(kind: MemoryStartKind, { isStillWanted = () => true, onMemoryWait = () => {} }: MemoryWaitOptions = {}): Promise<void> {
    if (!isStillWanted()) return;
    const shortfall = await admitOrDescribeShortfall(kind);
    if (shortfall === null) return;
    if (!isStillWanted()) return;
    const waitStartedAtMs = nowMs();
    warn(`[memory] holding a ${kind} start: ${toMegabytes(shortfall.headroomBytes)} MB headroom, ${toMegabytes(shortfall.heldBytes)} MB held for recent starts, ${toMegabytes(shortfall.reserveBytes)} MB reserve needed`);
    onMemoryWait(true);
    const isAdmitted = await recheckUntilAdmitted(kind, isStillWanted).finally(() => onMemoryWait(false));
    if (!isAdmitted) return;
    warn(`[memory] admitted a ${kind} start after waiting ${Math.round((nowMs() - waitStartedAtMs) / 1000)} s`);
  }

  return {
    waitForHeadroom,
    noteStartHeld: (isHeld) => { heldStartCount += isHeld ? 1 : -1; },
    gateStatus: () => ({ headroomBytes: latestHeadroomBytes, headroomReadAtMs: latestHeadroomReadAtMs, heldStartCount }),
    describeShortfallNow: (kind) => admitOrDescribeShortfall(kind, { isDryRun: true }),
  };
}

interface QueuedStart {
  isStillWanted: () => boolean;
  onMemoryWait: (isWaiting: boolean) => void;
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
    queuedStart.onMemoryWait(true);
  }

  function leaveQueue(queuedStart: QueuedStart): void {
    queuedStarts.delete(queuedStart);
    if (!flaggedStarts.delete(queuedStart)) return;
    admission.noteStartHeld(false);
    queuedStart.onMemoryWait(false);
  }

  function noteHeadStartHeld(isHeld: boolean): void {
    isHeadStartHeld = isHeld;
    if (!isHeld) return;
    for (const queuedStart of queuedStarts) flagWaitingForMemory(queuedStart);
  }

  function run<T>(fn: () => T | Promise<T>, options: SerialQueueRunOptions = {}): Promise<T> {
    const { isStillWanted = () => true, onMemoryWait = () => {} } = options;
    const queuedStart: QueuedStart = { isStillWanted, onMemoryWait };
    queuedStarts.add(queuedStart);
    if (isHeadStartHeld) flagWaitingForMemory(queuedStart);
    const release = () => leaveQueue(queuedStart);
    const result = queue.run(() => admission.waitForHeadroom(kind, { isStillWanted, onMemoryWait: noteHeadStartHeld }).finally(release).then(fn), options);
    result.then(release, release);
    return result;
  }

  return { run, idle: queue.idle };
}

export { createKeyedSerialQueue, createMemoryAdmission, createSerialQueue, createSpawnGate, isQueueAdmissionAbandoned, isQueueAdmissionTimeout };
export type { MemoryAdmission, MemoryGateStatus, SerialQueue };
