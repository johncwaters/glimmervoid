import type { ReviewsRefreshResult, ReviewsRetry } from '../shared/contracts/reviews.ts';
import { DEFAULT_BASE_MS, DEFAULT_MAX_MS, nextRetrySchedule, shouldSkipTick } from './core/lane-backoff.ts';
import { errorMessage } from '../shared/text.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from './core/timer-deps.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from './core/timer-deps.ts';
import { createSerialQueue } from './spawn-gate.ts';

interface TickOutcome {
  failed?: boolean;
  retryAfterMs?: number;
}

type TickTrigger = 'interval' | 'retry' | 'manual';

interface SharedClock {
  schedule(run: () => Promise<void>, intervalMs: number): () => void;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

interface TickLoopOptions {
  quickRetries?: boolean;
  onScheduleChange?: () => void;
  rateLimitWaitMs?: () => Promise<number | null>;
  tag: string;
  intervalMs: number;
  tick: () => Promise<TickOutcome | undefined | null>;
  writeState?: () => Promise<void> | void;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
  random?: () => number;
  log?: Pick<Console, 'warn'>;
}

interface TickLoop {
  start(prelude?: (() => Promise<void> | void) | null): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  refresh(): Promise<ReviewsRefreshResult>;
  scheduleStatus(): { nextAttemptAt: number | null; retry: ReviewsRetry | null; isRefreshing: boolean; refreshNotice: string | null };
  persist(): Promise<void>;
  track<T>(promise: Promise<T>): Promise<T>;
  isStopped(): boolean;
  backoffUntil(): number;
}

function createTickLoop({
  tag,
  quickRetries = false,
  onScheduleChange = () => {},
  rateLimitWaitMs = async () => null,
  intervalMs,
  tick: tickBody,
  writeState = async () => {},
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn,
  clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
  clock,
  firstTickDelayMs = () => 0,
  setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn,
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
  backoffBaseMs = Math.max(intervalMs, DEFAULT_BASE_MS),
  backoffMaxMs = DEFAULT_MAX_MS,
  now = Date.now,
  random = Math.random,
  log = console,
}: TickLoopOptions): TickLoop {
  let timer: NodeJS.Timeout | null = null;
  let unschedule: (() => void) | null = null;
  let firstTickTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let tickRunning = false;
  const persistQueue = createSerialQueue();

  let backoffUntil = 0;
  let failureStreak = 0;
  let quickRetryCount = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let nextAttemptAt: number | null = null;
  let retry: ReviewsRetry | null = null;
  let rateLimitedUntil = 0;
  let isRefreshing = false;
  let refreshNotice: string | null = null;

  const running = new Set<Promise<unknown>>();

  function persist(): Promise<void> {
    return persistQueue.run(() => writeState()).catch((e: unknown) => {
      log.warn(`[${tag}] state write failed: ${errorMessage(e)}`);
    });
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    running.add(promise);
    promise.finally(() => running.delete(promise));
    return promise;
  }

  function clearRetryTimer(): void {
    if (retryTimer) clearTimeoutFn(retryTimer);
    retryTimer = null;
  }

  function scheduleAttempt(waitMs: number, scheduledRetry: ReviewsRetry | null): void {
    clearRetryTimer();
    backoffUntil = now() + waitMs;
    nextAttemptAt = backoffUntil;
    retry = scheduledRetry;
    if (!quickRetries || stopped) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      void runTick('retry');
    }, waitMs);
    retryTimer.unref?.();
  }

  function scheduleStatus() {
    return { nextAttemptAt, retry, isRefreshing, refreshNotice };
  }

  async function runTick(trigger: TickTrigger): Promise<ReviewsRefreshResult> {
    const isManual = trigger === 'manual';
    if (stopped) return { ok: false, error: 'Reviews polling is stopped.' };
    if (tickRunning) {
      if (isManual) {
        refreshNotice = 'A refresh is already running.';
        onScheduleChange();
      }
      return { ok: false, error: 'A refresh is already running.' };
    }
    if (trigger === 'interval' && shouldSkipTick({ now: now(), backoffUntil })) return { ok: false };
    if (isManual && rateLimitedUntil > now()) {
      refreshNotice = 'GitHub rate limit asks to wait before refreshing.';
      onScheduleChange();
      return { ok: false, error: refreshNotice };
    }
    tickRunning = true;
    isRefreshing = true;
    refreshNotice = null;
    try {
      if (isManual) {
        const waitMs = await rateLimitWaitMs();
        if (stopped) return { ok: false, error: 'Reviews polling is stopped.' };
        if (waitMs !== null && waitMs > 0) {
          rateLimitedUntil = now() + waitMs;
          scheduleAttempt(waitMs, null);
          refreshNotice = 'GitHub rate limit asks to wait before refreshing.';
          return { ok: false, error: refreshNotice };
        }
      }
      clearRetryTimer();
      nextAttemptAt = null;
      retry = null;
      onScheduleChange();
      const outcome = clock ? await clock.exclusive(() => (stopped ? Promise.resolve(null) : tickBody())) : await tickBody();
      if (stopped) return { ok: false, error: 'Reviews polling is stopped.' };
      if (outcome?.failed !== true) {
        failureStreak = 0;
        quickRetryCount = 0;
        backoffUntil = 0;
        rateLimitedUntil = 0;
        refreshNotice = isManual ? 'Refreshed.' : null;
        return { ok: true };
      }
      failureStreak += 1;
      const scheduled = nextRetrySchedule({
        failureStreak, quickRetryCount, quickRetries, baseMs: backoffBaseMs, maxMs: backoffMaxMs,
        retryAfterMs: outcome.retryAfterMs, random,
      });
      if (scheduled.retry) quickRetryCount += 1;
      if (outcome.retryAfterMs && outcome.retryAfterMs > 0) rateLimitedUntil = now() + outcome.retryAfterMs;
      scheduleAttempt(scheduled.waitMs, scheduled.retry);
      log.warn(`[${tag}] poll failed (${failureStreak} in a row) - backing off ${Math.round(scheduled.waitMs / 1000)}s`);
      return { ok: false, error: 'Could not refresh from GitHub.' };
    } finally {
      tickRunning = false;
      isRefreshing = false;
      if (!stopped) onScheduleChange();
    }
  }

  async function tick(): Promise<void> {
    await runTick('interval');
  }

  function refresh(): Promise<ReviewsRefreshResult> {
    return runTick('manual');
  }

  async function start(prelude: (() => Promise<void> | void) | null = null): Promise<void> {
    stopped = false;
    if (prelude) await prelude();
    const delayMs = firstTickDelayMs();
    if (delayMs <= 0) {
      await tick();
      armRecurringTicks();
      return;
    }
    firstTickTimer = setTimeoutFn(() => {
      firstTickTimer = null;
      if (stopped) return;
      void tick().finally(() => { if (!stopped) armRecurringTicks(); });
    }, delayMs);
    unrefTimer(firstTickTimer);
  }

  function armRecurringTicks(): void {
    if (clock) {
      unschedule = clock.schedule(tick, intervalMs);
      return;
    }
    timer = setIntervalFn(() => { void tick(); }, intervalMs);
    unrefTimer(timer);
  }

  async function stop(): Promise<void> {
    stopped = true;
    backoffUntil = 0;
    failureStreak = 0;
    quickRetryCount = 0;
    rateLimitedUntil = 0;
    nextAttemptAt = null;
    retry = null;
    clearRetryTimer();
    if (timer) clearIntervalFn(timer);
    timer = null;
    if (firstTickTimer) clearTimeoutFn(firstTickTimer);
    firstTickTimer = null;
    unschedule?.();
    unschedule = null;
    await Promise.allSettled([...running]);
    await persistQueue.idle();
  }

  return { start, stop, tick, refresh, scheduleStatus, persist, track, isStopped: () => stopped, backoffUntil: () => backoffUntil };
}

interface LaneRunnerGate {
  start: boolean;
  reason?: string | null;
}

type LaneStatusRecord = Record<string, unknown>;

interface RestartablePoller {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface LaneRunnerOptions<Poller extends RestartablePoller> {
  tag: string;
  gate: () => LaneRunnerGate;
  cfgKey: () => string;
  emptyStatus: () => LaneStatusRecord;
  createPoller: (callbacks: { onTickComplete: (summary: LaneStatusRecord) => void }) => Poller;
  broadcast?: (status: LaneStatusRecord) => void;
  beforeStop?: () => void;
}

interface LaneRunner<Poller extends RestartablePoller> {
  startPoller(): void;
  restartIfConfigChanged(): void;
  stopPoller(): Promise<void>;
  patchStatus(patch: LaneStatusRecord): void;
  getStatus(): LaneStatusRecord;
  getPoller(): Poller | null;
  isStopped(): boolean;
}

function createLaneRunner<Poller extends RestartablePoller>({
  tag, gate, cfgKey, emptyStatus, createPoller, broadcast = () => {}, beforeStop = () => {},
}: LaneRunnerOptions<Poller>): LaneRunner<Poller> {
  let lastStatus: LaneStatusRecord | null = null;
  let poller: Poller | null = null;
  const restartQueue = createSerialQueue();
  let stopped = false;
  let lastKey: string | null = null;

  function onTickComplete(summary: LaneStatusRecord): void {
    lastStatus = { ...summary, configured: true };
    if (lastStatus) broadcast(lastStatus);
  }

  function startPoller(): void {
    lastKey = cfgKey();
    void restartQueue.run(async () => {
      if (stopped) return;
      if (poller) {
        const old = poller;
        poller = null;
        await old.stop();
      }
      const verdict = gate();
      if (!verdict.start) {
        lastStatus = null;
        broadcast(emptyStatus());
        if (verdict.reason) console.warn(`[${tag}] not starting: ${verdict.reason}`);
        return;
      }
      if (!lastStatus) broadcast(emptyStatus());
      const createdPoller = createPoller({ onTickComplete });
      poller = createdPoller;
      await createdPoller.start().catch((e: unknown) => console.warn(`[${tag}] start failed: ${errorMessage(e)}`));
    }).catch((e: unknown) => console.warn(`[${tag}] restart failed: ${errorMessage(e)}`));
  }

  function restartIfConfigChanged(): void {
    if (cfgKey() !== lastKey) startPoller();
  }

  function stopPoller(): Promise<void> {
    stopped = true;
    beforeStop();
    const draining = poller ? poller.stop() : Promise.resolve();
    return Promise.allSettled([draining, restartQueue.idle()]).then(() => {});
  }

  function patchStatus(patch: LaneStatusRecord): void {
    lastStatus = { ...(lastStatus || emptyStatus()), ...patch };
    if (lastStatus) broadcast(lastStatus);
  }

  return {
    startPoller,
    restartIfConfigChanged,
    stopPoller,
    patchStatus,
    getStatus: () => lastStatus || emptyStatus(),
    getPoller: () => poller,
    isStopped: () => stopped,
  };
}

export { createLaneRunner, createTickLoop };
export type { LaneRunner, LaneRunnerGate, LaneRunnerOptions, LaneStatusRecord, RestartablePoller, SharedClock, TickLoop, TickLoopOptions, TickOutcome };
