import assert from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../shared/timer-deps.ts';

test('DEFAULT_TIMER_FNS delegate to the real timers and hand back clearable handles', async () => {
  let fired = 0;
  const timeout = DEFAULT_TIMER_FNS.setTimeoutFn(() => { fired += 1; }, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fired, 1);
  const cancelled = DEFAULT_TIMER_FNS.setTimeoutFn(() => { fired += 100; }, 1);
  DEFAULT_TIMER_FNS.clearTimeoutFn(cancelled);
  const interval = DEFAULT_TIMER_FNS.setIntervalFn(() => { fired += 1; }, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  DEFAULT_TIMER_FNS.clearIntervalFn(interval);
  const afterClear = fired;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fired, afterClear, 'a cleared interval stops firing');
  assert.ok(fired > 1 && fired < 100, 'the cancelled timeout never fired');
  DEFAULT_TIMER_FNS.clearTimeoutFn(timeout);
});

test('unrefTimer unrefs a real handle, tolerates a fake without unref and returns its input', () => {
  const real = setTimeout(() => {}, 1000);
  assert.equal(unrefTimer(real), real);
  assert.equal(real.hasRef(), false);
  clearTimeout(real);
  const fake: { unref?: () => unknown; id: number } = { id: 7 };
  assert.equal(unrefTimer(fake), fake);
  assert.equal(unrefTimer(null), null);
  assert.equal(unrefTimer(undefined), undefined);
});
