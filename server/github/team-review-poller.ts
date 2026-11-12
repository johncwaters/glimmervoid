import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import { storeReadingLaneClock } from './github-store-wiring.ts';
import * as core from './core/team-review-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS, isRateLimitText, refusingReadsText } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from '../lanes/core/lane-backoff.ts';
import type { TeamReviewCandidate } from './core/team-review-core.ts';
import { createTickLoop } from '../lanes/lane-runner.ts';
import type { TickOutcome } from '../lanes/lane-runner.ts';
import type { InFlightReview } from '../../shared/contracts/team-review.ts';
import type { GithubPr } from '../../shared/contracts/github-prs.ts';
import type { TeamReviewCandidatesPayload } from '../../shared/contracts/team-review-candidates.ts';
import { errorMessage } from '../../shared/text.ts';
import { DEFAULT_TIMER_FNS } from '../../shared/timer-deps.ts';
import { TEAM_REVIEW_RATE_LIMIT_RESOURCES } from './team-review-poller/team-review-poller-context.ts';
import type {
  DraftExpectation, DraftPatch, NotMineOutcome, ReviewOutcome, SpawnReviewArgs, TeamReviewGithub, TeamReviewPollerContext, TeamReviewPollerDependencies, TeamReviewRuntime,
} from './team-review-poller/team-review-poller-context.ts';
import { createTeamReviewStatusReporter } from './team-review-poller/team-review-status-reporter.ts';
import { createTeamReviewCandidateSearch } from './team-review-poller/team-review-candidate-search.ts';
import { createTeamReviewHeadPlanning } from './team-review-poller/team-review-head-planning.ts';
import { createTeamReviewAnsweredThreads } from './team-review-poller/team-review-answered-threads.ts';
import { createTeamReviewRuns } from './team-review-poller/team-review-runs.ts';
import { createTeamReviewOperatorActions } from './team-review-poller/team-review-operator-actions.ts';
import { clock as timeClock } from '../../shared/clock.ts';

function createTeamReviewPoller(deps: TeamReviewPollerDependencies) {
  const {
    org, teams, github, store, spawnReview, discardResumable = async () => {},
    readState = async () => ({}), writeState = async () => {}, beforeStart = async () => {},
    setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn, clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
    setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn, clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
    log = console, telemetry = null, onTickComplete = () => {}, now = () => timeClock.nowMs(),
  } = deps;
  const maxConcurrentReviews = deps.maxConcurrentReviews ?? core.MAX_CONCURRENT_REVIEWS;
  const reReviewAfterMs = deps.reReviewAfterMs ?? core.DEFAULT_RE_REVIEW_AFTER_HOURS * 60 * 60 * 1000;
  const skipIdleAfterMs = deps.skipIdleAfterMs ?? core.DEFAULT_SKIP_IDLE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const runtime: TeamReviewRuntime = {
    state: {},
    self: null,
    teamProfile: null,
    waitingForSlot: [],
    pollingError: null,
    tickRateLimitWaitMs: null,
    teamCandidateKeys: new Set<string>(),
    hasLoadedState: false,
    hasSlotFreedSinceSlotCount: false,
  };
  const progressByKey = new Map<string, InFlightReview>();
  const reviewCancellersByKey = new Map<string, AbortController>();
  const notMineWhileReviewingKeys = new Set<string>();
  const watches = new Map<string, { qualifiers: string; source: 'direct' | 'team' | 'authored' }>();
  let lastRebuildQueueSignature: string | null = null;

  const loop = createTickLoop({
    tag: core.TEAM_REVIEW_LANE_ID, intervalMs: (deps.intervalMinutes ?? core.POLL_INTERVAL_MINUTES) * 60000,
    tick: async () => {
      try {
        return await runTick();
      } catch (error: unknown) {
        runtime.pollingError = errorMessage(error);
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] poll failed: ${runtime.pollingError}`);
        return rateLimitedOutcome();
      }
    },
    quickRetries: true, now, setTimeoutFn, clearTimeoutFn, onScheduleChange: () => { emitStatus(); },
    rateLimitWaitMs: () => store.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES),
    writeState: () => writeState(runtime.state), setIntervalFn, clearIntervalFn, clock: storeReadingLaneClock(deps.clock), firstTickDelayMs: deps.firstTickDelayMs, backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, log,
  });
  const persist = () => loop.persist();

  const context: TeamReviewPollerContext = {
    deps, org, teams, github, store, spawnReview, discardResumable, log, telemetry, onTickComplete, now, setTimeoutFn, clearTimeoutFn,
    maxConcurrentReviews, reReviewAfterMs, skipIdleAfterMs,
    runtime, progressByKey, reviewCancellersByKey, notMineWhileReviewingKeys, watches, loop, persist,
  };
  const statusReporter = createTeamReviewStatusReporter(context);
  const candidateSearch = createTeamReviewCandidateSearch(context);
  const headPlanning = createTeamReviewHeadPlanning(context);
  const { handleAnsweredThreads, refreshThreads: refreshThreadItems } = createTeamReviewAnsweredThreads(context, statusReporter);
  const reviewRuns = createTeamReviewRuns(context, statusReporter, headPlanning, candidateSearch);
  const { getDraft, updateDraft, updateThread, requeue, restore, requestReview, markNotMine } = createTeamReviewOperatorActions(context, statusReporter, headPlanning, candidateSearch, reviewRuns);
  const { inFlightKeys, cancelPendingProgressEmit, emitStatus } = statusReporter;
  const { closedEntryKeys, pruneDeparted, searchCandidates, searchResultFromSnapshot, candidatesFrom, watchAskedFor, unregisterWatches } = candidateSearch;
  const { headsToReview } = headPlanning;
  const { startReviews } = reviewRuns;

  function rebuild(): void {
    if (!runtime.hasLoadedState || loop.isStopped() || runtime.self === null) return;
    const { candidates, prsByKey } = candidatesFrom(searchResultFromSnapshot(runtime.self));
    const planned = headsToReview(candidates, prsByKey);
    if (planned.isDirty) loop.track(persist());
    emitStatus();
    if (closedEntryKeys().size > 0) {
      loop.tickSoon();
      return;
    }
    if (planned.queue.length === 0 || !canStartReview()) return;
    const queueSignature = queuedHeadsSignature(planned.queue, prsByKey);
    if (queueSignature === lastRebuildQueueSignature) return;
    lastRebuildQueueSignature = queueSignature;
    loop.tickSoon();
  }

  function canStartReview(): boolean {
    return inFlightKeys().length < maxConcurrentReviews;
  }

  function queuedHeadsSignature(queue: readonly TeamReviewCandidate[], prsByKey: ReadonlyMap<string, GithubPr>): string {
    return JSON.stringify(queue.map((candidate) => [candidate.key, prsByKey.get(comparablePrKey(candidate))?.headRefOid ?? null]));
  }

  function refusedOutcome(retryAfterMs: number): TickOutcome {
    runtime.pollingError = refusingReadsText(now() + retryAfterMs);
    return { failed: true, retryAfterMs, error: runtime.pollingError };
  }

  async function rateLimitedOutcome(): Promise<TickOutcome> {
    const rateLimitWaitMs = await store.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES) ?? secondaryRateLimitWaitMs(runtime.pollingError);
    if (rateLimitWaitMs !== null) return refusedOutcome(rateLimitWaitMs);
    if (isRateLimitText(runtime.pollingError)) runtime.pollingError = refusingReadsText(null);
    return { failed: true, error: runtime.pollingError ?? undefined };
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    runtime.pollingError = null;
    runtime.tickRateLimitWaitMs = null;
    const searched = await searchCandidates().catch((error: unknown) => {
      runtime.pollingError = errorMessage(error);
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] candidate search failed: ${runtime.pollingError}`);
      return null;
    });
    if (runtime.tickRateLimitWaitMs !== null) return refusedOutcome(runtime.tickRateLimitWaitMs);
    if (searched === null) {
      runtime.pollingError ??= 'Could not look up your GitHub account or team members.';
      return rateLimitedOutcome();
    }
    const storeError = store.getSnapshot().freshness.error;
    if (storeError) {
      runtime.pollingError = storeError;
      return rateLimitedOutcome();
    }
    return acceptCandidates(searched);
  }

  async function acceptCandidates(searched: TeamReviewCandidatesPayload): Promise<TickOutcome | undefined> {
    runtime.self = searched.viewer;
    const { candidates, prsByKey, isComplete } = candidatesFrom(searched);
    const rateLimitWaitMs = isComplete ? null : await store.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES);
    if (rateLimitWaitMs !== null) return refusedOutcome(rateLimitWaitMs);
    const isPruned = await pruneDeparted(new Set(candidates.map((candidate) => candidate.key)), isComplete);
    if (isPruned) watchAskedFor();
    const planned = headsToReview(candidates, prsByKey);
    const isStarted = await startReviews(planned.queue);
    const areThreadsChanged = runtime.tickRateLimitWaitMs === null ? await handleAnsweredThreads(candidates) : false;
    if (isPruned || planned.isDirty || areThreadsChanged || isStarted) await persist();
    if (runtime.tickRateLimitWaitMs !== null) return refusedOutcome(runtime.tickRateLimitWaitMs);
    if (runtime.hasSlotFreedSinceSlotCount && runtime.waitingForSlot.length > 0 && !loop.isStopped()) {
      setTimeoutFn(() => { void loop.tick(); }, 0);
    }
    return undefined;
  }

  async function start(): Promise<void> {
    await loop.start(async () => {
      runtime.state = (await readState()) || {};
      for (const entry of Object.values(runtime.state)) entry.inFlight = false;
      progressByKey.clear();
      emitStatus();
      const keepPaths = new Set<string>();
      for (const entry of Object.values(runtime.state)) {
        if (!entry.resumable) continue;
        keepPaths.add(entry.resumable.workDir);
        keepPaths.add(entry.resumable.worktreePath);
      }
      await beforeStart(keepPaths);
      runtime.hasLoadedState = true;
      watchAskedFor();
    });
  }

  async function refresh() {
    if (loop.isStopped()) return { ok: false, error: 'Reviews polling is stopped.' };
    if (watches.size === 0) await searchCandidates();
    return loop.refresh(async () => {
      const refreshed = await store.refreshWatches([...watches.keys()]);
      rebuild();
      return refreshed;
    });
  }

  async function refreshThreads(key: string): Promise<void> {
    if (!runtime.hasLoadedState) return;
    const isChanged = await refreshThreadItems(key).catch((error: unknown) => {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] thread refresh for ${key} failed: ${errorMessage(error)}`);
      return false;
    });
    if (!isChanged) return;
    await persist();
    emitStatus();
  }

  async function stop(): Promise<void> {
    runtime.hasLoadedState = false;
    unregisterWatches();
    cancelPendingProgressEmit();
    await loop.stop();
    cancelPendingProgressEmit();
  }

  return { start, stop, tick: loop.tick, refresh, refreshThreads, rebuild, getDraft, updateDraft, updateThread, requeue, restore, requestReview, markNotMine, _state: () => runtime.state };
}

type TeamReviewPoller = ReturnType<typeof createTeamReviewPoller>;

export { createTeamReviewPoller };
export type { DraftExpectation, DraftPatch, NotMineOutcome, ReviewOutcome, SpawnReviewArgs, TeamReviewGithub, TeamReviewPoller };
