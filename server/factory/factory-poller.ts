import { CoherenceOrient, CoherenceWorkInspect } from '../../shared/contracts/coherence.ts';
import type { FactoryProjectState, FactoryState } from '../../shared/contracts/factory.ts';
import { buildFactoryProjectState, FACTORY_TICK_INTERVAL_MS, factoryStateSignature, isCompletedCommandFailure } from './core/factory-core.ts';
import { createTickLoop } from '../lanes/lane-runner.ts';
import type { TickLoopOptions } from '../lanes/lane-runner.ts';
import { errorMessage } from '../../shared/text.ts';

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
  readIntentWriteScopes?: (projectId: string) => Promise<ReadonlyMap<string, readonly string[]>>;
  readIntentConfirmedFlakes?: (projectId: string) => Promise<Record<string, string[]> | undefined>;
  readTicketBlockCounts?: (projectId: string) => Promise<Record<string, number> | undefined>;
  processProjectState?: (project: FactoryProjectState) => Promise<FactoryProjectState>;
  releaseOrchestrator?: (projectId: string) => void;
  listObservedProjects?: () => Promise<FactoryProjectState[]>;
  broadcast: (message: FactoryState) => void;
};

export function createFactoryPoller({
  shouldHoldCheckout = () => false, beforeTick = () => {}, listFactoryProjects, resolveIntegrationBranch, readBranchSha, hasCoherenceConfigAt,
  ensureControlCheckout, releaseControlCheckout, runCoherence, readPaused = async () => false, readIntentWriteScopes = async () => new Map(), readIntentConfirmedFlakes = async () => undefined, readTicketBlockCounts = async () => undefined, processProjectState = async (project) => project, releaseOrchestrator = () => {}, listObservedProjects = async () => [], broadcast, now = Date.now, ...loopOptions
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

  async function readIntegrationTipSha(projectPath: string): Promise<{ sha: string } | { error: string }> {
    try {
      return { sha: await readBranchSha(projectPath, await resolveIntegrationBranch(projectPath)) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  async function readProject(project: FactoryProject): Promise<{ state: FactoryProjectState; shouldProcess: boolean } | null> {
    const integrationTip = await readIntegrationTipSha(project.path);
    if ('sha' in integrationTip) {
      const projectState = await readLedgerProject(project, integrationTip.sha);
      return projectState && { state: projectState, shouldProcess: true };
    }
    const lastReported = state?.projects.find((reported) => reported.projectId === project.id);
    if (!lastReported) return null;
    return { state: { ...lastReported, projectName: project.name, error: `Could not read the integration tip: ${integrationTip.error}` }, shouldProcess: false };
  }

  async function readLedgerProject(project: FactoryProject, headSha: string): Promise<FactoryProjectState | null> {
    let paused = false;
    const identity = { projectId: project.id, projectName: project.name };
    try {
      paused = await readPaused(project.id);
      const previous = processedProjects.get(project.id);
      const isUnchangedTip = previous?.path === project.path && previous.state.headSha === headSha;
      if (!isUnchangedTip && !(await hasCoherenceConfigAt(project.path, headSha))) return null;
      const confirmedFlakesByIntent = await readIntentConfirmedFlakes(project.id);
      if (previous?.path === project.path && (isUnchangedTip || shouldHoldCheckout(project.id))) {
        return { ...previous.state, paused, projectName: project.name, confirmedFlakesByIntent };
      }
      const cwd = await ensureControlCheckout({ projectId: project.id, projectPath: project.path, sha: headSha });
      const orient = CoherenceOrient.parse(JSON.parse(await readCoherenceReport({ cwd, args: ['orient', '--json'] })));
      const work = orient.action === 'refuse'
        ? null
        : CoherenceWorkInspect.parse(JSON.parse(await readCoherenceReport({ cwd, args: ['work', 'inspect', '--json'] })));
      const projectState = buildFactoryProjectState({ ...identity, headSha, paused, orient, work, error: null, intentWriteScopes: await readIntentWriteScopes(project.id), confirmedFlakesByIntent, ticketBlockCounts: await readTicketBlockCounts(project.id) });
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

  async function readObservedProjects(): Promise<FactoryProjectState[]> {
    try {
      return await listObservedProjects();
    } catch (error) {
      log.warn(`[factory] reading observed projects failed: ${errorMessage(error)}`);
      return [];
    }
  }

  async function runTick(): Promise<undefined> {
    beforeTick();
    const projects: FactoryProjectState[] = [];
    for (const project of await listFactoryProjects()) {
      const projectRead = await readProject(project);
      if (!projectRead) continue;
      projects.push(projectRead.shouldProcess ? await processProjectStateSafely(projectRead.state) : projectRead.state);
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
    projects.push(...(await readObservedProjects()).filter((observed) => !currentIds.has(observed.projectId)));
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
