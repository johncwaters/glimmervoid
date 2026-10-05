import assert from 'node:assert/strict';
import test from 'node:test';

import { createAwakeTimeoutFn, startAwakeStopwatch } from '../server/awake-timer.ts';

for (const timeoutMs of [0, -1]) {
  test(`awake timeout of ${timeoutMs}ms fires asynchronously without waiting for a tick`, (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let fireCount = 0;
    createAwakeTimeoutFn()(() => { fireCount += 1; }, timeoutMs);
    assert.equal(fireCount, 0);
    context.mock.timers.tick(1);
    assert.equal(fireCount, 1);
    context.mock.timers.tick(30000);
    assert.equal(fireCount, 1);
  });
}

test('awake timeout shorter than its tick interval fires at the requested delay', (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let fireCount = 0;
  createAwakeTimeoutFn()(() => { fireCount += 1; }, 100);
  context.mock.timers.tick(99);
  assert.equal(fireCount, 0);
  context.mock.timers.tick(1);
  assert.equal(fireCount, 1);
  context.mock.timers.tick(100);
  assert.equal(fireCount, 1);
});

test('awake timeout caps a clock jump and fires once while clearing its interval', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let nowMs = 0;
  let fireCount = 0;
  const scheduleTimeout = createAwakeTimeoutFn({ tickMs: 15000, now: () => nowMs });
  const interval = scheduleTimeout(() => { fireCount += 1; }, 60000);
  assert.equal(typeof interval.unref, 'function');
  interval.unref();
  nowMs = 15000;
  context.mock.timers.tick(15000);
  assert.equal(fireCount, 0);
  nowMs += 30 * 60 * 1000;
  context.mock.timers.tick(15000);
  assert.equal(fireCount, 0);
  nowMs += 15000;
  context.mock.timers.tick(15000);
  assert.equal(fireCount, 1);
  nowMs += 15000;
  context.mock.timers.tick(15000);
  assert.equal(fireCount, 1);
});

test('Node clearTimeout cancels an interval handle returned by the awake timer', async () => {
  let fireCount = 0;
  const scheduleTimeout = createAwakeTimeoutFn({ tickMs: 1 });
  const interval = scheduleTimeout(() => { fireCount += 1; }, 1);
  clearTimeout(interval);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(fireCount, 0);
});

test('awake stopwatch counts time since the last tick and caps a clock jump between ticks', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let nowMs = 0;
  const stopwatch = startAwakeStopwatch({ tickMs: 15000, now: () => nowMs });
  nowMs = 15000;
  context.mock.timers.tick(15000);
  assert.equal(stopwatch.awakeElapsedMs(), 15000);
  nowMs += 30 * 60 * 1000;
  context.mock.timers.tick(15000);
  assert.equal(stopwatch.awakeElapsedMs(), 45000);
  nowMs += 5000;
  assert.equal(stopwatch.awakeElapsedMs(), 50000);
  stopwatch.stop();
});
