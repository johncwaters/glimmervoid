import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_CLOCK_INTERVAL_MINUTES, runsEveryTicks } from '../server/core/github-clock-core.ts';
import { POLL_INTERVAL_MINUTES as MY_PRS_POLL_INTERVAL_MINUTES } from '../server/core/my-prs-core.ts';
import { POLL_INTERVAL_MINUTES as TEAM_REVIEW_POLL_INTERVAL_MINUTES } from '../server/core/team-review-core.ts';
import { createGithubClock } from '../server/github-clock.ts';
import { createTickLoop } from '../server/lane-runner.ts';

const FIVE_MINUTES_MS = 5 * 60000;

function manualTimer() {
  const timers: { fn: () => void; ms: number; isCleared: boolean }[] = [];
  return {
    timers,
    setIntervalFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms, isCleared: false });
      return { unref() {} } as NodeJS.Timeout;
    },
    clearIntervalFn: () => {
      const latest = timers.at(-1);
      if (latest) latest.isCleared = true;
    },
  };
}

test('a lane runs on every Nth clock tick, rounded, and never less than every tick', () => {
  assert.equal(runsEveryTicks(FIVE_MINUTES_MS, FIVE_MINUTES_MS), 1);
  assert.equal(runsEveryTicks(15 * 60000, FIVE_MINUTES_MS), 3);
  assert.equal(runsEveryTicks(60000, FIVE_MINUTES_MS), 1);
  assert.equal(runsEveryTicks(16 * 60000, FIVE_MINUTES_MS), 3);
  assert.equal(runsEveryTicks(FIVE_MINUTES_MS, 0), 1);
});

test('every subscriber shares one interval timer that stops when the last one leaves', () => {
  const timer = manualTimer();
  const clock = createGithubClock({ baseIntervalMs: FIVE_MINUTES_MS, ...timer, log: { warn() {} } });
  const leaveFirst = clock.schedule(async () => {}, FIVE_MINUTES_MS);
  const leaveSecond = clock.schedule(async () => {}, 15 * 60000);
  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0]?.ms, FIVE_MINUTES_MS);
  leaveFirst();
  assert.equal(timer.timers[0]?.isCleared, false);
  leaveSecond();
  assert.equal(timer.timers[0]?.isCleared, true);
});

test('a sweep runs due lanes in order and runs a slower lane only on its own ticks', async () => {
  const runs: string[] = [];
  const clock = createGithubClock({ baseIntervalMs: FIVE_MINUTES_MS, ...manualTimer(), log: { warn() {} } });
  clock.schedule(async () => { runs.push('my-prs'); }, FIVE_MINUTES_MS);
  clock.schedule(async () => { runs.push('team-review'); }, 15 * 60000);
  for (let sweepCount = 0; sweepCount < 6; sweepCount += 1) await clock.sweep();
  assert.deepEqual(runs, ['my-prs', 'my-prs', 'my-prs', 'team-review', 'my-prs', 'my-prs', 'my-prs', 'team-review']);
});

test('a sweep that fires while the previous one still runs is skipped, so lanes never overlap', async () => {
  let releaseRun: () => void = () => {};
  let runCount = 0;
  const clock = createGithubClock({ baseIntervalMs: FIVE_MINUTES_MS, ...manualTimer(), log: { warn() {} } });
  clock.schedule(() => new Promise<void>((resolve) => { runCount += 1; releaseRun = resolve; }), FIVE_MINUTES_MS);
  const firstSweep = clock.sweep();
  await clock.sweep();
  assert.equal(runCount, 1);
  releaseRun();
  await firstSweep;
});

test('a failing lane is logged and does not stop the lanes after it', async () => {
  const warnings: string[] = [];
  const runs: string[] = [];
  const clock = createGithubClock({ baseIntervalMs: FIVE_MINUTES_MS, ...manualTimer(), log: { warn: (message: string) => warnings.push(message) } });
  clock.schedule(async () => { throw new Error('gh offline'); }, FIVE_MINUTES_MS);
  clock.schedule(async () => { runs.push('second'); }, FIVE_MINUTES_MS);
  await clock.sweep();
  assert.deepEqual(runs, ['second']);
  assert.match(warnings[0] ?? '', /gh offline/);
});

test('a tick loop given a shared clock registers with it instead of its own timer and leaves it on stop', async () => {
  const ownTimers: number[] = [];
  const scheduled: number[] = [];
  let isUnscheduled = false;
  let ticks = 0;
  const loop = createTickLoop({
    tag: 'test-lane', intervalMs: FIVE_MINUTES_MS, log: { warn() {} },
    tick: async () => { ticks += 1; return null; },
    setIntervalFn: (_fn, ms) => { ownTimers.push(ms); return { unref() {} } as NodeJS.Timeout; },
    clock: {
      schedule: (_run, intervalMs) => {
        scheduled.push(intervalMs);
        return () => { isUnscheduled = true; };
      },
      exclusive: (work) => work(),
    },
  });
  await loop.start();
  assert.equal(ticks, 1);
  assert.deepEqual(ownTimers, []);
  assert.deepEqual(scheduled, [FIVE_MINUTES_MS]);
  await loop.stop();
  assert.equal(isUnscheduled, true);
});

test('both GitHub lane intervals are exact positive multiples of the clock tick', () => {
  for (const laneIntervalMinutes of [MY_PRS_POLL_INTERVAL_MINUTES, TEAM_REVIEW_POLL_INTERVAL_MINUTES]) {
    assert.ok(laneIntervalMinutes >= GITHUB_CLOCK_INTERVAL_MINUTES);
    assert.equal(laneIntervalMinutes % GITHUB_CLOCK_INTERVAL_MINUTES, 0);
  }
});

function overlapTrackingLoop(tag: string, clock: ReturnType<typeof createGithubClock>, tracker: { activeTicks: number; maxActiveTicks: number; tickTags: string[] }) {
  return createTickLoop({
    tag, intervalMs: FIVE_MINUTES_MS, clock, log: { warn() {} },
    tick: async () => {
      tracker.activeTicks += 1;
      tracker.maxActiveTicks = Math.max(tracker.maxActiveTicks, tracker.activeTicks);
      tracker.tickTags.push(tag);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      tracker.activeTicks -= 1;
      return null;
    },
  });
}

test('two tick loops sharing one clock and started together never run their ticks at the same time', async () => {
  const tracker = { activeTicks: 0, maxActiveTicks: 0, tickTags: [] as string[] };
  const clock = createGithubClock({ baseIntervalMs: FIVE_MINUTES_MS, ...manualTimer(), log: { warn() {} } });
  const myPrsLoop = overlapTrackingLoop('my-prs', clock, tracker);
  const teamReviewLoop = overlapTrackingLoop('team-review', clock, tracker);
  await Promise.all([myPrsLoop.start(), teamReviewLoop.start()]);
  await Promise.all([clock.sweep(), myPrsLoop.tick(), teamReviewLoop.tick()]);
  assert.equal(tracker.maxActiveTicks, 1);
  assert.deepEqual([...tracker.tickTags].sort(), ['my-prs', 'my-prs', 'team-review', 'team-review']);
  await Promise.all([myPrsLoop.stop(), teamReviewLoop.stop()]);
});

test('an ad-hoc tick during a sweep waits until the sweep run finishes', async () => {
  const events: string[] = [];
  let releaseSweepRun: () => void = () => {};
  const clock = createGithubClock({ baseIntervalMs: FIVE_MINUTES_MS, ...manualTimer(), log: { warn() {} } });
  clock.schedule(() => clock.exclusive(() => new Promise<void>((resolve) => {
    events.push('sweep-run-started');
    releaseSweepRun = () => { events.push('sweep-run-finished'); resolve(); };
  })), FIVE_MINUTES_MS);
  const loop = createTickLoop({
    tag: 'team-review', intervalMs: FIVE_MINUTES_MS, clock, log: { warn() {} },
    tick: async () => { events.push('ad-hoc-tick'); return null; },
  });
  const sweep = clock.sweep();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const adHocTick = loop.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['sweep-run-started']);
  releaseSweepRun();
  await Promise.all([sweep, adHocTick]);
  assert.deepEqual(events, ['sweep-run-started', 'sweep-run-finished', 'ad-hoc-tick']);
});
