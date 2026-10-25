import test from 'node:test';
import assert from 'node:assert/strict';

import { createChangesWatch } from '../server/changes-watch.ts';
import { CHANGES_POLL_INTERVAL_MS, CHANGES_WATCH_LEASE_MS } from '../shared/contracts/control-messages.ts';
import { manualTimers } from './helpers/manual-timers.ts';

type Viewer = { name: string; isOpen: boolean };

function watchHarness(sessionIds: string[]) {
  const timers = manualTimers();
  const checksBySessionId = new Map<string, number>(sessionIds.map((id) => [id, 0]));
  let nowMs = 0;
  const watch = createChangesWatch<Viewer>({
    findSession: (id) => {
      if (!checksBySessionId.has(id)) return null;
      return { worktreeLifecycle: { scheduleCheck: () => checksBySessionId.set(id, (checksBySessionId.get(id) ?? 0) + 1) } };
    },
    isHolderOpen: (viewer) => viewer.isOpen,
    setIntervalFn: timers.setTimeoutFn,
    clearIntervalFn: timers.clearTimeoutFn,
    nowFn: () => nowMs,
  });
  return {
    watch,
    checksOf: (id: string) => checksBySessionId.get(id),
    liveTimerCount: () => timers.pending.filter((timer) => !timer.cleared).length,
    tick: () => {
      nowMs += CHANGES_POLL_INTERVAL_MS;
      timers.fireAll();
    },
  };
}

test('a held watch polls its one session each tick and every way of letting go leaves no timer behind', () => {
  const harness = watchHarness(['alpha', 'beta']);
  const desktop: Viewer = { name: 'desktop', isOpen: true };
  const phone: Viewer = { name: 'phone', isOpen: true };

  assert.equal(harness.liveTimerCount(), 0);

  harness.watch.request(desktop, 'alpha');
  assert.equal(harness.checksOf('alpha'), 1);
  assert.equal(harness.liveTimerCount(), 1);
  harness.tick();
  assert.equal(harness.checksOf('alpha'), 2);

  harness.watch.request(phone, 'beta');
  assert.equal(harness.checksOf('beta'), 1);
  harness.tick();
  assert.equal(harness.checksOf('alpha'), 2);
  assert.equal(harness.checksOf('beta'), 2);
  assert.equal(harness.liveTimerCount(), 1);

  harness.watch.request(desktop, null);
  assert.equal(harness.liveTimerCount(), 1);
  harness.watch.request(phone, null);
  assert.equal(harness.liveTimerCount(), 0);

  harness.watch.request(phone, 'beta');
  phone.isOpen = false;
  harness.tick();
  assert.equal(harness.checksOf('beta'), 3);
  assert.equal(harness.liveTimerCount(), 0);

  harness.watch.request(desktop, 'alpha');
  const checksAfterTakingSlot = harness.checksOf('alpha') ?? 0;
  const ticksWithinLease = Math.floor(CHANGES_WATCH_LEASE_MS / CHANGES_POLL_INTERVAL_MS);
  for (let i = 0; i < ticksWithinLease; i += 1) harness.tick();
  assert.equal(harness.liveTimerCount(), 1);
  harness.tick();
  assert.equal(harness.liveTimerCount(), 0);
  assert.equal(harness.checksOf('alpha'), checksAfterTakingSlot + ticksWithinLease);

  harness.watch.request(desktop, 'ended-session');
  assert.equal(harness.liveTimerCount(), 0);
});
