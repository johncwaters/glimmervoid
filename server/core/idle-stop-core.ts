import { advanceAwakeElapsed } from '../github/core/team-review-core.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';

const IDLE_STOP_WINDOW_MS = 20 * 60_000;
const HOST_WAKE_THRESHOLD_MS = 30_000;
const BUSY_STATES: ReadonlySet<SessionState> = new Set([STATES.INITIALIZING, STATES.STARTING, STATES.RUNNING]);

function isSessionBusy(session: { state: SessionState; hasBackgroundWork: boolean }): boolean {
  return BUSY_STATES.has(session.state) || session.hasBackgroundWork;
}

function nextQuietAwakeMs({ quietAwakeMs, isBusy, previousTickAt, nowMs, tickMs }: {
  quietAwakeMs: number; isBusy: boolean; previousTickAt: number; nowMs: number; tickMs: number;
}): number {
  if (isBusy) return 0;
  return advanceAwakeElapsed({ awakeElapsedMs: quietAwakeMs, previousTickAt, nowMs, tickMs });
}

function shouldRequestStop(quietAwakeMs: number): boolean {
  return quietAwakeMs >= IDLE_STOP_WINDOW_MS;
}

function sleptMsBetweenTicks({ previousTickAt, nowMs, tickMs }: { previousTickAt: number; nowMs: number; tickMs: number }): number {
  return Math.max(0, nowMs - previousTickAt - tickMs);
}

function isHostWake(sleptMs: number): boolean {
  return sleptMs >= HOST_WAKE_THRESHOLD_MS;
}

export { isHostWake, isSessionBusy, nextQuietAwakeMs, shouldRequestStop, sleptMsBetweenTicks };
