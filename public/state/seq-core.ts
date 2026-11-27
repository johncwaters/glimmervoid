interface SeqWaiter {
  targetSeq: number;
  resolve: () => void;
  cleanup: () => void;
}

export interface WhenReachedOptions {
  signal?: AbortSignal;
}

export interface SeqTracker {
  current(): number;
  advance(nextSeq: number): boolean;
  reset(nextSeq?: number): void;
  whenReached(targetSeq: number, options?: WhenReachedOptions): Promise<void>;
  pendingCount(): number;
}

function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason.length > 0) return new Error(reason);
  return new Error('Sequence wait aborted.');
}

export function createSeqTracker(initialSeq = 0): SeqTracker {
  let currentSeq = Number.isFinite(initialSeq) && initialSeq >= 0 ? initialSeq : 0;
  let waiters: SeqWaiter[] = [];

  function resolveMatchingWaiters(): void {
    if (waiters.length === 0) return;
    const ready: SeqWaiter[] = [];
    const remaining: SeqWaiter[] = [];
    for (const waiter of waiters) {
      if (waiter.targetSeq <= currentSeq) {
        ready.push(waiter);
        continue;
      }
      remaining.push(waiter);
    }
    waiters = remaining;
    for (const waiter of ready) {
      waiter.cleanup();
      waiter.resolve();
    }
  }

  function current(): number {
    return currentSeq;
  }

  function advance(nextSeq: number): boolean {
    if (!Number.isFinite(nextSeq) || nextSeq <= currentSeq) return false;
    currentSeq = nextSeq;
    resolveMatchingWaiters();
    return true;
  }

  function reset(nextSeq = 0): void {
    currentSeq = Number.isFinite(nextSeq) && nextSeq >= 0 ? nextSeq : 0;
    const superseded = waiters;
    waiters = [];
    for (const waiter of superseded) {
      waiter.cleanup();
      waiter.resolve();
    }
  }

  function whenReached(targetSeq: number, options?: WhenReachedOptions): Promise<void> {
    if (!Number.isFinite(targetSeq) || targetSeq <= currentSeq) {
      return Promise.resolve();
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(abortReasonToError(signal.reason));
    }
    return new Promise<void>((resolve, reject) => {
      let waiter!: SeqWaiter;
      const handleAbort = (): void => {
        waiters = waiters.filter((entry) => entry !== waiter);
        reject(abortReasonToError(signal?.reason));
      };
      const cleanup = (): void => {
        signal?.removeEventListener('abort', handleAbort);
      };
      waiter = { targetSeq, resolve, cleanup };
      if (signal) {
        signal.addEventListener('abort', handleAbort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  function pendingCount(): number {
    return waiters.length;
  }

  return { current, advance, reset, whenReached, pendingCount };
}
