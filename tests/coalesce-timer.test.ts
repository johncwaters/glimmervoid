import assert from 'node:assert';
import { test } from 'node:test';
import { createCoalescedTimer } from '../shared/coalesce-timer.ts';

const PARKED_TIMER_MS = 1 << 30;

function fakeTimers() {
  const pending: { handle: NodeJS.Timeout; fn: () => void; ms: number }[] = [];
  const idByHandle = new Map<NodeJS.Timeout, number>();
  const cleared: number[] = [];
  return {
    pending,
    cleared,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const handle = setTimeout(() => {}, PARKED_TIMER_MS);
      handle.unref();
      idByHandle.set(handle, idByHandle.size + 1);
      pending.push({ handle, fn, ms });
      return handle;
    },
    clearTimeoutFn: (handle: NodeJS.Timeout) => {
      clearTimeout(handle);
      cleared.push(idByHandle.get(handle) ?? -1);
      const index = pending.findIndex((entry) => entry.handle === handle);
      if (index !== -1) pending.splice(index, 1);
    },
    fireAll() {
      for (const entry of pending.splice(0)) {
        clearTimeout(entry.handle);
        entry.fn();
      }
    },
  };
}

test('leading mode keeps the first arm and ignores later schedules until it fires', () => {
  const timers = fakeTimers();
  let runs = 0;
  const timer = createCoalescedTimer({ mode: 'leading', delayMs: 25, run: () => { runs += 1; }, ...timers });
  timer.schedule();
  timer.schedule();
  timer.schedule();
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, 25);
  assert.equal(timer.isArmed, true);
  timers.fireAll();
  assert.equal(runs, 1);
  assert.equal(timer.isArmed, false);
  timer.schedule();
  assert.equal(timers.pending.length, 1, 'after firing it can be armed again');
});

test('trailing mode re-arms on every schedule so only the last one fires', () => {
  const timers = fakeTimers();
  let runs = 0;
  const timer = createCoalescedTimer({ mode: 'trailing', delayMs: 10, run: () => { runs += 1; }, ...timers });
  timer.schedule();
  timer.schedule();
  timer.schedule();
  assert.deepEqual(timers.cleared, [1, 2]);
  assert.equal(timers.pending.length, 1);
  timers.fireAll();
  assert.equal(runs, 1);
});

test('cancel drops the armed timer and a schedule from inside run re-arms', () => {
  const timers = fakeTimers();
  let runs = 0;
  const timer = createCoalescedTimer({
    mode: 'trailing',
    delayMs: 10,
    run: () => {
      runs += 1;
      if (runs === 1) timer.schedule();
    },
    ...timers,
  });
  timer.schedule();
  timer.cancel();
  assert.equal(timer.isArmed, false);
  assert.equal(timers.pending.length, 0);
  timer.cancel();
  timer.schedule();
  timers.fireAll();
  assert.equal(runs, 1);
  assert.equal(timer.isArmed, true, 'run re-armed the timer');
  timers.fireAll();
  assert.equal(runs, 2);
});

test('the default timers unref their handle unless unref is false', async () => {
  let fired = false;
  const timer = createCoalescedTimer({ mode: 'leading', delayMs: 1, run: () => { fired = true; } });
  timer.schedule();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fired, true);
  const kept = createCoalescedTimer({ mode: 'leading', delayMs: 1000, run: () => {}, unref: false });
  kept.schedule();
  kept.cancel();
});
