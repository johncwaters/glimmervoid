import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutcomesLane } from '../server/outcomes-wiring.ts';
import type { LoopLagHistogram } from '../server/outcomes-wiring.ts';

function parkedHandle(): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 3_600_000);
  handle.unref();
  return handle;
}

function makeHarness({ histogram = null }: { histogram?: LoopLagHistogram | null } = {}) {
  const lines: string[] = [];
  const drains: (() => void)[] = [];
  const handles: NodeJS.Timeout[] = [];
  const clearedHandles: NodeJS.Timeout[] = [];
  const lane = createOutcomesLane({
    logger: { log: (line: string) => lines.push(line) },
    setIntervalFn: (fn: () => void) => {
      drains.push(fn);
      const handle = parkedHandle();
      handles.push(handle);
      return handle;
    },
    clearIntervalFn: (handle: NodeJS.Timeout) => {
      clearTimeout(handle);
      clearedHandles.push(handle);
    },
    createLoopLagHistogram: () => histogram,
  });
  const tick = () => { for (const drain of drains) drain(); };
  return { lane, lines, tick, handles, clearedHandles };
}

function makeHistogram({ p99Nanoseconds, count = 1 }: { p99Nanoseconds: number; count?: number }) {
  const state = { enabled: false, resets: 0, count };
  const histogram: LoopLagHistogram = {
    get count() { return state.count; },
    enable: () => { state.enabled = true; return true; },
    disable: () => { state.enabled = false; return true; },
    reset: () => { state.resets += 1; state.count = 0; },
    percentile: () => p99Nanoseconds,
  };
  return { histogram, state };
}

test('one busy minute produces exactly one summary line whatever the event volume', () => {
  const { lane, lines, tick } = makeHarness();
  for (let index = 0; index < 500; index += 1) lane.record('dataWsOpened');
  lane.record('notifyFailed');
  assert.deepEqual(lines, [], 'nothing is logged as the events arrive');

  tick();

  assert.deepEqual(lines, ['[outcomes] summary notifyFailed=1 dataWsOpened=500']);
  lane.stop();
});

test('an idle minute stays silent', () => {
  const { lane, lines, tick } = makeHarness();
  tick();
  tick();

  assert.deepEqual(lines, []);
  lane.stop();
});

test('loop lag above the threshold rides the summary line and the histogram is reset each drain', () => {
  const { histogram, state } = makeHistogram({ p99Nanoseconds: 180_000_000 });
  const { lane, lines, tick } = makeHarness({ histogram });
  assert.equal(state.enabled, true, 'the lane enables the histogram as it starts');

  lane.record('hookRejected403');
  tick();

  assert.deepEqual(lines, ['[outcomes] summary hookRejected403=1 loopLagP99Ms=180']);
  assert.equal(state.resets, 1);
  lane.stop();
});

test('loop lag below the threshold leaves the key off', () => {
  const { histogram } = makeHistogram({ p99Nanoseconds: 4_000_000 });
  const { lane, lines, tick } = makeHarness({ histogram });
  lane.record('telegramDelivered');

  tick();

  assert.deepEqual(lines, ['[outcomes] summary telegramDelivered=1']);
  lane.stop();
});

test('an unsampled event loop reports no lag rather than a floor reading', () => {
  const { histogram } = makeHistogram({ p99Nanoseconds: 500_000_000, count: 0 });
  const { lane, lines, tick } = makeHarness({ histogram });
  lane.record('controlWsClosed');

  tick();

  assert.deepEqual(lines, ['[outcomes] summary controlWsClosed=1']);
  lane.stop();
});

test('a shutdown inside the first minute still reports the counts it gathered, and only once', () => {
  const { lane, lines } = makeHarness();
  lane.record('notifyFailed');
  lane.record('notifyFailed');
  lane.record('hookRejectedNonLoopback');

  lane.stop();

  assert.deepEqual(lines, ['[outcomes] summary notifyFailed=2 hookRejectedNonLoopback=1']);

  lane.stop();

  assert.deepEqual(lines, ['[outcomes] summary notifyFailed=2 hookRejectedNonLoopback=1']);
});

test('a second stop releases nothing twice', () => {
  const { histogram, state } = makeHistogram({ p99Nanoseconds: 1_000_000 });
  const { lane, handles, clearedHandles } = makeHarness({ histogram });

  lane.stop();
  lane.stop();

  assert.deepEqual(clearedHandles, handles);
  assert.equal(state.enabled, false);
});

test('stop clears the summary timer, disables the histogram and stops counting', () => {
  const { histogram, state } = makeHistogram({ p99Nanoseconds: 1_000_000 });
  const { lane, lines, handles, clearedHandles } = makeHarness({ histogram });

  lane.stop();

  assert.deepEqual(clearedHandles, handles);
  assert.equal(state.enabled, false);
  assert.equal(lane.isStopped, true);

  lane.record('notifyDelivered');
  lane.drain();
  assert.deepEqual(lines, []);
});
