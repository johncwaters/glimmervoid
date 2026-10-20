import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../../shared/contracts/config.ts';
import type { CoderEnvironmentOffer } from '../../shared/contracts/control-messages.ts';
import { DEFAULT_TIMER_FNS } from '../../shared/timer-deps.ts';
import { coderCreateArgs, remoteShellCommand, workspaceNameFromHex } from '../../session/core/remote-launch-core.ts';
import { bootStaggerDelay } from '../boot-stagger.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { createCoderEnvPoller } from './coder-env-poller.ts';
import type { CoderEnvPollerDeps } from './coder-env-poller.ts';
import {
  CODER_ENV_READY_POLL_MS, decideReadiness, failedProvisionCleanup, liveLimitRefusal, parseGlimmervoidWorkspaces, remoteCheckoutDirectory, resolveCoderEnvironment, sharingRefusal,
} from './core/coder-env-core.ts';
import type { CoderEnvironmentSettings, CoderWorkspace, ReadinessVerdict, ResolvedCoderEnvironment } from './core/coder-env-core.ts';
import { createLaneRunner } from '../lanes/lane-runner.ts';

type ProjectEnvironment = NonNullable<Config['projects'][number]['environment']>;
type CoderEnvResult = { ok: true; mapping: ProjectEnvironment } | { ok: false; reason: string };

interface RunCoderOptions {
  timeoutMs: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

interface CoderEnvWiringOptions extends Omit<CoderEnvPollerDeps, 'listWorkspaces' | 'stopWorkspace' | 'deleteWorkspace' | 'mappings' | 'busyWorkspaces' | 'isReconcilePending' | 'deleteAfterStoppedDays' | 'onReconciled'> {
  config: Pick<Config, 'coder' | 'projects'>;
  persistMapping: (projectId: string, mapping: ProjectEnvironment | undefined) => void | Promise<void>;
  onReconciled?: CoderEnvPollerDeps['onReconciled'];
  runCoder?: (args: string[], options: RunCoderOptions) => Promise<{ stdout: string }>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetch?: typeof globalThis.fetch;
  createPoller?: typeof createCoderEnvPoller;
}

function createCoderEnvWiring({
  config, persistMapping, onReconciled = () => {}, runCoder: executeCoder, env = process.env, platform = process.platform,
  fetch: fetchReady = globalThis.fetch, createPoller = createCoderEnvPoller, now = Date.now, log = console,
  ...pollerDeps
}: CoderEnvWiringOptions) {
  let binaryProbe: Promise<boolean> | null = null;
  let isCoderAvailable = false;
  let hasReconciled = false;
  const operationCountByWorkspace = new Map<string, number>();
  const lastSeenStatusByWorkspace = new Map<string, CoderWorkspace['status']>();
  const provisionByProject = new Map<string, Promise<CoderEnvResult>>();
  const failedProvisionByProject = new Map<string, { ok: false; reason: string }>();
  const setTimeoutFn = pollerDeps.setTimeoutFn ?? DEFAULT_TIMER_FNS.setTimeoutFn;

  async function runCoder(args: string[], { timeoutMs, input = '', env: commandEnv }: RunCoderOptions): Promise<{ stdout: string }> {
    try {
      const options = { timeoutMs, input, env: { ...env, ...commandEnv } };
      if (executeCoder) return await executeCoder(args, options);
      return await execFileAsync('coder', args, { timeout: timeoutMs, input, env: options.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch {
      throw new Error(`Coder ${args[0]} failed`);
    }
  }

  function command(args: string[], timeoutMs = 30_000): Promise<{ stdout: string }> {
    return runCoder(args, { timeoutMs });
  }

  function recordListing(listingJson: string): CoderWorkspace[] | null {
    const workspaces = parseGlimmervoidWorkspaces(listingJson);
    if (workspaces === null) return null;
    lastSeenStatusByWorkspace.clear();
    for (const workspace of workspaces) lastSeenStatusByWorkspace.set(workspace.name, workspace.status);
    return workspaces;
  }

  async function readWorkspaceListing(): Promise<string> {
    const listingJson = (await command(['list', '-o', 'json'])).stdout;
    recordListing(listingJson);
    return listingJson;
  }

  async function listWorkspaces(): Promise<CoderWorkspace[]> {
    const workspaces = recordListing((await command(['list', '-o', 'json'])).stdout);
    if (workspaces === null) throw new Error('Invalid Coder workspace listing');
    return workspaces;
  }

  function workspaceStatus(workspace: string): CoderWorkspace['status'] | null {
    return lastSeenStatusByWorkspace.get(workspace) ?? null;
  }

  function isConfigured(): boolean {
    return Boolean(config.coder?.environments?.length) && (platform === 'linux' || platform === 'darwin');
  }

  async function probeBinary(): Promise<boolean> {
    try {
      await command(['version'], 5_000);
      isCoderAvailable = true;
      return true;
    } catch {
      log.warn('[coder-env] coder binary is unavailable');
      return false;
    }
  }

  async function ensureAvailable(): Promise<boolean> {
    if (!isConfigured()) return false;
    binaryProbe ??= probeBinary();
    const isAvailable = await binaryProbe;
    if (!isAvailable) binaryProbe = null;
    return isAvailable;
  }

  async function whileWorkspaceBusy<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
    operationCountByWorkspace.set(workspace, (operationCountByWorkspace.get(workspace) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remainingOperations = (operationCountByWorkspace.get(workspace) ?? 1) - 1;
      if (remainingOperations > 0) operationCountByWorkspace.set(workspace, remainingOperations);
      if (remainingOperations <= 0) operationCountByWorkspace.delete(workspace);
    }
  }

  const runner = createLaneRunner({
    tag: 'coder-env',
    gate: () => ({ start: isConfigured() && isCoderAvailable }),
    cfgKey: () => JSON.stringify(config.coder?.environments ?? []),
    emptyStatus: () => ({}),
    createPoller: () => createPoller({
      ...pollerDeps, now, log,
      firstTickDelayMs: pollerDeps.firstTickDelayMs ?? bootStaggerDelay,
      listWorkspaces: readWorkspaceListing,
      stopWorkspace: async (workspace) => { await command(['stop', workspace, '--yes']); },
      deleteWorkspace: async (workspace) => { await command(['delete', workspace, '--yes']); },
      mappings: () => config.projects.flatMap((project) => project.id && project.environment
        ? [{ projectId: project.id, workspace: project.environment.workspace, wasActive: project.wasActive === true }]
        : []),
      busyWorkspaces: () => new Set(operationCountByWorkspace.keys()),
      isReconcilePending: () => !hasReconciled,
      deleteAfterStoppedDays: () => Math.max(...(config.coder?.environments ?? []).map((environment) => resolveCoderEnvironment(environment).deleteAfterStoppedDays)),
      onReconciled: async (plan) => {
        await onReconciled(plan);
        hasReconciled = true;
      },
    }),
  });

  async function start(): Promise<void> {
    await ensureAvailable();
    runner.startPoller();
  }

  async function restartIfConfigChanged(): Promise<void> {
    await ensureAvailable();
    runner.restartIfConfigChanged();
  }

  function availableEnvironments(): CoderEnvironmentOffer[] | null {
    if (!isConfigured() || !isCoderAvailable) return null;
    return (config.coder?.environments ?? []).map((settings) => {
      const environment = resolveCoderEnvironment(settings);
      return {
        name: environment.name,
        template: environment.template,
        parameters: { ...environment.parameters },
        hourlyCostUsd: environment.hourlyCostUsd ?? null,
        idleStopMinutes: environment.idleStopMinutes,
      };
    });
  }

  function resolveEnvironment(environmentName: string): ResolvedCoderEnvironment | null {
    const environment: CoderEnvironmentSettings | undefined = config.coder?.environments?.find((candidate) => candidate.name === environmentName);
    return environment ? resolveCoderEnvironment(environment) : null;
  }

  async function saveMapping(projectId: string, mapping: ProjectEnvironment | undefined): Promise<void> {
    await persistMapping(projectId, mapping);
    const savedMapping = config.projects.find((project) => project.id === projectId)?.environment;
    if (JSON.stringify(savedMapping) !== JSON.stringify(mapping)) throw new Error('Coder mapping was not persisted');
  }

  function remoteCommand(argv: readonly string[]): string {
    const shellCommand = remoteShellCommand(argv);
    if (shellCommand === null) throw new Error('Invalid Coder remote command');
    return shellCommand;
  }

  async function waitForReady(workspaceName: string, environment: ResolvedCoderEnvironment): Promise<void> {
    const startedAtMs = now();
    for (;;) {
      const workspaces = await listWorkspaces();
      const workspace = workspaces.find((candidate) => candidate.name === workspaceName);
      let isReadyUrlUp: boolean | null = null;
      if (environment.readyUrl) {
        isReadyUrlUp = false;
        if (workspace?.status === 'running' && workspace.areAgentsReady) {
          try {
            isReadyUrlUp = (await fetchReady(environment.readyUrl, { signal: AbortSignal.timeout(5_000) })).ok;
          } catch {
            isReadyUrlUp = false;
          }
        }
      }
      const readiness: ReadinessVerdict = decideReadiness({ workspace, elapsedMs: now() - startedAtMs, isReadyUrlUp });
      if (readiness.kind === 'ready') return;
      if (readiness.kind === 'failed') throw new Error(readiness.reason);
      await new Promise<void>((resolve) => setTimeoutFn(resolve, CODER_ENV_READY_POLL_MS));
    }
  }

  async function checkSharing(workspace: string): Promise<void> {
    const reason = sharingRefusal((await command(['sharing', 'status', workspace])).stdout);
    if (reason) throw new Error(reason);
  }

  async function failAttempt({ workspace, didCreate, didStart, reason }: {
    workspace: string;
    didCreate: boolean;
    didStart: boolean;
    reason: string;
  }): Promise<{ ok: false; reason: string }> {
    const cleanup = failedProvisionCleanup({ didCreate, didStart });
    const reasons = [reason];
    if (cleanup) {
      try {
        await command([cleanup, workspace, '--yes']);
      } catch {
        reasons.push(`Coder cleanup ${cleanup} failed for ${workspace}`);
      }
    }
    return { ok: false, reason: reasons.join('; ') };
  }

  async function reserve({ projectId, environmentName, branch, liveCount }: {
    projectId: string;
    environmentName: string;
    branch: string;
    liveCount: number;
  }): Promise<CoderEnvResult> {
    const environment = resolveEnvironment(environmentName);
    if (!environment) return { ok: false, reason: `Unknown Coder environment: ${environmentName}` };
    const limitReason = liveLimitRefusal({ liveCount, maxLive: environment.maxLive, environmentName });
    if (limitReason) return { ok: false, reason: limitReason };
    if (config.projects.some((candidate) => candidate.id === projectId && candidate.environment)) return { ok: false, reason: 'Project already has a Coder workspace mapping' };
    if (!await ensureAvailable()) return { ok: false, reason: 'Coder environments are unavailable on this host' };
    const workspace = workspaceNameFromHex(randomBytes(6).toString('hex'));
    if (workspace === null) return { ok: false, reason: 'Invalid generated Coder workspace name' };
    return { ok: true, mapping: { name: environmentName, workspace, remotePort: randomInt(40_000, 50_000), branch } };
  }

  function provision({ projectId, mapping, repoRemoteUrl, baseBranch }: {
    projectId: string;
    mapping: ProjectEnvironment;
    repoRemoteUrl: string;
    baseBranch: string;
  }): Promise<CoderEnvResult> {
    const savedMapping = config.projects.find((candidate) => candidate.id === projectId)?.environment;
    if (JSON.stringify(savedMapping) !== JSON.stringify(mapping)) return Promise.resolve({ ok: false, reason: `Project ${projectId} does not hold this Coder workspace mapping` });
    if (provisionByProject.has(projectId)) return Promise.resolve({ ok: false, reason: `Project ${projectId} is already provisioning a Coder workspace` });
    const attempt = whileWorkspaceBusy(mapping.workspace, () => createWorkspace({ mapping, repoRemoteUrl, baseBranch }));
    provisionByProject.set(projectId, attempt);
    void attempt.then((provisioned) => {
      provisionByProject.delete(projectId);
      if (!provisioned.ok) failedProvisionByProject.set(projectId, provisioned);
    });
    return attempt;
  }

  async function createWorkspace({ mapping, repoRemoteUrl, baseBranch }: {
    mapping: ProjectEnvironment;
    repoRemoteUrl: string;
    baseBranch: string;
  }): Promise<CoderEnvResult> {
    const { workspace, branch } = mapping;
    let didCreate = false;
    try {
      const environment = resolveEnvironment(mapping.name);
      if (!environment) throw new Error(`Unknown Coder environment: ${mapping.name}`);
      if (!await ensureAvailable()) throw new Error('Coder environments are unavailable on this host');
      const createArgs = coderCreateArgs({ workspace, template: environment.template, stopAfter: environment.stopAfter, parameters: environment.parameters });
      if (createArgs === null) throw new Error('Invalid Coder create parameters');
      const checkoutDirectory = remoteCheckoutDirectory({ checkoutRoot: environment.checkoutRoot, workspace });
      didCreate = true;
      await command(createArgs, 20 * 60_000);
      await waitForReady(workspace, environment);
      await checkSharing(workspace);
      const nodeVersion = await command(['ssh', workspace, '--', remoteCommand([environment.nodePath, '--version'])])
        .catch(() => { throw new Error(`Coder node probe failed for ${environment.nodePath}`); });
      if (!/^v\d+\.\d+\.\d+\s*$/.test(nodeVersion.stdout)) throw new Error(`Coder node probe failed for ${environment.nodePath}`);
      const checkoutCommand = [
        remoteCommand(['mkdir', '-p', environment.checkoutRoot]),
        remoteCommand(['git', 'clone', '--branch', baseBranch, '--', repoRemoteUrl, checkoutDirectory]),
        remoteCommand(['git', '-C', checkoutDirectory, 'switch', '-c', branch]),
      ].join(' && ');
      await command(['ssh', workspace, '--', checkoutCommand], 20 * 60_000);
      return { ok: true, mapping };
    } catch (error) {
      return failAttempt({ workspace, didCreate, didStart: false, reason: error instanceof Error ? error.message : 'Coder provision failed' });
    }
  }

  async function resume({ projectId }: { projectId: string }): Promise<CoderEnvResult> {
    const inFlightProvision = provisionByProject.get(projectId);
    if (inFlightProvision) {
      const provisioned = await inFlightProvision;
      if (!provisioned.ok) return provisioned;
    }
    const failedProvision = failedProvisionByProject.get(projectId);
    if (failedProvision) return failedProvision;
    const mapping = config.projects.find((project) => project.id === projectId)?.environment;
    if (!mapping) return { ok: false, reason: `Project ${projectId} has no Coder workspace mapping` };
    const environment = resolveEnvironment(mapping.name);
    if (!environment) return { ok: false, reason: `Unknown Coder environment: ${mapping.name}` };
    if (!await ensureAvailable()) return { ok: false, reason: 'Coder environments are unavailable on this host' };
    return whileWorkspaceBusy(mapping.workspace, () => startWorkspace({ mapping, environment }));
  }

  async function startWorkspace({ mapping, environment }: {
    mapping: ProjectEnvironment;
    environment: ResolvedCoderEnvironment;
  }): Promise<CoderEnvResult> {
    let didStart = false;
    try {
      const workspaces = await listWorkspaces();
      const workspace = workspaces.find((candidate) => candidate.name === mapping.workspace);
      if (!workspace) throw new Error(`Coder workspace ${mapping.workspace} no longer exists; close this session and start a new one`);
      if (workspace.status === 'stopped') {
        didStart = true;
        await command(['start', mapping.workspace, '--yes'], 20 * 60_000);
      }
      await waitForReady(mapping.workspace, environment);
      await checkSharing(mapping.workspace);
      return { ok: true, mapping };
    } catch (error) {
      return failAttempt({ workspace: mapping.workspace, didCreate: false, didStart, reason: error instanceof Error ? error.message : 'Coder resume failed' });
    }
  }

  async function release({ projectId }: { projectId: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
    failedProvisionByProject.delete(projectId);
    const mapping = config.projects.find((project) => project.id === projectId)?.environment;
    if (!mapping) return { ok: true };
    if (!await ensureAvailable()) return { ok: false, reason: 'Coder environments are unavailable on this host' };
    return whileWorkspaceBusy(mapping.workspace, async () => {
      try {
        await command(['delete', mapping.workspace, '--yes'], 20 * 60_000);
        await saveMapping(projectId, undefined);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'Coder release failed' };
      }
    });
  }

  async function uploadFile({ workspace, remotePath, contents, mode }: { workspace: string; remotePath: string; contents: string; mode: number | string }): Promise<void> {
    if (workspaceNameFromHex(workspace.slice(3)) !== workspace) throw new Error('Invalid Coder workspace name');
    const fileMode = typeof mode === 'number' ? mode.toString(8) : mode;
    if (!/^[0-7]{3,4}$/.test(fileMode)) throw new Error('Invalid remote file mode');
    if (!path.posix.isAbsolute(remotePath)) throw new Error('Remote upload path must be absolute');
    if (!await ensureAvailable()) throw new Error('Coder environments are unavailable on this host');
    const script = `umask 077; mkdir -p "$(dirname "$1")" && cat > "$1" && chmod ${fileMode} "$1"`;
    await runCoder(['ssh', workspace, '--', remoteCommand(['sh', '-c', script, 'sh', remotePath])], { timeoutMs: 30_000, input: contents });
  }

  return { start, stop: runner.stopPoller, restartIfConfigChanged, availableEnvironments, reserve, provision, resume, release, uploadFile, workspaceStatus };
}

export { createCoderEnvWiring };
