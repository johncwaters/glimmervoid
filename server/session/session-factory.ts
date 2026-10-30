import { resolveCoherence } from '../coherence/coherence-runtime.ts';
import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import path from 'node:path';

import type { HookRouter } from '../../detection/hook-source.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import { createRecorder } from '../../session/session-recorder.ts';
import type { GitWorkspace } from '../../session/session-worktree-lifecycle.ts';
import { Session } from '../../session/sessions.ts';
import type { RemoteLaunch, SessionOptions, SessionPlanReviewPort } from '../../session/sessions.ts';
import { getAdapter } from '../../session/adapters/index.ts';
import { SHELL_AGENT_ID } from '../../shared/contracts/config.ts';
import { DEFAULT_CONFIG } from '../config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import { machineSkipsPermissionsByDefault, projectSkipsPermissions } from './core/session-registry-core.ts';
import { remoteCheckoutDirectory } from '../coder/core/coder-env-core.ts';
import { ensureSessionTempFolder } from '../session-temp/session-temp.ts';
import { resolveUsageConfig } from '../usage/usage-wiring.ts';

type SessionSpawnOverrides = Pick<SessionOptions,
  'requireWorktree' | 'gitWorkspace' | 'settingsPermissions' | 'hookTools' | 'dangerouslySkipPermissions' | 'agent' | 'agentDepth' | 'ownerId' | 'holdsQuestionsForParent' | 'ephemeral' | 'initialPrompt' | 'extraClaudeArgs' | 'extraUserHooks' | 'prependPathDirs' | 'spawnEnv'>;

interface SessionFactoryDependencies {
  configStore: { configPath: string };
  getConfig?: () => GlimmervoidConfig;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: () => number | null;
  getGitWorkspace: () => GitWorkspace | null;
  getPlanReviewPort: () => SessionPlanReviewPort | null;
  resolveHookTools: (config: GlimmervoidConfig) => ResolvedHookTool[];
  getUserHooks: (projectId: string) => UserHook[];
  commitSigningProgram?: string | null;
  homeDir?: string;
  getCoderEnv?: () => CoderWorkspacePort | null;
  claudeToken?: () => ReturnType<RemoteLaunch['claudeToken']>;
  codexVersion?: RemoteLaunch['codexVersion'];
  codexLoginParams?: RemoteLaunch['codexLoginParams'];
  codexRefreshResult?: RemoteLaunch['codexRefreshResult'];
}

interface CoderWorkspacePort {
  resume: (request: { projectId: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  describeRemoteExit: (workspace: string) => Promise<string>;
  uploadFile: (file: { workspace: string; remotePath: string; contents: string; mode: number }) => Promise<void>;
}

function createSessionFactory(dependencies: SessionFactoryDependencies) {
  function planLimitsEnabled(config: GlimmervoidConfig): boolean {
    const usageConfig = resolveUsageConfig(config.usage);
    return usageConfig.enabled && usageConfig.planLimits;
  }

  function remoteLaunchFor(builtProject: ProjectEntry, builtMapping: NonNullable<ProjectEntry['environment']>, config: GlimmervoidConfig): RemoteLaunch {
    const projectId = builtProject.id;
    const liveMapping = config.projects.find((project) => project.id === projectId)?.environment;
    const mapping = liveMapping ?? builtMapping;
    const environment = config.coder?.environments?.find((candidate) => candidate.name === mapping.name);
    const coderEnv = liveMapping && environment ? dependencies.getCoderEnv?.() ?? null : null;
    const claudeToken = dependencies.claudeToken;
    const refusal = liveMapping
      ? { ok: false as const, reason: `Coder environment ${mapping.name} is not available` }
      : { ok: false as const, reason: `Coder workspace mapping for ${builtProject.name} was removed; close this session and start a new one` };
    return {
      workspace: mapping.workspace,
      remotePort: mapping.remotePort,
      checkoutDirectory: remoteCheckoutDirectory({ checkoutRoot: environment?.checkoutRoot ?? '/', workspace: mapping.workspace }),
      nodePath: environment?.nodePath ?? 'node',
      ensureRunning: async () => (coderEnv ? coderEnv.resume({ projectId }) : refusal),
      describeExit: async () => (coderEnv ? coderEnv.describeRemoteExit(mapping.workspace) : null),
      uploadFile: async (file) => {
        if (!coderEnv) throw new Error(refusal.reason);
        await coderEnv.uploadFile({ ...file, workspace: mapping.workspace });
      },
      claudeToken: async () => (claudeToken ? claudeToken() : { ok: false, reason: 'no Claude Code login source is wired for remote sessions' }),
      codexVersion: async () => (dependencies.codexVersion ? dependencies.codexVersion() : null),
      codexLoginParams: async () => {
        if (!dependencies.codexLoginParams) throw new Error('no Codex login source is wired for remote sessions');
        return dependencies.codexLoginParams();
      },
      codexRefreshResult: async () => {
        if (!dependencies.codexRefreshResult) throw new Error('no Codex login source is wired for remote sessions');
        return dependencies.codexRefreshResult();
      },
    };
  }

  return function makeSession(
    project: ProjectEntry,
    config: GlimmervoidConfig,
    overrides: SessionSpawnOverrides = {},
  ): Session {
    const skipPermissions = projectSkipsPermissions(project, machineSkipsPermissionsByDefault(config));
    const hookToolConfig = (currentConfig: GlimmervoidConfig): GlimmervoidConfig => project.saneYolo === true ? { ...currentConfig, saneYolo: true } : currentConfig;
    const originalHookTools = dependencies.resolveHookTools(hookToolConfig(config));
    const prepareCoherence = overrides.ephemeral ? null : (cwd: string) => resolveCoherence({
      worktree: cwd, host: getAdapter(overrides.agent ?? project.agent)?.usageVendor,
      isSettingOn: (dependencies.getConfig?.() ?? config).coherence?.enabled === true,
    });
    const builtMapping = project.environment;
    const isMachineShell = (overrides.agent ?? project.agent) === SHELL_AGENT_ID;
    const sessionTempFolder = builtMapping ? null : ensureSessionTempFolder(project.id);
    const session = new Session({
      id: project.id,
      name: project.name,
      customTitle: project.customTitle,
      taskTitleState: project.taskTitleState,
      prLinks: project.prLinks,
      path: project.path,
      workspaceRepos: project.repos,
      dangerouslySkipPermissions: skipPermissions,
      agent: project.agent,
      bypassHookTrust: project.codexBypassHookTrust === true,
      replayBufferKB: config.replayBufferKB,
      hookRouter: dependencies.hookRouter,
      getHookPort: dependencies.getHookPort,
      gitWorkspace: builtMapping || isMachineShell ? null : dependencies.getGitWorkspace(),
      integrationBranch: project.baseBranch || configuredIntegrationBranch(config),
      autoRebase: config.worktreeAutoRebase !== false,
      syncOnStart: config.worktreeSyncOnStart !== false,
      liveWorktreeReview: config.liveWorktreeReview !== false,
      worktreeRoot: config.worktreeRoot || path.join(path.dirname(path.resolve(project.path)), '.glimmervoid-worktrees'),
      worktreeShare: config.worktreeShare || DEFAULT_CONFIG.worktreeShare,
      detectBackgroundAgents: config.detectBackgroundAgents,
      detectScheduledWakeups: config.detectScheduledWakeups,
      hookTools: originalHookTools,
      resumeSessionId: (project.resumeSessionId as string | null | undefined) || null,
      planReviewPort: dependencies.getPlanReviewPort(),
      planLimits: planLimitsEnabled(config),
      getUserHooks: () => dependencies.getUserHooks(project.id),
      prepareCoherence: builtMapping || isMachineShell ? null : prepareCoherence,
      commitSigningProgram: dependencies.commitSigningProgram ?? null,
      getRemoteLaunch: builtMapping ? () => remoteLaunchFor(project, builtMapping, dependencies.getConfig?.() ?? config) : null,
      ...overrides,
      spawnEnv: sessionTempFolder ? { CLAUDE_CODE_TMPDIR: sessionTempFolder, ...(overrides.spawnEnv ?? {}) } : overrides.spawnEnv,
    });
    const captureConfig = {
      ...(config.capture || {}),
      baseDir: path.join(path.dirname(dependencies.configStore.configPath), 'recordings'),
    };
    const recorder = createRecorder(project.name, captureConfig, config.recordSignals ?? DEFAULT_CONFIG.recordSignals);
    if (recorder) session.setRecorder(recorder);
    return session;
  };
}

export { createSessionFactory };
export type { SessionSpawnOverrides };
