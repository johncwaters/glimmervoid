const QUEUE_ADMISSION_TIMED_OUT = 'serial-queue-admission-timed-out';

interface SerialQueueRunOptions {
  admissionTimeoutMs?: number;
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
    const admissionTimeoutMs = options.admissionTimeoutMs;
    if (admissionTimeoutMs === undefined) return result;
    return new Promise<T>((resolve, reject) => {
      const admissionTimer = setTimeout(() => {
        if (started) return;
        abandoned = true;
        reject(new Error(QUEUE_ADMISSION_TIMED_OUT));
      }, admissionTimeoutMs);
      result.then(
        (value) => { clearTimeout(admissionTimer); resolve(value); },
        (error: unknown) => { clearTimeout(admissionTimer); reject(error); },
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

const createSpawnGate = createSerialQueue;

export { createKeyedSerialQueue, createSerialQueue, createSpawnGate, isQueueAdmissionTimeout, QUEUE_ADMISSION_TIMED_OUT };
export type { KeyedSerialQueue, SerialQueue, SerialQueueRunOptions };
