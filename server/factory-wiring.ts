import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../shared/contracts/config.ts';
import { execFileAsync } from './child-process-safe.ts';
import { runGit } from './git-exec.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { FACTORY_FIRST_TICK_DELAY_MS, factoryShouldStart } from './core/factory-core.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';
import { createFactoryPoller } from './factory-poller.ts';
import type { FactoryPoller, FactoryPollerDeps } from './factory-poller.ts';
import { createGitWorkspace } from './git-workspace.ts';
import type { GitWorkspaceInstance } from './git-workspace.ts';
import { createLaneRunner } from './lane-runner.ts';
import { resolvePackageBin } from './runtime-paths.ts';
import { errorMessage, isMissingFileError } from '../shared/text.ts';

const COHERENCE_CONFIG_PROBE_TIMEOUT_MS = 5_000;

function isGitExitWithoutObject(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') return false;
  return !('killed' in error && error.killed === true);
}

interface FactoryWiringOptions extends Partial<Omit<FactoryPollerDeps, 'broadcast'>> {
  config: Pick<Config, 'factory' | 'projects' | 'integrationBranch'>;
  broadcast: FactoryPollerDeps['broadcast'];
  gitWorkspace?: GitWorkspaceInstance;
  homeDir?: string;
  createPoller?: typeof createFactoryPoller;
}

export function createFactoryWiring({
  config, broadcast, gitWorkspace = createGitWorkspace(), homeDir = glimmervoidHomeDir(),
  createPoller = createFactoryPoller, log = console, ...pollerDeps
}: FactoryWiringOptions) {
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  const checkouts = new Map<string, { projectPath: string; sha: string }>();

  function controlCheckoutPath(projectId: string): string {
    if (!projectId || projectId === '.' || projectId === '..' || /[/\\]/.test(projectId)) throw new Error('Invalid factory project id');
    return path.join(homeDir, 'factory', projectId, 'control');
  }

  async function removeControlCheckout(projectId: string, projectPath: string): Promise<void> {
    const checkoutPath = controlCheckoutPath(projectId);
    const removed = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: checkoutPath });
    if (removed.ok) return;
    await rm(checkoutPath, { recursive: true, force: true });
    const pruned = await gitWorkspace.pruneWorktrees({ projectPath });
    if (!pruned.ok) log.warn(`[factory] worktree prune after removing ${checkoutPath} failed: ${pruned.err}`);
  }

  async function removeCheckout(projectId: string): Promise<void> {
    const checkout = checkouts.get(projectId);
    if (!checkout) return;
    checkouts.delete(projectId);
    await removeControlCheckout(projectId, checkout.projectPath);
  }

  async function pathExists(candidatePath: string): Promise<boolean> {
    try {
      await access(candidatePath);
      return true;
    } catch (error) {
      if (isMissingFileError(error, { includeNotDir: false })) return false;
      throw error;
    }
  }

  async function ensureControlCheckout({ projectId, projectPath, sha }: {
    projectId: string; projectPath: string; sha: string;
  }): Promise<string> {
    const checkoutPath = controlCheckoutPath(projectId);
    const previous = checkouts.get(projectId);
    if (previous && previous.projectPath !== projectPath) await removeCheckout(projectId);
    const checkout = checkouts.get(projectId);
    if (checkout?.sha === sha) return checkoutPath;
    if (checkout) {
      const moved = await gitWorkspace.checkoutDetached({ worktreePath: checkoutPath, sha });
      if (!moved.ok) {
        await removeCheckout(projectId);
        throw new Error(moved.err);
      }
      checkout.sha = sha;
      return checkoutPath;
    }
    await mkdir(path.dirname(checkoutPath), { recursive: true });
    if (await pathExists(checkoutPath)) await removeControlCheckout(projectId, projectPath);
    const staged = await gitWorkspace.stageDetachedWorktree({ projectPath, worktreePath: checkoutPath, sha });
    if (!staged.ok) {
      await removeControlCheckout(projectId, projectPath);
      throw new Error(staged.err);
    }
    checkouts.set(projectId, { projectPath, sha });
    return checkoutPath;
  }

  async function hasCoherenceConfigAt(projectPath: string, sha: string): Promise<boolean> {
    const probe = await runGit(['cat-file', '-e', `${sha}:coherence.config.json`], { cwd: projectPath, timeoutMs: COHERENCE_CONFIG_PROBE_TIMEOUT_MS });
    if (probe.ok) return true;
    if (isGitExitWithoutObject(probe.error)) return false;
    throw probe.error;
  }

  const runner = createLaneRunner<FactoryPoller>({
    tag: 'factory',
    gate: () => factoryShouldStart(config),
    cfgKey: () => JSON.stringify(config.factory ?? null),
    emptyStatus: () => ({}),
    createPoller: () => {
      const poller = createPoller({
        log,
        listFactoryProjects: () => (config.projects ?? []).flatMap(({ id, name, path: projectPath }) => {
          if (!id || !projectPath) return [];
          return [{ id, name: name ?? path.basename(projectPath), path: projectPath }];
        }),
        resolveIntegrationBranch: async (projectPath) => {
          const branch = configuredIntegrationBranch(config) ?? await gitWorkspace.detectDefaultBranch({ projectPath });
          if (!branch) throw new Error('Could not resolve the integration branch');
          return branch;
        },
        readBranchSha: async (projectPath, branch) => {
          const listed = await gitWorkspace.listIntegrationTips({ projectPath, integrationBranch: branch });
          if (!('integrationTips' in listed)) throw new Error(listed.err || `Could not list the ${branch} refs`);
          const tip = listed.integrationTips.find((candidate) => candidate.branch === branch);
          if (!tip?.sha) throw new Error(`Could not resolve origin/${branch} or ${branch}`);
          return tip.sha;
        },
        hasCoherenceConfigAt,
        ensureControlCheckout,
        releaseControlCheckout: removeCheckout,
        runCoherence: async ({ cwd, args }) => {
          if (!coherenceCliPath) throw new Error('Could not resolve the coherence CLI');
          const { stdout } = await execFileAsync(process.execPath, [coherenceCliPath, ...args], {
            cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
          });
          return stdout;
        },
        ...pollerDeps,
        firstTickDelayMs: pollerDeps.firstTickDelayMs ?? (() => FACTORY_FIRST_TICK_DELAY_MS),
        broadcast,
      });
      let stopping: Promise<void> | null = null;
      const stop = async () => {
        await poller.stop();
        for (const projectId of [...checkouts.keys()]) {
          await removeCheckout(projectId).catch((error: unknown) => {
            log.warn(`[factory] removing the control checkout for ${projectId} failed: ${errorMessage(error)}`);
          });
        }
      };
      return { ...poller, stop: () => { stopping ??= stop(); return stopping; } };
    },
  });
  return {
    start: runner.startPoller,
    stop: runner.stopPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    getState: () => runner.isStopped() ? null : runner.getPoller()?.getState() ?? null,
  };
}

export type { FactoryWiringOptions };
