import * as core from './core/workflows-core.ts';
import type { PlannedWorkflowAction } from './core/workflows-core.ts';
import { mergedSinceDate } from './core/my-prs-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from './core/lane-backoff.ts';
import { firstLine } from './ephemeral-session.ts';
import { createTickLoop } from './lane-runner.ts';
import type { LaneStatusRecord, SharedClock } from './lane-runner.ts';
import type { PrGh } from './pr-gh.ts';
import { WorkflowsState } from '../shared/contracts/workflows.ts';
import type { WorkflowRule, WorkflowsState as WorkflowsStateType } from '../shared/contracts/workflows.ts';

const WORKFLOWS_RATE_LIMIT_RESOURCES = ['graphql'] as const;

type SpawnPlannedAction = PlannedWorkflowAction & { action: { type: 'spawn'; promptTemplate: string } };
type SpawnSession = (planned: SpawnPlannedAction, signal: AbortSignal) => Promise<void>;

export function createWorkflowSessionQueue({ spawnSession, log = console, maxConcurrentSessions = () => core.DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS, isSpawnStillAllowed = () => true }: {
  spawnSession: SpawnSession; log?: Pick<Console, 'warn'>; maxConcurrentSessions?: () => number; isSpawnStillAllowed?: (planned: SpawnPlannedAction) => boolean;
}) {
  const pendingSessions = new Set<Promise<void>>();
  const deferredSpawnsByKey = new Map<string, SpawnPlannedAction>();
  const shutdownController = new AbortController();

  function launchSession(planned: SpawnPlannedAction): void {
    const pending = spawnSession(planned, shutdownController.signal)
      .catch((error: unknown) => log.warn(`[${core.WORKFLOWS_LANE_ID}] ${planned.rule.id} session failed: ${firstLine(error instanceof Error ? error.message : String(error))}`))
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

  return { enqueue, stop };
}

interface WorkflowsPollerDependencies {
  rules: readonly WorkflowRule[];
  teamName: string | null;
  maxActionsPerPoll?: number;
  github: Pick<PrGh, 'viewer' | 'searchRepoPrs' | 'addPrLabel' | 'commentOnPr' | 'rateLimitWaitMs'>;
  readState: () => Promise<WorkflowsStateType | null>;
  writeState: (state: WorkflowsStateType) => Promise<void>;
  notify: (notification: { sessionName: string; message: string }) => void;
  startSession: (planned: SpawnPlannedAction) => void;
  onTickComplete: (status: LaneStatusRecord) => void;
  now?: () => number;
  intervalMinutes?: number;
  setIntervalFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  setTimeoutFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  beforeStart?: () => Promise<void>;
  log?: Pick<Console, 'warn'>;
}

export function createWorkflowsPoller(dependencies: WorkflowsPollerDependencies) {
  const { rules, teamName, maxActionsPerPoll = core.DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL, github, notify, startSession, onTickComplete, now = Date.now, intervalMinutes = core.WORKFLOWS_POLL_INTERVAL_MINUTES, log = console } = dependencies;
  let snapshot: WorkflowsStateType = core.emptyWorkflowsState();
  let stateLoad: Promise<void> | null = null;
  let viewer: string | null = null;
  let hasLookedUpViewer = false;
  let pollingError: string | null = null;
  const isViewerNeeded = rules.some((rule) => rule.enabled && rule.filters.mine === true);

  function loadState(): Promise<void> {
    stateLoad ??= dependencies.readState().then((state) => { snapshot = state ?? core.emptyWorkflowsState(); });
    return stateLoad;
  }

  function publishStatus(): void {
    onTickComplete({ type: 'workflows-status', ts: now(), configured: true, error: pollingError, ...loop.scheduleStatus() });
  }

  const loop = createTickLoop({
    tag: core.WORKFLOWS_LANE_ID, intervalMs: intervalMinutes * 60000, now, log, clock: dependencies.clock, firstTickDelayMs: dependencies.firstTickDelayMs,
    setIntervalFn: dependencies.setIntervalFn, clearIntervalFn: dependencies.clearIntervalFn, setTimeoutFn: dependencies.setTimeoutFn, clearTimeoutFn: dependencies.clearTimeoutFn,
    rateLimitWaitMs: () => github.rateLimitWaitMs(now(), WORKFLOWS_RATE_LIMIT_RESOURCES),
    onScheduleChange: publishStatus,
    backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS,
    tick: async () => {
      try {
        return await runTick();
      } catch (error: unknown) {
        pollingError = error instanceof Error ? error.message : String(error);
        return failedOutcome(pollingError);
      }
    },
  });

  async function failedOutcome(errorText: string) {
    const rateLimitWaitMs = await github.rateLimitWaitMs(now(), WORKFLOWS_RATE_LIMIT_RESOURCES) ?? secondaryRateLimitWaitMs(errorText);
    return rateLimitWaitMs === null ? { failed: true } : { failed: true, retryAfterMs: rateLimitWaitMs };
  }

  async function lookUpViewer(): Promise<boolean> {
    if (!isViewerNeeded || hasLookedUpViewer) return true;
    viewer = await github.viewer();
    hasLookedUpViewer = viewer !== null;
    return hasLookedUpViewer;
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
    if (loop.isStopped()) return { failed: false };
    if (!await lookUpViewer()) {
      pollingError = 'Could not look up your GitHub account.';
      return failedOutcome(pollingError);
    }
    if (loop.isStopped()) return { failed: false };
    const polledAtMs = now();
    const mergedSince = mergedSinceDate(polledAtMs);
    const nextRepos: WorkflowsStateType['repos'] = {};
    const searchErrors: string[] = [];
    const watchedRepos = core.watchedWorkflowRepos(rules);
    for (const repo of watchedRepos) {
      const repoKey = core.workflowRepoKey(repo);
      const previousRepo = snapshot.repos[repoKey];
      const search = await github.searchRepoPrs(repo, mergedSince);
      if (loop.isStopped()) return { failed: false };
      if (!search.ok) {
        searchErrors.push(`${repo}: ${search.error}`);
        if (previousRepo) nextRepos[repoKey] = previousRepo;
        continue;
      }
      nextRepos[repoKey] = core.nextRepoSnapshot(previousRepo, search.items.map(core.toWorkflowPr), search.isComplete, polledAtMs);
    }
    const events = core.diffPrEvents(snapshot.repos, nextRepos);
    const { planned, droppedCount, refusedSpawnCount } = core.matchRules(events, rules, { viewer, teamName }, maxActionsPerPoll);
    if (droppedCount > 0) log.warn(`[${core.WORKFLOWS_LANE_ID}] ${droppedCount} actions over the cap of ${maxActionsPerPoll} per poll were not run`);
    if (refusedSpawnCount > 0) log.warn(`[${core.WORKFLOWS_LANE_ID}] ${refusedSpawnCount} spawn actions on pull requests from forks were refused because their rule does not restrict authors or set mine`);
    let reposToSave = nextRepos;
    for (const plannedAction of planned) {
      const hasPostedOwnComment = await runActionAndReportOwnComment(plannedAction);
      if (hasPostedOwnComment) reposToSave = core.withOwnPostedComment(reposToSave, plannedAction.event.pr);
    }
    snapshot = WorkflowsState.parse({ repos: reposToSave });
    await dependencies.writeState(snapshot);
    pollingError = searchErrors.length > 0 ? searchErrors.join('; ') : null;
    if (watchedRepos.length > 0 && searchErrors.length === watchedRepos.length) return failedOutcome(pollingError ?? '');
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
  };
}

export type WorkflowsPoller = ReturnType<typeof createWorkflowsPoller>;
export type { SpawnPlannedAction, SpawnSession, WorkflowsPollerDependencies };
