import type { WebSocket } from 'ws';
import type { HookRouter } from '../detection/hook-source.ts';
import type { Session } from '../session/sessions.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { comparableDirectoryPath } from '../shared/paths.ts';
import { createBranchGcWiring } from './branch-gc-wiring.ts';
import { DEFAULT_CONFIG } from './config-store.ts';
import type { ConfigStore, GlimmervoidConfig } from './config-store.ts';
import { configSiblingPath } from './pairings-store.ts';
import { createGitWorkspace, createGitWorkspaceSync } from './git-workspace.ts';
import { createIngestLane } from './ingest-wiring.ts';
import { createChangeNarrator } from './change-narrator.ts';
import { createLaneSpawn } from './lane-spawn.ts';
import { createPlanReviewWiring } from './plan-review-wiring.ts';
import { createPosthogWiring } from './posthog-wiring.ts';
import { createSpawnGate } from './spawn-gate.ts';
import { createTeamReviewWiring } from './team-review-wiring.ts';
import { createMyPrsWiring } from './my-prs-wiring.ts';
import { createUsageWiring, resolveUsageConfig } from './usage-wiring.ts';
import { createLaneLedger } from './usage-lane-ledger.ts';
import { createTraceWiring } from './trace-wiring.ts';
import { createTraceChangeBroadcast } from './trace-control.ts';
import { createUploadsWiring } from './uploads-wiring.ts';
import { createVisionsDispatcher, createVisionsSpawn } from './visions-dispatch.ts';
import { createVisionsSetup } from './visions-setup.ts';
import { createVisionsWiring } from './visions-wiring.ts';
import { resolveIngestConfig } from './core/ingest-core.ts';
import { resolveVisionsConfig } from './core/visions-dispatch-core.ts';
import { resolveVisionsScopeProjects } from './core/visions-scope-core.ts';

interface BackendLaneOptions {
  branchGcWiringOptions?: Record<string, unknown>;
  ingestLaneOptions?: Record<string, unknown>;
  usageWiringOptions?: Record<string, unknown>;
}

interface BackendLaneDependencies {
  config: GlimmervoidConfig;
  configStore: ConfigStore;
  sessions: Map<string, Session>;
  agentSessions: Map<string, Session>;
  reviewSessions: Map<string, Session>;
  investigationSessions: Map<string, Session>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: HookRouter;
  getHookPort: () => number | null;
  broadcastControl: ControlBroadcast;
  broadcastLocalControl: ControlBroadcast;
  controlWss: {
    clients: Set<WebSocket>;
    on(event: 'connection', listener: (socket: WebSocket) => void): unknown;
  };
  options: BackendLaneOptions;
  logger: Console;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createBackendLanes(dependencies: BackendLaneDependencies) {
  const {
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
    broadcastLocalControl,
    controlWss,
    options,
    logger,
  } = dependencies;
  const spawnGate = createSpawnGate();
  const gitWorkspace = createGitWorkspace({ rerere: config.worktreeRerere !== false });
  const gitWorkspaceSync = createGitWorkspaceSync();
  const laneLedger = createLaneLedger({
    ledgerPath: configSiblingPath(configStore.configPath, 'usage-lanes.json'),
    retainDays: resolveUsageConfig(config.usage).warehouseRetainDays,
    logger,
  });
  void laneLedger.load();
  const recordLane = laneLedger.record;
  const allLiveSessions = (): Session[] => [
    ...sessions.values(),
    ...agentSessions.values(),
    ...reviewSessions.values(),
    ...investigationSessions.values(),
    ...visionsSessions.values(),
    ...changeMapSessions.values(),
  ];
  const branchGc = createBranchGcWiring({
    config,
    gitWorkspace,
    broadcast: broadcastControl,
    liveSessionIds: () => new Set(allLiveSessions().map((session) => session.id)),
    liveWorktreePaths: async () => new Set(await Promise.all(allLiveSessions()
      .flatMap((session) => [session.worktreeDir, session.path])
      .filter((sessionDirectory): sessionDirectory is string => Boolean(sessionDirectory))
      .map((sessionDirectory) => comparableDirectoryPath(sessionDirectory)))),
    ...(options.branchGcWiringOptions || {}),
  });
  const posthog = createPosthogWiring({
    config,
    investigationSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    spawnGate,
    recordLane,
    gitWorkspace,
    broadcast: broadcastControl,
  });
  const teamReview = createTeamReviewWiring({
    config,
    reviewSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    spawnGate,
    recordLane,
    gitWorkspace,
    broadcast: broadcastControl,
    log: logger,
  });
  const myPrs = createMyPrsWiring({ config, broadcast: broadcastControl, log: logger });

  let ingestConfig = resolveIngestConfig(config.ingest);
  let visionsConfig = resolveVisionsConfig(config.visions);
  const gitRepoRoots = (): string[] => {
    const directories: string[] = [];
    for (const session of sessions.values()) {
      for (const directory of [session.path, session.worktreeDir]) {
        if (typeof directory !== 'string' || !directory || directories.includes(directory)) continue;
        directories.push(directory);
      }
    }
    return directories;
  };
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
  const changeMapSessions = new Map<string, Session>();
  const changeMapNarrator = createChangeNarrator({
    getConfig: () => configStore.config,
    spawnLane: createLaneSpawn({
      sessions: changeMapSessions,
      closeSessionDataClients,
      hookRouter,
      getHookPort,
      spawnGate,
      recordLane,
      replayBufferKB: config.replayBufferKB,
      laneName: 'change-map',
    }),
  });

  let ingestLane: ReturnType<typeof createIngestLane> | null = null;
  let visionsLane: ReturnType<typeof createVisionsWiring> | null = null;
  const visionsSessions = new Map<string, Session>();

  function buildIngestLane() {
    if (!ingestConfig.enabled) return null;
    return createIngestLane({
      ...(options.ingestLaneOptions || {}),
      config: ingestConfig,
      logger,
      broadcast: broadcastLocalControl,
      laneMap: () => laneLedger.laneMap(),
      repoRoots: gitRepoRoots,
      editorRoots: () => (Array.isArray(config.projects) ? config.projects : [])
        .map((project) => project?.path)
        .filter((projectPath): projectPath is string => typeof projectPath === 'string' && projectPath !== ''),
      configPath: configStore.configPath,
      debug: () => configStore.getSettings().debugMode === true,
      onActivity: () => visionsLane?.noteActivity(),
    });
  }

  function buildVisionsLane() {
    if (!visionsConfig.enabled) return null;
    const dispatchConfig = visionsConfig.dispatch;
    return createVisionsWiring({
      logger,
      broadcast: broadcastControl,
      debug: () => configStore.getSettings().debugMode === true,
      dispatchConfig,
      autoFix: visionsConfig.autoFix,
      intentThreadTtlMs: visionsConfig.intent.threadTtlMs,
      intentStatePath: configSiblingPath(configStore.configPath, 'visions-intent.json'),
      dispatch: dispatchConfig.enabled
        ? createVisionsDispatcher({
          spawnSession: createVisionsSpawn({
            sessions: visionsSessions,
            closeSessionDataClients,
            hookRouter,
            getHookPort,
            spawnGate,
            recordLane,
            replayBufferKB: config.replayBufferKB,
          }),
          timeoutSeconds: dispatchConfig.dispatchTimeoutSeconds,
          model: dispatchConfig.model,
        })
        : null,
      contextDigest: (...args: Parameters<NonNullable<typeof ingestLane>['buildDigest']>) => ingestLane?.buildDigest(...args) ?? null,
      contextSeq: () => ingestLane?.latestSeq() ?? null,
      scopeProjects: resolveVisionsScopeProjects({
        configuredIds: visionsConfig.projects, projects: config.projects, warn: logger.warn.bind(logger),
      }),
      onEditorEvent: (event: { method?: string; uri?: string }) => ingestLane?.noteEditorEvent(event),
      knownProjectIds: (Array.isArray(config.projects) ? config.projects : [])
        .map((project) => project?.id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    });
  }

  function tapIngestForSession(session: Session): void {
    if (ingestLane?.terminalEnabled) ingestLane.attachSessionTap(session);
    if (ingestLane?.fsEnabled) ingestLane.noteSessionRoots(session);
  }

  ingestLane = buildIngestLane();
  visionsLane = buildVisionsLane();
  let laneRestart: Promise<void> = Promise.resolve();

  async function rebuildDynamicLanes(): Promise<void> {
    const stopping = [visionsLane?.stop(), ingestLane?.stop()];
    visionsLane = null;
    ingestLane = null;
    await Promise.allSettled(stopping);
    ingestLane = buildIngestLane();
    visionsLane = buildVisionsLane();
    if (ingestLane) {
      for (const session of sessions.values()) tapIngestForSession(session);
      void ingestLane.noteRepos();
    }
    logger.log(`[lanes] rebuilt: ingest ${ingestConfig.enabled ? 'on' : 'off'}, visions ${visionsConfig.enabled ? 'on' : 'off'}`);
  }

  function restartDynamicLanes(): Promise<void> {
    const previousSignature = JSON.stringify({ ingest: ingestConfig, visions: visionsConfig });
    ingestConfig = resolveIngestConfig(config.ingest);
    visionsConfig = resolveVisionsConfig(config.visions);
    const nextSignature = JSON.stringify({ ingest: ingestConfig, visions: visionsConfig });
    if (nextSignature === previousSignature) return laneRestart;
    laneRestart = laneRestart
      .then(() => rebuildDynamicLanes())
      .catch((error: unknown) => logger.warn(`[lanes] rebuild failed: ${errorMessage(error)}`));
    return laneRestart;
  }

  const visionsSetup = createVisionsSetup({
    getConfig: () => config,
    configStore,
    logger,
    debug: () => configStore.getSettings().debugMode === true,
    onConfigChanged: restartDynamicLanes,
  });
  const usage = createUsageWiring({
    config,
    sessions,
    broadcast: broadcastControl,
    controlClientCount: () => controlWss.clients.size,
    warehousePath: configSiblingPath(configStore.configPath, 'usage-warehouse.json'),
    laneMap: () => laneLedger.laneMap(),
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
    'team-review': teamReview,
    'my-prs': myPrs,
    usage,
    trace: traceWiring,
    'plan-review': planReview,
  };
  const fixedLanes = new Map<string, unknown>(Object.entries(fixedLaneEntries));
  type LaneMap = typeof fixedLaneEntries & { ingest: typeof ingestLane; visions: typeof visionsLane };

  function current<K extends keyof LaneMap>(name: K): LaneMap[K];
  function current(name: string): unknown {
    if (name === 'ingest') return ingestLane;
    if (name === 'visions') return visionsLane;
    return fixedLanes.get(name) || null;
  }

  const currentIngest = () => ingestLane;
  const currentVisions = () => visionsLane;

  function startRuntimeLanes(): void {
    const startSteps = [
      () => void visionsSetup.maybeApply(),
      () => branchGc.start(),
      () => posthog.startPoller(),
      () => teamReview.startPoller(),
      () => myPrs.startPoller(),
      () => traceWiring?.start().catch((error: unknown) => logger.warn(`[trace] start failed: ${errorMessage(error)}`)),
      () => uploadsWiring.start().catch((error: unknown) => logger.warn(`[uploads] start failed: ${errorMessage(error)}`)),
      () => planReview?.start().catch((error: unknown) => logger.warn(`[plan-review] start failed: ${errorMessage(error)}`)),
    ];
    for (const start of startSteps) start();
  }

  function restartServiceLanes(): void {
    const restartSteps = [
      () => branchGc.restartIfConfigChanged(),
      () => posthog.restartIfConfigChanged(),
      () => teamReview.restartIfConfigChanged(),
      () => myPrs.restartIfConfigChanged(),
      () => usage.restartIfConfigChanged(),
    ];
    for (const restart of restartSteps) restart();
  }

  return {
    allLiveSessions,
    branchGc,
    changeMapNarrator,
    current,
    currentIngest,
    currentVisions,
    changeMapSessions,
    gitWorkspace,
    gitWorkspaceSync,
    investigationSessions,
    planReview,
    posthog,
    recordLane,
    restartDynamicLanes,
    restartServiceLanes,
    reviewSessions,
    spawnGate,
    teamReview,
    myPrs,
    startRuntimeLanes,
    tapIngestForSession,
    traceWiring,
    uploadsWiring,
    traceChangeBroadcast,
    usage,
    visionsSessions,
    visionsSetup,
  };
}

export { createBackendLanes };
export type { BackendLaneDependencies, BackendLaneOptions };
