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
  isDashboardConnected: () => boolean;
  broadcast: (frame: GithubPrsFrame) => void;
  log: Pick<Console, 'warn'>;
}

export function createGithubStoreWiring({ github, clock, isDashboardConnected, broadcast, log }: GithubStoreWiringOptions) {
  const poller = createGithubStorePoller({
    github,
    now: Date.now,
    isDashboardConnected,
    exclusive: clock.exclusive,
    setTimeoutFn: DEFAULT_TIMER_FNS.setTimeoutFn,
    clearTimeoutFn: DEFAULT_TIMER_FNS.clearTimeoutFn,
    log,
  });

  function snapshotMessage(): GithubPrsFrame {
    return GithubPrsFrame.parse({ type: 'github-prs', ts: Date.now(), ...poller.getSnapshot() });
  }

  poller.events.on('snapshot-changed', () => broadcast(snapshotMessage()));
  clock.schedule(async () => { await poller.tick(); }, GITHUB_CLOCK_INTERVAL_MINUTES * 60000);

  function getFreshness(): GithubPrsFreshness {
    return poller.getSnapshot().freshness;
  }

  return { snapshotMessage, getFreshness };
}
