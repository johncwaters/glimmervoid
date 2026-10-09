import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextRetrySchedule, QUICK_RETRY_DELAYS_MS, parseRetryAfterMs, secondaryRateLimitWaitMs, shouldSkipTick, SECONDARY_RATE_LIMIT_MIN_WAIT_MS,
} from '../server/core/lane-backoff.ts';
import { DEFAULT_MAX_MS, nextBackoffMs } from '../shared/backoff.ts';
import type { TickLoopOptions, TickOutcome } from '../server/lane-runner.ts';
import { createTickLoop } from '../server/lane-runner.ts';

test('full jitter picks a point inside the exponential ceiling, never the ceiling itself', () => {
  const baseMs = 1000;
  assert.equal(nextBackoffMs({ attempt: 1, baseMs, random: () => 0 }), 0);
  assert.equal(nextBackoffMs({ attempt: 1, baseMs, random: () => 1 }), 1000);
  assert.equal(nextBackoffMs({ attempt: 2, baseMs, random: () => 1 }), 2000);
  assert.equal(nextBackoffMs({ attempt: 4, baseMs, random: () => 1 }), 8000);
  assert.equal(nextBackoffMs({ attempt: 3, baseMs, random: () => 0.5 }), 2000);
});

test('two clients at the same attempt do not pick the same wait', () => {
  const baseMs = 60_000;
  const a = nextBackoffMs({ attempt: 5, baseMs, random: () => 0.2 });
  const b = nextBackoffMs({ attempt: 5, baseMs, random: () => 0.9 });
  assert.notEqual(a, b);
});

test('the ceiling is capped, however long the outage runs', () => {
  assert.equal(nextBackoffMs({ attempt: 50, baseMs: 60_000, random: () => 1 }), DEFAULT_MAX_MS);
});

test('an explicit Retry-After wins over the guess, and is still capped', () => {
  assert.equal(nextBackoffMs({ attempt: 1, retryAfterMs: 45_000, random: () => 1 }), 45_000);
  assert.equal(nextBackoffMs({ attempt: 1, retryAfterMs: 999_999_999, maxMs: 60_000 }), 60_000);
  assert.equal(nextBackoffMs({ attempt: 1, retryAfterMs: 0, baseMs: 1000, random: () => 1 }), 1000);
});

test('Retry-After is read in both spellings the RFC allows', () => {
  assert.equal(parseRetryAfterMs('120'), 120_000);
  const now = Date.parse('2026-08-22T10:00:00Z');
  assert.equal(parseRetryAfterMs('Sat, 22 Aug 2026 10:02:00 GMT', now), 120_000);
  assert.equal(parseRetryAfterMs('Sat, 22 Aug 2026 09:58:00 GMT', now), null, 'a past date is not a wait');
  assert.equal(parseRetryAfterMs('nonsense'), null);
  assert.equal(parseRetryAfterMs(null), null);
});

test('a tick is skipped only while the window is genuinely open', () => {
  assert.equal(shouldSkipTick({ now: 100, backoffUntil: 200 }), true);
  assert.equal(shouldSkipTick({ now: 200, backoffUntil: 200 }), false);
  assert.equal(shouldSkipTick({ now: 300, backoffUntil: 0 }), false);
});

function makeLoop(outcomes: (TickOutcome | null)[], options: Partial<TickLoopOptions> = {}) {
  let clock = 0;
  const ticks: number[] = [];
  const timeouts = new Map<NodeJS.Timeout, { run: () => void; at: number; waitMs: number }>();
  const loop = createTickLoop({
    tag: 'test-lane',
    intervalMs: 1000,
    backoffBaseMs: 1000,
    now: () => clock,
    random: () => 1,
    setTimeoutFn: (run, waitMs) => {
      const handle = { unref() {} } as NodeJS.Timeout;
      timeouts.set(handle, { run, at: clock + waitMs, waitMs });
      return handle;
    },
    clearTimeoutFn: (handle) => { timeouts.delete(handle); },
    log: { warn: () => {} },
    tick: async () => {
      ticks.push(clock);
      return outcomes.shift() || null;
    },
    ...options,
  });
  return { loop, ticks, timeouts, advance: (ms: number) => { clock += ms; } };
}

test('a failed poll opens a window that later ticks are skipped inside', async () => {
  const { loop, ticks, advance } = makeLoop([{ failed: true }]);
  await loop.tick();
  assert.equal(ticks.length, 1);
  assert.equal(loop.backoffUntil(), 1000);

  advance(500);
  await loop.tick();
  assert.equal(ticks.length, 1, 'the tick inside the window never ran');

  advance(600);
  await loop.tick();
  assert.equal(ticks.length, 2, 'and it resumes once the window is over');
});

test('consecutive failures back off further, and one success resets it', async () => {
  const { loop, advance } = makeLoop([{ failed: true }, { failed: true }, null]);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 1000, 'attempt 1: base');

  advance(1000);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 3000, 'attempt 2: double the base, from now');

  advance(2000);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 0, 'a success clears the window and the streak');
});

test('a tick body that returns nothing never backs off (every lane before this)', async () => {
  const { loop, ticks, advance } = makeLoop([]);
  await loop.tick();
  advance(1);
  await loop.tick();
  assert.equal(ticks.length, 2);
  assert.equal(loop.backoffUntil(), 0);
});

test('a service-supplied Retry-After is what the loop waits', async () => {
  const { loop } = makeLoop([{ failed: true, retryAfterMs: 90_000 }]);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 90_000);
});

test('stopping clears the window, so a restarted lane polls at once', async () => {
  const { loop } = makeLoop([{ failed: true }]);
  await loop.tick();
  assert.notEqual(loop.backoffUntil(), 0);
  await loop.stop();
  assert.equal(loop.backoffUntil(), 0);
});

function retryDecision(quickRetryCount: number, overrides: Partial<Parameters<typeof nextRetrySchedule>[0]> = {}) {
  return nextRetrySchedule({ failureStreak: quickRetryCount + 1, quickRetryCount, quickRetries: true, baseMs: 300_000, maxMs: DEFAULT_MAX_MS, random: () => 1, ...overrides });
}

test('quick retry decisions choose 10, 30 and 90 seconds before exponential backoff', () => {
  assert.deepEqual(QUICK_RETRY_DELAYS_MS, [10_000, 30_000, 90_000]);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.deepEqual(retryDecision(attempt - 1), { waitMs: QUICK_RETRY_DELAYS_MS[attempt - 1], retry: { attempt, limit: 3 } });
  }
  assert.deepEqual(retryDecision(3), { waitMs: 300_000, retry: null });
  assert.deepEqual(retryDecision(3, { failureStreak: 5 }), { waitMs: 600_000, retry: null });
  assert.deepEqual(retryDecision(0, { quickRetries: false }), { waitMs: 300_000, retry: null });
});

test('a rate-limit wait wins without spending the quick retry budget', () => {
  assert.deepEqual(retryDecision(0, { retryAfterMs: 120_000 }), { waitMs: 120_000, retry: null });
  assert.deepEqual(retryDecision(1, { retryAfterMs: 120_000 }), { waitMs: 120_000, retry: null });
});

async function fireScheduledAttempt(harness: ReturnType<typeof makeLoop>) {
  const scheduled = [...harness.timeouts.entries()][0];
  assert.ok(scheduled);
  harness.advance(scheduled[1].waitMs);
  harness.timeouts.delete(scheduled[0]);
  scheduled[1].run();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('one-shot retries run at their deadlines and success clears the schedule and budget', async () => {
  const harness = makeLoop([{ failed: true }, { failed: true }, { failed: true }, { failed: true }, null, { failed: true }], { quickRetries: true });
  await harness.loop.tick();
  assert.deepEqual(harness.loop.scheduleStatus().retry, { attempt: 1, limit: 3 });
  for (const attempt of [2, 3]) {
    await fireScheduledAttempt(harness);
    assert.deepEqual(harness.loop.scheduleStatus().retry, { attempt, limit: 3 });
    assert.equal(harness.timeouts.size, 1);
  }
  await fireScheduledAttempt(harness);
  assert.equal(harness.loop.scheduleStatus().retry, null);
  assert.equal(harness.loop.scheduleStatus().nextAttemptAt, 131_000);
  await fireScheduledAttempt(harness);
  assert.equal(harness.loop.scheduleStatus().nextAttemptAt, null);
  assert.equal(harness.timeouts.size, 0);
  await harness.loop.tick();
  assert.deepEqual(harness.loop.scheduleStatus().retry, { attempt: 1, limit: 3 });
  await harness.loop.stop();
  assert.equal(harness.timeouts.size, 0);
});

test('a quick retry whose timer fires before its deadline on the wall clock still runs', async () => {
  const harness = makeLoop([{ failed: true }, null], { quickRetries: true });
  await harness.loop.tick();
  const scheduled = [...harness.timeouts.entries()][0];
  assert.ok(scheduled);
  harness.advance(scheduled[1].waitMs - 3);
  harness.timeouts.delete(scheduled[0]);
  scheduled[1].run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.ticks.length, 2);
  assert.equal(harness.loop.scheduleStatus().nextAttemptAt, null);
});

test('an interval tick inside a quick retry window is still skipped', async () => {
  const harness = makeLoop([{ failed: true }, null], { quickRetries: true });
  await harness.loop.tick();
  harness.advance(1000);
  await harness.loop.tick();
  assert.equal(harness.ticks.length, 1);
});

test('GitHub secondary rate limit and abuse wording waits at least a minute', () => {
  assert.equal(secondaryRateLimitWaitMs('HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'), SECONDARY_RATE_LIMIT_MIN_WAIT_MS);
  assert.equal(secondaryRateLimitWaitMs('gh: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (HTTP 403)'), SECONDARY_RATE_LIMIT_MIN_WAIT_MS);
  assert.equal(secondaryRateLimitWaitMs('HTTP 429: secondary rate limit exceeded, Retry-After: 300'), 300_000);
  assert.equal(secondaryRateLimitWaitMs('retry after 5 seconds'), SECONDARY_RATE_LIMIT_MIN_WAIT_MS);
});

test('ordinary GitHub failures are not read as a secondary rate limit', () => {
  assert.equal(secondaryRateLimitWaitMs('error connecting to api.github.com'), null);
  assert.equal(secondaryRateLimitWaitMs('HTTP 502: Bad Gateway'), null);
  assert.equal(secondaryRateLimitWaitMs(''), null);
  assert.equal(secondaryRateLimitWaitMs(null), null);
});

test('a secondary rate limit wait skips quick retries and refuses manual refresh', async () => {
  const harness = makeLoop([{ failed: true, retryAfterMs: secondaryRateLimitWaitMs('You have exceeded a secondary rate limit') ?? 0 }], { quickRetries: true });
  await harness.loop.tick();
  assert.equal(harness.loop.scheduleStatus().retry, null);
  assert.equal(harness.loop.scheduleStatus().nextAttemptAt, SECONDARY_RATE_LIMIT_MIN_WAIT_MS);
  const refreshed = await harness.loop.refresh();
  assert.equal(refreshed.ok, false);
  assert.equal(harness.ticks.length, 1);
});

test('manual refresh bypasses the scheduled wait and cancels it on success', async () => {
  const harness = makeLoop([{ failed: true }, null, { failed: true }], { quickRetries: true });
  await harness.loop.tick();
  assert.equal(harness.timeouts.size, 1);
  assert.deepEqual(await harness.loop.refresh(), { ok: true });
  assert.equal(harness.ticks.length, 2);
  assert.equal(harness.timeouts.size, 0);
  assert.equal(harness.loop.backoffUntil(), 0);
  await harness.loop.tick();
  assert.deepEqual(harness.loop.scheduleStatus().retry, { attempt: 1, limit: 3 });
  await harness.loop.stop();
});

test('manual refresh is refused during a known rate-limit wait without polling or probing again', async () => {
  let probeCount = 0;
  const harness = makeLoop([{ failed: true, retryAfterMs: 120_000 }, null], { quickRetries: true, rateLimitWaitMs: async () => { probeCount += 1; return null; } });
  await harness.loop.tick();
  const refusal = await harness.loop.refresh();
  assert.equal(refusal.ok, false);
  assert.match(refusal.error ?? '', /rate limit/);
  assert.equal(harness.loop.scheduleStatus().refreshNotice, refusal.error);
  assert.equal(harness.loop.scheduleStatus().retry, null);
  assert.equal(harness.loop.scheduleStatus().nextAttemptAt, 120_000);
  assert.equal(harness.ticks.length, 1);
  assert.equal(probeCount, 0);
  harness.advance(120_000);
  assert.equal((await harness.loop.refresh()).ok, true);
  assert.equal(probeCount, 1);
  await harness.loop.stop();
});

test('manual refresh checks the shared GitHub rate-limit wait before the poll', async () => {
  const harness = makeLoop([], { quickRetries: true, rateLimitWaitMs: async () => 120_000 });
  assert.equal((await harness.loop.refresh()).ok, false);
  assert.equal(harness.ticks.length, 0);
  assert.equal(harness.loop.scheduleStatus().nextAttemptAt, 120_000);
  assert.equal(harness.timeouts.size, 1);
  await harness.loop.stop();
});

test('manual refresh is ignored while an automatic tick is running and publishes why', async () => {
  let resolveOutcome: (outcome: TickOutcome) => void = () => {};
  const outcome = new Promise<TickOutcome>((resolve) => { resolveOutcome = resolve; });
  let runs = 0;
  const harness = makeLoop([], { quickRetries: true, tick: () => { runs += 1; return outcome; } });
  const ticking = harness.loop.tick();
  assert.equal(harness.loop.scheduleStatus().isRefreshing, true);
  const refusal = await harness.loop.refresh();
  assert.equal(refusal.ok, false);
  assert.match(refusal.error ?? '', /already running/);
  assert.equal(harness.loop.scheduleStatus().refreshNotice, refusal.error);
  assert.equal(runs, 1);
  resolveOutcome({ failed: false });
  await ticking;
  assert.equal(harness.loop.scheduleStatus().isRefreshing, false);
  await harness.loop.stop();
});

test('stopping during a failed tick prevents rearming a retry', async () => {
  let resolveOutcome: (outcome: TickOutcome) => void = () => {};
  const outcome = new Promise<TickOutcome>((resolve) => { resolveOutcome = resolve; });
  const harness = makeLoop([], { quickRetries: true, tick: () => outcome });
  const ticking = harness.loop.tick();
  await harness.loop.stop();
  resolveOutcome({ failed: true });
  await ticking;
  assert.equal(harness.timeouts.size, 0);
  assert.equal(harness.loop.scheduleStatus().nextAttemptAt, null);
});
