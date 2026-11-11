import type { GithubPrsFreshness } from '../../shared/contracts/github-polling.ts';
import { GithubPrsFrame } from '../../shared/contracts/github-prs.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../../shared/timer-deps.ts';
import type { SetTimeoutFn } from '../../shared/timer-deps.ts';
import type { SharedClock } from '../lanes/lane-runner.ts';
import { GITHUB_CLOCK_INTERVAL_MINUTES } from './core/github-clock-core.ts';
import { createGithubStorePoller } from './github-store-poller.ts';
import { GITHUB_STORE_LANE_ID, coveredProbeKey, githubStoreProbes, nudgedStorePoll } from './github-store-probes.ts';
import type { Nudge, Probe } from '../../shared/contracts/watcher-link.ts';
import type { PrGh } from './pr-gh.ts';
import { clock as timeClock } from '../../shared/clock.ts';

const MAX_NUDGED_POLL_ATTEMPTS = 5;
const MAX_NUDGED_POLL_RETRY_MS = 5 * 60_000;
const CATCH_UP_DEBOUNCE_MS = 10_000;

interface GithubStoreWiringOptions {
  github: PrGh;
  clock: SharedClock;
  now?: () => number;
  isDashboardConnected: () => boolean;
  broadcast: (frame: GithubPrsFrame) => void;
  log: Pick<Console, 'warn'>;
  setTimeoutFn?: SetTimeoutFn;
}

export function storeReadingLaneClock(clock: SharedClock | undefined): SharedClock | undefined {
  return clock ? { schedule: clock.schedule, exclusive: async (work) => work(), githubStatus: clock.githubStatus } : undefined;
}

export function createGithubStoreWiring({ github, clock, now = timeClock.nowMs, isDashboardConnected, broadcast, log, setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn }: GithubStoreWiringOptions) {
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

  function watchNames(): string[] {
    return poller.probeInputs().watches.map((watch) => watch.name);
  }

  let catchUpTimer: ReturnType<SetTimeoutFn> | null = null;
  let coveredProbeKeys: ReadonlySet<string> = new Set();
  const newlyCoveredProbeIds = new Set<string>();

  function runStorePoll(probeId: string, attempt = 1): void {
    const nudgedPoll = nudgedStorePoll(probeId, watchNames());
    if (nudgedPoll === null) return;
    const poll = 'watchName' in nudgedPoll ? poller.tick([nudgedPoll.watchName]) : poller.tick(undefined, nudgedPoll.poll);
    void poll.then((outcome) => {
      if (!outcome.failed || attempt >= MAX_NUDGED_POLL_ATTEMPTS) return;
      unrefTimer(setTimeoutFn(() => runStorePoll(probeId, attempt + 1), Math.min(MAX_NUDGED_POLL_RETRY_MS, outcome.retryAfterMs ?? MAX_NUDGED_POLL_RETRY_MS)));
    });
  }

  function runNudgedPoll(nudge: Nudge): void {
    if (nudge.probeId !== null) runStorePoll(nudge.probeId);
  }

  function coverWithWatcher(coveredProbes: readonly Probe[]): void {
    poller.setCoveredProbes(coveredProbes);
    for (const probe of coveredProbes) {
      if (!coveredProbeKeys.has(coveredProbeKey(probe))) newlyCoveredProbeIds.add(probe.id);
    }
    coveredProbeKeys = new Set(coveredProbes.map(coveredProbeKey));
    if (newlyCoveredProbeIds.size === 0 || catchUpTimer !== null) return;
    catchUpTimer = unrefTimer(setTimeoutFn(catchUpNewlyCovered, CATCH_UP_DEBOUNCE_MS));
  }

  function catchUpNewlyCovered(): void {
    catchUpTimer = null;
    const pollKeys = new Set<string>();
    for (const probeId of newlyCoveredProbeIds) {
      const nudgedPoll = nudgedStorePoll(probeId, watchNames());
      const pollKey = nudgedPoll === null ? null : 'watchName' in nudgedPoll ? `watch:${nudgedPoll.watchName}` : nudgedPoll.poll;
      if (pollKey === null || pollKeys.has(pollKey)) continue;
      pollKeys.add(pollKey);
      runStorePoll(probeId);
    }
    newlyCoveredProbeIds.clear();
  }

  function probes(): Probe[] {
    const inputs = poller.probeInputs();
    if (inputs.viewerLogin === null) void poller.requestViewer();
    return githubStoreProbes(inputs);
  }

  function onProbesMayHaveChanged(listener: () => void): void {
    poller.events.on('watches-changed', listener);
    poller.events.on('snapshot-changed', listener);
  }

  const probeSource = { laneId: GITHUB_STORE_LANE_ID, credential: 'github' as const, probes, onNudge: runNudgedPoll, onCoverageChange: coverWithWatcher };

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
    requestViewer: poller.requestViewer,
    requestViewerTeams: poller.requestViewerTeams,
    requestTeamProfile: poller.requestTeamProfile,
    requestTeamMembers: poller.requestTeamMembers,
    requestIssue: poller.requestIssue,
    requestMergedPrs: poller.requestMergedPrs,
    requestReviewCaseData: poller.requestReviewCaseData,
    requestCompareCommits: poller.requestCompareCommits,
    rateLimitWaitMs: poller.rateLimitWaitMs,
    requestPrView: poller.requestPrView,
    requestPrDiff: poller.requestPrDiff,
    requestPrHead: poller.requestPrHead,
    requestRepoIssues: poller.requestRepoIssues,
    requestIssueSearch: poller.requestIssueSearch,
    requestIssueLinkedPullRequests: poller.requestIssueLinkedPullRequests,
    requestTeamReviewCompare: poller.requestTeamReviewCompare,
    requestTeamReviewThreads: poller.requestTeamReviewThreads,
    subscribe: (event: 'snapshot-changed', listener: () => void) => {
      poller.events.on(event, listener);
      return () => { poller.events.off(event, listener); };
    },
  };
  return { snapshotMessage, getFreshness, laneStore, probeSource, onProbesMayHaveChanged };
}

export type GithubLaneStore = ReturnType<typeof createGithubStoreWiring>['laneStore'];
