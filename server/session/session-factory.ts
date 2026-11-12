import { resolveCoherence } from '../coherence/coherence-runtime.ts';
import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import path from 'node:path';

import type { HookRouter } from '../../detection/hook-source.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import type { QuestionManagerPort } from '../../session/session-approval-holds.ts';
import type { TerminalColors } from '../../session/core/terminal-color-query.ts';
import { createRecorder } from '../../session/session-recorder.ts';
import type { GitWorkspace } from '../../session/worktree/worktree-lifecycle-context.ts';
import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import { getAdapter, projectHookConfigRelPaths } from '../../session/adapters/index.ts';
import { SHELL_AGENT_ID } from '../../shared/contracts/config.ts';
import { DEFAULT_CONFIG } from '../config-store.ts';
import { seedWorktreeDependencies } from '../git/dependency-clone.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import { configuredIntegrationBranch, configuredWorktreeRoot } from '../core/integration-branch-core.ts';
import { machineSkipsPermissionsByDefault, projectSkipsPermissions } from './core/session-registry-core.ts';
import { ensureSessionTempFolder } from '../session-temp/session-temp.ts';
import { resolveUsageConfig } from '../usage/usage-wiring.ts';

type SessionSpawnOverrides = Pick<SessionOptions,
  'requireWorktree' | 'gitWorkspace' | 'settingsPermissions' | 'hookTools' | 'dangerouslySkipPermissions' | 'agent' | 'agentDepth' | 'ownerId' | 'holdsQuestionsForParent' | 'ephemeral' | 'initialPrompt' | 'extraClaudeArgs' | 'extraUserHooks' | 'prependPathDirs' | 'spawnEnv'>;

interface SessionFactoryDependencies {
  configStore: { configPath: string; isExperimentalBuild?: boolean };
  getConfig?: () => GlimmervoidConfig;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: () => number | null;
  getGitWorkspace: () => GitWorkspace | null;
  resolveHookTools: (config: GlimmervoidConfig) => ResolvedHookTool[];
  getUserHooks: (projectId: string) => UserHook[];
  getTerminalColors?: () => TerminalColors;
  questionManager?: { forSession: (session: { projectPath: string; isOn: boolean }) => QuestionManagerPort } | null;
  commitSigningProgram?: string | null;
  homeDir?: string;
}

function createSessionFactory(dependencies: SessionFactoryDependencies) {
  function planLimitsEnabled(config: GlimmervoidConfig): boolean {
    const usageConfig = resolveUsageConfig(config.usage);
    return usageConfig.enabled && usageConfig.planLimits;
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
      isSettingOn: dependencies.configStore.isExperimentalBuild === true && (dependencies.getConfig?.() ?? config).coherence?.enabled !== false,
    });
    const isMachineShell = (overrides.agent ?? project.agent) === SHELL_AGENT_ID;
    const sessionTempFolder = ensureSessionTempFolder(project.id);
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
      agentSetup: project.agentSetup ?? null,
      isCleanHome: project.agentHome === 'clean',
      startSha: project.startSha ?? null,
      bypassHookTrust: project.codexBypassHookTrust === true,
      replayBufferKB: config.replayBufferKB,
      hookRouter: dependencies.hookRouter,
      getHookPort: dependencies.getHookPort,
      gitWorkspace: isMachineShell ? null : dependencies.getGitWorkspace(),
      integrationBranch: project.baseBranch || configuredIntegrationBranch(config),
      autoRebase: config.worktree?.autoRebase !== false && project.isStartPinned !== true,
      syncOnStart: config.worktree?.syncOnStart !== false,
      liveWorktreeReview: config.liveWorktreeReview !== false,
      worktreeRoot: configuredWorktreeRoot(config, project.path),
      worktreeShare: config.worktree?.share ?? DEFAULT_CONFIG.worktree.share,
      seedDependencies: config.worktree?.cloneDependencies === false ? null : (seedArgs) => seedWorktreeDependencies({ ...seedArgs, hookConfigRelPaths: projectHookConfigRelPaths() }),
      detectBackgroundAgents: config.detectBackgroundAgents,
      detectScheduledWakeups: config.detectScheduledWakeups,
      hookTools: originalHookTools,
      resumeSessionId: (project.resumeSessionId as string | null | undefined) || null,
      planLimits: planLimitsEnabled(config),
      getUserHooks: () => dependencies.getUserHooks(project.id),
      getTerminalColors: dependencies.getTerminalColors ?? null,
      prepareCoherence: isMachineShell ? null : prepareCoherence,
      commitSigningProgram: dependencies.commitSigningProgram ?? null,
      questionManager: isMachineShell ? null : dependencies.questionManager?.forSession({ projectPath: project.path, isOn: project.questionManagerOn === true }) ?? null,
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
