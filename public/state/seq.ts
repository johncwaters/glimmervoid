import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createSeqTracker } from './seq-core.ts';
import type { WhenReachedOptions } from './seq-core.ts';

const tracker = createSeqTracker(0);
const [readSeq, setReadSeq] = createSignal(0);

export const currentSeq: Accessor<number> = readSeq;

export function advanceSeq(nextSeq: number): boolean {
  if (!tracker.advance(nextSeq)) return false;
  setReadSeq(tracker.current());
  return true;
}

export function resetSeq(nextSeq = 0): void {
  tracker.reset(nextSeq);
  setReadSeq(tracker.current());
}

export function whenSeqReached(targetSeq: number, options?: WhenReachedOptions): Promise<void> {
  return tracker.whenReached(targetSeq, options);
}
