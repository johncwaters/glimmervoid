import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeqTracker } from '../public/state/seq-core.ts';
import type { SeqTracker } from '../public/state/seq-core.ts';

test('seq-core advances monotonically, resolves reached waiters in order, and settles all waiters on snapshot reset', async () => {
  const tracker: SeqTracker = createSeqTracker(10);
  assert.equal(tracker.current(), 10);
  assert.equal(tracker.advance(10), false);
  assert.equal(tracker.advance(5), false);
  assert.equal(tracker.advance(Number.NaN), false);
  assert.equal(tracker.current(), 10);

  await tracker.whenReached(10);
  assert.equal(tracker.pendingCount(), 0);

  const settled: number[] = [];
  const waitTwelve = tracker.whenReached(12).then(() => { settled.push(12); });
  const waitFifteen = tracker.whenReached(15).then(() => { settled.push(15); });
  const waitTwenty = tracker.whenReached(20).then(() => { settled.push(20); });
  assert.equal(tracker.pendingCount(), 3);

  assert.equal(tracker.advance(15), true);
  assert.equal(tracker.current(), 15);
  assert.equal(tracker.pendingCount(), 1);
  await Promise.all([waitTwelve, waitFifteen]);
  assert.deepEqual(settled, [12, 15]);

  tracker.reset(3);
  assert.equal(tracker.current(), 3);
  assert.equal(tracker.pendingCount(), 0);
  await waitTwenty;
  assert.deepEqual(settled, [12, 15, 20]);
});
