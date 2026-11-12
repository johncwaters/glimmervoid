import path from 'node:path';
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
import { createSshSigner, installCommitSigningShim } from '../ssh-signing.ts';
import { createClaudeCredentials } from '../claude-credentials.ts';
import { commandFor, getAdapter } from '../../session/adapters/index.ts';
import { createAgentConnect } from '../agent-login/agent-connect.ts';
import { createAgentAccounts } from '../agent-login/agent-accounts.ts';
import codexAdapter, { readHostCodexVersion } from '../../session/adapters/codex.ts';
import { createCodexCredentials } from '../codex-credentials.ts';
import { chatgptAuthTokensLogin, chatgptAuthTokensRefreshResult } from '../core/codex-credentials-core.ts';
import type { createCoderEnvWiring } from '../coder/coder-env-wiring.ts';
import { createQuestionManager } from '../question-manager/question-manager.ts';
import type { QuestionManagerLane } from '../question-manager/question-manager.ts';
import { DEFAULT_TERMINAL_COLORS } from '../../session/core/terminal-color-query.ts';
import type { TerminalColors } from '../../session/core/terminal-color-query.ts';
import { clock } from '../../shared/clock.ts';
import { createPackSessionFiles } from '../packs/pack-session-files.ts';

interface BackendSessionRuntimeDependencies {
  config: GlimmervoidConfig;
  configStore: ConfigStore;
  getGitWorkspace: () => GitWorkspace | null;
  getBroadcastControl: () => ControlBroadcast | null;
  recordOutcome?: OutcomeRecorder;
  logger: Pick<Console, 'warn'>;
  getCoderEnv?: () => Pick<ReturnType<typeof createCoderEnvWiring>, 'resume' | 'uploadFile' | 'describeRemoteExit'> | null;
  getQuestionManagerLane?: () => QuestionManagerLane | null;
  liveSessionNamesUsing: (accountId: string) => string[];
  onConfigSaved: (config: GlimmervoidConfig) => void;
}

const REMOTE_SESSION_TOKEN_LIFETIME_SECONDS = 600;
const FORCED_CODEX_REFRESH_INTERVAL_MS = 5 * 60_000;

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
  const sshSigner = commitSigningProgram ? createSshSigner() : null;
  const claudeCommand = () => commandFor('claude-code').path;
  const agentLoginsRoot = configSiblingPath(dependencies.configStore.configPath, 'agent-logins');
  const claudeCredentials = createClaudeCredentials({ claudeCommand, connectedConfigDir: path.join(agentLoginsRoot, 'claude-code') });
  const codexCredentials = createCodexCredentials({
    connectedCodexHome: path.join(agentLoginsRoot, 'codex'),
    codexCommand: () => {
      const command = codexAdapter.buildSpawnCommand({ platform: process.platform, resolved: commandFor(codexAdapter), settingsArgs: [], agentArgs: [] });
      return { file: command.file, argsBeforeAppServer: command.args };
    },
  });
  const launchAgentCommand = (agent: string, agentArgs: string[]) => {
    const adapter = getAdapter(agent);
    const resolved = adapter ? commandFor(adapter) : null;
    if (!adapter || !resolved?.path) return null;
    const command = adapter.buildSpawnCommand({ platform: process.platform, resolved, settingsArgs: [], agentArgs });
    return { ...command, env: adapter.buildEnv(process.env, null) };
  };
  const agentConnect = createAgentConnect({
    loginsRoot: agentLoginsRoot,
    loginSource: (agent) => (agent === 'codex' ? codexCredentials.loginSource() : claudeCredentials.loginSource()),
    launchFor: launchAgentCommand,
    onChange: (logins) => dependencies.getBroadcastControl()?.({ type: 'agent-logins', logins }),
  });
  const agentAccounts = createAgentAccounts({
    accountsRoot: configSiblingPath(dependencies.configStore.configPath, 'agent-accounts'),
    configStore: dependencies.configStore,
    launchFor: launchAgentCommand,
    liveSessionNamesUsing: dependencies.liveSessionNamesUsing,
    onConfigSaved: dependencies.onConfigSaved,
    onChange: (accounts) => dependencies.getBroadcastControl()?.({ type: 'agent-accounts', accounts }),
  });
  void agentConnect.refresh();
  void agentAccounts.refresh();
  const codexLogin = (resolved: Awaited<ReturnType<typeof codexCredentials.hostLogin>>) => {
    if (!resolved.ok) throw new Error(resolved.reason);
    return resolved.login;
  };
  const lastForcedCodexRefreshAtMsByHome = new Map<string, number>();
  const rateLimitedCodexRefresh = (accountCodexHome: string | null) => {
    const nowMs = clock.nowMs();
    const homeKey = accountCodexHome ?? '';
    const lastForcedRefreshAtMs = lastForcedCodexRefreshAtMsByHome.get(homeKey);
    const isWithinForcedRefreshWindow = lastForcedRefreshAtMs !== undefined && nowMs - lastForcedRefreshAtMs < FORCED_CODEX_REFRESH_INTERVAL_MS;
    if (isWithinForcedRefreshWindow) return codexCredentials.hostLogin(accountCodexHome);
    lastForcedCodexRefreshAtMsByHome.set(homeKey, nowMs);
    return codexCredentials.refreshedHostLogin(accountCodexHome);
  };
  let terminalColors: TerminalColors = DEFAULT_TERMINAL_COLORS;
  const setTerminalColors = (colors: TerminalColors) => { terminalColors = colors; };
  const packSessionFiles = createPackSessionFiles({ root: configSiblingPath(dependencies.configStore.configPath, 'pack-session-files') });
  const makeSession = createSessionFactory({
    getPackAgentLaunch: packSessionFiles.launch,
    commitSigningProgram,
    getCoderEnv: dependencies.getCoderEnv,
    claudeToken: (accountFolder) => claudeCredentials.resolveArmToken(REMOTE_SESSION_TOKEN_LIFETIME_SECONDS, undefined, accountFolder),
    codexVersion: readHostCodexVersion,
    codexLoginParams: async (accountFolder) => chatgptAuthTokensLogin(await codexLogin(await codexCredentials.hostLogin(accountFolder))),
    codexRefreshResult: async (accountFolder) => chatgptAuthTokensRefreshResult(await codexLogin(await rateLimitedCodexRefresh(accountFolder))),
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

  return { agentAccounts, agentConnect, agentIngressServer, claudeCommand, claudeCredentials, getHookPort, hookRouter, makeSession, packSessionFiles, setTerminalColors, sshSigner };
}

export { createBackendSessionRuntime };
