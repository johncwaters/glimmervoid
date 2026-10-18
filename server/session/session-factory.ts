import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import { refreshRtkHookTools } from '../../session/core/rtk-settings-core.ts';
import path from 'node:path';

import type { HookRouter } from '../../detection/hook-source.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import { createRecorder } from '../../session/session-recorder.ts';
import type { GitWorkspace } from '../../session/session-worktree-lifecycle.ts';
import { Session } from '../../session/sessions.ts';
import type { SessionOptions, SessionPlanReviewPort } from '../../session/sessions.ts';
import { getAdapter } from '../../session/adapters/index.ts';
import { DEFAULT_CONFIG } from '../config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import type { CoherenceNativeHooks } from '../coherence/coherence-native-hooks.ts';
import { decideCoherenceAttachment } from '../coherence/core/coherence-session-core.ts';
import type { CoherenceSessionKind } from '../coherence/core/coherence-session-core.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import { isSessionGuarded } from '../guardrails/core/guardrails-roles-core.ts';
import { machineSkipsPermissionsByDefault, projectSkipsPermissions } from './core/session-registry-core.ts';
import { expandTilde } from '../usage/core/usage-scan-core.ts';
import type { SessionGuardrails } from '../guardrails/session-guardrails.ts';
import { resolveUsageConfig } from '../usage/usage-wiring.ts';

type SessionSpawnOverrides = Pick<SessionOptions,
  'requireWorktree' | 'gitWorkspace' | 'gitIsolation' | 'settingsPermissions' | 'settingsGuardrails' | 'prepareGuardrails' | 'hookTools' | 'getHookTools' | 'dangerouslySkipPermissions' | 'factoryRole' | 'agent' | 'agentDepth' | 'ephemeral' | 'initialPrompt' | 'extraClaudeArgs' | 'extraUserHooks' | 'prependPathDirs' | 'spawnEnv'>;

interface SessionFactoryDependencies {
  configStore: { configPath: string };
  getConfig?: () => GlimmervoidConfig;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: () => number | null;
  getGitWorkspace: () => GitWorkspace | null;
  getPlanReviewPort: () => SessionPlanReviewPort | null;
  resolveHookTools: (config: GlimmervoidConfig, options: { skipPermissions: boolean }) => ResolvedHookTool[];
  getUserHooks: (projectId: string) => UserHook[];
  sessionGuardrails?: SessionGuardrails;
  commitSigningProgram?: string | null;
  coherenceNativeHooks?: CoherenceNativeHooks | null;
  homeDir?: string;
}

function isConversationViewOnFor(config: GlimmervoidConfig, projectId: string): boolean {
  if (config.conversationView !== true) return false;
  return config.projects.some((project) => project.id === projectId && project.conversationView === true);
}

interface GuardedSessionProject {
  path: string;
  repos?: string[];
  agent?: string | null;
  unguarded?: boolean;
}

function willSessionRunGuarded(project: GuardedSessionProject, config: GlimmervoidConfig, homeDir: string | null): boolean {
  const unguardedRepos = (config.guardrails?.unguardedRepos ?? []).map((repo) => expandTilde(repo, process.env, homeDir));
  return isSessionGuarded({
    usageVendor: getAdapter(project.agent)?.usageVendor ?? null,
    isMarkedUnguarded: project.unguarded === true,
    sessionFolders: [project.path, ...(project.repos ?? [])],
    unguardedRepos,
  });
}

function createSessionFactory(dependencies: SessionFactoryDependencies) {
  function planLimitsEnabled(config: GlimmervoidConfig): boolean {
    const usageConfig = resolveUsageConfig(config.usage);
    return usageConfig.enabled && usageConfig.planLimits;
  }

  function defaultGuardrailsFor(project: ProjectEntry, config: GlimmervoidConfig, overrides: SessionSpawnOverrides): SessionOptions['prepareGuardrails'] {
    if (!dependencies.sessionGuardrails) return null;
    const isGuarded = willSessionRunGuarded({ ...project, agent: overrides.agent ?? project.agent }, config, dependencies.homeDir ?? null);
    return isGuarded ? dependencies.sessionGuardrails.prepareFor({ sessionId: project.id, isWorkspace: Boolean(project.repos?.length) }) : null;
  }

  function isReleasedOnlyByMark(project: ProjectEntry, config: GlimmervoidConfig, overrides: SessionSpawnOverrides): boolean {
    if (project.unguarded !== true || !dependencies.sessionGuardrails) return false;
    return willSessionRunGuarded({ ...project, agent: overrides.agent ?? project.agent, unguarded: false }, config, dependencies.homeDir ?? null);
  }

  return function makeSession(
    project: ProjectEntry,
    config: GlimmervoidConfig,
    overrides: SessionSpawnOverrides = {},
  ): Session {
    const skipPermissions = projectSkipsPermissions(project, machineSkipsPermissionsByDefault(config));
    const originalHookTools = dependencies.resolveHookTools(config, { skipPermissions });
    const sessionKind: CoherenceSessionKind = overrides.factoryRole ? 'factory' : 'writer';
    const coherenceNativeHooks = dependencies.coherenceNativeHooks;
    const coherenceHost = getAdapter(overrides.agent ?? project.agent)?.usageVendor;
    const prepareCoherenceHooks = coherenceNativeHooks && (coherenceHost === 'claude' || coherenceHost === 'codex')
      ? async (cwd: string, { canWriteShims }: { canWriteShims: boolean }) => {
        const isAttached = decideCoherenceAttachment({ sessionKind, isSettingOn: (dependencies.getConfig?.() ?? config).coherence?.enabled === true });
        return isAttached ? coherenceNativeHooks.prepare({ root: cwd, host: coherenceHost, canWriteShims }) : null;
      } : null;
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
      isMarkedUnguarded: project.unguarded === true,
      isGuardrailsReleased: isReleasedOnlyByMark(project, config, overrides),
      isConversationViewEnabled: () => isConversationViewOnFor(dependencies.getConfig?.() ?? config, project.id),
      isConversationViewSettingOn: () => (dependencies.getConfig?.() ?? config).conversationView === true,
      replayBufferKB: config.replayBufferKB,
      hookRouter: dependencies.hookRouter,
      getHookPort: dependencies.getHookPort,
      gitWorkspace: dependencies.getGitWorkspace(),
      integrationBranch: project.baseBranch || configuredIntegrationBranch(config),
      autoRebase: config.worktreeAutoRebase !== false,
      syncOnStart: config.worktreeSyncOnStart !== false,
      liveWorktreeReview: config.liveWorktreeReview !== false,
      worktreeRoot: config.worktreeRoot || path.join(path.dirname(path.resolve(project.path)), '.glimmervoid-worktrees'),
      worktreeShare: config.worktreeShare || DEFAULT_CONFIG.worktreeShare,
      detectBackgroundAgents: config.detectBackgroundAgents,
      detectScheduledWakeups: config.detectScheduledWakeups,
      hookTools: originalHookTools,
      getHookTools: () => refreshRtkHookTools(originalHookTools, dependencies.resolveHookTools(dependencies.getConfig?.() ?? config, { skipPermissions })),
      resumeSessionId: (project.resumeSessionId as string | null | undefined) || null,
      planReviewPort: dependencies.getPlanReviewPort(),
      planLimits: planLimitsEnabled(config),
      getUserHooks: () => dependencies.getUserHooks(project.id),
      prepareCoherenceHooks,
      commitSigningProgram: dependencies.commitSigningProgram ?? null,
      ...overrides,
      prepareGuardrails: 'prepareGuardrails' in overrides ? overrides.prepareGuardrails : defaultGuardrailsFor(project, config, overrides),
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

export { createSessionFactory, willSessionRunGuarded };
export type { SessionSpawnOverrides };
