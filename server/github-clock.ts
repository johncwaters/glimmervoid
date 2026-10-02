import { runsEveryTicks } from './core/github-clock-core.ts';
import type { SharedClock } from './lane-runner.ts';

interface GithubClockOptions {
  baseIntervalMs: number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  log?: Pick<Console, 'warn'>;
}

interface ClockSubscription {
  run: () => Promise<void>;
  everyTicks: number;
  ticksSinceRun: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGithubClock({ baseIntervalMs, setIntervalFn = (fn, ms) => setInterval(fn, ms), clearIntervalFn = clearInterval, log = console }: GithubClockOptions) {
  const subscriptions = new Set<ClockSubscription>();
  let timer: NodeJS.Timeout | null = null;
  let isSweeping = false;
  let exclusiveChain: Promise<unknown> = Promise.resolve();

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const outcome = exclusiveChain.then(() => work());
    exclusiveChain = outcome.catch(() => undefined);
    return outcome;
  }

  async function sweep(): Promise<void> {
    if (isSweeping) return;
    isSweeping = true;
    try {
      for (const subscription of [...subscriptions]) {
        subscription.ticksSinceRun += 1;
        if (subscription.ticksSinceRun < subscription.everyTicks) continue;
        subscription.ticksSinceRun = 0;
        await subscription.run().catch((error: unknown) => log.warn(`[github-clock] sweep failed: ${errorMessage(error)}`));
      }
    } finally {
      isSweeping = false;
    }
  }

  function stopTimerWhenIdle(): void {
    if (subscriptions.size > 0 || !timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  const schedule: SharedClock['schedule'] = (run, intervalMs) => {
    const subscription: ClockSubscription = { run, everyTicks: runsEveryTicks(intervalMs, baseIntervalMs), ticksSinceRun: 0 };
    subscriptions.add(subscription);
    if (!timer) {
      timer = setIntervalFn(() => { void sweep(); }, baseIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return () => {
      subscriptions.delete(subscription);
      stopTimerWhenIdle();
    };
  };

  return { schedule, exclusive, sweep };
}
