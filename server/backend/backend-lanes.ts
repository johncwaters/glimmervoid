import { createIssuesWiring } from '../github/issues-wiring.ts';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { HookRouter } from '../../detection/hook-source.ts';
import type { Session } from '../../session/sessions.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { comparableDirectoryPath } from '../../shared/canonical-paths.ts';
import { sanitizeWorktreeName } from '../../shared/paths.ts';
import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import { createBenchmarkWiring } from '../benchmark-wiring.ts';
import { STATES } from '../../shared/states.ts';
import { createCoderActivityWiring } from '../coder-activity-wiring.ts';
import { createCoderEnvWiring } from '../coder/coder-env-wiring.ts';
import { resolveCoderEnvironment } from '../coder/core/coder-env-core.ts';
import { persistSessionField } from '../session/session-event-wiring.ts';
import { createBranchGcWiring } from '../branch-gc-wiring.ts';
import type { createClaudeCredentials } from '../claude-credentials.ts';
import { DEFAULT_CONFIG, glimmervoidHomeDir } from '../config-store.ts';
import type { ConfigStore, GlimmervoidConfig } from '../config-store.ts';
import { configSiblingPath } from '../pairings-store.ts';
import fs from 'node:fs';
import { jsonStateLoadError, loadJsonStateFileSync, writeJsonAtomic } from '../json-file.ts';
import { CoderOwnedWorkspaces } from '../../shared/contracts/coder-owned-workspaces.ts';
import { createGitWorkspace, createGitWorkspaceSync } from '../git/git-workspace.ts';
import { createOwnedPathsLedger } from '../owned-paths-ledger.ts';
import { TASK_TITLE_LANE_TOOLS, createTaskTitleRefiner } from '../task-title-refiner.ts';
import { createLaneSpawn } from '../lanes/lane-spawn.ts';
import { createPlanReviewWiring } from '../plan-review-wiring.ts';
import { createRadarWiring } from '../radar/radar-wiring.ts';
import { createCommunityWiring } from '../community/community-wiring.ts';
import { createMemoryAdmission, createSpawnGate } from '../spawn-gate.ts';
import { readMemoryHeadroom } from '../memory-probe.ts';
import { memoryReserveBytes } from '../core/memory-admission-core.ts';
import type { Telemetry } from '../telemetry.ts';
import { createTeamReviewSpawn, createTeamReviewWiring, sweepLeftoverCheckouts } from '../github/team-review-wiring.ts';
import { createPrGh } from '../github/pr-gh.ts';
import { createRepoCache } from '../git/repo-cache.ts';
import { commandFor } from '../../session/adapters/index.ts';
import { createMyPrMergeabilityFix, createMyPrsWiring, createGuardedPrStaging, sweepKeepMergeableLeftovers } from '../github/my-prs-wiring.ts';
import { keepMergeableTimeoutSeconds } from '../github/core/my-prs-core.ts';
import { createSessionPrLinkWiring } from '../github/session-pr-link-wiring.ts';
import { createFeatureHintsWiring } from '../feature-hints-wiring.ts';
import { createWorkflowSpawn, createWorkflowsWiring } from '../workflows-wiring.ts';
import { createGithubClock } from '../github/github-clock.ts';
import { createGithubStatus } from '../github/github-status.ts';
import { createGithubStoreWiring } from '../github/github-store-wiring.ts';
import { GITHUB_CLOCK_INTERVAL_MINUTES } from '../github/core/github-clock-core.ts';
import { createUsageWiring, resolveUsageConfig } from '../usage/usage-wiring.ts';
import { createLaneLedger } from '../usage/usage-lane-ledger.ts';
import { createTraceWiring } from '../trace-wiring.ts';
import { createTraceChangeBroadcast } from '../trace-control.ts';
import { createUploadsWiring } from '../uploads-wiring.ts';
import { errorMessage } from '../../shared/text.ts';

interface BackendLaneOptions {
  branchGcWiringOptions?: Record<string, unknown>;
  usageWiringOptions?: Record<string, unknown>;
}

interface BackendLaneDependencies {
  config: GlimmervoidConfig;
  claudeCredentials: ReturnType<typeof createClaudeCredentials>;
  configStore: ConfigStore;
  sessions: Map<string, Session>;
  agentSessions: Map<string, Session>;
  reviewSessions: Map<string, Session>;
  investigationSessions: Map<string, Session>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: HookRouter;
  getHookPort: () => number | null;
  broadcastControl: ControlBroadcast;
  controlWss: {
    clients: Set<WebSocket>;
    on(event: 'connection', listener: (socket: WebSocket) => void): unknown;
  };
  options: BackendLaneOptions;
  notificationManager: { trigger(sessionName: string, category: string, message: string): unknown };
  telemetry: Telemetry;
  logger: Console;
  renameSessionFromTaskTitle?: (session: Session, proposedName: string) => void;
}

function createBackendLanes(dependencies: BackendLaneDependencies) {
  const {
    claudeCredentials,
    config,
    configStore,
    sessions,
    agentSessions,
    reviewSessions,
    investigationSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    broadcastControl,
    controlWss,
    options,
    notificationManager,
    telemetry,
    logger,
  } = dependencies;
  const memoryAdmission = createMemoryAdmission({
    readHeadroom: () => readMemoryHeadroom(),
    reserveBytesFor: (kind) => memoryReserveBytes(configStore.config, kind),
    warn: (message) => logger.warn(message),
  });
  const spawnGate = createSpawnGate({ memoryAdmission });
  const ownedPaths = createOwnedPathsLedger({ filePath: configSiblingPath(configStore.configPath, 'owned-paths.json'), log: logger });
  const protectedSessionIds = (): ReadonlySet<string> => new Set([
    ...config.projects.map((project) => project.id),
    ...allLiveSessions().map((session) => session.id),
  ].flatMap((sessionId) => [sessionId, sanitizeWorktreeName(sessionId)]));
  const gitWorkspace = createGitWorkspace({ rerere: config.worktreeRerere !== false, ownedPaths, removalGuard: { protectedSessionIds }, log: logger });
  const gitWorkspaceSync = createGitWorkspaceSync({ ownedPaths, removalGuard: { protectedSessionIds }, log: logger });
  const laneLedger = createLaneLedger({
    ledgerPath: configSiblingPath(configStore.configPath, 'usage-lanes.json'),
    retainDays: resolveUsageConfig(config.usage).warehouseRetainDays,
    logger,
  });
  void laneLedger.load();
  const recordLane = laneLedger.record;
  const liveSessionMaps = (): Map<string, Session>[] => [
    sessions, agentSessions, reviewSessions, investigationSessions, taskTitleSessions, benchmarkSessions,
  ];
  const allLiveSessions = (): Session[] => liveSessionMaps().flatMap((sessionsById) => [...sessionsById.values()]);
  const findLiveSession = (id: string): Session | null => {
    for (const sessionsById of liveSessionMaps()) {
      const session = sessionsById.get(id);
      if (session) return session;
    }
    return null;
  };
  const branchGc = createBranchGcWiring({
    config,
    gitWorkspace,
    liveSessionIds: () => new Set(allLiveSessions().map((session) => session.id)),
    liveWorktreePaths: async () => new Set(await Promise.all(allLiveSessions()
      .flatMap((session) => [session.worktreeDir, session.path])
      .filter((sessionDirectory): sessionDirectory is string => Boolean(sessionDirectory))
      .map((sessionDirectory) => comparableDirectoryPath(sessionDirectory)))),
    ...(options.branchGcWiringOptions || {}),
  });
  const coderActivity = createCoderActivityWiring({
    config,
    countRunningSessions: () => allLiveSessions().filter((session) => session.state === STATES.RUNNING).length,
    log: logger,
  });
  const laneTelemetry: Pick<Telemetry, 'capture'> = telemetry;
  const coderOwnedWorkspacesPath = path.join(glimmervoidHomeDir(), 'coder-owned-workspaces.json');
  const coderEnv = createCoderEnvWiring({
    config,
    loadOwnedWorkspaces: () => {
      const outcome = loadJsonStateFileSync({
        filePath: coderOwnedWorkspacesPath,
        fsSync: fs,
        parse: (raw) => CoderOwnedWorkspaces.safeParse(raw).data?.workspaces ?? null,
        quarantine: false,
        includeNotDir: false,
      });
      if (outcome.status === 'loaded') return outcome.value;
      if (outcome.status === 'missing') return [];
      logger.warn(`[coder-env] ignoring ${coderOwnedWorkspacesPath}: ${errorMessage(jsonStateLoadError(outcome))}`);
      return [];
    },
    saveOwnedWorkspaces: (workspaces) => writeJsonAtomic(coderOwnedWorkspacesPath, { version: 1, workspaces } satisfies CoderOwnedWorkspaces, { mode: 0o600, mkdir: true }),
    persistMapping: (projectId, mapping) => persistSessionField(configStore, config, projectId, 'environment', mapping),
    sessionsForIdleCheck: () => {
      const environmentsByName = new Map((config.coder?.environments ?? []).map((environment) => [environment.name, resolveCoderEnvironment(environment)]));
      return config.projects.flatMap((project) => {
        if (!project.environment) return [];
        const session = sessions.get(project.id);
        const environment = environmentsByName.get(project.environment.name);
        if (!session || !environment) return [];
        return [{
          projectId: project.id,
          workspace: project.environment.workspace,
          state: session.state,
          idleSinceMs: session.stateSince,
          idleStopMinutes: environment.idleStopMinutes,
        }];
      });
    },
    log: logger,
  });
  const posthog = createRadarWiring({
    config,
    investigationSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    spawnGate,
    recordLane,
    gitWorkspace,
    broadcast: broadcastControl,
    telemetry: laneTelemetry,
  });
  const community = createCommunityWiring({
    config, broadcast: broadcastControl, homeDir: glimmervoidHomeDir(), log: logger,
    controlClientCount: () => controlWss.clients.size,
    spawnDependencies: { investigationSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane, replayBufferKB: config.replayBufferKB },
  });
  const githubStatus = createGithubStatus({ log: logger });
  const githubClock = createGithubClock({ baseIntervalMs: GITHUB_CLOCK_INTERVAL_MINUTES * 60000, log: logger, githubStatus });
  const glimmervoidHome = glimmervoidHomeDir();
  const github = createPrGh(glimmervoidHome);
  const githubStore = createGithubStoreWiring({
    github,
    clock: githubClock,
    isDashboardConnected: () => [...controlWss.clients].some((client) => client.readyState === 1),
    broadcast: broadcastControl,
    log: logger,
  });
  const sharedRepoCacheRoot = path.join(glimmervoidHome, 'team-review-repos');
  const sharedRepoCache = createRepoCache({ rootDir: sharedRepoCacheRoot });
  const teamReview = createTeamReviewWiring({
    config, store: githubStore.laneStore,
    github,
    requestPrRefresh: githubStore.laneStore.requestRefresh,
    reviewSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    spawnGate,
    recordLane,
    gitWorkspace,
    broadcast: broadcastControl,
    log: logger,
    clock: githubClock,
    repoCacheRoot: sharedRepoCacheRoot,
    repoCache: sharedRepoCache,
    telemetry: laneTelemetry,
  });
  const sessionPrLink = createSessionPrLinkWiring({ store: githubStore.laneStore, git: gitWorkspace, log: logger });
  const featureHints = createFeatureHintsWiring({ statePath: configSiblingPath(configStore.configPath, 'feature-hints.json'), broadcast: broadcastControl, log: logger, currentConfig: () => configStore.config });
  const myPrsWorkRoot = path.join(glimmervoidHome, 'my-prs-work');
  const myPrs = createMyPrsWiring({
    config, github, store: githubStore.laneStore, log: logger, clock: githubClock,
    broadcast: broadcastControl,
    sweepLeftovers: () => sweepKeepMergeableLeftovers({ workRoot: myPrsWorkRoot, repoCache: sharedRepoCache, gitWorkspace, log: logger }),
    fixMergeability: createMyPrMergeabilityFix({
      requestPrRefresh: githubStore.laneStore.requestRefresh,
      workRoot: myPrsWorkRoot,
      timeoutSeconds: () => keepMergeableTimeoutSeconds(config),
      repoCache: sharedRepoCache,
      log: logger,
      spawnSession: createTeamReviewSpawn({
        reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
        replayBufferKB: config.replayBufferKB, laneName: 'my-prs', hookToolConfig: config,
      }),
    }),
  });
  const issues = createIssuesWiring({ config, store: githubStore.laneStore, github, gitWorkspace, broadcast: broadcastControl, hasSession: (id) => sessions.has(id), log: logger, clock: githubClock });
  const workflowsWorkRoot = path.join(glimmervoidHome, 'workflows-work');
  const workflows = createWorkflowsWiring({
    config, notificationManager, store: githubStore.laneStore, log: logger, clock: githubClock,
    github: {
      ...github,
      addPrLabel: async (action) => {
        const applied = await github.addPrLabel(action);
        if (applied.ok) githubStore.laneStore.requestRefresh(comparablePrKey(action));
        return applied;
      },
    },
    sweepLeftovers: () => sweepLeftoverCheckouts({ worktreeRoot: workflowsWorkRoot, workRoot: workflowsWorkRoot, keepPaths: new Set(), repoCache: sharedRepoCache, gitWorkspace, log: logger }),
    spawnSession: createWorkflowSpawn({
      workRoot: workflowsWorkRoot,
      log: logger,
      staging: createGuardedPrStaging({
        repoCache: sharedRepoCache,
        spawnSession: createTeamReviewSpawn({
          reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
          replayBufferKB: config.replayBufferKB, laneName: 'workflows', hookToolConfig: config,
        }),
      }),
    }),
  });
  const benchmarkSessions = new Map<string, Session>();
  const claudeCommand = () => commandFor('claude-code').path;
  const benchmarks = createBenchmarkWiring({
    benchmarksRoot: path.join(glimmervoidHome, 'benchmarks'),
    runsRoot: path.join(glimmervoidHome, 'benchmark-runs'),
    isEnabled: () => configStore.config.benchmarks?.enabled === true,
    broadcast: broadcastControl,
    store: githubStore.laneStore,
    repoCache: sharedRepoCache,
    gitWorkspace,
    spawnSubject: createTeamReviewSpawn({
      reviewSessions: benchmarkSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
      replayBufferKB: config.replayBufferKB, laneName: 'benchmark', hookToolConfig: config,
    }),
    spawnJudge: createLaneSpawn({
      sessions: benchmarkSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
      replayBufferKB: config.replayBufferKB, laneName: 'benchmark', getSaneYoloUnreadablePaths: () => configStore.config.saneYoloUnreadablePaths ?? [],
    }),
    credentials: claudeCredentials,
    claudeCommand,
    log: logger,
  });

  const isTraceEnabled = config.trace?.enabled ?? DEFAULT_CONFIG.trace.enabled;
  const traceWiring = isTraceEnabled
    ? createTraceWiring({
      configPath: configStore.configPath,
      logger,
      debug: () => configStore.getSettings().debugMode === true,
    })
    : null;
  const uploadsWiring = createUploadsWiring({
    configPath: configStore.configPath,
    liveSessionIds: () => new Set(allLiveSessions().map((session) => session.id)),
  });
  const traceChangeBroadcast = traceWiring
    ? createTraceChangeBroadcast({ source: traceWiring, broadcast: broadcastControl })
    : null;
  const isPlanReviewEnabled = config.planReview?.enabled ?? DEFAULT_CONFIG.planReview.enabled;
  const planReview = isPlanReviewEnabled
    ? createPlanReviewWiring({
      configPath: configStore.configPath,
      logger,
    })
    : null;
  planReview?.on('plan-changed', (summary: Record<string, unknown>) => {
    broadcastControl({ type: 'session-plan-changed', ...summary });
  });
  planReview?.on('plan-draft', (notice: Record<string, unknown>) => {
    broadcastControl({ type: 'session-plan-draft', ...notice });
  });
  const taskTitleSessions = new Map<string, Session>();
  const taskTitleRefiner = createTaskTitleRefiner({
    getConfig: () => configStore.config,
    logger,
    renameSession: dependencies.renameSessionFromTaskTitle,
    spawnLane: createLaneSpawn({
      sessions: taskTitleSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
      replayBufferKB: config.replayBufferKB, laneName: 'task-title', allowTools: TASK_TITLE_LANE_TOOLS, getSaneYoloUnreadablePaths: () => configStore.config.saneYoloUnreadablePaths ?? [],
    }),
  });

  const usage = createUsageWiring({
    config,
    sessions,
    broadcast: broadcastControl,
    controlClientCount: () => controlWss.clients.size,
    warehousePath: configSiblingPath(configStore.configPath, 'usage-warehouse.json'),
    laneMap: () => laneLedger.laneMap(),
    telemetry,
    budgetStatePath: configSiblingPath(configStore.configPath, 'usage-budget-state.json'),
    logger,
    debug: () => configStore.getSettings().debugMode === true,
    ...(options.usageWiringOptions || {}),
  });
  controlWss.on('connection', () => {
    void usage.start();
  });
  const fixedLaneEntries = {
    'branch-gc': branchGc,
    posthog,
    community,
    'team-review': teamReview,
    'my-prs': myPrs,
    issues,
    workflows,
    usage,
    'task-title': taskTitleRefiner,
    trace: traceWiring,
    'plan-review': planReview,
  };
  const fixedLanes = new Map<string, unknown>(Object.entries(fixedLaneEntries));
  type LaneMap = typeof fixedLaneEntries;

  function current<K extends keyof LaneMap>(name: K): LaneMap[K];
  function current(name: string): unknown {
    return fixedLanes.get(name) || null;
  }

  function startRuntimeLanes(): void {
    const startSteps = [
      () => branchGc.start(),
      () => coderActivity.start(),
      () => coderEnv.start(),
      () => posthog.startPoller(),
      () => community.startPoller(),
      () => teamReview.startPoller(),
      () => myPrs.startPoller(),
      () => issues.startPoller(),
      () => workflows.startPoller(),
      () => void benchmarks.sweepLeftovers().then(() => { void benchmarks.refreshStatus(); }),
      () => traceWiring?.start().catch((error: unknown) => logger.warn(`[trace] start failed: ${errorMessage(error)}`)),
      () => uploadsWiring.start().catch((error: unknown) => logger.warn(`[uploads] start failed: ${errorMessage(error)}`)),
      () => planReview?.start().catch((error: unknown) => logger.warn(`[plan-review] start failed: ${errorMessage(error)}`)),
    ];
    for (const start of startSteps) start();
  }

  function restartServiceLanes(): void {
    const restartSteps = [
      () => branchGc.restartIfConfigChanged(),
      () => coderActivity.restartIfConfigChanged(),
      () => coderEnv.restartIfConfigChanged(),
      () => posthog.restartIfConfigChanged(),
      () => community.restartIfConfigChanged(),
      () => teamReview.restartIfConfigChanged(),
      () => myPrs.restartIfConfigChanged(),
      () => issues.restartIfConfigChanged(),
      () => workflows.restartIfConfigChanged(),
      () => usage.restartIfConfigChanged(),
      () => void benchmarks.refreshStatus(),
    ];
    for (const restart of restartSteps) restart();
  }

  return {
    allLiveSessions,
    findLiveSession,
    benchmarks,
    benchmarkSessions,
    branchGc,
    coderActivity,
    coderEnv,
    taskTitleRefiner,
    taskTitleSessions,
    current,
    featureHints,
    gitWorkspace,
    gitWorkspaceSync,
    ownedPaths,
    githubStore,
    investigationSessions,
    planReview,
    posthog,
    recordLane,
    restartServiceLanes,
    reviewSessions,
    spawnGate,
    memoryAdmission,
    teamReview,
    myPrs,
    issues,
    community,
    workflows,
    startRuntimeLanes,
    attachSessionPrLink: (session: Session) => sessionPrLink.attachSession(session),
    traceWiring,
    uploadsWiring,
    traceChangeBroadcast,
    usage,
  };
}

export { createBackendLanes };
export type { BackendLaneOptions };
