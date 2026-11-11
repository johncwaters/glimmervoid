import { isSessionBusy, nextQuietAwakeMs, shouldRequestStop } from './core/idle-stop-core.ts';
import type { HostStopRequestOutcome } from '../cloud/link/watcher-link.ts';
import type { SessionState } from '../shared/states.ts';

const DEFAULT_TICK_MS = 15_000;

function startIdleStop({ liveSessions, requestHostStop, now = Date.now, tickMs = DEFAULT_TICK_MS, log = console }: {
  liveSessions: () => Iterable<{ state: SessionState; hasBackgroundWork: boolean }>;
  requestHostStop: () => Promise<HostStopRequestOutcome>;
  now?: () => number;
  tickMs?: number;
  log?: Pick<Console, 'log'>;
}): { stop(): void } {
  let quietAwakeMs = 0;
  let previousTickAt = now();
  let isRequestInFlight = false;
  let hasLoggedNoAdapter = false;

  async function askHostToStop(): Promise<void> {
    isRequestInFlight = true;
    const outcome = await requestHostStop().finally(() => {
      isRequestInFlight = false;
    });
    if (outcome === 'stopping') log.log('[idle-stop] no agent work for 20 awake minutes; asked the doorman to stop this host');
    if (outcome !== 'no-adapter' || hasLoggedNoAdapter) return;
    hasLoggedNoAdapter = true;
    log.log('[idle-stop] no agent work for 20 awake minutes; this doorman has no host to stop, so this server stays up');
  }

  function tick(): void {
    const nowMs = now();
    const isBusy = [...liveSessions()].some(isSessionBusy);
    quietAwakeMs = nextQuietAwakeMs({ quietAwakeMs, isBusy, previousTickAt, nowMs, tickMs });
    previousTickAt = nowMs;
    if (isRequestInFlight || !shouldRequestStop(quietAwakeMs)) return;
    quietAwakeMs = 0;
    void askHostToStop();
  }

  const interval = setInterval(tick, tickMs);
  interval.unref();
  return { stop: () => clearInterval(interval) };
}

export { startIdleStop };
