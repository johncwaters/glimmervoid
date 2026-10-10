import { CoherenceOrient, CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import type { FactoryProjectState, FactoryState } from '../shared/contracts/factory.ts';
import { buildFactoryProjectState, FACTORY_TICK_INTERVAL_MS, factoryStateSignature, isCompletedCommandFailure } from './core/factory-core.ts';
import { createTickLoop } from './lane-runner.ts';
import type { TickLoopOptions } from './lane-runner.ts';
import { errorMessage } from '../shared/text.ts';

interface FactoryProject {
  id: string;
  name: string;
  path: string;
}

type FactoryPollerDeps = Pick<TickLoopOptions, 'now' | 'setIntervalFn' | 'clearIntervalFn' | 'setTimeoutFn' | 'clearTimeoutFn' | 'firstTickDelayMs' | 'random' | 'log'> & {
  shouldHoldCheckout?: (projectId: string) => boolean;
  beforeTick?: () => void;
  listFactoryProjects: () => FactoryProject[] | Promise<FactoryProject[]>;
  resolveIntegrationBranch: (projectPath: string) => Promise<string>;
  readBranchSha: (projectPath: string, branch: string) => Promise<string>;
  hasCoherenceConfigAt: (projectPath: string, sha: string) => Promise<boolean>;
  ensureControlCheckout: (args: { projectId: string; projectPath: string; sha: string }) => Promise<string>;
  releaseControlCheckout: (projectId: string) => Promise<void>;
  runCoherence: (args: { cwd: string; args: string[] }) => Promise<string>;
  readPaused?: (projectId: string) => Promise<boolean>;
  processProjectState?: (project: FactoryProjectState) => Promise<FactoryProjectState>;
  releaseOrchestrator?: (projectId: string) => void;
  broadcast: (message: FactoryState) => void;
};

export function createFactoryPoller({
  shouldHoldCheckout = () => false, beforeTick = () => {}, listFactoryProjects, resolveIntegrationBranch, readBranchSha, hasCoherenceConfigAt,
  ensureControlCheckout, releaseControlCheckout, runCoherence, readPaused = async () => false, processProjectState = async (project) => project, releaseOrchestrator = () => {}, broadcast, now = Date.now, ...loopOptions
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
      log.warn(`[factory] releasing the control checkout for ${projectId} failed: ${errorMessage(error)}`);
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
    let paused = false;
    const identity = { projectId: project.id, projectName: project.name };
    try {
      paused = await readPaused(project.id);
      if (!(await hasCoherenceConfigAt(project.path, headSha))) return null;
      const previous = processedProjects.get(project.id);
      if (previous?.path === project.path && (previous.state.headSha === headSha || shouldHoldCheckout(project.id))) {
        return { ...previous.state, paused, projectName: project.name };
      }
      const cwd = await ensureControlCheckout({ projectId: project.id, projectPath: project.path, sha: headSha });
      const orient = CoherenceOrient.parse(JSON.parse(await readCoherenceReport({ cwd, args: ['orient', '--json'] })));
      const work = orient.action === 'refuse'
        ? null
        : CoherenceWorkInspect.parse(JSON.parse(await readCoherenceReport({ cwd, args: ['work', 'inspect', '--json'] })));
      const projectState = buildFactoryProjectState({ ...identity, headSha, paused, orient, work, error: null });
      processedProjects.set(project.id, { path: project.path, state: projectState });
      return projectState;
    } catch (error) {
      processedProjects.delete(project.id);
      return buildFactoryProjectState({
        ...identity, headSha, paused, orient: null, work: null,
        error: errorMessage(error),
      });
    }
  }

  async function processProjectStateSafely(projectState: FactoryProjectState): Promise<FactoryProjectState> {
    try {
      return await processProjectState(projectState);
    } catch (error) {
      log.warn(`[factory] processing ${projectState.projectId} failed: ${errorMessage(error)}`);
      return { ...projectState, error: errorMessage(error) };
    }
  }

  async function runTick(): Promise<undefined> {
    beforeTick();
    const projects: FactoryProjectState[] = [];
    for (const project of await listFactoryProjects()) {
      const projectState = await readProject(project);
      if (projectState) projects.push(await processProjectStateSafely(projectState));
    }
    const currentIds = new Set(projects.map((project) => project.projectId));
    for (const projectId of processedProjects.keys()) {
      if (!currentIds.has(projectId)) processedProjects.delete(projectId);
    }
    for (const projectId of reportedProjectIds) {
      if (!currentIds.has(projectId)) {
        releaseOrchestrator(projectId);
        await releaseCheckout(projectId);
      }
    }
    reportedProjectIds = currentIds;
    const nextSignature = factoryStateSignature(projects);
    if (nextSignature === signature) return;
    const message: FactoryState = { type: 'factory-state', ts: now(), projects };
    broadcast(message);
    state = message;
    signature = nextSignature;
  }

  let tickChain: Promise<undefined> = Promise.resolve(undefined);
  function enqueueTick(): Promise<undefined> {
    const read = () => loop.isStopped() ? Promise.resolve(undefined) : runTick();
    const next = tickChain.then(read, read);
    tickChain = next;
    return loop.track(next);
  }

  const loop = createTickLoop({
    ...loopOptions, now, tag: 'factory', intervalMs: FACTORY_TICK_INTERVAL_MS,
    tick: enqueueTick,
  });
  return { start: () => loop.start(), stop: loop.stop, tick: loop.tick, refreshNow: enqueueTick, getState: () => state };
}

function stdoutOfFailedCommand(error: unknown): string | null {
  if (!isCompletedCommandFailure(error) || !('stdout' in error)) return null;
  const { stdout } = error;
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  return stdout;
}

export type FactoryPoller = ReturnType<typeof createFactoryPoller>;
export type { FactoryPollerDeps };
