import * as core from './core/workflows-core.ts';
import type { PlannedWorkflowAction } from './core/workflows-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './github/core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from './lanes/core/lane-backoff.ts';
import { watcherFeedError } from './lanes/core/watchee-feed-core.ts';
import { firstLine } from './lanes/ephemeral-session.ts';
import { createTickLoop } from './lanes/lane-runner.ts';
import type { LaneStatusRecord, SharedClock } from './lanes/lane-runner.ts';
import type { PrGh } from './github/pr-gh.ts';
import type { GithubLaneStore } from './github/github-store-wiring.ts';
import { storeReadingLaneClock } from './github/github-store-wiring.ts';
import { WorkflowsState } from '../shared/contracts/workflows.ts';
import type { WorkflowRule, WorkflowsState as WorkflowsStateType } from '../shared/contracts/workflows.ts';
import type { WorkflowsCandidatesPayload } from '../shared/contracts/workflows-candidates.ts';
import { errorMessage } from '../shared/text.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../shared/timer-deps.ts';

const WORKFLOWS_RATE_LIMIT_RESOURCES = ['graphql'] as const;

type SpawnPlannedAction = PlannedWorkflowAction & { action: { type: 'spawn'; promptTemplate: string } };
type SpawnSession = (planned: SpawnPlannedAction, signal: AbortSignal) => Promise<void>;

export function createWorkflowSessionQueue({ spawnSession, log = console, maxConcurrentSessions = () => core.DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS, isSpawnStillAllowed = () => true }: {
  spawnSession: SpawnSession; log?: Pick<Console, 'warn'>; maxConcurrentSessions?: () => number; isSpawnStillAllowed?: (planned: SpawnPlannedAction) => boolean;
}) {
  const pendingSessions = new Set<Promise<void>>();
  const deferredSpawnsByKey = new Map<string, SpawnPlannedAction>();
  const shutdownController = new AbortController();
  let activeSessionsController = new AbortController();

  function launchSession(planned: SpawnPlannedAction): void {
    const pending = spawnSession(planned, AbortSignal.any([shutdownController.signal, activeSessionsController.signal]))
      .catch((error: unknown) => log.warn(`[${core.WORKFLOWS_LANE_ID}] ${planned.rule.id} session failed: ${firstLine(errorMessage(error))}`))
      .finally(() => {
        pendingSessions.delete(pending);
        startDeferredSessions();
      });
    pendingSessions.add(pending);
  }

  function startDeferredSessions(): void {
    while (!shutdownController.signal.aborted && core.hasFreeWorkflowSessionSlot(pendingSessions.size, maxConcurrentSessions())) {
      const nextDeferred = deferredSpawnsByKey.entries().next();
      if (nextDeferred.done) return;
      const [queueKey, planned] = nextDeferred.value;
      deferredSpawnsByKey.delete(queueKey);
      if (!isSpawnStillAllowed(planned)) {
        log.warn(`[${core.WORKFLOWS_LANE_ID}] ${planned.rule.id} session for ${planned.event.pr.repo}#${planned.event.pr.number} was discarded because workflows or its rule are turned off`);
        continue;
      }
      launchSession(planned);
    }
  }

  function enqueue(planned: SpawnPlannedAction): void {
    if (shutdownController.signal.aborted) return;
    const queueKey = core.workflowSpawnQueueKey(planned);
    const prLabel = `${planned.event.pr.repo}#${planned.event.pr.number}`;
    const isQueueFull = !deferredSpawnsByKey.has(queueKey) && deferredSpawnsByKey.size >= core.MAX_DEFERRED_WORKFLOW_SPAWNS;
    if (isQueueFull) {
      log.warn(`[${core.WORKFLOWS_LANE_ID}] ${planned.rule.id} session for ${prLabel} was dropped because ${core.MAX_DEFERRED_WORKFLOW_SPAWNS} workflow sessions already wait`);
      return;
    }
    deferredSpawnsByKey.set(queueKey, planned);
    const sessionLimit = maxConcurrentSessions();
    const isDeferred = deferredSpawnsByKey.size > 1 || !core.hasFreeWorkflowSessionSlot(pendingSessions.size, sessionLimit);
    if (isDeferred) log.warn(`[${core.WORKFLOWS_LANE_ID}] ${planned.rule.id} session for ${prLabel} waits for one of ${sessionLimit} running workflow sessions to finish`);
    startDeferredSessions();
  }

  async function stop(): Promise<void> {
    shutdownController.abort();
    deferredSpawnsByKey.clear();
    await Promise.allSettled([...pendingSessions]);
  }

  function cancelSessions(): void {
    deferredSpawnsByKey.clear();
    activeSessionsController.abort();
    activeSessionsController = new AbortController();
  }

  return { enqueue, stop, cancelSessions };
}

interface WorkflowsPollerDependencies {
  rules: readonly WorkflowRule[];
  areActionsEnabled?: () => boolean;
  teamName: string | null;
  maxActionsPerPoll?: number;
  github: Pick<PrGh, 'addPrLabel' | 'commentOnPr'>;
  store: Pick<GithubLaneStore, 'rateLimitWaitMs'>;
  latestLists: () => readonly WorkflowsCandidatesPayload[];
  feedSilenceMs: () => number;
  readState: () => Promise<WorkflowsStateType | null>;
  writeState: (state: WorkflowsStateType) => Promise<void>;
  notify: (notification: { sessionName: string; message: string }) => void;
  startSession: (planned: SpawnPlannedAction) => void;
  onTickComplete: (status: LaneStatusRecord) => void;
  now?: () => number;
  intervalMinutes?: number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  beforeStart?: () => Promise<void>;
  log?: Pick<Console, 'warn'>;
}

export function createWorkflowsPoller(dependencies: WorkflowsPollerDependencies) {
  const { rules, teamName, maxActionsPerPoll = core.DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL, github, store, notify, startSession, onTickComplete, now = Date.now, intervalMinutes = core.WORKFLOWS_POLL_INTERVAL_MINUTES, log = console } = dependencies;
  let snapshot: WorkflowsStateType = core.emptyWorkflowsState();
  let stateLoad: Promise<void> | null = null;
  let pollingError: string | null = null;
  const plannedLists = new WeakSet<WorkflowsCandidatesPayload>();

  function loadState(): Promise<void> {
    stateLoad ??= dependencies.readState().then((state) => { snapshot = state ?? core.emptyWorkflowsState(); });
    return stateLoad;
  }

  function publishStatus(): void {
    const { nextAttemptAt, retry, isRefreshing, refreshNotice } = loop.scheduleStatus();
    onTickComplete({ type: 'workflows-status', ts: now(), configured: true, error: pollingError, nextAttemptAt, retry, isRefreshing, refreshNotice });
  }

  const loop = createTickLoop({
    tag: core.WORKFLOWS_LANE_ID, intervalMs: intervalMinutes * 60000, now, log, clock: storeReadingLaneClock(dependencies.clock), firstTickDelayMs: dependencies.firstTickDelayMs,
    setIntervalFn: dependencies.setIntervalFn, clearIntervalFn: dependencies.clearIntervalFn, setTimeoutFn: dependencies.setTimeoutFn, clearTimeoutFn: dependencies.clearTimeoutFn,
    rateLimitWaitMs: () => store.rateLimitWaitMs(now(), WORKFLOWS_RATE_LIMIT_RESOURCES),
    onScheduleChange: publishStatus,
    backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS,
    tick: async () => {
      try {
        return await runTick();
      } catch (error: unknown) {
        pollingError = errorMessage(error);
        return failedOutcome(pollingError);
      }
    },
  });

  async function failedOutcome(errorText: string) {
    const rateLimitWaitMs = await store.rateLimitWaitMs(now(), WORKFLOWS_RATE_LIMIT_RESOURCES) ?? secondaryRateLimitWaitMs(errorText);
    return rateLimitWaitMs === null ? { failed: true } : { failed: true, retryAfterMs: rateLimitWaitMs };
  }

  async function runActionAndReportOwnComment(planned: PlannedWorkflowAction): Promise<boolean> {
    const { action, event, rule } = planned;
    const target = { repo: event.pr.repo, number: event.pr.number };
    if (action.type === 'notify') {
      notify(core.workflowNotification(planned));
      return false;
    }
    if (action.type === 'spawn') {
      startSession({ ...planned, action });
      return false;
    }
    const outcome = action.type === 'label'
      ? await github.addPrLabel({ ...target, name: action.name })
      : await github.commentOnPr({ ...target, body: action.body });
    if (!outcome.ok) log.warn(`[${core.WORKFLOWS_LANE_ID}] ${rule.id} could not ${action.type} ${event.pr.repo}#${event.pr.number}: ${firstLine(outcome.err)}`);
    return outcome.ok && action.type === 'comment';
  }

  async function runTick() {
    await loadState();
    if (loop.isStopped() || dependencies.areActionsEnabled?.() === false) return { failed: false };
    pollingError = watcherFeedError('Workflows has no pull request list', dependencies.feedSilenceMs(), intervalMinutes * 60000);
    const unplannedLists = dependencies.latestLists().filter((listed) => !plannedLists.has(listed));
    const viewer = unplannedLists[0]?.viewer;
    if (viewer === undefined) {
      publishStatus();
      return { failed: false };
    }
    const nextRepos = core.nextListedRepos(snapshot.repos, rules, unplannedLists, now());
    for (const listed of unplannedLists) plannedLists.add(listed);
    const events = core.diffPrEvents(snapshot.repos, nextRepos);
    const { planned, droppedCount, refusedSpawnCount } = core.matchRules(events, rules, { viewer, teamName }, maxActionsPerPoll);
    if (droppedCount > 0) log.warn(`[${core.WORKFLOWS_LANE_ID}] ${droppedCount} actions over the cap of ${maxActionsPerPoll} per poll were not run`);
    if (refusedSpawnCount > 0) log.warn(`[${core.WORKFLOWS_LANE_ID}] ${refusedSpawnCount} spawn actions on pull requests from forks were refused because their rule does not restrict authors or set mine`);
    let reposToSave = nextRepos;
    for (const plannedAction of planned) {
      if (dependencies.areActionsEnabled?.() === false) break;
      const hasPostedOwnComment = await runActionAndReportOwnComment(plannedAction);
      if (hasPostedOwnComment) reposToSave = core.withOwnPostedComment(reposToSave, plannedAction.event.pr);
    }
    snapshot = WorkflowsState.parse({ repos: reposToSave });
    await dependencies.writeState(snapshot);
    return { failed: false };
  }

  return {
    async start(): Promise<void> {
      await loop.start(dependencies.beforeStart ?? null);
    },
    async stop(): Promise<void> {
      await loop.stop();
    },
    tick: loop.tick,
    tickSoon: loop.tickSoon,
  };
}

export type WorkflowsPoller = ReturnType<typeof createWorkflowsPoller>;
export type { SpawnSession, WorkflowsPollerDependencies };
