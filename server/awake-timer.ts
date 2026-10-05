import { advanceAwakeElapsed } from './core/team-review-core.ts';

const DEFAULT_TICK_MS = 15000;

interface AwakeTicks {
  interval: NodeJS.Timeout;
  awakeElapsedMs: () => number;
}

function startAwakeTicks({ tickMs, now, onTick }: {
  tickMs: number;
  now: () => number;
  onTick: (awakeElapsedMs: number, interval: NodeJS.Timeout) => void;
}): AwakeTicks {
  let awakeElapsedMs = 0;
  let previousTickAt = now();
  const interval = setInterval(() => {
    const nowMs = now();
    awakeElapsedMs = advanceAwakeElapsed({ awakeElapsedMs, previousTickAt, nowMs, tickMs });
    previousTickAt = nowMs;
    onTick(awakeElapsedMs, interval);
  }, tickMs);
  return { interval, awakeElapsedMs: () => advanceAwakeElapsed({ awakeElapsedMs, previousTickAt, nowMs: now(), tickMs }) };
}

export function createAwakeTimeoutFn({ tickMs = DEFAULT_TICK_MS, now = Date.now }: {
  tickMs?: number;
  now?: () => number;
} = {}): (callback: () => void, timeoutMs: number) => NodeJS.Timeout {
  return (callback, timeoutMs) => {
    if (timeoutMs <= 0) return setTimeout(callback, 0);
    return startAwakeTicks({
      tickMs: Math.min(tickMs, timeoutMs),
      now,
      onTick: (awakeElapsedMs, interval) => {
        if (awakeElapsedMs < timeoutMs) return;
        clearInterval(interval);
        callback();
      },
    }).interval;
  };
}

export interface AwakeStopwatch {
  awakeElapsedMs: () => number;
  stop: () => void;
}

export function startAwakeStopwatch({ tickMs = DEFAULT_TICK_MS, now = Date.now }: {
  tickMs?: number;
  now?: () => number;
} = {}): AwakeStopwatch {
  const ticks = startAwakeTicks({ tickMs, now, onTick: () => {} });
  ticks.interval.unref();
  return { awakeElapsedMs: ticks.awakeElapsedMs, stop: () => clearInterval(ticks.interval) };
}
