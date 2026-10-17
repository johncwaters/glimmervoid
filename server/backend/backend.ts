import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { customAgentFingerprint, resolveAdapter, setCustomAgents } from '../../session/adapters/index.ts';
import type { Session } from '../../session/sessions.ts';
import { createConfigStore, generateProjectId, ensureProjectIds, glimmervoidHomeDir } from '../config-store.ts';
import type { GlimmervoidConfig } from '../config-store.ts';
import { createLifecycle } from '../server-lifecycle.ts';
import { execFileAsync, spawn } from '../child-process-safe.ts';
import { createAgentIngressApp, createBackendHttpApp } from './backend-http.ts';
import { createHostUrlOpener } from '../host-url-opener.ts';
import { createAgentApiWiring } from '../agent-api-wiring.ts';
import type { AgentApiPort } from '../agent-api-wiring.ts';
import { createBackendWebSockets } from './backend-websockets.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { createBackendShutdown } from './backend-shutdown.ts';
import { createBackendTrust } from './backend-trust.ts';
import { createSessionEventWiring, persistSessionField } from '../session/session-event-wiring.ts';
import {
  carryWorktreeAcrossRecreate,
  createSessionRegistry,
  reconcileSessionWorktrees,
  runAutoResume,
} from '../session/session-registry.ts';
import { createBackendLanes } from './backend-lanes.ts';
import type { BackendLaneOptions } from './backend-lanes.ts';
import type { AgentIngressDependencies } from './backend-http.ts';
import { decideWasActiveFlip, shouldStartAfterModify } from '../session/core/session-registry-core.ts';
import { createBackendHealth } from './backend-health.ts';
import { createBackendNotifications } from './backend-notifications.ts';
import { createBackendControl } from './backend-control.ts';
import { createBackendUpdateCheck } from './backend-update.ts';
import { normalizeUpdateChannel } from '../core/update-core.ts';
import { detectInstallFlavor } from '../update-check.ts';
import type { CheckForUpdate } from './backend-update.ts';
import { createBackendSessionRuntime } from './backend-session-runtime.ts';
import { checkGuardrailsDependencies } from '../guardrails/guardrails-deps.ts';
import { sweepOrphanedGuardrailsLaunches } from '../guardrails/guardrails-launch.ts';
import { warnWhenGitIsTooOld } from '../git/git-version.ts';
import { createOutcomesLane } from '../outcomes-wiring.ts';
import { createUpdateApplyLane } from '../update-apply.ts';
import { cleanPostTurnLeftovers, recheckRepositoriesTrackingReports } from '../post-turn-leftovers.ts';
import { trackedReportCleanupCommands } from '../../shared/post-turn-leftovers.ts';
import type { RepositoryTrackingReports } from '../../shared/post-turn-leftovers.ts';
import { errorMessage } from '../../shared/text.ts';
import { bundled, packageRoot } from '../runtime-paths.ts';
import { createTelemetry } from '../telemetry.ts';
import { createSessionDocsWiring } from '../session/session-docs-wiring.ts';
import { buildSettingsPayload } from '../settings-payload.ts';
import { glimmervoidHomeDir as resolveGlimmervoidHomeDir } from '../core/config-path-core.ts';
import { decideIsDevInstall, parsePosthogReleaseId } from '../core/telemetry-core.ts';

interface CreateBackendOptions extends BackendLaneOptions {
  staticDir?: string | null;
  settingsDefaults?: Record<string, unknown>;
  checkForUpdate?: CheckForUpdate | null;
  onRestart?: (() => void) | null;
}

const AGENT_INGRESS_HOST = '127.0.0.1';

function createBackend(httpServer: Server, options: CreateBackendOptions = {}) {
  const { staticDir = 'auto', settingsDefaults } = options;
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
    glimmervoid?: { posthogReleaseId?: unknown };
  };

  const configStore = createConfigStore({ settingsDefaults });
  const { config } = configStore;
  applyCustomAgents(config);
  const port = process.env.GLIMMERVOID_PORT
    ? Number.parseInt(process.env.GLIMMERVOID_PORT, 10)
    : (config.port || 3000);

  const trust = createBackendTrust({
    localPort: port,
    remoteConfig: config.remote,
    configPath: configStore.configPath,
    env: process.env,
  });
  const {
    remote,
    bindDecision,
    remoteListenerPort,
    pageToken,
    allowedHosts,
    remoteAuth,
    tokenMatches,
    listenerPortsFor,
  } = trust;

  const serverBuild = `${packageJson.version}+${crypto.randomBytes(4).toString('hex')}`;

  const installFlavor = detectInstallFlavor(packageRoot).flavor;
  const telemetry = createTelemetry({
    config,
    env: process.env,
    stateFilePath: path.join(glimmervoidHomeDir(), 'telemetry.json'),
    pendingCrashFilePath: path.join(glimmervoidHomeDir(), 'telemetry-pending-crash.json'),
    packageRoot,
    version: packageJson.version,
    installFlavor,
    isBundled: bundled,
    isDevInstall: decideIsDevInstall({
      installFlavor,
      isBundled: bundled,
      homeDir: glimmervoidHomeDir(),
      defaultHomeDir: resolveGlimmervoidHomeDir(os.homedir(), {}),
    }),
    releaseId: parsePosthogReleaseId(packageJson.glimmervoid?.posthogReleaseId),
    getActiveSessionCount: () => sessions.size + agentSessions.size,
  });
  telemetry.watchForCrashes();
  telemetry.startRemoteSwitchChecks();
  void telemetry.sendPendingCrash();

  const outcomes = createOutcomesLane();
  const recordOutcome = outcomes.record;

  let broadcastControl: ControlBroadcast | null = null;
  let agentApi: AgentApiPort | null = null;
  let gitWorkspace: ReturnType<typeof createBackendLanes>['gitWorkspace'] | null = null;
  const guardrailsRefusal = checkGuardrailsDependencies({ log: console });
  warnWhenGitIsTooOld({ log: console });
  const sessionRuntime = createBackendSessionRuntime({
    config,
    configStore,
    guardrailsRefusal,
    getGitWorkspace: () => gitWorkspace,
    getPlanReviewPort: () => laneAssembly.planReview?.port ?? null,
    getBroadcastControl: () => broadcastControl,
    recordOutcome,
    logger: console,
  });
  const { agentIngressServer, getHookPort, hookRouter, makeSession, rtkInstall, sshSigner } = sessionRuntime;

  const getCurrentIngestLane = () => laneAssembly.currentIngest();
  const getCurrentVisionsLane = () => laneAssembly.currentVisions();

  const agentIngressDependencies: AgentIngressDependencies = {
    allowedHosts,
    hookRouter,
    getSession: (glimmervoidId) => laneAssembly.findLiveSession(glimmervoidId),
    getUsage: () => usage,
    getPlanReview: () => laneAssembly.planReview,
    refocusContextFor: (glimmervoidId) => ({
      taskTitle: getSessionAny(glimmervoidId)?.refocusTaskTitle ?? null,
      latestPlanTitle: laneAssembly.planReview?.latestPlanTitle(glimmervoidId) ?? null,
    }),
    getAgentApi: () => agentApi,
    getFactory: () => factory,
    sshSigner,
    recordOutcome,
    logger: console,
  };
  const app = createBackendHttpApp({
    ...agentIngressDependencies,
    staticDir,
    configStore,
    remote,
    remoteAuth,
    listenerPortsFor,
    pageToken,
    remoteListenerPort,
    tokenMatches,
    openUrlOnHost: createHostUrlOpener(),
  });
  agentIngressServer.on('request', createAgentIngressApp(agentIngressDependencies));
  agentIngressServer.listen(0, AGENT_INGRESS_HOST);
  agentIngressServer.unref();
  httpServer.once('close', () => {
    agentIngressServer.close();
    agentIngressServer.closeAllConnections();
  });

  const webSockets = createBackendWebSockets({
    remote,
    remoteAuth,
    remoteListenerPort,
    allowedHosts,
    listenerPortsFor,
    tokenMatches,
    getSession: getSessionAny,
    getVisionsLane: getCurrentVisionsLane,
    recordOutcome,
    logger: console,
  });
  const {
    controlWss,
    dataWss,
    controlReplayLog,
    sessionDataClients,
    broadcastControl: broadcastControlFromWebSockets,
    broadcastLocalControl,
    closeSessionDataClients,
  } = webSockets;
  broadcastControl = broadcastControlFromWebSockets;
  const sessionDocs = createSessionDocsWiring({ broadcastControl: broadcastControlFromWebSockets });

  const sessions = new Map<string, Session>();
  const agentSessions = new Map<string, Session>();
  const health = createBackendHealth({
    sessions,
    getAllSessions: () => allLiveSessions(),
    sessionDataClients,
    getIngestLane: getCurrentIngestLane,
    controlWss,
    dataWss,
    broadcastControl,
  });
  const { buildHealthSnapshot, healthInterval } = health;

  const notifications = createBackendNotifications({
    config,
    configStore,
    sessions,
    controlWss,
    dataWss,
    broadcastControl,
    recordOutcome,
    logger: console,
  });
  const {
    handleClientFocus,
    heartbeat,
    investigationSessions,
    notificationManager,
    reviewSessions,
    telegramChannel,
    telegramOutbox,
  } = notifications;

  function getSessionAny(id: string): Session | null {
    return sessions.get(id) || agentSessions.get(id) || null;
  }

  const laneAssembly = createBackendLanes({
    config,
    makeSession,
    guardrailsRefusal,
    wireSessionEvents: (session: Session) => wireSessionEvents(session),
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
    notificationManager,
    telemetry,
    logger: console,
  });
  const {
    allLiveSessions,
    branchGc,
    coderActivity,
    factory,
    changeMapSessions,
    gitWorkspace: assembledGitWorkspace,
    gitWorkspaceSync,
    posthog,
    recordLane,
    spawnGate,
    tapIngestForSession,
    teamReview,
    myPrs,
    issues,
    traceChangeBroadcast,
    traceWiring,
    uploadsWiring,
    usage,
    visionsSessions,
    visionsSetup,
  } = laneAssembly;
  gitWorkspace = assembledGitWorkspace;
  agentApi = createAgentApiWiring({
    config,
    factory,
    agentSessions,
    listAllSessions: () => allLiveSessions(),
    listBoardSessions: () => [...sessions.values(), ...agentSessions.values()],
    makeSession,
    wireSessionEvents: (session: Session) => wireSessionEvents(session),
    closeSessionDataClients,
    broadcastControl,
    spawnGate,
    recordLane,
    sessionDocs,
    logger: console,
  });

  const wireSessionEvents = createSessionEventWiring({
    configStore,
    config,
    recordLane,
    usage,
    broadcastControl,
    telegramChannel,
    notificationManager,
    getIngestLane: getCurrentIngestLane,
    tapIngestForSession,
    traceWiring,
    taskTitleRefiner: laneAssembly.taskTitleRefiner,
    planReview: laneAssembly.planReview,
    closeSessionDataClients,
    telemetry,
    logger: console,
  });

  const sessionRegistry = createSessionRegistry({
    httpServer,
    sessions,
    config,
    configStore,
    makeSession,
    wireSessionEvents,
    closeSessionDataClients,
    notificationManager,
    getIngestLane: getCurrentIngestLane,
    broadcastControl,
    applySettingsReload,
    spawnGate,
    gitWorkspaceSync,
    reconcileSessionWorktrees,
    carryWorktreeAcrossRecreate,
    ensureProjectIds,
    resolveAgentId: (agent: string | null | undefined) => {
      const adapter = resolveAdapter(agent);
      if (!adapter) throw new Error('Default agent adapter is unavailable');
      return adapter.id;
    },
    agentFingerprintOf: customAgentFingerprint,
    logger: console,
  });
  sessionRegistry.initialize();
  const reconcileProjectsOnReload = sessionRegistry.applyConfigReload;

  void rtkInstall.maybeInstall();
  void sweepOrphanedGuardrailsLaunches();
  laneAssembly.startRuntimeLanes();

  function applyCustomAgents(sourceConfig: GlimmervoidConfig): void {
    setCustomAgents(sourceConfig.customAgents ?? []);
  }

  function applyConfigReload(newConfig: GlimmervoidConfig): void {
    applyCustomAgents(newConfig);
    reconcileProjectsOnReload(newConfig);
  }

  function applySettingsReload(newConfig: GlimmervoidConfig): void {
    configStore.applySettings(newConfig);
    telemetry.applyConfig();
    applyCustomAgents(newConfig);
    updateCheck.applySettings();
    for (const [, sess] of sessions) {
      sess.updateSettings(config);
    }
    notifications.applySettings();
    laneAssembly.restartServiceLanes();
    void rtkInstall.maybeInstall();
    void visionsSetup.maybeApply();
    void laneAssembly.restartDynamicLanes();
  }

  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: packageJson.version,
    platform: process.platform,
    checkForUpdate: options.checkForUpdate || undefined,
    fetchOrigin: (args) => assembledGitWorkspace.fetchOrigin(args),
    getUpdateJournal: () => updateApply.getJournal(),
    isRestartRequested: () => updateApply.isRestartRequested(),
    getControlClientCount: () => controlWss.clients.size,
    broadcastControl,
    logger: console,
  });
  const updateApply = createUpdateApplyLane({
    gitWorkspace: assembledGitWorkspace,
    runCommand: execFileAsync,
    fsPromises: fs.promises,
    packageRoot,
    journalPath: path.join(glimmervoidHomeDir(), 'update-journal.json'),
    getUpdateStatus: updateCheck.getStatus,
    getUpdateChannel: () => normalizeUpdateChannel(config.updateChannel),
    broadcastControl: (message) => {
      broadcastControl(message);
      updateCheck.refreshApplyAvailability();
    },
    logger: console,
  });
  let repositoriesTrackingPostTurnReports: RepositoryTrackingReports[] = [];
  let isRecheckingPostTurnReports = false;
  function postTurnLeftoversMessage() {
    return {
      type: 'post-turn-leftovers' as const,
      repositories: repositoriesTrackingPostTurnReports.map(({ repositoryPath }) => repositoryPath),
      command: trackedReportCleanupCommands(repositoriesTrackingPostTurnReports, process.platform),
    };
  }
  function startPostTurnLeftoverCleanup(): void {
    cleanPostTurnLeftovers({ projects: config.projects }).then((repositories) => {
      repositoriesTrackingPostTurnReports = repositories;
      if (repositories.length > 0) broadcastControlFromWebSockets(postTurnLeftoversMessage());
    }).catch((error) => {
      console.warn(`[post-turn] old report cleanup failed: ${errorMessage(error)}`);
    });
  }
  function recheckPostTurnLeftovers(): void {
    if (isRecheckingPostTurnReports || repositoriesTrackingPostTurnReports.length === 0) return;
    isRecheckingPostTurnReports = true;
    const previousRepositories = repositoriesTrackingPostTurnReports;
    recheckRepositoriesTrackingReports(previousRepositories).then((repositories) => {
      if (JSON.stringify(repositories) === JSON.stringify(previousRepositories)) return;
      repositoriesTrackingPostTurnReports = repositories;
      broadcastControlFromWebSockets(postTurnLeftoversMessage());
    }).catch((error) => {
      console.warn(`[post-turn] old report re-check failed: ${errorMessage(error)}`);
    }).finally(() => {
      isRecheckingPostTurnReports = false;
    });
  }
  let stopConfigWatch: (() => void) | null = null;
  const shutdown = createBackendShutdown({
    configStore,
    cancelAutoResume: sessionRegistry.cancelAutoResume,
    cancelPostTurnLeftoverCleanup: () => httpServer.off('listening', startPostTurnLeftoverCleanup),
    healthInterval,
    getStopConfigWatch: () => stopConfigWatch,
    remoteAuth,
    stopUpdateCheck: updateCheck.stop,
    stopUpdateApply: updateApply.stop,
    notificationManager,
    telegramChannel,
    sessions,
    agentSessions,
    reviewSessions,
    investigationSessions,
    visionsSessions,
    changeMapSessions,
    taskTitleSessions: laneAssembly.taskTitleSessions,
    benchmarkSessions: laneAssembly.benchmarkSessions,
    branchGc,
    coderActivity,
    factory,
    posthog,
    teamReview,
    myPrs,
    issues,
    workflows: laneAssembly.workflows,
    benchmarks: laneAssembly.benchmarks,
    usage,
    getIngestLane: getCurrentIngestLane,
    getVisionsLane: getCurrentVisionsLane,
    traceWiring,
    uploadsWiring,
    traceChangeBroadcast,
    taskTitleRefiner: laneAssembly.taskTitleRefiner,
    planReview: laneAssembly.planReview,
    telegramOutbox,
    heartbeat,
    outcomes,
    telemetry,
    controlWss,
    dataWss,
  });
  const { requestShutdown, requestRestart } = createLifecycle({
    shutdown,
    httpServer,
    extraServers: [agentIngressServer],
    onRestart: options.onRestart || null,
    spawn,
    beforeHandOff: updateApply.handOffStagedUpdate,
  });

  createBackendControl({
    controlWss,
    sessions,
    agentSessions,
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    getRtkInstallStatus: () => rtkInstall.getStatus(),
    generateProjectId,
    makeSession,
    wireSessionEvents,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
    buildHealthSnapshot,
    getUpdateStatus: updateCheck.getStatus,
    getUpdateJournal: updateApply.getJournal,
    getPostTurnLeftoversNotice: () => (repositoriesTrackingPostTurnReports.length > 0 ? postTurnLeftoversMessage() : null),
    recheckPostTurnLeftovers,
    checkNow: updateCheck.checkNow,
    applyUpdate: updateApply.applyUpdate,
    isStaging: updateApply.isStaging,
    noteRestartRequested: () => {
      updateApply.noteRestartRequested();
      updateCheck.refreshApplyAvailability();
    },
    laneAssembly,
    posthog,
    teamReview,
    myPrs,
    issues,
    benchmarks: laneAssembly.benchmarks,
    factory,
    usage,
    readTracePage: traceWiring?.readTracePage ?? null,
    readPlanRevision: laneAssembly.planReview?.readPlanRevision ?? null,
    decidePlanReview: laneAssembly.planReview?.decide ?? null,
    sessionDocs,
    changeMapNarrator: laneAssembly.changeMapNarrator,
    serverBuild: () => serverBuild,
    telemetry,
    logger: console,
  });

  webSockets.attachDataConnection();
  const { handleUpgrade } = webSockets;
  httpServer.on('upgrade', handleUpgrade);
  updateApply.startAfterListening(httpServer);
  httpServer.once('listening', startPostTurnLeftoverCleanup);

  stopConfigWatch = configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
    broadcastControl({ type: 'settings-updated', settings: buildSettingsPayload({ configStore, rtkInstallStatus: rtkInstall.getStatus() }) });
  });
  updateCheck.start();

  return {
    shutdown,
    port,
    app,
    telemetry,
    version: packageJson.version,
    getSession: getSessionAny,
    getLane: laneAssembly.current,
    bindHost: bindDecision.host,
    remote: {
      enabled: remote.enabled,
      port: remote.port,
      publicHost: remote.publicHost,
      attach(remoteHttpServer: Server) {
        remoteHttpServer.on('request', app);
        remoteHttpServer.on('upgrade', handleUpgrade);
      },
    },
  };
}

export {
  createBackend, runAutoResume, persistSessionField, decideWasActiveFlip, carryWorktreeAcrossRecreate,
  reconcileSessionWorktrees, shouldStartAfterModify,
};
export type { CreateBackendOptions };
