import { isHostWake, isSessionBusy, isWakeDueWithinIdleWindow, nextQuietAwakeMs, shouldRequestStop, sleptMsBetweenTicks } from './core/idle-stop-core.ts';
import type { HostStopRequestOutcome } from '../cloud/link/watcher-link.ts';
import type { SessionState } from '../shared/states.ts';
import type { ExpiredOpenWork } from '../session/core/agent-tracker.ts';
import type { TelemetryEventProperties } from '../shared/contracts/telemetry.ts';
import { clock } from '../shared/clock.ts';

type LiveSessionView = { state: SessionState; hasBackgroundWork: boolean; expiredOpenWork: ExpiredOpenWork };
type StopRequestedReport = TelemetryEventProperties<'idle_stop_requested'>;

function expiredWorkReport(sessions: readonly LiveSessionView[]): Omit<StopRequestedReport, 'outcome'> {
  const report = { sessions_with_expired_work: 0, expired_subagent_count: 0, expired_shell_count: 0 };
  for (const { expiredOpenWork } of sessions) {
    if (expiredOpenWork.subagent + expiredOpenWork.shell === 0) continue;
    report.sessions_with_expired_work += 1;
    report.expired_subagent_count += expiredOpenWork.subagent;
    report.expired_shell_count += expiredOpenWork.shell;
  }
  return report;
}

const DEFAULT_TICK_MS = 15_000;

function startIdleStop({ liveSessions, requestHostStop, reportStopRequested, onHostWoke = () => {}, nextWakeAt = () => null, now = clock.nowMs, tickMs = DEFAULT_TICK_MS, log = console }: {
  liveSessions: () => Iterable<LiveSessionView>;
  requestHostStop: () => Promise<HostStopRequestOutcome>;
  reportStopRequested: (report: StopRequestedReport) => void;
  onHostWoke?: (sleptMs: number) => void;
  nextWakeAt?: () => number | null;
  now?: () => number;
  tickMs?: number;
  log?: Pick<Console, 'log'>;
}): { stop(): void } {
  let quietAwakeMs = 0;
  let previousTickAt = now();
  let isRequestInFlight = false;
  let hasLoggedNoAdapter = false;

  async function askHostToStop(sessions: readonly LiveSessionView[]): Promise<void> {
    isRequestInFlight = true;
    const expiredWork = expiredWorkReport(sessions);
    const outcome = await requestHostStop().finally(() => {
      isRequestInFlight = false;
    });
    reportStopRequested({ outcome, ...expiredWork });
    if (outcome === 'stopping') log.log('[idle-stop] no agent work for 20 awake minutes; asked the doorman to stop this host');
    if (outcome !== 'no-adapter' || hasLoggedNoAdapter) return;
    hasLoggedNoAdapter = true;
    log.log('[idle-stop] no agent work for 20 awake minutes; this doorman has no host to stop, so this server stays up');
  }

  function tick(): void {
    const nowMs = now();
    const sleptMs = sleptMsBetweenTicks({ previousTickAt, nowMs, tickMs });
    if (isHostWake(sleptMs)) {
      log.log(`[idle-stop] this host slept for ${Math.round(sleptMs / 1000)} s; rechecking the watcher link`);
      onHostWoke(sleptMs);
    }
    const sessions = [...liveSessions()];
    const isBusy = sessions.some(isSessionBusy) || isWakeDueWithinIdleWindow(nextWakeAt(), nowMs);
    quietAwakeMs = nextQuietAwakeMs({ quietAwakeMs, isBusy, previousTickAt, nowMs, tickMs });
    previousTickAt = nowMs;
    if (isRequestInFlight || !shouldRequestStop(quietAwakeMs)) return;
    quietAwakeMs = 0;
    void askHostToStop(sessions);
  }

  const interval = setInterval(tick, tickMs);
  interval.unref();
  return { stop: () => clearInterval(interval) };
}

export { startIdleStop };
