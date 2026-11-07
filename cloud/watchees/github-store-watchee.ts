import { createGithubStorePoller } from '../../server/github/github-store-poller.ts';
import { createPrGh } from '../../server/github/pr-gh.ts';
import { DEFAULT_TIMER_FNS } from '../../shared/timer-deps.ts';
import type { WatcheeContext } from './watchee.ts';

function createWatcheeGithubStore({ watcherHome, now, log }: WatcheeContext) {
  return createGithubStorePoller({
    github: createPrGh(watcherHome),
    now,
    isDashboardConnected: () => false,
    exclusive: async (work) => work(),
    setTimeoutFn: DEFAULT_TIMER_FNS.setTimeoutFn,
    clearTimeoutFn: DEFAULT_TIMER_FNS.clearTimeoutFn,
    log,
  });
}

export { createWatcheeGithubStore };
