import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HookRouter } from '../../detection/hook-source.ts';
import { sweepOrphans } from '../../detection/settings-injector.ts';
import { hooksForProject } from '../../session/core/user-hooks-core.ts';
import type { GitWorkspace } from '../../session/worktree/worktree-lifecycle-context.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import type { ConfigStore, GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { resolveHookTools } from '../hook-tools.ts';
import { createSessionFactory } from '../session/session-factory.ts';
import type { SessionIsolation } from '../session/session-factory.ts';
import { ensureEverySandboxedHomesRoot } from '../../session/agent-home.ts';
import { DEFAULT_AGENT_ID } from '../../session/adapters/index.ts';
import { selfLaunch } from '../runtime-paths.ts';
import { createSshSigner, installCommitSigningShim, installGhShim, installGitCredentialShim } from '../ssh-signing.ts';
import { createHostSigningKeyStore } from '../commit-signing.ts';
import { commandFor, getAdapter } from '../../session/adapters/index.ts';
import { createAgentAccounts } from '../agent-login/agent-accounts.ts';
import { createQuestionManager } from '../question-manager/question-manager.ts';
import type { QuestionManagerLane } from '../question-manager/question-manager.ts';
import { DEFAULT_TERMINAL_COLORS } from '../../session/core/terminal-color-query.ts';
import type { TerminalColors } from '../../session/core/terminal-color-query.ts';
import { createPackSessionFiles } from '../packs/pack-session-files.ts';
import type { SecretsBroker } from '../secrets/secrets-broker.ts';
import { createSessionSandbox, refusingSandbox } from '../sandbox/sandbox-wiring.ts';
import { WARGAMES_SEAT_ROOT_DIR, isWargamesSeatProject } from '../wargames/wargames-launch.ts';
import { listenAgentIngressSocket } from './backend-http.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import type { PackMcpServer } from '../../shared/contracts/pack.ts';

interface BackendSessionRuntimeDependencies {
  config: GlimmervoidConfig;
  configStore: ConfigStore;
  getGitWorkspace: () => GitWorkspace | null;
  getBroadcastControl: () => ControlBroadcast | null;
  recordOutcome?: OutcomeRecorder;
  logger: Pick<Console, 'warn'>;
  getQuestionManagerLane?: () => QuestionManagerLane | null;
  getSecretsBroker?: () => Pick<SecretsBroker, 'holdForLaunch' | 'deniedLaunchNames'> | null;
  liveSessionNamesUsing: (accountId: string) => string[];
  githubUserToken: () => Promise<string | null>;
  onConfigSaved: (config: GlimmervoidConfig) => void;
  packMcpServersFor?: (agentId: string, cwd: string) => Promise<PackMcpServer[]>;
  sharedPackMcpServersFor?: (agentId: string) => PackMcpServer[];
}

const SHARED_AGENT_SKILLS_FOLDER = path.join(os.homedir(), '.agents');
const SEAT_CLAUDE_ARGS = ['--strict-mcp-config'];
const SEAT_NEEDS_SANDBOX_PLATFORM = 'Wargames seats run only inside the session sandbox, which needs Linux or macOS';

function createBackendSessionRuntime(dependencies: BackendSessionRuntimeDependencies) {
  const hookRouter = new HookRouter({ recordOutcome: dependencies.recordOutcome });
  const agentIngressServer = http.createServer();
  const getHookPort = (): number | null => {
    const address = agentIngressServer.address();
    if (!address || typeof address !== 'object' || !address.port) return null;
    return address.port;
  };
  try {
    sweepOrphans();
  } catch {}

  const commitSigningProgram = installCommitSigningShim({
    binDir: configSiblingPath(dependencies.configStore.configPath, 'bin'),
    cliLaunch: selfLaunch('cli'),
    log: dependencies.logger,
  });
  const gitCredentialProgram = installGitCredentialShim({
    binDir: configSiblingPath(dependencies.configStore.configPath, 'bin'),
    cliLaunch: selfLaunch('cli'),
    log: dependencies.logger,
  });
  const ghShimDir = installGhShim({
    binDir: configSiblingPath(dependencies.configStore.configPath, 'gh-bin'),
    cliLaunch: selfLaunch('cli'),
    log: dependencies.logger,
  });
  const hostSigningKeys = createHostSigningKeyStore({ folder: configSiblingPath(dependencies.configStore.configPath, 'commit-signing') });
  const sshSigner = commitSigningProgram ? createSshSigner({ hostSigningKeys }) : null;
  const launchAgentCommand = (agent: string, agentArgs: string[]) => {
    const adapter = getAdapter(agent);
    const resolved = adapter ? commandFor(adapter) : null;
    if (!adapter || !resolved?.path) return null;
    const command = adapter.buildSpawnCommand({ platform: process.platform, resolved, settingsArgs: [], agentArgs });
    return { ...command, env: adapter.buildEnv(process.env, null) };
  };
  const agentAccounts = createAgentAccounts({
    accountsRoot: configSiblingPath(dependencies.configStore.configPath, 'agent-accounts'),
    configStore: dependencies.configStore,
    launchFor: launchAgentCommand,
    liveSessionNamesUsing: dependencies.liveSessionNamesUsing,
    onConfigSaved: dependencies.onConfigSaved,
    onChange: (accounts) => dependencies.getBroadcastControl()?.({ type: 'agent-accounts', accounts }),
  });
  void agentAccounts.refresh();
  let terminalColors: TerminalColors = DEFAULT_TERMINAL_COLORS;
  const setTerminalColors = (colors: TerminalColors) => { terminalColors = colors; };
  const packSessionFiles = createPackSessionFiles({ root: configSiblingPath(dependencies.configStore.configPath, 'pack-session-files') });
  const sessionSandbox = createSessionSandbox({
    platform: process.platform,
    glimmervoidHome: glimmervoidHomeDir(),
    configPath: dependencies.configStore.configPath,
    agentIngressServer,
    listenIngressSocket: listenAgentIngressSocket,
    getIngressPort: getHookPort,
    getExtraAllowedHosts: () => dependencies.configStore.config.sandboxAllowedHosts ?? [],
    isWeakerNetworkIsolationOn: () => dependencies.configStore.config.sandboxWeakerNetworkIsolation === true,
    getAgentAccountFolders: () => (dependencies.configStore.config.agentAccounts ?? []).map((account) => account.folder),
    githubUserToken: dependencies.githubUserToken,
    logger: dependencies.logger,
  });
  const isSessionSandboxOn = dependencies.config.sessionSandbox === true;
  if (isSessionSandboxOn && sessionSandbox === null) throw new Error(`sessionSandbox is on, but sandboxed sessions run only on Linux and macOS (this machine is ${process.platform})`);
  const seatIsolation = (project: ProjectEntry, sessionTempFolder: string | null): SessionIsolation => {
    if (sessionSandbox === null) return { prepareSandbox: refusingSandbox(SEAT_NEEDS_SANDBOX_PLATFORM), privateHomeKey: null, extraClaudeArgs: [] };
    const hiddenFolders = [WARGAMES_SEAT_ROOT_DIR, ...ensureEverySandboxedHomesRoot(), SHARED_AGENT_SKILLS_FOLDER];
    return { prepareSandbox: sessionSandbox.sandboxFor(sessionTempFolder, hiddenFolders), privateHomeKey: project.id, extraClaudeArgs: (project.agent ?? DEFAULT_AGENT_ID) === DEFAULT_AGENT_ID ? SEAT_CLAUDE_ARGS : [] };
  };
  const isolationForProject = (project: ProjectEntry, sessionTempFolder: string | null): SessionIsolation | null => {
    if (isWargamesSeatProject(project)) return seatIsolation(project, sessionTempFolder);
    if (!isSessionSandboxOn || sessionSandbox === null) return null;
    return { prepareSandbox: sessionSandbox.sandboxFor(sessionTempFolder, []), privateHomeKey: null, extraClaudeArgs: [] };
  };
  const seatSandboxRefusal = async () => sessionSandbox === null ? SEAT_NEEDS_SANDBOX_PLATFORM : sessionSandbox.refusal();
  const makeSession = createSessionFactory({
    isolationForProject,
    getPackAgentLaunch: packSessionFiles.launch,
    getSecretsBroker: dependencies.getSecretsBroker,
    commitSigningProgram,
    gitCredentialProgram,
    ghShimDir,
    hostSigningKeys,
    configStore: dependencies.configStore,
    getConfig: () => dependencies.configStore.config,
    hookRouter,
    getHookPort,
    getGitWorkspace: dependencies.getGitWorkspace,
    resolveHookTools: (config) => resolveHookTools(config, { warn: dependencies.logger.warn.bind(dependencies.logger) }),
    getUserHooks: (projectId: string) => hooksForProject(dependencies.config.hooks, projectId),
    getTerminalColors: () => terminalColors,
    packMcpServers: dependencies.packMcpServersFor ?? null,
    sharedPackMcpServers: dependencies.sharedPackMcpServersFor ?? null,
    questionManager: createQuestionManager({ getSettings: () => dependencies.configStore.config.questionManager, getLane: dependencies.getQuestionManagerLane }),
  });

  const recheckSandboxLogins = () => { sessionSandbox?.recheckLogins(); };

  return { agentAccounts, agentIngressServer, recheckSandboxLogins, seatSandboxRefusal, getHookPort, ghShimDir, hookRouter, hostSigningKeys, makeSession, packSessionFiles, setTerminalColors, sshSigner };
}

export { createBackendSessionRuntime };
