import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import { chatApprovalModeFor } from '../../session/core/claude-approval-core.ts';
import path from 'node:path';
import { sessionUploadsDirectory } from '../uploads-wiring.ts';

import type { HookRouter } from '../../detection/hook-source.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import type { QuestionManagerPort } from '../../session/session-approval-holds.ts';
import type { TerminalColors } from '../../session/core/terminal-color-query.ts';
import { createRecorder } from '../../session/session-recorder.ts';
import type { GitWorkspace } from '../../session/worktree/worktree-lifecycle-context.ts';
import { Session } from '../../session/sessions.ts';
import type { PrepareSandbox, SessionOptions } from '../../session/sessions.ts';
import { DEFAULT_AGENT_ID, projectHookConfigRelPaths } from '../../session/adapters/index.ts';
import { resolveSessionAccountHome } from '../../session/core/agent-account-core.ts';
import type { SessionAccountHome } from '../../session/core/agent-account-core.ts';
import { SHELL_AGENT_ID } from '../../shared/contracts/config.ts';
import { DEFAULT_CONFIG } from '../config-store.ts';
import { seedWorktreeDependencies } from '../git/dependency-clone.ts';
import { runGit } from '../git/git-exec.ts';
import { GITHUB_CREDENTIAL_SCOPE } from '../../session/core/git-credential-env.ts';
import type { HostSigningKeyStore } from '../commit-signing.ts';
import { hasGhOutside } from '../ssh-signing.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import { configuredIntegrationBranch, configuredWorktreeRoot } from '../core/integration-branch-core.ts';
import { machineSkipsPermissionsByDefault, projectSkipsPermissions } from './core/session-registry-core.ts';
import { ensureSessionTempFolder } from '../session-temp/session-temp.ts';
import type { PackAgentLaunch } from '../../session/core/pack-session-core.ts';
import { resolveUsageConfig } from '../usage/usage-wiring.ts';
import type { SecretsBroker } from '../secrets/secrets-broker.ts';
import type { PackMcpLaunchHold, PackMcpServer } from '../../shared/contracts/pack.ts';
import { packMcpLaunchOf, packSecretNamesOf } from '../packs/core/pack-core.ts';

type SessionSpawnOverrides = Pick<SessionOptions,
  'requireWorktree' | 'gitWorkspace' | 'settingsPermissions' | 'hookTools' | 'dangerouslySkipPermissions' | 'agent' | 'agentDepth' | 'ownerId' | 'holdsQuestionsForParent' | 'ephemeral' | 'initialPrompt' | 'doneMeans' | 'extraClaudeArgs' | 'extraUserHooks' | 'prependPathDirs' | 'spawnEnv'>;

interface SessionFactoryDependencies {
  configStore: { configPath: string };
  getConfig?: () => GlimmervoidConfig;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: () => number | null;
  getGitWorkspace: () => GitWorkspace | null;
  resolveHookTools: (config: GlimmervoidConfig) => ResolvedHookTool[];
  getUserHooks: (projectId: string) => UserHook[];
  getTerminalColors?: () => TerminalColors;
  questionManager?: { forSession: (session: { projectPath: string; isOn: boolean }) => QuestionManagerPort } | null;
  commitSigningProgram?: string | null;
  gitCredentialProgram?: string | null;
  ghShimDir?: string | null;
  hostSigningKeys?: Pick<HostSigningKeyStore, 'gitEnvFor'> | null;
  homeDir?: string;
  getPackAgentLaunch?: () => PackAgentLaunch | null;
  getSecretsBroker?: () => Pick<SecretsBroker, 'holdForLaunch' | 'deniedLaunchNames'> | null;
  sessionSandboxFor?: ((sessionTempFolder: string | null) => PrepareSandbox) | null;
  packMcpServers?: ((agentId: string, cwd: string) => Promise<PackMcpServer[]>) | null;
  sharedPackMcpServers?: ((agentId: string) => PackMcpServer[]) | null;
}

const OPENROUTER_LAUNCH_REASON = 'the agent starts on OpenRouter with this key';
const PACK_SERVER_LAUNCH_REASON = 'a pack MCP server sends it as a bearer token';

type NeedingProject = Parameters<SecretsBroker['holdForLaunch']>[0];

type PackSecretBroker = Pick<SecretsBroker, 'holdForLaunch' | 'deniedLaunchNames'>;
type SecretValues = Readonly<Record<string, string>>;
type SecretValuesHold = { values: SecretValues } | { held: Promise<SecretValues> };

async function settledValuesOf(hold: SecretValuesHold): Promise<SecretValues> {
  return 'held' in hold ? hold.held : hold.values;
}

async function readablePackSecrets(project: NeedingProject, secretNames: readonly string[], broker: PackSecretBroker): Promise<SecretValuesHold> {
  const deniedNames = broker.deniedLaunchNames(project, secretNames);
  const askedNames = secretNames.filter((name) => !deniedNames.includes(name));
  if (askedNames.length === 0) return { values: {} };
  const hold = await broker.holdForLaunch(project, askedNames, PACK_SERVER_LAUNCH_REASON);
  if (!('held' in hold)) return { values: 'valuesByName' in hold ? hold.valuesByName : {} };
  const valuesOnceAnswered = hold.held.then(async (outcome) => {
    if ('valuesByName' in outcome) return outcome.valuesByName;
    const isAnyNameNewlyDenied = broker.deniedLaunchNames(project, askedNames).length > 0;
    return isAnyNameNewlyDenied ? settledValuesOf(await readablePackSecrets(project, askedNames, broker)) : {};
  });
  return { held: valuesOnceAnswered };
}

async function packMcpLaunchFor(servers: readonly PackMcpServer[], project: NeedingProject, broker: PackSecretBroker | null): Promise<PackMcpLaunchHold> {
  const secretNames = packSecretNamesOf(servers);
  if (secretNames.length === 0 || broker === null) return packMcpLaunchOf(servers, {});
  const secrets = await readablePackSecrets(project, secretNames, broker);
  if ('held' in secrets) return { held: secrets.held.then((values) => packMcpLaunchOf(servers, values)) };
  return packMcpLaunchOf(servers, secrets.values);
}

function gitCredentialHelperResolverFor(helperProgram: string | null | undefined, isSandboxed: boolean): ((cwd: string) => Promise<string | null>) | null {
  if (!helperProgram) return null;
  if (isSandboxed) return async () => helperProgram;
  return async (cwd) => {
    const ownHelper = await runGit(['config', '--get-urlmatch', 'credential.helper', GITHUB_CREDENTIAL_SCOPE], { cwd });
    return ownHelper.ok && ownHelper.out !== '' ? null : helperProgram;
  };
}

function createSessionFactory(dependencies: SessionFactoryDependencies) {
  const resolveGitCredentialHelper = gitCredentialHelperResolverFor(dependencies.gitCredentialProgram, Boolean(dependencies.sessionSandboxFor));
  function planLimitsEnabled(config: GlimmervoidConfig): boolean {
    return resolveUsageConfig(config.usage).enabled;
  }

  function ghShimDirsForSpawn(): string[] {
    const shimDir = dependencies.ghShimDir;
    return shimDir && hasGhOutside(shimDir, process.env.PATH) ? [shimDir] : [];
  }

  return function makeSession(
    project: ProjectEntry,
    config: GlimmervoidConfig,
    overrides: SessionSpawnOverrides = {},
  ): Session {
    const skipPermissions = projectSkipsPermissions(project, machineSkipsPermissionsByDefault(config));
    const hookToolConfig = (currentConfig: GlimmervoidConfig): GlimmervoidConfig => project.saneYolo === true ? { ...currentConfig, saneYolo: true } : currentConfig;
    const originalHookTools = dependencies.resolveHookTools(hookToolConfig(config));
    const resolveAccountHome = (): SessionAccountHome => {
      const liveConfig = dependencies.getConfig?.() ?? config;
      const liveProject = liveConfig.projects.find((candidate) => candidate.id === project.id) ?? project;
      return resolveSessionAccountHome(liveConfig.agentAccounts ?? [], liveProject.accountId, overrides.agent ?? liveProject.agent ?? DEFAULT_AGENT_ID);
    };
    const isMachineShell = (overrides.agent ?? project.agent) === SHELL_AGENT_ID;
    const packMcpServersOf = isMachineShell || overrides.ephemeral ? null : dependencies.packMcpServers ?? null;
    const sessionTempFolder = ensureSessionTempFolder(project.id);
    const session = new Session({
      id: project.id,
      name: project.name,
      customTitle: project.customTitle,
      taskTitleState: project.taskTitleState,
      prLinks: project.prLinks,
      agentDoneLines: project.agentDoneLines,
      path: project.path,
      workspaceRepos: project.repos,
      dangerouslySkipPermissions: skipPermissions,
      chatUploadsDirectory: sessionUploadsDirectory(dependencies.configStore.configPath, project.id),
      readChatApprovals: () => chatApprovalModeFor((dependencies.getConfig?.() ?? config).sessionChat?.enabled === true, skipPermissions),
      agent: project.agent,
      agentSetup: project.agentSetup ?? null,
      isCleanHome: project.agentHome === 'clean',
      startSha: project.startSha ?? null,
      raceId: project.raceId ?? null,
      branchOf: project.branchOf ?? null,
      bypassHookTrust: project.codexBypassHookTrust === true,
      replayBufferKB: config.replayBufferKB,
      hookRouter: dependencies.hookRouter,
      getHookPort: dependencies.getHookPort,
      gitWorkspace: isMachineShell ? null : dependencies.getGitWorkspace(),
      integrationBranch: project.baseBranch || configuredIntegrationBranch(config),
      autoRebase: project.isStartPinned !== true,
      syncOnStart: true,
      liveWorktreeReview: config.liveWorktreeReview !== false,
      worktreeRoot: configuredWorktreeRoot(config, project.path),
      worktreeShare: config.worktree?.share ?? DEFAULT_CONFIG.worktree.share,
      seedDependencies: (seedArgs) => seedWorktreeDependencies({ ...seedArgs, hookConfigRelPaths: projectHookConfigRelPaths() }),
      hookTools: originalHookTools,
      resumeSessionId: (project.resumeSessionId as string | null | undefined) || null,
      planLimits: planLimitsEnabled(config),
      getUserHooks: () => dependencies.getUserHooks(project.id),
      getTerminalColors: dependencies.getTerminalColors ?? null,
      sharedPackMcpServers: isMachineShell ? null : dependencies.sharedPackMcpServers ?? null,
      packMcpServers: packMcpServersOf === null ? null : async (agentId, cwd) => packMcpLaunchFor(await packMcpServersOf(agentId, cwd), { id: project.id, project: project.path, cwd }, dependencies.getSecretsBroker?.() ?? null),
      commitSigningProgram: dependencies.commitSigningProgram ?? null,
      resolveGitCredentialHelper,
      resolveHostSigningEnv: dependencies.hostSigningKeys?.gitEnvFor ?? null,
      questionManager: isMachineShell ? null : dependencies.questionManager?.forSession({ projectPath: project.path, isOn: project.questionManagerOn === true }) ?? null,
      resolveAccountHome,
      getPackAgentLaunch: isMachineShell ? null : dependencies.getPackAgentLaunch ?? null,
      resolveLaunchSecrets: async ({ names, cwd }) => {
        const broker = dependencies.getSecretsBroker?.() ?? null;
        if (broker === null) return { refusal: `${names.join(', ')} cannot be read: the vault is not ready` };
        return broker.holdForLaunch({ id: project.id, project: project.path, cwd }, names, OPENROUTER_LAUNCH_REASON);
      },
      prepareSandbox: dependencies.sessionSandboxFor?.(sessionTempFolder) ?? null,
      ...overrides,
      prependPathDirs: [...ghShimDirsForSpawn(), ...(overrides.prependPathDirs ?? [])],
      spawnEnv: sessionTempFolder ? { CLAUDE_CODE_TMPDIR: sessionTempFolder, ...(overrides.spawnEnv ?? {}) } : overrides.spawnEnv,
    });
    const captureConfig = {
      ...(config.capture || {}),
      baseDir: path.join(path.dirname(dependencies.configStore.configPath), 'recordings'),
    };
    const recorder = createRecorder(project.name, captureConfig, true);
    if (recorder) session.setRecorder(recorder);
    return session;
  };
}

export { createSessionFactory };
export type { SessionSpawnOverrides };
