import http from 'node:http';
import { HookRouter } from '../../detection/hook-source.ts';
import { sweepOrphans } from '../../detection/settings-injector.ts';
import { hooksForProject } from '../../session/core/user-hooks-core.ts';
import type { GitWorkspace } from '../../session/worktree/worktree-lifecycle-context.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import type { ConfigStore, GlimmervoidConfig } from '../config-store.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { resolveHookTools } from '../hook-tools.ts';
import { createSessionFactory } from '../session/session-factory.ts';
import { selfLaunch } from '../runtime-paths.ts';
import { createSshSigner, installCommitSigningShim, installGitCredentialShim } from '../ssh-signing.ts';
import { createHostSigningKeyStore } from '../commit-signing.ts';
import { commandFor, getAdapter } from '../../session/adapters/index.ts';
import { createAgentAccounts } from '../agent-login/agent-accounts.ts';
import { createQuestionManager } from '../question-manager/question-manager.ts';
import type { QuestionManagerLane } from '../question-manager/question-manager.ts';
import { DEFAULT_TERMINAL_COLORS } from '../../session/core/terminal-color-query.ts';
import type { TerminalColors } from '../../session/core/terminal-color-query.ts';
import { createPackSessionFiles } from '../packs/pack-session-files.ts';

interface BackendSessionRuntimeDependencies {
  config: GlimmervoidConfig;
  configStore: ConfigStore;
  getGitWorkspace: () => GitWorkspace | null;
  getBroadcastControl: () => ControlBroadcast | null;
  recordOutcome?: OutcomeRecorder;
  logger: Pick<Console, 'warn'>;
  getQuestionManagerLane?: () => QuestionManagerLane | null;
  liveSessionNamesUsing: (accountId: string) => string[];
  onConfigSaved: (config: GlimmervoidConfig) => void;
}

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
  const makeSession = createSessionFactory({
    getPackAgentLaunch: packSessionFiles.launch,
    commitSigningProgram,
    gitCredentialProgram,
    hostSigningKeys,
    configStore: dependencies.configStore,
    getConfig: () => dependencies.configStore.config,
    hookRouter,
    getHookPort,
    getGitWorkspace: dependencies.getGitWorkspace,
    resolveHookTools: (config) => resolveHookTools(config, { warn: dependencies.logger.warn.bind(dependencies.logger) }),
    getUserHooks: (projectId: string) => hooksForProject(dependencies.config.hooks, projectId),
    getTerminalColors: () => terminalColors,
    questionManager: dependencies.configStore.isExperimentalBuild === true
      ? createQuestionManager({ getSettings: () => dependencies.configStore.config.questionManager, getLane: dependencies.getQuestionManagerLane })
      : null,
  });

  return { agentAccounts, agentIngressServer, getHookPort, hookRouter, hostSigningKeys, makeSession, packSessionFiles, setTerminalColors, sshSigner };
}

export { createBackendSessionRuntime };
