import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { OutcomeName } from '../shared/outcome-names.ts';
import { countOutcome, drainOutcomeSummary, emptyOutcomeCounts } from './core/outcome-summary-core.ts';
import type { OutcomeCounts } from './core/outcome-summary-core.ts';
import { createLaneLog } from './lanes/lane-log.ts';
import type { LaneLogger } from './lanes/lane-log.ts';
import { DEFAULT_TIMER_FNS } from '../shared/timer-deps.ts';
import type { ClearIntervalFn, SetIntervalFn } from '../shared/timer-deps.ts';

const SUMMARY_INTERVAL_MS = 60000;
const LOOP_LAG_RESOLUTION_MS = 20;
const NANOSECONDS_PER_MILLISECOND = 1e6;

interface LoopLagHistogram {
  count: number;
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  percentile(percentile: number): number;
}

interface OutcomesLaneOptions {
  logger?: LaneLogger | null;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  createLoopLagHistogram?: () => LoopLagHistogram | null;
}

function defaultLoopLagHistogram(): LoopLagHistogram {
  return monitorEventLoopDelay({ resolution: LOOP_LAG_RESOLUTION_MS });
}

function createOutcomesLane({
  logger = console,
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn,
  clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
  createLoopLagHistogram = defaultLoopLagHistogram,
}: OutcomesLaneOptions = {}) {
  const { note } = createLaneLog({ prefix: '[outcomes]', logger });
  let counts: OutcomeCounts = emptyOutcomeCounts();
  let stopped = false;
  let worstLoopLagP99Ms: number | null = null;

  const histogram = createLoopLagHistogram();
  histogram?.enable();

  function record(name: OutcomeName): void {
    if (stopped) return;
    countOutcome(counts, name);
  }

  function readLoopLagP99Ms(): number | null {
    if (!histogram) return null;
    if (histogram.count === 0) return null;
    const nanoseconds = histogram.percentile(99);
    histogram.reset();
    if (!Number.isFinite(nanoseconds)) return null;
    return nanoseconds / NANOSECONDS_PER_MILLISECOND;
  }

  function takeWorstLoopLagP99Ms(): number | null {
    const worst = worstLoopLagP99Ms;
    worstLoopLagP99Ms = null;
    return worst;
  }

  function drain(): void {
    const loopLagP99Ms = readLoopLagP99Ms();
    if (loopLagP99Ms !== null) worstLoopLagP99Ms = Math.max(worstLoopLagP99Ms ?? 0, loopLagP99Ms);
    const drained = drainOutcomeSummary(counts, loopLagP99Ms);
    counts = drained.next;
    if (!drained.fields) return;
    note('summary', drained.fields);
  }

  let summaryTimer: NodeJS.Timeout | null = setIntervalFn(drain, SUMMARY_INTERVAL_MS);
  summaryTimer.unref();

  function stop(): void {
    if (stopped) return;
    drain();
    stopped = true;
    if (summaryTimer) clearIntervalFn(summaryTimer);
    summaryTimer = null;
    histogram?.disable();
  }

  return {
    record,
    drain,
    takeWorstLoopLagP99Ms,
    stop,
    get isStopped() { return stopped; },
  };
}

export { createOutcomesLane };
