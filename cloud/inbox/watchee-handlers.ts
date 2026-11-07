import type { WatcheeJobKind, WatcherJobOfKind } from '../../shared/contracts/watcher-jobs.ts';
import type { WatcherJobHandlers } from './job-inbox-listener.ts';

type WatcheeJobHandlers = { [Kind in WatcheeJobKind]: (job: WatcherJobOfKind<Kind>) => Promise<void> };

function withBuiltInJobHandlers(watcheeHandlers: WatcheeJobHandlers): WatcherJobHandlers {
  return Object.freeze({ ping: async () => {}, ...watcheeHandlers });
}

export { withBuiltInJobHandlers };
export type { WatcheeJobHandlers };
