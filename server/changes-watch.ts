import { decideWatchRequest } from './core/changes-watch-core.ts';
import type { ChangesWatch } from './core/changes-watch-core.ts';

type WatchedSession = { worktreeLifecycle: { scheduleCheck(): void } };

function createChangesWatch<Holder>({ findSession }: { findSession: (sessionId: string) => WatchedSession | null }) {
  let watch: ChangesWatch<Holder> | null = null;

  function request(holder: Holder, sessionId: string | null): void {
    const decision = decideWatchRequest(watch, { holder, sessionId });
    watch = decision.next;
    if (decision.shouldCheckNow && watch !== null) findSession(watch.sessionId)?.worktreeLifecycle.scheduleCheck();
  }

  return { request };
}

export { createChangesWatch };
