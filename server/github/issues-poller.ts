import * as core from './core/issues-core.ts';
import { IssuesState } from '../../shared/contracts/issues.ts';
import type { CachedIssueRow, IssuesState as IssuesStateType, IssuesStatus } from '../../shared/contracts/issues.ts';
import type { IssuesListingPayload } from '../../shared/contracts/issues-listing.ts';
import type { GithubPollingRefreshResult } from '../../shared/contracts/github-polling.ts';
import type { GithubLaneStore } from './github-store-wiring.ts';
import { storeReadingLaneClock } from './github-store-wiring.ts';
import { createTickLoop } from '../lanes/lane-runner.ts';
import type { SharedClock } from '../lanes/lane-runner.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from '../lanes/core/lane-backoff.ts';
import { watcherFeedError } from '../lanes/core/watchee-feed-core.ts';
import { errorMessage } from '../../shared/text.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../../shared/timer-deps.ts';

const POLL_INTERVAL_MS = core.POLL_INTERVAL_MINUTES * 60000;

interface IssuesPollerDependencies {
  teams: string[];
  resolveProjects: (cachedIssues: readonly CachedIssueRow[]) => Promise<core.IssuesProjectRepo[]>;
  store: Pick<GithubLaneStore, 'requestIssueLinkedPullRequests' | 'setWatchedKeys' | 'rateLimitWaitMs'>;
  latestListings: () => readonly IssuesListingPayload[];
  feedSilenceMs: () => number;
  heldClosedKeys: () => ReadonlySet<string>;
  getSessionLinks?: () => Record<string, string>;
  readState: () => Promise<unknown>;
  writeState: (state: IssuesStateType) => Promise<void>;
  onTickComplete: (status: IssuesStatus) => void;
  now?: () => number;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  log?: Pick<Console, 'warn'>;
}

export function createIssuesPoller(dependencies: IssuesPollerDependencies) {
  const { teams, store, onTickComplete, now = Date.now, log = console } = dependencies;
  let state = core.emptyIssuesState();
  let projects: core.IssuesProjectRepo[] = [];
  let viewer: string | null = null;
  let hasResolvedSources = false;
  let pollingError: string | null = null;
  let stateLoad: Promise<void> | null = null;
  let shouldRereadHeldIssues = false;
  const plannedListings = new WeakSet<IssuesListingPayload>();
  const rateLimitWaitMs = () => store.rateLimitWaitMs(now(), ['core']);

  function publishStatus(): void {
    if (loop.isStopped()) return;
    const gate = hasResolvedSources ? core.issuesSettingsGate(projects, teams, viewer) : core.issuesCachedSourcesGate(state.issues, teams);
    onTickComplete(core.issuesStatus({ ts: now(), ...gate, issues: state.issues, sessionLinks: dependencies.getSessionLinks?.() ?? state.sessionLinks, lastSyncAt: state.lastSyncAt, error: pollingError, ...loop.scheduleStatus() }));
  }

  function loadState(): Promise<void> {
    if (stateLoad) return stateLoad;
    stateLoad = (async () => {
      state = IssuesState.parse(await dependencies.readState());
      publishStatus();
    })();
    return stateLoad;
  }

  async function failedOutcome(error: string) {
    const waitMs = await rateLimitWaitMs() ?? secondaryRateLimitWaitMs(error);
    return waitMs === null ? { failed: true, error } : { failed: true, retryAfterMs: waitMs, error };
  }

  async function rereadHeldIssues(): Promise<{ isRateLimited: true; waitMs: number } | null> {
    if (state.issues.length === 0) return null;
    const response = await store.requestIssueLinkedPullRequests(state.issues.map((issue) => issue.key.toLowerCase()), 'no-wait');
    if (response.isRateLimited) return response;
    const pullRequestsByIssue = response.value;
    state = { ...state, issues: state.issues.map((issue) => ({ ...issue, pullRequests: pullRequestsByIssue.get(issue.key.toLowerCase()) ?? issue.pullRequests })) };
    return null;
  }

  async function runTick() {
    await loadState();
    if (loop.isStopped()) return { failed: false };
    projects = await dependencies.resolveProjects(state.issues);
    if (loop.isStopped()) return { failed: false };
    const latestListings = dependencies.latestListings();
    pollingError = watcherFeedError('Issues has no issue list', dependencies.feedSilenceMs(), POLL_INTERVAL_MS) ?? core.issuesListingErrors(latestListings);
    const unplannedListings = latestListings.filter((listing) => !plannedListings.has(listing));
    viewer = unplannedListings[0]?.viewer ?? viewer;
    const isRereadingHeldIssues = shouldRereadHeldIssues;
    shouldRereadHeldIssues = false;
    if (unplannedListings.length === 0 && !isRereadingHeldIssues) {
      publishStatus();
      return { failed: false };
    }
    if (unplannedListings.length > 0) {
      hasResolvedSources = true;
      const batches = core.issuesListingBatches(unplannedListings, projects, teams);
      const issues = core.withListedPullRequests(core.mergeIssues(state.issues, batches, projects, teams, dependencies.heldClosedKeys()), unplannedListings);
      for (const listing of unplannedListings) plannedListings.add(listing);
      state = { ...state, issues, lastSyncAt: now() };
    }
    if (isRereadingHeldIssues) {
      const rateLimited = await rereadHeldIssues();
      if (loop.isStopped()) return { failed: false };
      if (rateLimited) return { failed: true, retryAfterMs: rateLimited.waitMs };
    }
    state = { ...state, sessionLinks: dependencies.getSessionLinks?.() ?? state.sessionLinks };
    await loop.persist();
    return { failed: false };
  }

  const loop = createTickLoop({
    tag: core.ISSUES_LANE_ID, intervalMs: POLL_INTERVAL_MS, quickRetries: true,
    now, clock: storeReadingLaneClock(dependencies.clock), firstTickDelayMs: dependencies.firstTickDelayMs,
    setIntervalFn: dependencies.setIntervalFn, clearIntervalFn: dependencies.clearIntervalFn,
    setTimeoutFn: dependencies.setTimeoutFn, clearTimeoutFn: dependencies.clearTimeoutFn,
    log, backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, rateLimitWaitMs,
    onScheduleChange: publishStatus, writeState: () => dependencies.writeState(state),
    tick: () => loop.track(runTick().catch((error: unknown) => {
      pollingError = errorMessage(error);
      return failedOutcome(pollingError);
    }).finally(() => {
      if (!loop.isStopped()) store.setWatchedKeys('issues-linked-prs', core.issuesLinkedPrKeys(state.issues));
    })),
  });

  async function forgetIssue(issueKey: string): Promise<void> {
    await loadState();
    const forgottenKey = issueKey.toLowerCase();
    state = { ...state, issues: state.issues.filter((issue) => issue.key.toLowerCase() !== forgottenKey) };
    await loop.persist();
    publishStatus();
  }

  async function refresh(): Promise<GithubPollingRefreshResult> {
    if (loop.scheduleStatus().isRefreshing) return loop.refresh();
    shouldRereadHeldIssues = true;
    return loop.refresh();
  }

  return { start: () => loop.start(loadState), stop: loop.stop, tick: loop.tick, tickSoon: loop.tickSoon, refresh, forgetIssue };
}
