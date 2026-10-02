import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_STAGGER_MAX_MS, BOOT_STAGGER_MIN_MS, bootStaggerDelayMs } from '../server/core/boot-stagger-core.ts';
import { createTickLoop } from '../server/lane-runner.ts';

test('a lane started at boot waits a random 30 s to 5 min before its first tick', () => {
  assert.equal(bootStaggerDelayMs(0, 0), BOOT_STAGGER_MIN_MS);
  assert.equal(bootStaggerDelayMs(0, 1), BOOT_STAGGER_MAX_MS);
  assert.equal(bootStaggerDelayMs(0, 0.5), BOOT_STAGGER_MIN_MS + (BOOT_STAGGER_MAX_MS - BOOT_STAGGER_MIN_MS) / 2);
});

test('the boot wait counts time already spent since boot, so a lane restarted later ticks at once', () => {
  assert.equal(bootStaggerDelayMs(20_000, 0), 10_000);
  assert.equal(bootStaggerDelayMs(BOOT_STAGGER_MAX_MS, 1), 0);
  assert.equal(bootStaggerDelayMs(60 * 60_000, 0.7), 0);
});

test('a bad clock or random value never produces a negative or unbounded wait', () => {
  assert.equal(bootStaggerDelayMs(Number.NaN, 0.5), 0);
  assert.equal(bootStaggerDelayMs(-5, 2), BOOT_STAGGER_MAX_MS);
  assert.equal(bootStaggerDelayMs(0, Number.NaN), BOOT_STAGGER_MIN_MS);
});

test('a tick loop with a first-tick delay starts without ticking, ticks when the delay fires, then arms its interval', async () => {
  let ticks = 0;
  let delayedTick: () => void = () => {};
  const delays: number[] = [];
  const intervals: number[] = [];
  const loop = createTickLoop({
    tag: 'test-lane', intervalMs: 60_000, log: { warn() {} },
    tick: async () => { ticks += 1; return null; },
    firstTickDelayMs: () => 45_000,
    setTimeoutFn: (fn, ms) => { delays.push(ms); delayedTick = fn; return { unref() {} } as NodeJS.Timeout; },
    setIntervalFn: (_fn, ms) => { intervals.push(ms); return { unref() {} } as NodeJS.Timeout; },
    clearIntervalFn: () => {},
  });
  await loop.start();
  assert.equal(ticks, 0);
  assert.deepEqual(delays, [45_000]);
  assert.deepEqual(intervals, []);
  delayedTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 1);
  assert.deepEqual(intervals, [60_000]);
  await loop.stop();
});

test('stopping a tick loop before its delayed first tick cancels that tick', async () => {
  let ticks = 0;
  let cleared = 0;
  let delayedTick: () => void = () => {};
  const loop = createTickLoop({
    tag: 'test-lane', intervalMs: 60_000, log: { warn() {} },
    tick: async () => { ticks += 1; return null; },
    firstTickDelayMs: () => 45_000,
    setTimeoutFn: (fn) => { delayedTick = fn; return { unref() {} } as NodeJS.Timeout; },
    clearTimeoutFn: () => { cleared += 1; },
    setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout,
    clearIntervalFn: () => {},
  });
  await loop.start();
  await loop.stop();
  delayedTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared, 1);
  assert.equal(ticks, 0);
});
