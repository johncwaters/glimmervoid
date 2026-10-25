import { CHANGES_POLL_INTERVAL_MS } from '../shared/contracts/control-messages.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../shared/timer-deps.ts';
import type { ClearIntervalFn, SetIntervalFn, TimerHandle } from '../shared/timer-deps.ts';
import { decidePollTick, decideWatchRequest } from './core/changes-watch-core.ts';
import type { ChangesWatch } from './core/changes-watch-core.ts';

type WatchedSession = { worktreeLifecycle: { scheduleCheck(): void } };

function createChangesWatch<Holder>({
  findSession,
  isHolderOpen,
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn,
  clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
  nowFn = Date.now,
}: {
  findSession: (sessionId: string) => WatchedSession | null;
  isHolderOpen: (holder: Holder) => boolean;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  nowFn?: () => number;
}) {
  let watch: ChangesWatch<Holder> | null = null;
  let pollTimer: TimerHandle | null = null;

  function syncPollTimer(): void {
    if (watch === null && pollTimer !== null) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
      return;
    }
    if (watch === null || pollTimer !== null) return;
    pollTimer = unrefTimer(setIntervalFn(pollWatchedSession, CHANGES_POLL_INTERVAL_MS));
  }

  function checkSession(sessionId: string): void {
    const session = findSession(sessionId);
    if (session) {
      session.worktreeLifecycle.scheduleCheck();
      return;
    }
    watch = null;
  }

  function pollWatchedSession(): void {
    const holderIsOpen = watch !== null && isHolderOpen(watch.holder);
    const tick = decidePollTick(watch, { nowMs: nowFn(), isHolderOpen: holderIsOpen });
    watch = tick.next;
    if (tick.sessionIdToCheck !== null) checkSession(tick.sessionIdToCheck);
    syncPollTimer();
  }

  function request(holder: Holder, sessionId: string | null): void {
    const decision = decideWatchRequest(watch, { holder, sessionId, nowMs: nowFn() });
    watch = decision.next;
    if (decision.shouldCheckNow && watch !== null) checkSession(watch.sessionId);
    syncPollTimer();
  }

  return { request };
}

export { createChangesWatch };
