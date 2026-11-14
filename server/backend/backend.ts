import { readPosthogReadConnection } from '../community/core/community-core.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:http';
import { remoteListenerPortPath, resolveLocalPort } from '../core/remote-config.ts';
import os from 'node:os';
import path from 'node:path';
import { customAgentFingerprint, resolveAdapter, setCustomAgents } from '../../session/adapters/index.ts';
import type { Session } from '../../session/sessions.ts';
import type { HintedCommand } from '../../session/core/session-routes.ts';
import { ABORT_CONFIG_SAVE, createConfigStore, DEFAULT_CONFIG, generateProjectId, ensureProjectIds, glimmervoidHomeDir } from '../config-store.ts';
import { reconcileOwnedPaths } from '../owned-paths-ledger.ts';
import type { GlimmervoidConfig } from '../config-store.ts';
import { createLifecycle } from '../server-lifecycle.ts';
import { execFileAsync, spawn } from '../child-process-safe.ts';
import { createAgentIngressApp, createBackendHttpApp } from './backend-http.ts';
import { createLinkPreviewFetcher } from '../link-preview-fetcher.ts';
import { createHostUrlOpener } from '../host-url-opener.ts';
import { createAgentApiWiring } from '../agent-api-wiring.ts';
import { createWhiteboardWiring, WHITEBOARDS_FOLDER_NAME } from '../whiteboard/whiteboard-wiring.ts';
import { createReviewWiring, REVIEWS_FOLDER_NAME } from '../review/review-wiring.ts';
import type { ProvisionalBoardNaming } from '../whiteboard/whiteboard-wiring.ts';
import { createChangeMapService, joinSessionRegistries } from '../change-map/change-map-wiring.ts';
import { createRemoteSetupWiring } from '../remote-setup-wiring.ts';
import type { AgentApiPort } from '../agent-api-wiring.ts';
import { configFileViewOf, readSettingsForAgent } from '../core/settings-readout-core.ts';
import { readPacksForAgent } from '../packs/pack-agent.ts';
import { createBackendWebSockets } from './backend-websockets.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { createBackendShutdown } from './backend-shutdown.ts';
import { createBoardPackPreviews } from '../packs/pack-preview-server.ts';
import { createBackendTrust } from './backend-trust.ts';
import { createSessionEventWiring, persistSessionField } from '../session/session-event-wiring.ts';
import {
  carryWorktreeAcrossRecreate,
  createSessionRegistry,
  reconcileSessionWorktrees,
  runAutoResume,
} from '../session/session-registry.ts';
import { createBackendLanes } from './backend-lanes.ts';
import { createWatcherLink } from '../../cloud/link/watcher-link.ts';
import { startIdleStop } from '../idle-stop-wiring.ts';
import { startAwakeUsageAlerts } from '../awake-usage-wiring.ts';
import { startGithubConnectionAlerts } from '../github-connection-alerts.ts';
import { createRemoteWatcherStarter } from '../../cloud/link/remote-watcher-starter.ts';
import { createCommitSigning, createUnsignedCommitNotices, followingGithubConnection } from '../commit-signing.ts';
import { createHostReady } from '../ready-host.ts';
import { ensureDoorman, localDoormanUrl, retireLocalDoorman } from '../../cloud/doorman/ensure-doorman.ts';
import { clock, setOperatorTimezoneSource } from '../../shared/clock.ts';
import { NUDGES_PATH } from '../../shared/contracts/watcher-link.ts';
import { loadOrCreateLinkSecret } from '../../cloud/link/link-secret.ts';
import { laneAccessConfigOf, NO_GITHUB_APP_GRANTS } from '../lanes/core/lane-permissions-core.ts';
import type { GithubAppGrants } from '../lanes/core/lane-permissions-core.ts';
import type { GithubUserGrant } from '../../shared/contracts/watcher-link.ts';
import type { BackendLaneOptions } from './backend-lanes.ts';
import type { AgentIngressDependencies } from './backend-http.ts';
import { decideWasActiveFlip, shouldStartAfterModify } from '../session/core/session-registry-core.ts';
import { createBackendHealth } from './backend-health.ts';
import { createBackendNotifications } from './backend-notifications.ts';
import { createBackendControl } from './backend-control.ts';
import type { RaceLauncher } from '../race/race-launch.ts';
import { createBackendUpdateCheck } from './backend-update.ts';
import { normalizeManagedBy, normalizeUpdateChannel } from '../core/update-core.ts';
import { detectInstallFlavor } from '../update-check.ts';
import type { CheckForUpdate } from './backend-update.ts';
import { createBackendSessionRuntime } from './backend-session-runtime.ts';
import { deleteRetiredGuardrailsFolders } from '../session-temp/retired-guardrails.ts';
import { warnWhenGitIsTooOld } from '../git/git-version.ts';
import { createOutcomesLane } from '../outcomes-wiring.ts';
import { createUpdateApplyLane } from '../update-apply.ts';
import { cleanPostTurnLeftovers, recheckRepositoriesTrackingReports } from '../post-turn-leftovers.ts';
import { trackedReportCleanupCommands } from '../../shared/post-turn-leftovers.ts';
import type { RepositoryTrackingReports } from '../../shared/post-turn-leftovers.ts';
import { errorMessage } from '../../shared/text.ts';
import { chooseRefinedSessionName } from '../../session/core/task-title-core.ts';
import { assetRoot, bundled, examplePacksDir, packageRoot, refuseUnstableSelfLaunches, resolveFnoxPath } from '../runtime-paths.ts';
import { createAccountIdReader, createTelemetry } from '../telemetry.ts';
import { createSessionDocsWiring } from '../session/session-docs-wiring.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { COMMIT_SESSIONS_FOLDER_NAME, PROVENANCE_WRITER_FILE_NAME, createCommitSessions, createProvenanceWriterId } from '../commit-sessions.ts';
import { createCoherenceSessionFeed } from '../coherence/coherence-session-feed.ts';
import { buildSettingsPayload } from '../settings-payload.ts';
import { glimmervoidHomeDir as resolveGlimmervoidHomeDir, isOperatorHomeUnderTest } from '../core/config-path-core.ts';
import { decideIsDevInstall, parsePosthogReleaseId } from '../core/telemetry-core.ts';
import { promptContextReplyOf } from '../../session/core/refocus-core.ts';
import { lookupWhy } from '../why-lookup.ts';
import { createSecretsBroker } from '../secrets/secrets-broker.ts';
import { createFnoxRunner } from '../secrets/fnox-runner.ts';
import { createWrittenSecretNames } from '../secrets/written-secret-names.ts';
import { SecretSource } from '../../shared/contracts/secrets.ts';
import type { SecretSourceTestResult } from '../../shared/contracts/secrets.ts';
import { readEnvValues, writeEnvFile } from '../secrets/env-file.ts';
import { wireSecretsBroker } from '../secrets/secrets-wiring.ts';
import { legacyVaultCompanionPath, legacyWatcherLinkKeyPath, vaultCompanionPath, watcherLinkKeyPath } from '../secrets/core/secret-files-core.ts';

interface CreateBackendOptions extends BackendLaneOptions {
  staticDir?: string | null;
  settingsDefaults?: Record<string, unknown>;
  checkForUpdate?: CheckForUpdate | null;
  onRestart?: (() => void) | null;
  exit?: (code?: number) => unknown;
  downloadUpdatesInBackground?: boolean;
  configReloadDebounceMs?: number;
  localPort?: number;
}

const AGENT_INGRESS_HOST = '127.0.0.1';

function createBackend(httpServer: Server, options: CreateBackendOptions = {}) {
  if (isOperatorHomeUnderTest(os.homedir(), process.env)) {
    throw new Error('createBackend refused to boot on the operator\'s Glimmervoid home under node:test; run tests through npm test or npm run test:files, which isolate GLIMMERVOID_HOME');
  }
  refuseUnstableSelfLaunches();
  const { staticDir = 'auto', settingsDefaults } = options;
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
    glimmervoid?: { posthogReleaseId?: unknown };
  };

  const configStore = createConfigStore({ settingsDefaults, readTelemetryInstallId: () => telemetry.currentInstallId() });
  const { config } = configStore;
  setOperatorTimezoneSource(() => config.operatorTimezone);
  applyCustomAgents(config);
  const port = options.localPort ?? resolveLocalPort({ envPort: process.env.GLIMMERVOID_PORT, configPort: config.port, defaultPort: DEFAULT_CONFIG.port });
  const boundDashboardPort = (): number => {
    const address = httpServer.address();
    if (address === null || typeof address === 'string') return port;
    return address.port;
  };

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
  let broadcastSettings: (() => void) | null = null;
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
    takeWatcherRollup: () => watcherLink.takeRollup(),
    readAccountIds: createAccountIdReader({ env: process.env, homeDir: os.homedir() }),
    onInstallIdChange: () => broadcastSettings?.(),
  });
  telemetry.watchForCrashes();
  telemetry.startRemoteSwitchChecks();
  void telemetry.sendPendingCrash();

  const outcomes = createOutcomesLane();
  const recordOutcome = outcomes.record;

  let broadcastControl: ControlBroadcast | null = null;
  let removeExitedSession: ((id: string) => void) | null = null;
  let raceLauncher: RaceLauncher | null = null;
  let agentApi: AgentApiPort | null = null;
  let gitWorkspace: ReturnType<typeof createBackendLanes>['gitWorkspace'] | null = null;
  warnWhenGitIsTooOld({ log: console });
  const sessionRuntime = createBackendSessionRuntime({
    config,
    configStore,
    getGitWorkspace: () => gitWorkspace,
    getQuestionManagerLane: () => laneAssembly.questionManagerLane,
    getBroadcastControl: () => broadcastControl,
    recordOutcome,
    logger: console,
    liveSessionNamesUsing: (accountId) => laneAssembly.allLiveSessions()
      .filter((session) => session.accountIdInUse === accountId || configStore.config.projects.some((project) => project.id === session.id && project.accountId === accountId))
      .map((session) => session.name),
    onConfigSaved: (freshConfig) => applyConfigReload(freshConfig),
  });
  const { agentAccounts, agentIngressServer, getHookPort, ghShimDir, hookRouter, hostSigningKeys, makeSession, packSessionFiles, setTerminalColors, sshSigner } = sessionRuntime;


  const agentIngressDependencies: AgentIngressDependencies = {
    allowedHosts,
    hookRouter,
    getSession: (glimmervoidId) => laneAssembly.findLiveSession(glimmervoidId),
    getUsage: () => usage,
    refocusContextFor: (glimmervoidId) => ({
      taskTitle: getSessionAny(glimmervoidId)?.refocusTaskTitle ?? null,
    }),
    takePromptSupervision: (glimmervoidId) => {
      const session = getSessionAny(glimmervoidId);
      const replyShape = session?.promptContextReply() ?? null;
      if (!session || !replyShape) return null;
      const isConnectedToBoard = whiteboards.isConnected(glimmervoidId);
      const keepsHint = (command: HintedCommand) => (agentApi?.refuseRole(session, command) ?? null) === null && !(command === 'whiteboard' && isConnectedToBoard);
      const promptMessages = [...session.takePromptNotes(keepsHint), whiteboards.takeBoardNotice(glimmervoidId, session.path)];
      const deliverable = promptMessages.filter((promptMessage) => promptMessage !== null);
      return deliverable.length === 0 ? null : promptContextReplyOf(replyShape, deliverable.join('\n\n'));
    },
    getAgentApi: () => agentApi,
    getWhiteboardAssets: () => whiteboards.assets,
    getWhiteboardLayouts: () => whiteboards.layouts,
    getPrActionReports: () => laneAssembly.prFlows,
    sshSigner,
    githubUserCredential: () => githubUserCredentialOfLink(),
    recordOutcome,
    logger: console,
  };
  const frameSecret = crypto.randomBytes(32);
  const boardPackPreviews = createBoardPackPreviews({ env: process.env, homeDir: glimmervoidHomeDir(), pagesDir: path.join(glimmervoidHomeDir(), 'pack-previews') });
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
    isLinkPreviewEnabled: () => config.linkPreviews !== false,
    fetchLinkPreview: createLinkPreviewFetcher(),
    getPackFile: (packName, fingerprint, filePath) => laneAssembly.packStore.servableFile(packName, fingerprint, filePath),
    packPreviews: boardPackPreviews,
    getWhiteboardFiles: () => whiteboards.handleOperator,
    frameSecret,
  });
  agentIngressServer.on('request', createAgentIngressApp(agentIngressDependencies));
  agentIngressServer.listen(0, AGENT_INGRESS_HOST);
  agentIngressServer.unref();
  httpServer.once('close', () => {
    agentIngressServer.close();
    agentIngressServer.closeAllConnections();
    agentAccounts.stop();
  });

  const webSockets = createBackendWebSockets({
    remote,
    remoteAuth,
    remoteListenerPort,
    allowedHosts,
    listenerPortsFor,
    tokenMatches,
    getSession: getSessionAny,
    recordOutcome,
    logger: console,
  });
  const {
    controlWss,
    onControlConnection,
    dataWss,
    controlReplayLog,
    sessionDataClients,
    broadcastControl: broadcastControlFromWebSockets,
    closeSessionDataClients,
    viewerControlClientCount,
    isViewerConnected,
  } = webSockets;
  function forgetSessionInSavedOrder(sessionId: string) {
    if (!config.sessionOrder?.includes(sessionId)) return;
    configStore.saveAsync((savedConfig) => {
      if (!savedConfig.sessionOrder?.includes(sessionId)) return ABORT_CONFIG_SAVE;
      savedConfig.sessionOrder = savedConfig.sessionOrder.filter((id) => id !== sessionId);
      return undefined;
    })
      .then((saved) => { if (saved) config.sessionOrder = saved.sessionOrder; })
      .catch((error: unknown) => console.warn(`[config] Failed to drop a removed session from sessionOrder: ${errorMessage(error)}`));
  }
  broadcastControl = (message) => {
    broadcastControlFromWebSockets(message);
    if (message.type !== 'session-removed' || typeof message.id !== 'string') return;
    void whiteboards.forgetSession(message.id);
    void reviews.forgetSession(message.id);
    forgetSessionInSavedOrder(message.id);
  };
  const sessionDocs = createSessionDocsWiring({ broadcastControl: broadcastControlFromWebSockets });
  const whiteboards = createWhiteboardWiring({
    boardsRoot: configSiblingPath(configStore.configPath, WHITEBOARDS_FOLDER_NAME),
    broadcastControl: broadcastControlFromWebSockets,
    codeContextOf: (sessionId) => {
      const session = getSessionAny(sessionId);
      return session ? { root: session.effectiveCwd(), buildChangeMap: () => changeMaps.build(session) } : null;
    },
    projectOf: (sessionId) => getSessionAny(sessionId)?.path ?? null,
    onBoardNamedProvisionally: (naming) => nameProvisionalBoard(naming),
  });
  const coherenceFeed = createCoherenceSessionFeed({ broadcastControl: broadcastControlFromWebSockets });
  const reviews = createReviewWiring({
    reviewsRoot: configSiblingPath(configStore.configPath, REVIEWS_FOLDER_NAME),
    broadcastControl: broadcastControlFromWebSockets,
    findSession: (sessionId) => getSessionAny(sessionId),
  });

  const sessions = new Map<string, Session>();
  const agentSessions = new Map<string, Session>();
  const changeMaps = createChangeMapService({ sessions: joinSessionRegistries(sessions, agentSessions) });
  const health = createBackendHealth({
    sessions,
    getAllSessions: () => allLiveSessions(),
    sessionDataClients,
    getMemoryGateStatus: () => laneAssembly.memoryAdmission.gateStatus(),
    controlWss,
    viewerControlClientCount,
    dataWss,
    broadcastControl,
  });
  const { buildHealthSnapshot, healthInterval } = health;

  const notifications = createBackendNotifications({
    config,
    configStore,
    sessions,
    controlWss,
    onControlConnection,
    viewerControlClientCount,
    dataWss,
    broadcastControl,
    recordOutcome,
    logger: console,
  });
  const {
    acknowledgeSeenAlert,
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

  const provenanceWriterId = createProvenanceWriterId(configSiblingPath(configStore.configPath, PROVENANCE_WRITER_FILE_NAME), console);
  let githubAppGrantsOfLink: GithubAppGrants = NO_GITHUB_APP_GRANTS;
  let githubUserCredentialOfLink: () => Promise<GithubUserGrant | null> = async () => null;
  const githubAppGrants: GithubAppGrants = {
    tokenFor: (owner) => githubAppGrantsOfLink.tokenFor(owner),
    tokens: () => githubAppGrantsOfLink.tokens(),
    hasAny: () => githubAppGrantsOfLink.hasAny(),
  };
  const laneAssembly = createBackendLanes({
    config,
    frameSecret,
    githubAppGrants,
    githubUserCredential: () => githubUserCredentialOfLink(),
    appVersion: packageJson.version,
    provenanceWriterId,
    configStore,
    sessions,
    agentSessions,
    reviewSessions,
    investigationSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    dashboardPort: boundDashboardPort,
    broadcastControl,
    onControlConnection,
    viewerControlClientCount,
    isViewerConnected,
    options,
    notificationManager,
    telemetry,
    logger: console,
    renameSessionFromTaskTitle,
    retitleProvisionalBoard: whiteboards.retitleProvisionalBoard,
    packSessionFiles,
  });
  const {
    allLiveSessions,
    branchGc,
    gitWorkspace: assembledGitWorkspace,
    gitWorkspaceSync,
    posthog,
    recordLane,
    spawnGate,
    attachSessionPrLink,
    teamReview,
    myPrs,
    packStore,
    community,
    traceChangeBroadcast,
    traceWiring,
    uploadsWiring,
    usage,
  } = laneAssembly;
  gitWorkspace = assembledGitWorkspace;
  const vaultSourceFor = (lookIn: unknown) => SecretSource.safeParse({ manager: config.vault?.manager ?? '1password', lookIn });
  const testSecretSource = async (lookIn: string): Promise<SecretSourceTestResult> => {
    const source = vaultSourceFor(lookIn);
    if (!source.success) return { ok: false, message: source.error.issues[0]?.message ?? 'Glimmervoid cannot use that vault', detail: '' };
    return fnoxRunner.test(source.data);
  };
  for (const retiredCompanionFile of [vaultCompanionPath(glimmervoidHomeDir()), legacyVaultCompanionPath(glimmervoidHomeDir())]) {
    fs.promises.rm(retiredCompanionFile, { force: true }).catch((error: unknown) => console.warn(`[vault] could not remove the retired companion file ${retiredCompanionFile}: ${errorMessage(error)}`));
  }
  const fnoxRunner = createFnoxRunner({ fnoxPath: resolveFnoxPath(), runsRoot: path.join(glimmervoidHomeDir(), 'fnox-runs'), environment: process.env });
  const secretsBroker = createSecretsBroker({
    readSecrets: () => config.secrets,
    currentSource: () => {
      const source = vaultSourceFor(config.vault?.lookIn);
      return source.success ? source.data : null;
    },
    readSecret: fnoxRunner.read,
    writeEnvFile,
    readEnvValues,
    writtenNames: createWrittenSecretNames({ filePath: path.join(glimmervoidHomeDir(), 'env-file-names.json') }),
    telemetry,
    writeSecrets: async (mutate) => {
      const saved = await configStore.saveAsync((savedConfig) => {
        const nextSecrets = mutate(savedConfig.secrets);
        if (!nextSecrets) return ABORT_CONFIG_SAVE;
        savedConfig.secrets = nextSecrets;
        return undefined;
      });
      if (!saved) return false;
      config.secrets = saved.secrets;
      return true;
    },
  });
  const secretsWiring = wireSecretsBroker({ broker: secretsBroker, findSession: getSessionAny, broadcastControl: broadcastControlFromWebSockets });
  agentApi = createAgentApiWiring({
    config,
    agentSessions,
    listAllSessions: () => allLiveSessions(),
    listBoardSessions: () => [...sessions.values(), ...agentSessions.values()],
    makeSession,
    wireSessionEvents: (session: Session) => wireSessionEvents(session),
    closeSessionDataClients,
    broadcastControl,
    spawnGate,
    memoryAdmission: laneAssembly.memoryAdmission,
    recordLane,
    sessionDocs,
    operatorState: {
      requestReview: (reference) => teamReview.requestReview(reference),
      teamReviewStatus: () => teamReview.getStatus(),
      myPrsStatus: () => myPrs.getStatus(),
      readSettings: (request) => readSettingsForAgent(request, configFileViewOf(configStore.configPath, config, process.env, configStore.secretsFileKeys())),
      readPacks: (request) => readPacksForAgent(request, {
        homeDir: glimmervoidHomeDir(), env: process.env, examplePacksDir,
        packRows: () => laneAssembly.packStore.statusFrame().packs, isApproved: (fingerprint) => laneAssembly.packStore.isApproved(fingerprint), dashboardPort: boundDashboardPort,
        isRequestDismissed: (packName) => laneAssembly.packStore.isRequestDismissed(packName), reopenRequest: (packName) => laneAssembly.packStore.reopenRequest(packName),
        sources: laneAssembly.packSources,
      }),
      previewPackPage: (packDir) => boardPackPreviews.pageFor(packDir, path.basename(packDir)),
    },
    whiteboards,
    lookupWhy: (request) => lookupWhy({ ...request, configPath: configStore.configPath }),
    reviewComments: reviews,
    repoClones: assembledGitWorkspace,
    settleSessionCoherence: coherenceFeed.settle,
    secrets: secretsBroker,
    races: laneAssembly.races,
    startRace: (spec, permissions) => (raceLauncher ? raceLauncher.start(spec, permissions) : Promise.resolve({ ok: false as const, error: 'Races are not running' })),
    wakesFilePath: path.join(glimmervoidHomeDir(), 'wakes.json'),
    logger: console,
  });
  const remoteSetup = createRemoteSetupWiring({
    config,
    agentSessions,
    makeSession,
    wireSessionEvents: (session: Session) => wireSessionEvents(session),
    closeSessionDataClients,
    broadcastControl,
    spawnGate,
    recordLane,
    setupRootDir: path.join(glimmervoidHomeDir(), 'remote-setup'),
    skillSourceDir: path.join(assetRoot, 'session', 'remote-setup'),
  });

  const wireSessionStatusEvents = createSessionEventWiring({
    configStore,
    config,
    recordLane,
    usage,
    broadcastControl,
    telegramChannel,
    notificationManager,
    attachSessionPrLink,
    traceWiring,
    commitSessions: createCommitSessions({
      storeRoot: configSiblingPath(configStore.configPath, COMMIT_SESSIONS_FOLDER_NAME),
      logger: console,
      writerIdFn: provenanceWriterId,
      unsignedCommitNotices: createUnsignedCommitNotices({ store: hostSigningKeys, notify: (name, category, message) => { notificationManager.trigger(name, category, message); } }),
    }),
    pushProvenanceNotes: (repoDir: string) => assembledGitWorkspace.pushProvenanceNotes(repoDir),
    taskTitleRefiner: laneAssembly.taskTitleRefiner,
    coherenceFeed,
    starHint: laneAssembly.starHint,
    closeSessionDataClients,
    removeExitedSession: (id: string) => removeExitedSession?.(id),
    telemetry,
    logger: console,
  });

  function wireSessionEvents(session: Session): void {
    wireSessionStatusEvents(session);
    agentApi?.watchSessionWakes(session);
    secretsWiring.seedSessionMasks(session);
  }

  const sessionRegistry = createSessionRegistry({
    httpServer,
    sessions,
    config,
    configStore,
    makeSession,
    wireSessionEvents,
    closeSessionDataClients,
    notificationManager,
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
    settleSessionCoherence: coherenceFeed.settle,
    logger: console,
  });
  sessionRegistry.initialize();
  const reconcileProjectsOnReload = sessionRegistry.applyConfigReload;

  const bootWork: Promise<unknown>[] = [
    whiteboards.forgetClosedSessions((sessionId) => getSessionAny(sessionId) === null),
    whiteboards.fileUnfiledBoards(),
    deleteRetiredGuardrailsFolders(glimmervoidHomeDir()),
    reconcileOwnedPaths({
      ledger: laneAssembly.ownedPaths,
      configuredSessionIds: new Set(config.projects.map((project) => project.id)),
      git: laneAssembly.gitWorkspace,
      shareList: config.worktree?.share ?? DEFAULT_CONFIG.worktree.share,
    }),
  ];
  laneAssembly.startRuntimeLanes();

  function applyCustomAgents(sourceConfig: GlimmervoidConfig): void {
    for (const shadowedId of setCustomAgents(sourceConfig.customAgents ?? [])) {
      console.warn(`[glimmervoid] customAgents entry "${shadowedId}" is ignored: a built-in agent now has that id; rename the entry to keep using it`);
    }
  }

  function applyConfigReload(newConfig: GlimmervoidConfig): void {
    applyCustomAgents(newConfig);
    reconcileProjectsOnReload(newConfig);
    void laneAssembly.packLaunchers.refresh();
  }

  function nameProvisionalBoard({ boardId, provisionalTitle, sessionId, cardTitle, caption }: ProvisionalBoardNaming): void {
    const session = getSessionAny(sessionId);
    void laneAssembly.taskTitleRefiner.nameBoard({
      boardId, provisionalTitle, cardTitle, caption, sessionName: session?.name ?? null, taskTitle: session?.taskTitle ?? null,
    });
  }

  function renameSessionFromTaskTitle(session: Session, proposedName: string): void {
    if (sessions.get(session.id) !== session) return;
    const sessionName = chooseRefinedSessionName({
      currentName: session.name, projectFolderName: path.basename(session.path), proposedName,
      takenNames: [...sessions.values()].map((other) => other.name),
    });
    if (!sessionName || sessionName === session.name) return;
    const checkedAutoName = session.name;
    const freshConfig = configStore.save((savedConfig) => {
      const project = savedConfig.projects.find((candidate) => candidate.id === session.id);
      if (project?.name === checkedAutoName) project.name = sessionName;
    });
    if (freshConfig) applyConfigReload(freshConfig);
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
    watcherLink.credentialsMayHaveChanged();
  }

  function downloadUpdateOnceListening() {
    if (httpServer.listening) return updateApply.applyUpdate();
    return new Promise<void>((resolve) => { httpServer.once('listening', resolve); }).then(() => updateApply.applyUpdate());
  }
  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: packageJson.version,
    platform: process.platform,
    checkForUpdate: options.checkForUpdate || undefined,
    getUpdateJournal: () => updateApply.getJournal(),
    isRestartRequested: () => updateApply.isRestartRequested(),
    isSupervised: () => updateApply.isSupervised(),
    managedBy: normalizeManagedBy(process.env.GLIMMERVOID_MANAGED_BY),
    getBinaryUpdaterPath: () => updateApply.getBinaryUpdaterPath(),
    probeBinaryUpdater: () => updateApply.probeBinaryUpdater(),
    getControlClientCount: viewerControlClientCount,
    broadcastControl,
    logger: console,
    ...(options.downloadUpdatesInBackground ? { downloadUpdate: downloadUpdateOnceListening } : {}),
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
  const configuredDoormanUrl = config.remote?.doormanUrl ?? null;
  async function prepareLocalDoorman(): Promise<void> {
    if (configuredDoormanUrl !== null) return retireLocalDoorman(glimmervoidHomeDir(), port);
    const remoteListenerPort = trust.remoteListenerPort();
    if (remoteListenerPort === null) return;
    await ensureDoorman({ glimmervoidHome: glimmervoidHomeDir(), localPort: port, bindHost: bindDecision.host, remoteListenerPort, version: packageJson.version });
  }
  const watcherLink = createWatcherLink({
    linkSecret: loadOrCreateLinkSecret(watcherLinkKeyPath(glimmervoidHomeDir()), legacyWatcherLinkKeyPath(glimmervoidHomeDir())),
    credentials: () => ({ github: laneAccessConfigOf(configStore.config, null).readToken, posthog: readPosthogReadConnection(configStore.config) }),
    telemetry,
    startWatcher: createRemoteWatcherStarter({
      resolveWatcherUrl: async () => configuredDoormanUrl ?? localDoormanUrl(glimmervoidHomeDir(), port),
      prepareWatcher: prepareLocalDoorman,
    }),
    onGithubAppTokenChange: () => laneAssembly.restartServiceLanes(),
  });
  githubAppGrantsOfLink = { tokenFor: watcherLink.githubAppTokenFor, tokens: watcherLink.githubAppTokens, hasAny: watcherLink.hasGithubAppGrants };
  githubUserCredentialOfLink = watcherLink.githubUserCredential;
  const announceHostReadyChanged = () => { broadcastControl?.({ type: 'host-ready-changed', timestamp: clock.nowMs() }); };
  const commitSigning = createCommitSigning({ store: hostSigningKeys, githubUserCredential: () => githubUserCredentialOfLink(), githubConnectionState: () => watcherLink.githubConnection('read'), onChanged: announceHostReadyChanged });
  const githubConnection = followingGithubConnection(watcherLink.githubConnection, commitSigning, announceHostReadyChanged);
  const hostReady = createHostReady({ githubConnection: () => githubConnection('read'), commitSigningStatus: () => commitSigning.act('read'), ghShimDir });
  const idleStop = startIdleStop({
    liveSessions: allLiveSessions,
    requestHostStop: watcherLink.requestHostStop,
    reportStopRequested: (properties) => telemetry.capture('idle_stop_requested', properties),
    onHostWoke: watcherLink.hostWoke,
    nextWakeAt: () => agentApi?.sessionWakes.nextWakeAt() ?? null,
  });
  const awakeUsageAlerts = startAwakeUsageAlerts({
    readAwakeUsage: watcherLink.readAwakeUsage,
    notify: (name, category, message) => { notificationManager.trigger(name, category, message); },
    statePath: configSiblingPath(configStore.configPath, 'awake-usage-alerts.json'),
  });
  watcherLink.whenLinked(awakeUsageAlerts.check);
  const githubConnectionAlerts = startGithubConnectionAlerts({
    githubConnection,
    noticeOfKeyGoneFromGithub: commitSigning.noticeOfKeyGoneFromGithub,
    notify: (name, category, message) => { notificationManager.trigger(name, category, message); },
    statePath: configSiblingPath(configStore.configPath, 'github-connection-alerts.json'),
  });
  watcherLink.whenLinked(githubConnectionAlerts.check);
  let stopConfigWatch: (() => void) | null = null;
  const shutdown = createBackendShutdown({
    configStore,
    bootWork,
    ownedPaths: laneAssembly.ownedPaths,
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
    taskTitleSessions: laneAssembly.taskTitleSessions,
    questionManagerSessions: laneAssembly.questionManagerSessions,
    raceSessions: laneAssembly.raceSessions,
    branchGc,
    posthog,
    teamReview,
    myPrs,
    packStore,
    packSources: laneAssembly.packSources,
    community,
    workflows: laneAssembly.workflows,
    races: laneAssembly.races,
    starHint: laneAssembly.starHint,
    usage,
    traceWiring,
    uploadsWiring,
    traceChangeBroadcast,
    taskTitleRefiner: laneAssembly.taskTitleRefiner,
    telegramOutbox,
    heartbeat,
    outcomes,
    telemetry,
    watcherLink,
    idleStop,
    awakeUsageAlerts,
    githubConnectionAlerts,
    remoteListenerPortFile: { stop: withdrawRemoteListenerPort },
    controlWss,
    dataWss,
  });
  const lifecycleServers: Server[] = [agentIngressServer];
  const remoteListenerPortFile = remoteListenerPortPath(glimmervoidHomeDir(), port);
  const remoteListenerPortOwner = `${process.pid}-${crypto.randomUUID()}`;
  function publishRemoteListenerPort(boundPort: number): void {
    fs.mkdirSync(path.dirname(remoteListenerPortFile), { recursive: true });
    fs.writeFileSync(remoteListenerPortFile, `${boundPort}\n${remoteListenerPortOwner}\n`);
  }
  function withdrawRemoteListenerPort(): void {
    const publishedText = fs.existsSync(remoteListenerPortFile) ? fs.readFileSync(remoteListenerPortFile, 'utf8') : '';
    if (publishedText.split('\n')[1] === remoteListenerPortOwner) fs.rmSync(remoteListenerPortFile, { force: true });
  }
  watcherLink.registerProbeSource({
    ...laneAssembly.githubStore.probeSource,
    onWatcherProblem: (problem) => {
      for (const githubLane of [laneAssembly.myPrs, laneAssembly.teamReview, laneAssembly.workflows]) githubLane.setWatcherProblem(problem);
    },
  });
  laneAssembly.githubStore.onProbesMayHaveChanged(watcherLink.probesMayHaveChanged);
  if (agentApi) {
    watcherLink.registerAlarmSource(agentApi.sessionWakes);
    agentApi.sessionWakes.onAlarmsMayHaveChanged(watcherLink.probesMayHaveChanged);
  }
  for (const posthogLane of [laneAssembly.posthog, laneAssembly.community]) {
    watcherLink.registerProbeSource(posthogLane.probeSource);
    posthogLane.onProbesMayHaveChanged(watcherLink.probesMayHaveChanged);
  }
  const { requestShutdown, requestRestart } = createLifecycle({
    shutdown,
    httpServer,
    extraServers: lifecycleServers,
    onRestart: options.onRestart || null,
    exit: options.exit,
    spawn,
    beforeHandOff: updateApply.handOffStagedUpdate,
  });

  ({ removeExitedSession, raceLauncher } = createBackendControl({
    onControlConnection,
    sessions,
    agentSessions,
    markChildWorktreeDiscard: (childId) => agentApi?.markChildWorktreeDiscard(childId),
    sessionWakes: {
      pendingWakesBySession: () => agentApi?.sessionWakes.pendingWakesBySession() ?? [],
      cancelForOperator: async (sessionId, wakeId) => agentApi ? agentApi.sessionWakes.cancelForOperator(sessionId, wakeId) : 'Wakes are not available yet',
    },
    githubAppGrants,
    githubUserCredential: () => githubUserCredentialOfLink(),
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    agentAccounts,
    remoteSetup,
    telegramDelivery: notifications.telegramDelivery,
    generateProjectId,
    makeSession,
    wireSessionEvents,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    acknowledgeSeenAlert,
    setTerminalColors,
    buildHealthSnapshot,
    getUpdateStatus: updateCheck.getStatus,
    getUpdateJournal: updateApply.getJournal,
    getPostTurnLeftoversNotice: () => (repositoriesTrackingPostTurnReports.length > 0 ? postTurnLeftoversMessage() : null),
    recheckPostTurnLeftovers,
    checkNow: updateCheck.checkNow,
    applyUpdate: updateApply.applyUpdate,
    noteRestartRequested: () => {
      updateApply.noteRestartRequested();
      updateCheck.refreshApplyAvailability();
    },
    laneAssembly,
    posthog,
    teamReview,
    community,
    myPrs,
    usage,
    readTracePage: traceWiring?.readTracePage ?? null,
    sessionDocs,
    secrets: secretsBroker,
    testSecretSource,
    githubConnection,
    commitSigning,
    hostReady,
    whiteboards,
    reviews,
    changeMaps,
    coherenceFeed,
    serverBuild: () => serverBuild,
    telemetry,
    logger: console,
  }));

  webSockets.attachDataConnection();
  const { handleUpgrade } = webSockets;
  httpServer.on('upgrade', handleUpgrade);
  updateApply.startAfterListening(httpServer);
  httpServer.once('listening', startPostTurnLeftoverCleanup);

  broadcastSettings = () => broadcastControl?.({ type: 'settings-updated', settings: buildSettingsPayload({ configStore }) });
  stopConfigWatch = configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
    broadcastSettings?.();
    broadcastControl?.({ type: 'secret-approvals', projects: secretsBroker.approvalRows() });
    secretsBroker.refreshCards();
  }, { reloadDebounceMs: options.configReloadDebounceMs });
  updateCheck.start();

  return {
    shutdown,
    watcherLink,
    requestShutdown,
    requestRestart,
    handOffStagedUpdate: updateApply.handOffStagedUpdate,
    port,
    hookPort: getHookPort,
    app,
    telemetry,
    version: packageJson.version,
    getSession: getSessionAny,
    getLane: laneAssembly.current,
    whiteboards,
    bindHost: bindDecision.host,
    remote: {
      configuredPort: remote.port,
      publicHost: remote.publicHost,
      markBound(boundPort: number) {
        trust.markRemoteListenerBound(boundPort);
        publishRemoteListenerPort(boundPort);
      },
      attach(remoteHttpServer: Server) {
        remoteHttpServer.on('request', (request, response) => {
          if (request.url?.split('?')[0] === NUDGES_PATH) {
            watcherLink.answerNudgeRequest(request, response);
            return;
          }
          app(request, response);
        });
        remoteHttpServer.on('upgrade', handleUpgrade);
        lifecycleServers.push(remoteHttpServer);
      },
    },
  };
}

type Backend = ReturnType<typeof createBackend>;

async function startBackendLinks(backend: Backend): Promise<Server> {
  const remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  await new Promise<void>((resolve, reject) => {
    remoteServer.once('error', reject);
    remoteServer.listen(backend.remote.configuredPort ?? 0, backend.bindHost, () => {
      remoteServer.off('error', reject);
      resolve();
    });
  });
  const address = remoteServer.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : 0;
  backend.remote.markBound(boundPort);
  console.log(`Glimmervoid remote listener on http://${backend.bindHost}:${boundPort} (paired devices only)`);
  console.log(`  proxy target for ${backend.remote.publicHost || '(remote.publicHost not set)'}; pair a device with: glimmervoid pair`);
  backend.watcherLink.start().catch((error: unknown) => {
    console.warn(`[watcher] link failed to start, lanes keep their own timers: ${errorMessage(error)}`);
  });
  return remoteServer;
}

export {
  createBackend, startBackendLinks, runAutoResume, persistSessionField, decideWasActiveFlip, carryWorktreeAcrossRecreate,
  reconcileSessionWorktrees, shouldStartAfterModify,
};
