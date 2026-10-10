import * as core from './core/issues-core.ts';
import { IssuesState } from '../shared/contracts/issues.ts';
import type { CachedIssueRow, IssuePullRequest, IssuesState as IssuesStateType, IssuesStatus } from '../shared/contracts/issues.ts';
import type { ReviewsRefreshResult } from '../shared/contracts/reviews.ts';
import type { PrGh } from './pr-gh.ts';
import { createTickLoop } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from './core/lane-backoff.ts';
import { errorMessage } from '../shared/text.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../shared/timer-deps.ts';

interface IssuesPollerDependencies {
  teams: string[];
  resolveProjects: (cachedIssues: readonly CachedIssueRow[]) => Promise<core.IssuesProjectRepo[]>;
  github: Pick<PrGh, 'viewer' | 'searchIssues' | 'listRepoIssues' | 'issueLinkedPullRequests' | 'rateLimitWaitMs'>;
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
  const { teams, github, onTickComplete, now = Date.now, log = console } = dependencies;
  let state = core.emptyIssuesState();
  let projects: core.IssuesProjectRepo[] = [];
  let viewer: string | null = null;
  let hasResolvedSources = false;
  let pollingError: string | null = null;
  let stateLoad: Promise<void> | null = null;
  let shouldReconcile = false;
  let laneTickCount = 0;
  const rateLimitWaitMs = () => github.rateLimitWaitMs(now(), ['core', 'search']);

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
    return waitMs === null ? { failed: true } : { failed: true, retryAfterMs: waitMs };
  }

  async function runTick() {
    await loadState();
    if (loop.isStopped()) return { failed: false };
    projects = await dependencies.resolveProjects(state.issues);
    if (loop.isStopped()) return { failed: false };
    if (!viewer) viewer = await github.viewer();
    if (loop.isStopped()) return { failed: false };
    hasResolvedSources = true;
    const timestamp = now();
    const isFullRefresh = shouldReconcile;
    shouldReconcile = false;
    laneTickCount += 1;
    const isLaneReconcileTick = laneTickCount % 6 === 0;
    const batches: core.IssuesSourceBatch[] = [];
    const failures: string[] = [];
    const perRepoSync = { ...state.perRepoSync };
    const reconciledRepos = new Set<string>();
    for (const project of projects) {
      const sync = perRepoSync[project.repo];
      const isReconcile = isFullRefresh || ((sync?.ticks ?? 0) + 1) % 6 === 0;
      if (isReconcile) reconciledRepos.add(project.repo.toLowerCase());
      const isFull = isReconcile || !sync?.lastSyncAt || sync.needsFullReconcile;
      const fetched = await github.listRepoIssues(project.repo, isFull ? null : new Date(sync.lastSyncAt ?? timestamp).toISOString(), core.MAX_REPO_ISSUES);
      if (loop.isStopped()) return { failed: false };
      batches.push({ source: 'project', repo: project.repo, isIncremental: !isFull, fetched });
      const isSuccessful = fetched.ok && fetched.isComplete;
      perRepoSync[project.repo] = {
        lastSyncAt: isSuccessful ? timestamp : sync?.lastSyncAt ?? null,
        ticks: (sync?.ticks ?? 0) + 1,
        needsFullReconcile: !isSuccessful,
      };
      if (!fetched.ok) failures.push(`${project.repo}: ${fetched.error || 'Issue listing failed.'}`);
    }
    const searchedSources = [{ source: 'me' as const, query: 'is:issue is:open assignee:@me archived:false' }, ...teams.map((team) => ({ source: 'team' as const, team, query: `is:issue is:open team:${team} archived:false` }))];
    for (const searched of searchedSources) {
      const fetched = await github.searchIssues(searched.query);
      if (loop.isStopped()) return { failed: false };
      batches.push({ ...searched, fetched });
      if (!fetched.ok) failures.push(`${'team' in searched ? searched.team : 'Assigned to you'}: ${fetched.error || 'Issue search failed.'}`);
    }
    const activeRepos = new Set(projects.map((project) => project.repo));
    const projectRepos = new Set(projects.map((project) => project.repo.toLowerCase()));
    const mergedIssues = core.mergeIssues(state.issues, batches, projects, teams);
    const hasPendingPullRequest = (issue: CachedIssueRow) => issue.pullRequests.some((pullRequest) => pullRequest.state === 'open' || pullRequest.state === 'draft');
    const isReconcileDue = (repo: string) => isFullRefresh || reconciledRepos.has(repo) || (isLaneReconcileTick && !projectRepos.has(repo));
    const isReconciledPending = (issue: CachedIssueRow) => isReconcileDue(issue.repo.toLowerCase()) && hasPendingPullRequest(issue);
    const changedIssues = mergedIssues.filter((issue) => state.pullRequestsFetchedAt[issue.key.toLowerCase()] !== issue.updatedAt || isReconciledPending(issue));
    let pullRequestsByIssue = new Map<string, IssuePullRequest[]>();
    if (changedIssues.length > 0) {
      try {
        pullRequestsByIssue = await github.issueLinkedPullRequests(changedIssues.map((issue) => issue.key.toLowerCase()));
      } catch (error: unknown) {
        log.warn(`[issues] linked pull requests fetch failed: ${errorMessage(error)}`);
      }
    }
    if (loop.isStopped()) return { failed: false };
    const pullRequestsFetchedAt: Record<string, string> = {};
    const issues = mergedIssues.map((issue) => {
      const key = issue.key.toLowerCase();
      const pullRequests = pullRequestsByIssue.get(key);
      const fetchedAt = pullRequests ? issue.updatedAt : state.pullRequestsFetchedAt[key];
      if (fetchedAt) pullRequestsFetchedAt[key] = fetchedAt;
      return { ...issue, pullRequests: pullRequests ?? issue.pullRequests };
    });
    state = {
      issues, pullRequestsFetchedAt, sessionLinks: dependencies.getSessionLinks?.() ?? state.sessionLinks,
      lastSyncAt: failures.length === 0 ? timestamp : state.lastSyncAt,
      perRepoSync: Object.fromEntries(Object.entries(perRepoSync).filter(([repo]) => activeRepos.has(repo))),
    };
    pollingError = failures.length > 0 ? failures.join(' ') : null;
    await loop.persist();
    if (pollingError) return failedOutcome(pollingError);
    return { failed: false };
  }

  const loop = createTickLoop({
    tag: core.ISSUES_LANE_ID, intervalMs: core.POLL_INTERVAL_MINUTES * 60000, quickRetries: true,
    now, clock: dependencies.clock, firstTickDelayMs: dependencies.firstTickDelayMs,
    setIntervalFn: dependencies.setIntervalFn, clearIntervalFn: dependencies.clearIntervalFn,
    setTimeoutFn: dependencies.setTimeoutFn, clearTimeoutFn: dependencies.clearTimeoutFn,
    log, backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, rateLimitWaitMs,
    onScheduleChange: publishStatus, writeState: () => dependencies.writeState(state),
    tick: () => loop.track(runTick().catch((error: unknown) => {
      pollingError = errorMessage(error);
      return failedOutcome(pollingError);
    })),
  });

  async function refresh(): Promise<ReviewsRefreshResult> {
    if (loop.scheduleStatus().isRefreshing) return loop.refresh();
    shouldReconcile = true;
    return loop.refresh();
  }

  return { start: () => loop.start(loadState), stop: loop.stop, tick: loop.tick, refresh };
}
