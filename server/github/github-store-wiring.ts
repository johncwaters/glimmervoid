import type { GithubPrsFreshness } from '../../shared/contracts/github-polling.ts';
import { GithubPrsFrame } from '../../shared/contracts/github-prs.ts';
import { DEFAULT_TIMER_FNS } from '../../shared/timer-deps.ts';
import type { SharedClock } from '../lanes/lane-runner.ts';
import { GITHUB_CLOCK_INTERVAL_MINUTES } from './core/github-clock-core.ts';
import { createGithubStorePoller } from './github-store-poller.ts';
import type { PrGh } from './pr-gh.ts';

interface GithubStoreWiringOptions {
  github: PrGh;
  clock: SharedClock;
  now?: () => number;
  isDashboardConnected: () => boolean;
  broadcast: (frame: GithubPrsFrame) => void;
  log: Pick<Console, 'warn'>;
}

export function createGithubStoreWiring({ github, clock, now = Date.now, isDashboardConnected, broadcast, log }: GithubStoreWiringOptions) {
  const poller = createGithubStorePoller({
    github,
    now,
    isDashboardConnected,
    exclusive: clock.exclusive,
    setTimeoutFn: DEFAULT_TIMER_FNS.setTimeoutFn,
    clearTimeoutFn: DEFAULT_TIMER_FNS.clearTimeoutFn,
    log,
  });

  function snapshotMessage(): GithubPrsFrame {
    const { prs, freshness } = poller.getSnapshot();
    return GithubPrsFrame.parse({ type: 'github-prs', ts: now(), prs, freshness });
  }

  poller.events.on('snapshot-changed', () => broadcast(snapshotMessage()));
  clock.schedule(async () => { await poller.tick(); }, GITHUB_CLOCK_INTERVAL_MINUTES * 60000);

  function getFreshness(): GithubPrsFreshness {
    return poller.getSnapshot().freshness;
  }

  const laneStore = {
    registerWatch: poller.registerWatch,
    unregisterWatch: poller.unregisterWatch,
    setWatchedKeys: poller.setWatchedKeys,
    getSnapshot: poller.getSnapshot,
    refreshWatches: poller.refreshWatches,
    requestRefresh: poller.requestRefresh,
    requestPrView: poller.requestPrView,
    requestPrDiff: poller.requestPrDiff,
    requestPrHead: poller.requestPrHead,
    requestRepoIssues: poller.requestRepoIssues,
    requestIssueSearch: poller.requestIssueSearch,
    requestIssueLinkedPullRequests: poller.requestIssueLinkedPullRequests,
    requestTeamReviewCompare: poller.requestTeamReviewCompare,
    requestTeamReviewThreads: poller.requestTeamReviewThreads,
    subscribe: <Event extends 'snapshot-changed' | 'change'>(event: Event, listener: Parameters<typeof poller.events.on<Event>>[1]) => {
      poller.events.on(event, listener);
      return () => { poller.events.off(event, listener); };
    },
  };
  return { snapshotMessage, getFreshness, laneStore };
}

export type GithubLaneStore = ReturnType<typeof createGithubStoreWiring>['laneStore'];
