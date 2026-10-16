import http from 'node:http';
import { HookRouter } from '../../detection/hook-source.ts';
import { sweepOrphans } from '../../detection/settings-injector.ts';
import { hooksForProject } from '../../session/core/user-hooks-core.ts';
import type { SessionPlanReviewPort } from '../../session/sessions.ts';
import type { GitWorkspace } from '../../session/session-worktree-lifecycle.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import type { ConfigStore, GlimmervoidConfig } from '../config-store.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { createRtkInstallWiring } from '../rtk-install-wiring.ts';
import { resolveHookTools } from '../hook-tools.ts';
import { createClaudeFolderTrust } from '../claude-trust.ts';
import { DEFAULT_CONFIG } from '../config-store.ts';
import type { GuardrailsSpawnRefusal } from '../guardrails/guardrails-deps.ts';
import { createSessionFactory } from '../session/session-factory.ts';
import { createSessionGuardrails } from '../guardrails/session-guardrails.ts';
import { buildSettingsPayload } from '../settings-payload.ts';
import { cliPath } from '../runtime-paths.ts';
import { createSshSigner, installCommitSigningShim } from '../ssh-signing.ts';

interface BackendSessionRuntimeDependencies {
  config: GlimmervoidConfig;
  configStore: ConfigStore;
  getGitWorkspace: () => GitWorkspace | null;
  getPlanReviewPort?: () => SessionPlanReviewPort | null;
  getBroadcastControl: () => ControlBroadcast | null;
  recordOutcome?: OutcomeRecorder;
  logger: Pick<Console, 'warn'>;
  guardrailsRefusal: GuardrailsSpawnRefusal;
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

  const rtkInstall = createRtkInstallWiring({
    config: dependencies.config,
    onStatusChange: (status) => {
      const broadcast = dependencies.getBroadcastControl();
      if (!broadcast) return;
      broadcast({
        type: 'settings-updated',
        settings: buildSettingsPayload({ configStore: dependencies.configStore, rtkInstallStatus: status }),
      });
    },
  });
  const commitSigningProgram = installCommitSigningShim({
    binDir: configSiblingPath(dependencies.configStore.configPath, 'bin'),
    nodePath: process.execPath,
    cliPath,
    log: dependencies.logger,
  });
  const sshSigner = commitSigningProgram ? createSshSigner() : null;
  const makeSession = createSessionFactory({
    commitSigningProgram,
    configStore: dependencies.configStore,
    getConfig: () => dependencies.configStore.config,
    hookRouter,
    getHookPort,
    getGitWorkspace: dependencies.getGitWorkspace,
    getPlanReviewPort: dependencies.getPlanReviewPort || (() => null),
    resolveHookTools: (config, options) => resolveHookTools(config, { ...options, warn: dependencies.logger.warn.bind(dependencies.logger) }),
    getUserHooks: (projectId: string) => hooksForProject(dependencies.config.hooks, projectId),
    sessionGuardrails: createSessionGuardrails({
      getSettings: () => {
        const { guardrails } = dependencies.configStore.config;
        return {
          blockedPaths: guardrails?.blockedPaths ?? DEFAULT_CONFIG.guardrails.blockedPaths,
          unreadablePaths: guardrails?.unreadablePaths ?? DEFAULT_CONFIG.guardrails.unreadablePaths,
        };
      },
      uploadsRoot: configSiblingPath(dependencies.configStore.configPath, 'uploads'),
      guardrailsRefusal: dependencies.guardrailsRefusal,
      trustClaudeFolder: createClaudeFolderTrust().ensureTrusted,
      log: dependencies.logger,
    }),
  });

  return { agentIngressServer, getHookPort, hookRouter, makeSession, rtkInstall, sshSigner };
}

export { createBackendSessionRuntime };
