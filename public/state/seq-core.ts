interface SeqWaiter {
  targetSeq: number;
  resolve: () => void;
}

export interface SeqTracker {
  current(): number;
  advance(nextSeq: number): boolean;
  reset(nextSeq?: number): void;
  whenReached(targetSeq: number): Promise<void>;
  pendingCount(): number;
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
    for (const waiter of ready) waiter.resolve();
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
    for (const waiter of superseded) waiter.resolve();
  }

  function whenReached(targetSeq: number): Promise<void> {
    if (!Number.isFinite(targetSeq) || targetSeq <= currentSeq) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push({ targetSeq, resolve });
    });
  }

  function pendingCount(): number {
    return waiters.length;
  }

  return { current, advance, reset, whenReached, pendingCount };
}
