import {
  buildCoderActivityMessage, CODER_ACTIVITY_RETRY_MAX_WAIT_MS, CODER_ACTIVITY_STOPPED_MESSAGE, CODER_ACTIVITY_TICK_INTERVAL_MS, decideCoderReport,
} from './core/coder-activity-core.ts';
import type { CoderActivityLastReport, CoderActivityState } from './core/coder-activity-core.ts';
import { createTickLoop } from './lane-runner.ts';
import type { TickLoopOptions, TickOutcome } from './lane-runner.ts';
import { errorMessage } from '../shared/text.ts';

interface CoderActivityReport {
  state: CoderActivityState;
  message: string;
}

type CoderActivityPollerDeps = Pick<TickLoopOptions, 'now' | 'setIntervalFn' | 'clearIntervalFn' | 'setTimeoutFn' | 'clearTimeoutFn' | 'firstTickDelayMs' | 'random' | 'log'> & {
  countRunningSessions: () => number;
  reportStatus: (report: CoderActivityReport) => Promise<void>;
};

function createCoderActivityPoller({ countRunningSessions, reportStatus, now = Date.now, log = console, ...loopOptions }: CoderActivityPollerDeps) {
  let lastReport: CoderActivityLastReport | null = null;
  let stopping: Promise<void> | null = null;

  async function runTick(): Promise<TickOutcome | undefined> {
    const runningSessionCount = countRunningSessions();
    const reportTime = now();
    const state = decideCoderReport({ runningSessionCount, lastReport, now: reportTime });
    if (state === null) return;
    try {
      await reportStatus({ state, message: buildCoderActivityMessage(runningSessionCount) });
      lastReport = { state, at: reportTime };
      return;
    } catch (error) {
      log.warn(`[coder-activity] ${state} report failed: ${errorMessage(error)}`);
      return { failed: true };
    }
  }

  const loop = createTickLoop({
    ...loopOptions,
    tag: 'coder-activity',
    log,
    intervalMs: CODER_ACTIVITY_TICK_INTERVAL_MS,
    backoffBaseMs: CODER_ACTIVITY_TICK_INTERVAL_MS,
    backoffMaxMs: CODER_ACTIVITY_RETRY_MAX_WAIT_MS,
    now,
    tick: () => loop.track(runTick()),
  });

  async function stopAndCloseWorkingStatus(): Promise<void> {
    await loop.stop();
    if (lastReport?.state !== 'working') return;
    try {
      await reportStatus({ state: 'idle', message: CODER_ACTIVITY_STOPPED_MESSAGE });
      lastReport = { state: 'idle', at: now() };
    } catch (error) {
      log.warn(`[coder-activity] idle report on stop failed: ${errorMessage(error)}`);
    }
  }

  function start(): Promise<void> {
    stopping = null;
    return loop.start();
  }

  function stop(): Promise<void> {
    stopping ??= stopAndCloseWorkingStatus();
    return stopping;
  }

  return { start, stop, tick: loop.tick };
}

type CoderActivityPoller = ReturnType<typeof createCoderActivityPoller>;
export { createCoderActivityPoller };
export type { CoderActivityReport, CoderActivityPollerDeps, CoderActivityPoller };
