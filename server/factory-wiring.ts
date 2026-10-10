import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { CoherenceWorkCreated } from '../shared/contracts/coherence.ts';
import { FACTORY_ERROR_MAX_CHARS, FactoryControlRequest, FactoryLaneState, FactoryQueueIntentRequest, isSingleFactoryPathSegment } from '../shared/contracts/factory.ts';
import type { FactoryControlResult, FactoryQueueIntentResult, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import { comparableDirectoryPath } from '../shared/paths.ts';
import type { Config } from '../shared/contracts/config.ts';
import { execFileAsync } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { buildCoherenceShims } from './core/coherence-session-core.ts';
import { factoryWrittenRecordId, findFactoryProjectPath, FACTORY_FIRST_TICK_DELAY_MS, FACTORY_LEDGER_SESSION, FACTORY_NOTIFY_CATEGORY, factoryShouldStart, isCompletedCommandFailure } from './core/factory-core.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';
import { commitAndLandFactoryLedger, screenPendingLedgerWrites } from './factory-ledger.ts';
import { createFactoryCloseOut } from './factory-closeout.ts';
import type { FactoryCloseOutDeps } from './factory-closeout.ts';
import { createFactoryDispatch } from './factory-dispatch.ts';
import { createFactoryOrchestrator } from './factory-orchestrator.ts';
import type { Session } from '../session/sessions.ts';
import type { FactoryOrchestratorDeps, FactoryOrchestratorSession } from './factory-orchestrator.ts';
import { createFactoryPoller } from './factory-poller.ts';
import type { FactoryPoller, FactoryPollerDeps } from './factory-poller.ts';
import { createGitWorkspace, factoryGitEnvironment, isolateGitWorkspace, runFactoryGit } from './git-workspace.ts';
import type { GitWorkspaceInstance } from './git-workspace.ts';
import { loadJsonStateFile, writeJsonAtomic, writeTextAtomic } from './json-file.ts';
import { createLaneRunner } from './lane-runner.ts';
import { cliPath as glimmervoidCliPath, resolvePackageBin } from './runtime-paths.ts';
import { errorMessage, isMissingFileError } from '../shared/text.ts';
import { createFactoryWatch } from './factory-watch.ts';
import type { FactoryWatchDeps } from './factory-watch.ts';
import { createFactoryVerifier } from './factory-verifier.ts';
import { createPosthogApi } from './posthog-api.ts';

const COHERENCE_CONFIG_PROBE_TIMEOUT_MS = 5_000;

interface FactoryWiringOptions<ManagedSession extends FactoryOrchestratorSession = Session> extends Partial<Omit<FactoryPollerDeps, 'broadcast' | 'beforeTick'>> {
  config: Pick<Config, 'factory' | 'projects' | 'integrationBranch' | 'posthog' | 'worktreeShare'>;
  broadcast: FactoryPollerDeps['broadcast'];
  gitWorkspace?: GitWorkspaceInstance;
  homeDir?: string;
  readSpentTodayUsd?: () => number | null;
  createPoller?: typeof createFactoryPoller;
  runHogQL?: FactoryWatchDeps['runHogQL'];
  notify?: (projectName: string, category: string, message: string) => void;
  spawnVerifier?: FactoryCloseOutDeps['spawnReviewer'];
  spawnReviewer?: FactoryCloseOutDeps['spawnReviewer'];
  orchestratorOptions?: Omit<FactoryOrchestratorDeps<ManagedSession>, 'nodePath' | 'hookCliPath' | 'shimDir' | 'ensureLedger' | 'commitAndLand' | 'readTrustedIntentIds'>;
}

export function createFactoryWiring<ManagedSession extends FactoryOrchestratorSession = Session>({
  config, broadcast, gitWorkspace = createGitWorkspace(), homeDir = glimmervoidHomeDir(),
  createPoller = createFactoryPoller, log = console, orchestratorOptions, spawnReviewer, spawnVerifier = spawnReviewer, readSpentTodayUsd = () => 0, runHogQL, notify = () => {}, runCoherence: customRunCoherence, ...pollerDeps
}: FactoryWiringOptions<ManagedSession>) {
  gitWorkspace = isolateGitWorkspace(gitWorkspace, { disableRepoCommands: true });
  const writtenRecordIdsByCheckout = new Map<string, Set<string>>();
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  const coherenceHookCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence-hook');
  let dispatcher: ReturnType<typeof createFactoryDispatch<ManagedSession>> | null = null;
  let spentTodayUsd: number | null = 0;
  const exceptions = new Map<string, string>();
  const landingErrors = new Map<string, string>();
  let orchestrator: ReturnType<typeof createFactoryOrchestrator<ManagedSession>> | null = null;
  const binDir = path.join(homeDir, 'factory', 'bin');
  const projectChains = new Map<string, Promise<unknown>>();
  const laneStates = new Map<string, Promise<FactoryLaneState>>();
  const invokeCoherence: FactoryPollerDeps['runCoherence'] = customRunCoherence ?? (async ({ cwd, args }) => {
    if (!coherenceCliPath) throw new Error('Could not resolve the coherence CLI');
    const { stdout } = await execFileAsync(process.execPath, [coherenceCliPath, ...args], {
      cwd, env: await factoryGitEnvironment(cwd), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  });
  const runCoherence: FactoryPollerDeps['runCoherence'] = async ({ cwd, args }) => {
    const isFactoryWrite = args[args.indexOf('--session') + 1] === FACTORY_LEDGER_SESSION
      && (args[0] === 'defect' || args[0] === 'work' || args[0] === 'consequence');
    const writeArgs = isFactoryWrite && args[0] !== 'defect' && !args.includes('--json') ? [...args, '--json'] : args;
    const output = await invokeCoherence({ cwd, args: writeArgs });
    if (!isFactoryWrite) return output;
    const recordId = factoryWrittenRecordId(output);
    if (!recordId) throw new Error('Factory ledger writer did not return a record id');
    const checkoutKey = await comparableDirectoryPath(cwd);
    const writtenRecordIds = writtenRecordIdsByCheckout.get(checkoutKey) ?? new Set<string>();
    writtenRecordIds.add(recordId);
    writtenRecordIdsByCheckout.set(checkoutKey, writtenRecordIds);
    return output;
  };
  const checkouts = new Map<string, { projectPath: string; sha: string }>();

  async function ensureCoherenceShims(): Promise<void> {
    if (!coherenceCliPath) throw new Error('Could not resolve the coherence CLI');
    const shims = buildCoherenceShims({ nodePath: process.execPath, cliPath: coherenceCliPath, glimmervoidCliPath });
    await mkdir(binDir, { recursive: true });
    for (const shim of shims) {
      const shimPath = path.join(binDir, shim.fileName);
      const existingText = await readFile(shimPath, 'utf8').catch((error: unknown) => {
        if (isMissingFileError(error, { includeNotDir: false })) return null;
        throw error;
      });
      if (existingText !== shim.text) await writeTextAtomic(shimPath, shim.text, { mode: shim.mode });
      if (!shim.fileName.endsWith('.cmd')) await chmod(shimPath, shim.mode);
    }
  }

  function projectHomePath(projectId: string): string {
    if (!projectId || !isSingleFactoryPathSegment(projectId)) throw new Error('Invalid factory project id');
    return path.join(homeDir, 'factory', projectId);
  }

  const controlCheckoutPath = (projectId: string) => path.join(projectHomePath(projectId), 'control');
  const statePath = (projectId: string) => path.join(projectHomePath(projectId), 'state.json');

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
    try {
      await runFactoryGit(['cat-file', '-e', `${sha}:coherence.config.json`], {
        cwd: projectPath, encoding: 'utf8', timeout: COHERENCE_CONFIG_PROBE_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      if (isCompletedCommandFailure(error)) return false;
      throw error;
    }
  }

  async function resolveIntegrationBranch(projectPath: string): Promise<string> {
    const branch = configuredIntegrationBranch(config) ?? await gitWorkspace.detectDefaultBranch({ projectPath });
    if (!branch) throw new Error('Could not resolve the integration branch');
    return branch;
  }

  async function loadLaneState(projectId: string): Promise<FactoryLaneState> {
    const loaded = await loadJsonStateFile({
      filePath: statePath(projectId), fsPromises: { readFile, rename }, nowMs: Date.now,
      parse: (raw) => {
        const parsed = FactoryLaneState.safeParse(raw);
        return parsed.success ? parsed.data : null;
      },
    });
    if (loaded.status === 'unreadable') throw loaded.error;
    if (loaded.status === 'loaded') return loaded.value;
    return { ledgerPath: null, ledgerBranch: null, paused: false };
  }

  function readLaneState(projectId: string): Promise<FactoryLaneState> {
    const existing = laneStates.get(projectId);
    if (existing) return existing;
    const loading = loadLaneState(projectId);
    laneStates.set(projectId, loading);
    void loading.catch(() => { if (laneStates.get(projectId) === loading) laneStates.delete(projectId); });
    return loading;
  }

  async function writeLaneState(projectId: string, state: FactoryLaneState): Promise<void> {
    const validated = FactoryLaneState.parse(state);
    await writeJsonAtomic(statePath(projectId), validated, { mkdir: true });
    laneStates.set(projectId, Promise.resolve(validated));
  }

  async function updateLaneState(projectId: string, changesOf: (state: FactoryLaneState) => Partial<FactoryLaneState>): Promise<void> {
    const state = await readLaneState(projectId);
    await writeLaneState(projectId, { ...state, ...changesOf(state) });
  }

  const readPaused = async (projectId: string) => (await readLaneState(projectId)).paused;

  function serializeProject<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = projectChains.get(projectId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    projectChains.set(projectId, next);
    const release = () => { if (projectChains.get(projectId) === next) projectChains.delete(projectId); };
    void next.then(release, release);
    return next;
  }

  function requireProject(projectId: string): string {
    if (runner.isStopped() || !factoryShouldStart(config).start || !runner.getPoller()) throw new Error('Factory is not running');
    const projectPath = findFactoryProjectPath(config, projectId);
    if (!projectPath) throw new Error('Unknown factory project');
    return projectPath;
  }

  async function ensureLedgerCheckout(projectId: string, projectPath: string) {
    const state = await readLaneState(projectId);
    const integrationBranch = await resolveIntegrationBranch(projectPath);
    if (state.ledgerPath && state.ledgerBranch) {
      const ledgerPath = await comparableDirectoryPath(state.ledgerPath);
      const worktrees = await gitWorkspace.listWorktrees({ projectPath, integrationBranch, prefixes: [state.ledgerBranch] });
      const existing = worktrees.find((worktree) => worktree.cwd === ledgerPath && worktree.branch === state.ledgerBranch && !worktree.prunable);
      if (existing) return { cwd: existing.cwd, branch: existing.branch, base: integrationBranch, isGit: true };
    }
    const ledger = await gitWorkspace.create({
      projectPath, teamId: projectId, label: 'factory-ledger', baseBranch: integrationBranch,
      configuredIntegrationBranch: configuredIntegrationBranch(config),
      worktreeBase: projectHomePath(projectId), shareList: [],
    });
    if (!ledger.isGit || !ledger.branch) throw new Error(ledger.error ?? ledger.reason ?? 'Could not create the factory ledger');
    await writeLaneState(projectId, { ...state, ledgerPath: ledger.cwd, ledgerBranch: ledger.branch });
    return ledger;
  }

  async function ensureTrustedLedgerCheckout(projectId: string, projectPath: string) {
    const ledger = await ensureLedgerCheckout(projectId, projectPath);
    await screenPendingLedgerWrites({ cwd: ledger.cwd, intentId: activeIntentIdOf(projectId),
      onRefused: (reason) => raiseException(projectId, reason) });
    return ledger;
  }

  function activeIntentIdOf(projectId: string): string | null {
    return orchestrator?.activeIntentId(projectId) ?? null;
  }

  async function readTrustedIntentIds(projectId: string): Promise<ReadonlySet<string>> {
    return new Set((await readLaneState(projectId)).trustedIntentIds ?? []);
  }

  async function landLedger(projectId: string, projectPath: string, ledger: Awaited<ReturnType<typeof ensureLedgerCheckout>>, message: string,
    { trusted, intentId = null, onCommitted }: { trusted: boolean; intentId?: string | null; onCommitted?: () => Promise<void> }): Promise<void> {
    const checkoutKey = await comparableDirectoryPath(ledger.cwd);
    try {
      await commitAndLandFactoryLedger({
        projectPath, ledger, message, targetBranch: await resolveIntegrationBranch(projectPath), gitWorkspace, trusted, intentId, writtenRecordIds: writtenRecordIdsByCheckout.get(checkoutKey) ?? new Set(),
        retryLanding: landingErrors.has(projectId), onRefused: (reason) => raiseException(projectId, reason), onCommitted,
      });
      landingErrors.delete(projectId);
      writtenRecordIdsByCheckout.delete(checkoutKey);
    } catch (error) {
      landingErrors.set(projectId, errorMessage(error));
      throw error;
    }
  }

  async function queueIntent(request: FactoryQueueIntentRequest): Promise<FactoryQueueIntentResult> {
    try {
      const intent = FactoryQueueIntentRequest.parse(request);
      const outcome = await serializeProject(intent.projectId, async () => {
        const projectPath = requireProject(intent.projectId);
        const ledger = await ensureTrustedLedgerCheckout(intent.projectId, projectPath);
        const args = [
          'work', 'create', intent.objective,
          ...intent.criteria.flatMap((criterion) => ['--success', criterion]),
          '--risk', intent.risk, '--authority', 'user-directed', '--granted-by', 'operator',
          '--boundary', intent.boundary, '--session', FACTORY_LEDGER_SESSION,
          ...intent.writeScopes.flatMap((scope) => ['--write-scope', scope]), '--json',
        ];
        const created = CoherenceWorkCreated.parse(JSON.parse(await runCoherence({ cwd: ledger.cwd, args })));
        await updateLaneState(intent.projectId, (state) => ({ trustedIntentIds: [...new Set([...(state.trustedIntentIds ?? []), created.work])] }));
        await landLedger(intent.projectId, projectPath, ledger, `factory: queue intent ${created.work}`, { trusted: true, intentId: activeIntentIdOf(intent.projectId) });
        return { projectId: intent.projectId, ok: true, workId: created.work };
      });
      await runner.getPoller()?.refreshNow();
      return outcome;
    } catch (error) {
      return { projectId: request.projectId, ok: false, error: errorMessage(error).slice(0, FACTORY_ERROR_MAX_CHARS) };
    }
  }

  async function control(request: FactoryControlRequest): Promise<FactoryControlResult> {
    try {
      const command = FactoryControlRequest.parse(request);
      const outcome = await serializeProject(command.projectId, async () => {
        requireProject(command.projectId);
        await updateLaneState(command.projectId, () => ({ paused: command.action === 'pause' }));
        return { ...command, ok: true };
      });
      await runner.getPoller()?.refreshNow();
      return outcome;
    } catch (error) {
      return { projectId: request.projectId, action: request.action, ok: false, error: errorMessage(error).slice(0, FACTORY_ERROR_MAX_CHARS) };
    }
  }

  function raiseException(projectId: string, reason: string): void {
    if (exceptions.get(projectId) === reason) return;
    exceptions.set(projectId, reason);
    notify(config.projects.find((project) => project.id === projectId)?.name ?? projectId, FACTORY_NOTIFY_CATEGORY, reason);
  }

  const runner = createLaneRunner<FactoryPoller>({
    tag: 'factory',
    gate: () => factoryShouldStart(config),
    cfgKey: () => JSON.stringify(config.factory ?? null),
    emptyStatus: () => ({}),
    createPoller: () => {
      const activeOrchestrator = orchestratorOptions && coherenceHookCliPath ? createFactoryOrchestrator({
        ...orchestratorOptions,
        nodePath: process.execPath, hookCliPath: coherenceHookCliPath, shimDir: binDir, readTrustedIntentIds,
        ensureLedger: (projectId) => serializeProject(projectId, async () => {
          const ledger = await ensureLedgerCheckout(projectId, requireProject(projectId));
          return ledger.cwd;
        }),
        commitAndLand: (projectId, intentId) => serializeProject(projectId, async () => {
          const projectPath = requireProject(projectId);
          const ledger = await ensureLedgerCheckout(projectId, projectPath);
          await landLedger(projectId, projectPath, ledger, `factory: orchestrator ledger ${projectId}`, { trusted: false, intentId });
        }),
      }) : null;
      orchestrator = activeOrchestrator;
      const commitAndLand = async (projectId: string, projectPath: string, message: string, { onCommitted }: { onCommitted?: () => Promise<void> } = {}) => {
        const ledger = await ensureLedgerCheckout(projectId, projectPath);
        await landLedger(projectId, projectPath, ledger, message, { trusted: true, intentId: activeIntentIdOf(projectId), onCommitted });
      };
      const readIntegrationSha = async (projectPath: string) => (await runFactoryGit(
        ['rev-parse', `refs/heads/${await resolveIntegrationBranch(projectPath)}`], { cwd: projectPath, timeout: 30_000 })).stdout.trim();
      const refreshAfter = (changedSubject: string) => () => {
        void runner.getPoller()?.refreshNow().catch((error: unknown) => {
          log.warn(`[factory] ${changedSubject} refresh failed: ${errorMessage(error)}`);
        });
      };
      const refresh = refreshAfter('state');
      const notifyOrchestrator = (projectId: string, event: FactoryWorkerEvent) => activeOrchestrator?.notifyOrchestrator(projectId, event);
      const activeWatch = createFactoryWatch({
        config, readLaneState, writeLaneState, serializeProject, ensureLedger: ensureTrustedLedgerCheckout, runCoherence, commitAndLand,
        runHogQL: runHogQL ?? ((projectId, query) => createPosthogApi({ host: typeof config.posthog?.host === 'string' ? config.posthog.host : undefined, apiKey: typeof config.posthog?.apiKey === 'string' ? config.posthog.apiKey : undefined }).runHogQL(projectId, query)),
        notifyOrchestrator,
        notify: (projectName, message) => notify(projectName, FACTORY_NOTIFY_CATEGORY, message), now: pollerDeps.now, log, onChanged: refresh,
      });
      const activeVerifier = spawnVerifier ? createFactoryVerifier({
        config, spawnVerifier, serializeProject, ensureLedger: ensureTrustedLedgerCheckout, ensureControlCheckout, readIntegrationSha, readLaneState, writeLaneState,
        runCoherence, commitAndLand, pause: (projectId) => serializeProject(projectId, () => updateLaneState(projectId, () => ({ paused: true }))),
        setException: raiseException,
        notifyOrchestrator,
        stopOrchestrator: (projectId) => activeOrchestrator?.releaseProject(projectId), onChanged: refresh,
      }) : null;
      const activeCloseOut = spawnReviewer ? createFactoryCloseOut({
        config, spawnReviewer, gitWorkspace, serializeProject, ensureLedger: ensureTrustedLedgerCheckout, runCoherence, commitAndLand, readIntegrationSha,
        readPaused,
        appendWatch: (entry) => updateLaneState(entry.projectId, (state) => ({ watch: [...(state.watch ?? []), entry] })),
        notifyOrchestrator,
        setException: raiseException,
        onReviewingChanged: refreshAfter('review state'),
      }) : null;
      const activeDispatcher = orchestratorOptions && coherenceHookCliPath ? createFactoryDispatch({
        ...orchestratorOptions, nodePath: process.execPath, hookCliPath: coherenceHookCliPath, shimDir: binDir,
        onWorkerTurnEnd: activeCloseOut?.turnEnded,
        getOrchestrator: (sessionId) => activeOrchestrator?.getLiveOrchestrator(sessionId) ?? null,
        serializeProject, ensureLedger: ensureTrustedLedgerCheckout, runCoherence, readSpentTodayUsd: () => spentTodayUsd, readTrustedIntentIds, readPaused,
        onReadyIntent: (projectId, intentId) => activeVerifier?.ready(projectId, intentId),
        commitAndLand,
        notifyOrchestrator,
        setException: (projectId, reason) => {
          if (reason === null) { exceptions.delete(projectId); return; }
          raiseException(projectId, reason);
        },
      }) : null;
      dispatcher = activeDispatcher;
      const poller = createPoller({
        log,
        listFactoryProjects: () => (config.projects ?? []).flatMap(({ id, name, path: projectPath }) => {
          if (!id || !projectPath) return [];
          return [{ id, name: name ?? path.basename(projectPath), path: projectPath }];
        }),
        resolveIntegrationBranch,
        readPaused,
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
        runCoherence,
        ...pollerDeps,
        firstTickDelayMs: pollerDeps.firstTickDelayMs ?? (() => FACTORY_FIRST_TICK_DELAY_MS),
        shouldHoldCheckout: (projectId) => activeVerifier?.isVerifying(projectId) ?? false,
        beforeTick: () => { spentTodayUsd = readSpentTodayUsd(); },
        processProjectState: async (project) => {
          await activeDispatcher?.reconcileActiveOrders(project);
          if (!project.paused) activeCloseOut?.resumeHeld(project.projectId);
          const watched = await activeWatch.tick(project);
          const verified = activeVerifier ? await activeVerifier.tick(watched) : watched;
          const updated = activeOrchestrator ? await activeOrchestrator.tick(verified) : verified;
          const liveWorkers = activeDispatcher?.getLiveWorkers(project.projectId) ?? [];
          const reviewing = liveWorkers.filter((worker) => activeCloseOut?.reviewing.has(worker.workId)).map((worker) => worker.workId);
          return { ...updated, reviewing, liveWorkers, spentTodayUsd: spentTodayUsd ?? undefined, dailyBudgetUsd: config.factory?.dailyBudgetUsd ?? null,
            error: updated.error ?? exceptions.get(project.projectId) ?? landingErrors.get(project.projectId) ?? null };
        },
        releaseOrchestrator: (projectId) => {
          activeDispatcher?.releaseProject(projectId);
          activeOrchestrator?.releaseProject(projectId);
          exceptions.delete(projectId);
        },
        broadcast,
      });
      let stopping: Promise<void> | null = null;
      const stop = async () => {
        activeWatch.stop();
        await activeVerifier?.stop();
        await activeCloseOut?.stop();
        const stoppingWorkers = activeDispatcher?.stop();
        const stoppingOrchestrator = activeOrchestrator?.stop();
        await poller.stop();
        await stoppingOrchestrator;
        await stoppingWorkers;
        if (dispatcher === activeDispatcher) dispatcher = null;
        if (orchestrator === activeOrchestrator) orchestrator = null;
        for (const projectId of [...checkouts.keys()]) {
          await removeCheckout(projectId).catch((error: unknown) => {
            log.warn(`[factory] removing the control checkout for ${projectId} failed: ${errorMessage(error)}`);
          });
        }
      };
      return {
        ...poller,
        start: async () => {
          await ensureCoherenceShims().catch((error: unknown) => {
            log.warn(`[factory] coherence shim setup failed: ${errorMessage(error)}`);
          });
          if (stopping) return;
          await poller.start();
        },
        stop: () => { stopping ??= stop(); return stopping; },
      };
    },
  });
  return {
    binDir,
    start: runner.startPoller,
    stop: async () => {
      const stopped = runner.stopPoller();
      await Promise.allSettled([...projectChains.values()]);
      await stopped;
    },
    getLiveOrchestrator: (sessionId: string) => factoryShouldStart(config).start ? orchestrator?.getLiveOrchestrator(sessionId) ?? null : null,
    dispatch: async (sessionId: string, payload: Record<string, unknown>) => {
      const outcome = await dispatcher?.dispatch(sessionId, payload) ?? { ok: false as const, reason: 'Factory is not running' };
      await runner.getPoller()?.refreshNow();
      return outcome;
    },
    queueIntent,
    control,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    getState: () => runner.isStopped() ? null : runner.getPoller()?.getState() ?? null,
  };
}
