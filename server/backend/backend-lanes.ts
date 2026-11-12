import { createIssuesWiring } from '../github/issues-wiring.ts';
import path from 'node:path';
import { parseJsonOrNull } from '../core/json-core.ts';
import { sessionLinkedToPr } from '../github/core/team-review-core.ts';
import type { WebSocket } from 'ws';
import type { HookRouter } from '../../detection/hook-source.ts';
import type { Session } from '../../session/sessions.ts';
import type { ControlBroadcast, ControlConnectionHandler } from './backend-websockets.ts';
import { comparableDirectoryPath } from '../../shared/canonical-paths.ts';
import { sanitizeWorktreeName } from '../../shared/paths.ts';
import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import { deleteRetiredBenchmarkRuns, deleteRetiredPlans } from './retired-feature-data.ts';
import { createRaceWiring } from '../race/race-wiring.ts';
import { contestantDiff } from '../race/race-diff.ts';
import { REMOVED_CONTESTANT } from '../../shared/race-core.ts';
import { selectionArgs } from '../../shared/agent-models-core.ts';
import { absolutePathReadRule } from '../github/core/team-review-core.ts';
import { createRaceStore } from '../race/race-store.ts';
import { createReviewCaseLibrary } from '../race/review-cases.ts';
import { checkOutcomeOf, raceIdsOf } from '../race/core/race-core.ts';
import { runCommandSafely } from '../child-process-safe.ts';
import { buildAllowlistedChildEnv } from '../git/core/git-invocation-core.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import { STATES } from '../../shared/states.ts';
import { createCoderActivityWiring } from '../coder-activity-wiring.ts';
import { createCoderEnvWiring } from '../coder/coder-env-wiring.ts';
import { resolveCoderEnvironment } from '../coder/core/coder-env-core.ts';
import { persistSessionField } from '../session/session-event-wiring.ts';
import { createBranchGcWiring } from '../branch-gc-wiring.ts';
import { ABORT_CONFIG_SAVE, DEFAULT_CONFIG, glimmervoidHomeDir } from '../config-store.ts';
import { PrFlowsSettings, prActionReportPath } from '../../shared/contracts/pr-flows.ts';
import type { ConfigStore, GlimmervoidConfig } from '../config-store.ts';
import { configSiblingPath } from '../pairings-store.ts';
import fs from 'node:fs';
import { jsonStateLoadError, loadJsonStateFileSync, writeJsonAtomic } from '../json-file.ts';
import { CoderOwnedWorkspaces } from '../../shared/contracts/coder-owned-workspaces.ts';
import { createGitWorkspace, createGitWorkspaceSync } from '../git/git-workspace.ts';
import { createOwnedPathsLedger } from '../owned-paths-ledger.ts';
import { TASK_TITLE_LANE_TOOLS, createTaskTitleRefiner } from '../task-title-refiner.ts';
import { createLaneSpawn } from '../lanes/lane-spawn.ts';
import { createQuestionManagerLane, QUESTION_MANAGER_LANE_TOOLS } from '../question-manager/question-manager.ts';
import { createRadarWiring } from '../radar/radar-wiring.ts';
import { createCommunityWiring } from '../community/community-wiring.ts';
import { createMemoryAdmission, createSpawnGate } from '../spawn-gate.ts';
import { readMemoryHeadroom } from '../memory-probe.ts';
import { memoryReserveBytes } from '../core/memory-admission-core.ts';
import type { Telemetry } from '../telemetry.ts';
import { createTeamReviewSpawn } from '../github/team-review-spawn.ts';
import { createTeamReviewWiring } from '../github/team-review-wiring.ts';
import { sweepLeftoverCheckouts } from '../github/team-review-checkouts.ts';
import { createPrGh } from '../github/pr-gh.ts';
import { createGithubUsageLedger } from '../github/github-usage-ledger.ts';
import { createRepoCache } from '../git/repo-cache.ts';
import { createPrFlowsWiring } from '../github/pr-flows-wiring.ts';
import { packsStatePath } from '../packs/pack-files.ts';
import { createPackData } from '../packs/pack-data.ts';
import { createPackStore } from '../packs/pack-store.ts';
import { packPathsOf } from '../github/core/pr-flows-core.ts';
import { examplePacksDir } from '../runtime-paths.ts';
import { createPrFlowsExternal } from '../github/pr-flows-external.ts';
import { createMyPrMergeabilityFix, createMyPrsWiring, createGuardedPrStaging, sweepKeepMergeableLeftovers } from '../github/my-prs-wiring.ts';
import { keepMergeableTimeoutSeconds } from '../github/core/my-prs-core.ts';
import { createSessionPrLinkWiring } from '../github/session-pr-link-wiring.ts';
import { createStarHintWiring } from '../star-hint-wiring.ts';
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
import { repoNotesRefFor } from '../commit-sessions.ts';
import { laneAccessConfigOf } from '../lanes/core/lane-permissions-core.ts';

const RACE_JUDGE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Write']);
const RACE_CHECK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

interface BackendLaneOptions {
  branchGcWiringOptions?: Record<string, unknown>;
  usageWiringOptions?: Record<string, unknown>;
}

interface BackendLaneDependencies {
  config: GlimmervoidConfig;
  appVersion: string;
  configStore: ConfigStore;
  githubAppToken: () => string | null;
  sessions: Map<string, Session>;
  agentSessions: Map<string, Session>;
  reviewSessions: Map<string, Session>;
  investigationSessions: Map<string, Session>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: HookRouter;
  getHookPort: () => number | null;
  dashboardPort: () => number;
  broadcastControl: ControlBroadcast;
  onControlConnection: (handleConnection: ControlConnectionHandler) => void;
  viewerControlClientCount: () => number;
  isViewerConnected: () => boolean;
  isHubControlSocket: (socket: WebSocket) => boolean;
  options: BackendLaneOptions;
  notificationManager: { trigger(sessionName: string, category: string, message: string): unknown };
  telemetry: Telemetry;
  logger: Console;
  provenanceWriterId: () => Promise<string>;
  renameSessionFromTaskTitle?: (session: Session, proposedName: string) => void;
  retitleProvisionalBoard?: (boardId: string, provisionalTitle: string, title: string) => Promise<boolean>;
}

function createBackendLanes(dependencies: BackendLaneDependencies) {
  const {
    config,
    configStore,
    githubAppToken,
    sessions,
    agentSessions,
    reviewSessions,
    investigationSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    dashboardPort,
    broadcastControl,
    onControlConnection,
    viewerControlClientCount,
    isViewerConnected,
    isHubControlSocket,
    options,
    notificationManager,
    telemetry,
    logger,
    provenanceWriterId,
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
  const provenanceNotesRef = async (projectPath: string): Promise<string | null> => (configStore.config.shareCommitProvenance === false ? null : repoNotesRefFor(projectPath, await provenanceWriterId()));
  const gitWorkspace = createGitWorkspace({ rerere: config.worktree?.rerere !== false, ownedPaths, removalGuard: { protectedSessionIds }, log: logger, provenanceNotesRef });
  const gitWorkspaceSync = createGitWorkspaceSync({ ownedPaths, removalGuard: { protectedSessionIds }, log: logger });
  const laneLedger = createLaneLedger({
    ledgerPath: configSiblingPath(configStore.configPath, 'usage-lanes.json'),
    retainDays: resolveUsageConfig(config.usage).warehouseRetainDays,
    logger,
  });
  void laneLedger.load();
  const recordLane = laneLedger.record;
  const raceSessions = new Map<string, Session>();
  const liveSessionMaps = (): Map<string, Session>[] => [
    sessions, agentSessions, reviewSessions, investigationSessions, taskTitleSessions, raceSessions, questionManagerSessions,
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
  const getLaneAccessConfig = () => laneAccessConfigOf(configStore.config, githubAppToken());
  const posthog = createRadarWiring({
    config,
    getLaneAccessConfig,
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
    config, githubAppToken, broadcast: broadcastControl, homeDir: glimmervoidHomeDir(), log: logger,
    controlClientCount: viewerControlClientCount,
    spawnDependencies: { investigationSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane, replayBufferKB: config.replayBufferKB },
  });
  const githubStatus = createGithubStatus({ log: logger });
  const githubClock = createGithubClock({ baseIntervalMs: GITHUB_CLOCK_INTERVAL_MINUTES * 60000, log: logger, githubStatus });
  const glimmervoidHome = glimmervoidHomeDir();
  const githubUsage = createGithubUsageLedger({ homeDir: glimmervoidHome, readAccountPool: () => githubStore.readAccountRateLimit(), log: logger });
  const github = createPrGh(glimmervoidHome, undefined, githubUsage.recorder);
  githubUsage.start(githubClock);
  const githubStore = createGithubStoreWiring({
    github,
    clock: githubClock,
    isDashboardConnected: isViewerConnected,
    broadcast: broadcastControl,
    log: logger,
  });
  const sharedRepoCacheRoot = path.join(glimmervoidHome, 'team-review-repos');
  const sharedRepoCache = createRepoCache({ rootDir: sharedRepoCacheRoot });
  const teamReview = createTeamReviewWiring({
    config, githubAppToken, store: githubStore.laneStore,
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
  const starHint = createStarHintWiring({ statePath: configSiblingPath(configStore.configPath, 'feature-hints.json'), broadcast: broadcastControl, log: logger, controlClientCount: viewerControlClientCount });
  const myPrsWorkRoot = path.join(glimmervoidHome, 'my-prs-work');
  const myPrs = createMyPrsWiring({
    config, github, store: githubStore.laneStore, log: logger, clock: githubClock,
    broadcast: (frame) => {
      broadcastControl(frame);
      if (frame.type === 'my-prs-status') void prFlows.applyRules();
    },
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
  const appendListedPackPath = async (listedPath: string) => {
    let listedPaths: string[] = [];
    const saved = await configStore.saveAsync((savedConfig) => {
      listedPaths = [...new Set([...packPathsOf(savedConfig), listedPath])];
      savedConfig.packs = listedPaths;
      return undefined;
    });
    if (!saved) return { ok: false as const, error: configStore.lastSaveFailureReason() ?? 'Could not save config.json.' };
    return { ok: true as const, listedPaths };
  };
  const packStore = createPackStore({ homeDir: glimmervoidHome, statePath: packsStatePath(glimmervoidHome), env: process.env, log: logger, examplePacksDir, appendListedPath: appendListedPackPath });
  const packData = createPackData({ homeDir: glimmervoidHome, panelPackDir: (packName) => packStore.panelPackDir(packName) });
  let lastPacksFrameText = '';
  const broadcastPacksIfChanged = () => {
    const frame = packStore.statusFrame();
    const frameText = JSON.stringify(frame);
    if (frameText === lastPacksFrameText) return;
    lastPacksFrameText = frameText;
    broadcastControl(frame);
  };
  const prFlows = createPrFlowsWiring({
    statePath: path.join(glimmervoidHome, 'pr-flows-state.json'), openPrs: () => myPrs.getStatus().prs.filter((pr) => pr.state === 'OPEN'),
    linkedSession: (pullRequestKey) => sessionLinkedToPr(sessions.values(), pullRequestKey),
    readConfigFile: async () => parseJsonOrNull(await fs.promises.readFile(configStore.configPath, 'utf8').catch(() => 'null')),
    appendRule: async (rule) => Boolean(await configStore.saveAsync((savedConfig) => {
      const current = PrFlowsSettings.safeParse(savedConfig.prFlows ?? {});
      if (!current.success) return ABORT_CONFIG_SAVE;
      savedConfig.prFlows = { ...current.data, rules: [...(current.data.rules ?? []), rule] };
      return undefined;
    })),
    github, external: createPrFlowsExternal({ homeDir: glimmervoidHome }), broadcast: broadcastControl, log: logger,
    reportUrlFor: (runId) => `http://127.0.0.1:${dashboardPort()}${prActionReportPath(runId)}`,
    loadPacks: async (configFile) => {
      packStore.setListedPaths(packPathsOf(configFile));
      const approvedPacks = await packStore.approvedPacks();
      broadcastPacksIfChanged();
      return approvedPacks;
    },
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
  const races = createRaceWiring({
    store: createRaceStore({ directory: path.join(glimmervoidHome, 'races'), log: logger }),
    git: gitWorkspace,
    integrationBranch: () => configuredIntegrationBranch(configStore.config),
    broadcast: broadcastControl,
    log: logger,
    sessionStateOf: (sessionId) => findLiveSession(sessionId)?.state ?? REMOVED_CONTESTANT,
    sessionWatchOf: (sessionId) => {
      const session = findLiveSession(sessionId);
      if (!session) return null;
      return { state: session.state, stateSince: session.stateSince, waitingOn: session._conversationApproval?.summary ?? null };
    },
    worktreeOf: (sessionId) => findLiveSession(sessionId)?.worktreeDir ?? null,
    transitionsOf: (sessionId) => findLiveSession(sessionId)?.auditLog.flatMap((entry) => (typeof entry.to === 'string' && typeof entry.timestamp === 'number' ? [{ to: entry.to, at: entry.timestamp }] : [])) ?? null,
    usageLookup: () => usage.sessionUsageLookup(),
    diffOf: contestantDiff,
    judgeRoot: path.join(glimmervoidHome, 'race-judges'),
    reviewCases: createReviewCaseLibrary({ minedRoot: path.join(glimmervoidHome, 'review-cases'), legacySuitesRoot: path.join(glimmervoidHome, 'benchmarks'), store: githubStore.laneStore, log: logger }),
    runCheck: async ({ worktreeDir, check }) => {
      const startedAt = Date.now();
      const run = await runCommandSafely(check.program, check.args, { cwd: worktreeDir, env: buildAllowlistedChildEnv(process.env, process.platform), timeoutMs: check.timeoutSeconds * 1000, maxBufferBytes: RACE_CHECK_MAX_BUFFER_BYTES });
      return checkOutcomeOf(check, run, Date.now() - startedAt, worktreeDir);
    },
    spawnJudge: ({ setup, readPaths, ...request }) => createLaneSpawn({
      sessions: raceSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
      replayBufferKB: config.replayBufferKB, laneName: 'race', getSaneYoloUnreadablePaths: () => configStore.config.saneYoloUnreadablePaths ?? [], getLaneAccessConfig,
      allowTools: RACE_JUDGE_TOOLS,
    })({
      ...request, agent: setup.agent, model: setup.model,
      extraArgs: [
        ...(setup.agent === 'claude-code' ? ['--allowedTools', ...readPaths.flatMap((readPath) => ['Read', 'Glob', 'Grep'].map((tool) => absolutePathReadRule(readPath).replace(/^Read/, tool)))] : []),
        ...selectionArgs({ agent: setup.agent, model: null, options: setup.options }),
      ],
    }),
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
  const taskTitleSessions = new Map<string, Session>();
  const taskTitleRefiner = createTaskTitleRefiner({
    getConfig: () => configStore.config,
    logger,
    renameSession: dependencies.renameSessionFromTaskTitle,
    retitleBoard: dependencies.retitleProvisionalBoard,
    spawnLane: createLaneSpawn({
      sessions: taskTitleSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
      replayBufferKB: config.replayBufferKB, laneName: 'task-title', allowTools: TASK_TITLE_LANE_TOOLS, getSaneYoloUnreadablePaths: () => configStore.config.saneYoloUnreadablePaths ?? [], getLaneAccessConfig,
    }),
  });

  const questionManagerSessions = new Map<string, Session>();
  const questionManagerLane = createQuestionManagerLane(createLaneSpawn({
    sessions: questionManagerSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
    replayBufferKB: config.replayBufferKB, laneName: 'question-manager', allowTools: QUESTION_MANAGER_LANE_TOOLS, getSaneYoloUnreadablePaths: () => configStore.config.saneYoloUnreadablePaths ?? [], getLaneAccessConfig,
  }));

  const usage = createUsageWiring({
    config,
    sessions,
    broadcast: broadcastControl,
    controlClientCount: viewerControlClientCount,
    warehousePath: configSiblingPath(configStore.configPath, 'usage-warehouse.json'),
    snapshotPath: configSiblingPath(configStore.configPath, 'usage-scan-snapshot.json'),
    appVersion: dependencies.appVersion,
    laneMap: () => laneLedger.laneMap(),
    telemetry,
    budgetStatePath: configSiblingPath(configStore.configPath, 'usage-budget-state.json'),
    logger,
    debug: () => configStore.getSettings().debugMode === true,
    ...(options.usageWiringOptions || {}),
  });
  onControlConnection((socket) => {
    if (isHubControlSocket(socket)) return;
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
      () => {
        packStore.on('changed', () => {
          broadcastPacksIfChanged();
          void prFlows.applyRules();
        });
        const forgetRemovedPackData = () => packData.forgetRemovedPacks().catch((error: unknown) => logger.warn(`[packs] could not delete the stored data of removed packs: ${errorMessage(error)}`));
        packStore.on('removed', forgetRemovedPackData);
        packStore.start().then(forgetRemovedPackData, (error: unknown) => logger.warn(`[packs] start failed: ${errorMessage(error)}`));
      },
      () => issues.startPoller(),
      () => workflows.startPoller(),
      () => void deleteRetiredBenchmarkRuns(glimmervoidHome, gitWorkspace, logger),
      () => void deleteRetiredPlans(configSiblingPath(configStore.configPath, 'plans'), logger),
      () => void races.loadRaces(raceIdsOf(configStore.config.projects)).then(() => races.startWatching()),
      () => traceWiring?.start().catch((error: unknown) => logger.warn(`[trace] start failed: ${errorMessage(error)}`)),
      () => uploadsWiring.start().catch((error: unknown) => logger.warn(`[uploads] start failed: ${errorMessage(error)}`)),
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
    ];
    for (const restart of restartSteps) restart();
  }

  return {
    allLiveSessions,
    findLiveSession,
    raceSessions,
    races,
    branchGc,
    coderActivity,
    coderEnv,
    taskTitleRefiner,
    taskTitleSessions,
    questionManagerLane,
    questionManagerSessions,
    current,
    starHint,
    gitWorkspace,
    gitWorkspaceSync,
    ownedPaths,
    githubStore,
    investigationSessions,
    posthog,
    recordLane,
    restartServiceLanes,
    reviewSessions,
    spawnGate,
    memoryAdmission,
    teamReview,
    myPrs,
    prFlows,
    packStore,
    packData,
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
