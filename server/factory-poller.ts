import { CoherenceOrient, CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import type { FactoryProjectState, FactoryState } from '../shared/contracts/factory.ts';
import { buildFactoryProjectState, FACTORY_TICK_INTERVAL_MS, factoryStateSignature } from './core/factory-core.ts';
import { createTickLoop } from './lane-runner.ts';
import type { TickLoopOptions } from './lane-runner.ts';

interface FactoryProject {
  id: string;
  name: string;
  path: string;
}

type FactoryPollerDeps = Pick<TickLoopOptions, 'now' | 'setIntervalFn' | 'clearIntervalFn' | 'setTimeoutFn' | 'clearTimeoutFn' | 'firstTickDelayMs' | 'random' | 'log'> & {
  listFactoryProjects: () => FactoryProject[] | Promise<FactoryProject[]>;
  resolveIntegrationBranch: (projectPath: string) => Promise<string>;
  readBranchSha: (projectPath: string, branch: string) => Promise<string>;
  hasCoherenceConfigAt: (projectPath: string, sha: string) => Promise<boolean>;
  ensureControlCheckout: (args: { projectId: string; projectPath: string; sha: string }) => Promise<string>;
  releaseControlCheckout: (projectId: string) => Promise<void>;
  runCoherence: (args: { cwd: string; args: string[] }) => Promise<string>;
  broadcast: (message: FactoryState) => void;
};

export function createFactoryPoller({
  listFactoryProjects, resolveIntegrationBranch, readBranchSha, hasCoherenceConfigAt,
  ensureControlCheckout, releaseControlCheckout, runCoherence, broadcast, now = Date.now, ...loopOptions
}: FactoryPollerDeps) {
  const log = loopOptions.log ?? console;
  let state: FactoryState | null = null;
  let signature: string | null = null;
  const processedProjects = new Map<string, { path: string; state: FactoryProjectState }>();
  let reportedProjectIds = new Set<string>();

  async function releaseCheckout(projectId: string): Promise<void> {
    try {
      await releaseControlCheckout(projectId);
    } catch (error) {
      log.warn(`[factory] releasing the control checkout for ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function readCoherenceReport(command: { cwd: string; args: string[] }): Promise<string> {
    try {
      return await runCoherence(command);
    } catch (error) {
      const printedReport = stdoutOfFailedCommand(error);
      if (printedReport === null) throw error;
      return printedReport;
    }
  }

  async function readIntegrationTipSha(projectPath: string): Promise<string | null> {
    try {
      return await readBranchSha(projectPath, await resolveIntegrationBranch(projectPath));
    } catch {
      return null;
    }
  }

  async function readProject(project: FactoryProject): Promise<FactoryProjectState | null> {
    const headSha = await readIntegrationTipSha(project.path);
    if (headSha === null) return null;
    const identity = { projectId: project.id, projectName: project.name };
    try {
      if (!(await hasCoherenceConfigAt(project.path, headSha))) return null;
      const previous = processedProjects.get(project.id);
      if (previous?.path === project.path && previous.state.headSha === headSha) {
        return { ...previous.state, projectName: project.name };
      }
      const cwd = await ensureControlCheckout({ projectId: project.id, projectPath: project.path, sha: headSha });
      const orient = CoherenceOrient.parse(JSON.parse(await readCoherenceReport({ cwd, args: ['orient', '--json'] })));
      const work = orient.action === 'refuse'
        ? null
        : CoherenceWorkInspect.parse(JSON.parse(await readCoherenceReport({ cwd, args: ['work', 'inspect', '--json'] })));
      const projectState = buildFactoryProjectState({ ...identity, headSha, orient, work, error: null });
      processedProjects.set(project.id, { path: project.path, state: projectState });
      return projectState;
    } catch (error) {
      processedProjects.delete(project.id);
      return buildFactoryProjectState({
        ...identity, headSha, orient: null, work: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function runTick(): Promise<undefined> {
    const projects: FactoryProjectState[] = [];
    for (const project of await listFactoryProjects()) {
      const projectState = await readProject(project);
      if (projectState) projects.push(projectState);
    }
    const currentIds = new Set(projects.map((project) => project.projectId));
    for (const projectId of processedProjects.keys()) {
      if (!currentIds.has(projectId)) processedProjects.delete(projectId);
    }
    for (const projectId of reportedProjectIds) {
      if (!currentIds.has(projectId)) await releaseCheckout(projectId);
    }
    reportedProjectIds = currentIds;
    const nextSignature = factoryStateSignature(projects);
    if (nextSignature === signature) return;
    const message: FactoryState = { type: 'factory-state', ts: now(), projects };
    broadcast(message);
    state = message;
    signature = nextSignature;
  }

  const loop = createTickLoop({
    ...loopOptions, now, tag: 'factory', intervalMs: FACTORY_TICK_INTERVAL_MS,
    tick: () => loop.track(runTick()),
  });
  return { start: () => loop.start(), stop: loop.stop, tick: loop.tick, getState: () => state };
}

function stdoutOfFailedCommand(error: unknown): string | null {
  if (!(error instanceof Error) || !('stdout' in error)) return null;
  if (!('code' in error) || typeof error.code !== 'number') return null;
  if ('killed' in error && error.killed === true) return null;
  const { stdout } = error;
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  return stdout;
}

export type FactoryPoller = ReturnType<typeof createFactoryPoller>;
export type { FactoryPollerDeps, FactoryProject };
