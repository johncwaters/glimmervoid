import { access, chmod, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { CoherenceTicketCreated, CoherenceWorkCreated, CoherenceWorkInspect } from '../../shared/contracts/coherence.ts';
import { FACTORY_ERROR_MAX_CHARS, FactoryControlRequest, FactoryLaneState, FactoryQueueIntentRequest, isSingleFactoryPathSegment } from '../../shared/contracts/factory.ts';
import type { FactoryControlResult, FactoryProjectState, FactoryQueueIntentResult, FactoryUnlandedRecord } from '../../shared/contracts/factory.ts';
import { comparableDirectoryPath } from '../../shared/canonical-paths.ts';
import type { Config, ProjectConfig } from '../../shared/contracts/config.ts';
import type { AgentTicketReply, AgentTicketRequest, TicketAgentVerb } from '../../shared/contracts/session.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { DEFAULT_CONFIG, glimmervoidHomeDir } from '../config-store.ts';
import { buildCoherenceShims } from '../core/coherence-session-core.ts';
import { appendFactoryLandedSha, buildTicketCreateArgs, decideFactoryStalls, decideIntentOutcomeNotices, exceedsRiskCeiling, factoryConfigKey, factoryWrittenRecordId, findFactoryProjectPath, findIntentTicketProblem, FACTORY_FIRST_TICK_DELAY_MS, FACTORY_LEDGER_SESSION, FACTORY_NOTIFY_CATEGORY, factoryIntentWorkId, factoryShouldStart, isFactoryProjectInFlight, hasValidWriteScopes, hasWildcardWriteScope, isCompletedCommandFailure, redactSecretLines, withIntentFloorAllowances, withIntentConfirmedFlakes, withIntentScopeNeeds, withTicketBlockCount } from './core/factory-core.ts';
import type { FactoryWorkRefusal } from './core/factory-core.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import type { LaneSpend } from '../usage/core/usage-scan-core.ts';
import { captureFactoryLedgerRecord, commitAndLandFactoryLedger, discardPendingLedgerWrites, hasCodeChangedBetween, listRecordsMissingFromHead, readCodeDiffBetween, screenPendingLedgerWrites } from './factory-ledger.ts';
import { createFactoryDecisionLog } from './factory-decision-log.ts';
import { factoryDecisionContext, isLogOnlyFactoryEvent } from './core/factory-decision-log-core.ts';
import type { FactoryDecisionWorkerEvent } from './core/factory-decision-log-core.ts';
import { createFactoryCloseOut, factorySecretValues } from './factory-closeout.ts';
import type { FactoryCloseOutDeps } from './factory-closeout.ts';
import { createFactoryDispatch } from './factory-dispatch.ts';
import { readLaneCommonGitDir } from '../lanes/work-lane.ts';
import { buildFactoryDecisionEvent } from '../core/telemetry-core.ts';
import type { Telemetry } from '../telemetry.ts';
import { repositoryRootOfCommonGitDir } from '../core/claude-trust-core.ts';
import type { FolderTrustOutcome } from '../claude-trust.ts';
import { createFactoryOrchestrator, createFactoryTicketVerbs } from './factory-orchestrator.ts';
import type { Session } from '../../session/sessions.ts';
import type { FactoryOrchestratorDeps, FactoryOrchestratorSession } from './factory-orchestrator.ts';
import { createFactoryPoller } from './factory-poller.ts';
import type { FactoryPoller, FactoryPollerDeps } from './factory-poller.ts';
import { createGitWorkspace, factoryGitEnvironment, isolateGitWorkspace, runHardenedGit } from '../git/git-workspace.ts';
import type { GitWorkspaceInstance } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { loadJsonStateFile, writeJsonAtomic, writeTextAtomic } from '../json-file.ts';
import { createLaneRunner } from '../lanes/lane-runner.ts';
import { cliPath as glimmervoidCliPath, resolvePackageBin } from '../runtime-paths.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { createFactoryVerifier } from './factory-verifier.ts';
import { createFactorySetup } from './factory-setup.ts';
import type { FactorySetupResult } from './core/factory-setup-core.ts';
import { decideTicketAction } from '../core/agent-api-core.ts';
import { FACTORY_TICKET_BLOCK_CAP } from './core/factory-core.ts';
import { resolveFactoryProfile } from './core/factory-profile-core.ts';

const COHERENCE_CONFIG_PROBE_TIMEOUT_MS = 5_000;
const ORCHESTRATOR_EXCEPTION_PREFIX = 'factory-exception';

interface FactoryWiringOptions<ManagedSession extends FactoryOrchestratorSession = Session> extends Partial<Omit<FactoryPollerDeps, 'broadcast' | 'beforeTick'>> {
  config: Pick<Config, 'factory' | 'projects' | 'integrationBranch' | 'posthog' | 'worktreeShare' | 'worktreeRoot'>;
  broadcast: FactoryPollerDeps['broadcast'];
  gitWorkspace?: GitWorkspaceInstance;
  homeDir?: string;
  telemetry?: Pick<Telemetry, 'capture'>;
  readSpentTodayUsd?: () => LaneSpend;
  createPoller?: typeof createFactoryPoller;
  notify?: (projectName: string, category: string, message: string) => void;
  spawnVerifier?: FactoryCloseOutDeps['spawnReviewer'];
  spawnReviewer?: FactoryCloseOutDeps['spawnReviewer'];
  prepareCheckRunner?: FactoryCloseOutDeps['prepareCheckRunner'];
  saveProjectFactoryProfile?: (projectPath: string, profile: NonNullable<ProjectConfig['factoryProfile']>) => Promise<void>;
  trustClaudeFolder?: (repositoryRoot: string) => Promise<FolderTrustOutcome>;
  orchestratorOptions?: Omit<FactoryOrchestratorDeps<ManagedSession>, 'nodePath' | 'hookCliPath' | 'shimDir' | 'ensureLedger' | 'commitAndLand' | 'readTrustedIntentIds' | 'beginIntent'>;
}

export function createFactoryWiring<ManagedSession extends FactoryOrchestratorSession = Session>({
  config, broadcast, gitWorkspace = createGitWorkspace(), homeDir = glimmervoidHomeDir(),
  createPoller = createFactoryPoller, log = console, telemetry, orchestratorOptions, trustClaudeFolder, spawnReviewer, prepareCheckRunner, saveProjectFactoryProfile, spawnVerifier = spawnReviewer, readSpentTodayUsd = () => ({ status: 'known', amountUsd: 0 }), notify = () => {}, runCoherence: customRunCoherence, ...pollerDeps
}: FactoryWiringOptions<ManagedSession>) {
  gitWorkspace = isolateGitWorkspace(gitWorkspace, { disableRepoCommands: true });
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  const coherenceHookCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence-hook');
  let dispatcher: ReturnType<typeof createFactoryDispatch<ManagedSession>> | null = null;
  let ticketVerbs: ReturnType<typeof createFactoryTicketVerbs> | null = null;
  let todaySpend: LaneSpend = { status: 'known', amountUsd: 0 };
  const decisionLog = createFactoryDecisionLog({
    homeDir, now: pollerDeps.now, log, redact: (text) => redactSecretLines(text, factorySecretValues(process.env)),
    onDecision: (line) => telemetry?.capture('factory_decision', buildFactoryDecisionEvent(line)),
  });
  void decisionLog.pruneEveryProject();
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
    const projectId = await findProjectIdOfLedger(cwd);
    if (!projectId) throw new Error('Factory ledger write ran outside a factory ledger checkout');
    const writtenRecord = await captureFactoryLedgerRecord(cwd, recordId, { args: writeArgs, output });
    if (!writtenRecord) return output;
    await updateLaneState(projectId, (state) => {
      const unlandedRecords = state.unlandedFactoryRecords ?? [];
      return { unlandedFactoryRecords: unlandedRecords.some(({ id }) => id === writtenRecord.id) ? unlandedRecords : [...unlandedRecords, writtenRecord] };
    });
    return output;
  };

  async function findProjectIdOfLedger(cwd: string): Promise<string | null> {
    const checkoutKey = await comparableDirectoryPath(cwd);
    for (const { id } of config.projects ?? []) {
      if (!id || !isSingleFactoryPathSegment(id)) continue;
      const { ledgerPath } = await readLaneState(id);
      if (ledgerPath && await comparableDirectoryPath(ledgerPath) === checkoutKey) return id;
    }
    return null;
  }

  async function readUnlandedFactoryRecords(projectId: string): Promise<FactoryUnlandedRecord[]> {
    return (await readLaneState(projectId)).unlandedFactoryRecords ?? [];
  }

  function forgetUnlandedFactoryRecords(projectId: string, recordIds: ReadonlySet<string>): Promise<void> {
    return updateLaneState(projectId, (state) => ({ unlandedFactoryRecords: (state.unlandedFactoryRecords ?? []).filter(({ id }) => !recordIds.has(id)) }));
  }
  const checkouts = new Map<string, { projectPath: string; sha: string }>();
  const setup = createFactorySetup({
    readIntegrationSha: async (projectPath) => {
      const branch = await resolveIntegrationBranch(projectPath);
      const listed = await gitWorkspace.listIntegrationTips({ projectPath, integrationBranch: branch });
      if (!('integrationTips' in listed)) throw new Error(listed.err || `Could not list the ${branch} refs`);
      const tip = listed.integrationTips.find((candidate) => candidate.branch === branch);
      if (!tip?.sha) throw new Error(`Could not resolve origin/${branch} or ${branch}`);
      return tip.sha;
    },
    globalChecks: () => config.factory?.checks,
    sharedEntries: () => config.worktreeShare ?? DEFAULT_CONFIG.worktreeShare,
    gitWorkspace, prepareCheckRunner, spawnSetupAgent: spawnReviewer,
    model: () => config.factory?.reviewerModel ?? null,
    secretValues: factorySecretValues(process.env),
    saveProjectFactoryProfile: async (projectPath, profile) => {
      if (!saveProjectFactoryProfile) throw new Error('Factory setup profile persistence is unavailable');
      await saveProjectFactoryProfile(projectPath, profile);
      const project = config.projects?.find((entry) => entry.path === projectPath);
      if (!project) throw new Error('Factory setup project is no longer configured');
      project.factoryProfile = profile;
    },
    recordBaseline: async (projectId, baseline) => {
      await mkdir(projectHomePath(projectId), { recursive: true });
      await writeJsonAtomic(path.join(projectHomePath(projectId), 'setup-baseline.json'), baseline);
    },
  });

  async function rerunSetup(projectId: string): Promise<FactorySetupResult> {
    try {
      const outcome = await setup.runSetup(projectId, requireProject(projectId));
      await runner.getPoller()?.refreshNow();
      return outcome;
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

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
      await runHardenedGit(['cat-file', '-e', `${sha}:coherence.config.json`], {
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

  async function countTicketBlock(projectId: string, workId: string, shouldPark = false): Promise<number> {
    let blockCount = 0;
    await updateLaneState(projectId, (state) => {
      const ticketBlockCounts = withTicketBlockCount(state.ticketBlockCounts, workId, shouldPark);
      blockCount = ticketBlockCounts[workId];
      return { ticketBlockCounts };
    });
    return blockCount;
  }

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

  async function changeTicket(verb: TicketAgentVerb, sessionId: string, request: AgentTicketRequest): Promise<AgentTicketReply> {
    const verbs = factoryShouldStart(config).start ? ticketVerbs : null;
    if (!verbs) return { ok: false, reason: 'Factory is not running' };
    const reply = await verbs[verb](sessionId, request);
    await runner.getPoller()?.refreshNow();
    return reply;
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
    await screenPendingLedgerWrites({ cwd: ledger.cwd, intentId: activeIntentIdOf(projectId), declaredFactoryRecords: await readUnlandedFactoryRecords(projectId),
      onRefused: (reason) => raiseException(projectId, reason) });
    return ledger;
  }

  function activeIntentIdOf(projectId: string): string | null {
    return orchestrator?.activeIntentId(projectId) ?? null;
  }

  async function readTrustedIntentIds(projectId: string): Promise<ReadonlySet<string>> {
    return new Set((await readLaneState(projectId)).trustedIntentIds ?? []);
  }

  async function notifyIntentOutcomes(project: FactoryProjectState): Promise<void> {
    const { notifiedIntentOutcomes } = await readLaneState(project.projectId);
    const outcomeNotices = decideIntentOutcomeNotices({ project, trustedIntentIds: await readTrustedIntentIds(project.projectId), notifiedIntentOutcomes });
    const isNotifiedListUnchanged = JSON.stringify(outcomeNotices.notifiedIntentOutcomes) === JSON.stringify(notifiedIntentOutcomes);
    if (isNotifiedListUnchanged && outcomeNotices.messages.length === 0) return;
    await serializeProject(project.projectId, () => updateLaneState(project.projectId, () => ({ notifiedIntentOutcomes: outcomeNotices.notifiedIntentOutcomes })));
    for (const message of outcomeNotices.messages) notifyProject(project.projectId, message);
  }

  async function writePendingTickets(projectId: string, intentId: string): Promise<void> {
    const pending = (await readLaneState(projectId)).pendingIntentTickets?.[intentId];
    if (!pending) return;
    const projectPath = requireProject(projectId);
    const ledger = await ensureTrustedLedgerCheckout(projectId, projectPath);
    const recordIdsBeforeTickets = new Set((await readUnlandedFactoryRecords(projectId)).map(({ id }) => id));
    try {
      for (const ticket of pending.tickets) {
        CoherenceTicketCreated.parse(JSON.parse(await runCoherence({ cwd: ledger.cwd, args: buildTicketCreateArgs({ intent: pending, intentWorkId: intentId, ticket }) })));
      }
      await landLedger(projectId, projectPath, ledger, `factory: write tickets of ${intentId}`, { intentId, landsCommittedWrites: true });
    } catch (error) {
      await discardFailedTicketWrites(projectId, ledger.cwd, recordIdsBeforeTickets).catch((discardError: unknown) => {
        log.warn(`[factory] could not discard unlanded tickets of ${intentId}: ${errorMessage(discardError)}`);
      });
      throw error;
    }
    await updateLaneState(projectId, (state) => ({
      pendingIntentTickets: Object.fromEntries(Object.entries(state.pendingIntentTickets ?? {}).filter(([pendingIntentId]) => pendingIntentId !== intentId)),
    }));
  }

  async function discardFailedTicketWrites(projectId: string, ledgerPath: string, recordIdsBeforeTickets: ReadonlySet<string>): Promise<void> {
    const ticketRecords = (await readUnlandedFactoryRecords(projectId)).filter(({ id }) => !recordIdsBeforeTickets.has(id));
    const discardableRecords = await listRecordsMissingFromHead(ledgerPath, ticketRecords);
    await forgetUnlandedFactoryRecords(projectId, new Set(discardableRecords.map(({ id }) => id)));
    await discardPendingLedgerWrites(ledgerPath, await readUnlandedFactoryRecords(projectId));
  }

  async function beginIntent({ projectId, intentId, headSha }: { projectId: string; intentId: string; headSha: string | null }): Promise<{ hasTickets: boolean }> {
    await writePendingTickets(projectId, intentId);
    const state = await readLaneState(projectId);
    if (headSha && !state.intentBaseShas?.[intentId]) await writeLaneState(projectId, { ...state, intentBaseShas: { ...state.intentBaseShas, [intentId]: headSha } });
    return { hasTickets: (state.ticketedIntentIds ?? []).includes(intentId) };
  }

  async function readIntentDiff({ projectId, projectPath, intentId, tipSha }: { projectId: string; projectPath: string; intentId: string; tipSha: string }) {
    const baseSha = (await readLaneState(projectId)).intentBaseShas?.[intentId];
    if (!baseSha) return null;
    return { baseSha, diffText: await readCodeDiffBetween({ projectPath, sinceSha: baseSha, tipSha }) };
  }

  async function readIntentWriteScopes(projectId: string): Promise<ReadonlyMap<string, readonly string[]>> {
    return new Map(Object.entries((await readLaneState(projectId)).intentWriteScopes ?? {}));
  }

  async function readIntentScopeNeeds(projectId: string): Promise<ReadonlyMap<string, readonly string[]>> {
    return new Map(Object.entries((await readLaneState(projectId)).intentScopeNeeds ?? {}));
  }

  async function readIntentFloorAllowances(projectId: string, intentId: string): Promise<readonly string[]> {
    return (await readLaneState(projectId)).intentFloorAllowances?.[intentId] ?? [];
  }

  function recordFactoryLandedSha(projectId: string, integrationSha: string): Promise<void> {
    return updateLaneState(projectId, (state) => ({ factoryLandedShas: appendFactoryLandedSha(state.factoryLandedShas ?? [], integrationSha) }));
  }

  async function landLedger(projectId: string, projectPath: string, ledger: Awaited<ReturnType<typeof ensureLedgerCheckout>>, message: string,
    { intentId = null, onCommitted, landsCommittedWrites = false }: { intentId?: string | null; onCommitted?: () => Promise<void>; landsCommittedWrites?: boolean }): Promise<void> {
    const unlandedRecords = await readUnlandedFactoryRecords(projectId);
    try {
      await commitAndLandFactoryLedger({
        projectPath, ledger, message, targetBranch: await resolveIntegrationBranch(projectPath), gitWorkspace, intentId, declaredFactoryRecords: unlandedRecords,
        retryLanding: landsCommittedWrites || landingErrors.has(projectId) || unlandedRecords.length > 0, factoryLandedShas: new Set((await readLaneState(projectId)).factoryLandedShas ?? []),
        onRefused: (reason) => raiseException(projectId, reason), onCommitted,
        onIntegrationLanded: (integrationSha) => recordFactoryLandedSha(projectId, integrationSha),
      });
      if (landingErrors.delete(projectId)) void decisionLog.record({ ...factoryDecisionContext(projectId, { intentId }), kind: 'landing', outcome: 'recovered', failureClass: null });
      if (unlandedRecords.length > 0) await forgetUnlandedFactoryRecords(projectId, new Set(unlandedRecords.map(({ id }) => id)));
    } catch (error) {
      const reason = errorMessage(error);
      if (landingErrors.get(projectId) !== reason) {
        landingErrors.set(projectId, reason);
        void decisionLog.record({ ...factoryDecisionContext(projectId, { intentId, reason }), kind: 'landing', outcome: 'failed', failureClass: 'landing' });
      }
      throw error;
    }
  }

  function buildIntentCreateArgs(intent: FactoryQueueIntentRequest): string[] {
    return [
      'work', 'create', intent.objective,
      ...intent.criteria.flatMap((criterion) => ['--success', criterion]),
      '--risk', intent.risk, '--authority', 'user-directed', '--granted-by', 'operator',
      '--boundary', intent.boundary, '--id', factoryIntentWorkId(intent), '--session', FACTORY_LEDGER_SESSION, '--json',
    ];
  }

  async function rehearseTicketCreation(intent: FactoryQueueIntentRequest): Promise<void> {
    const rehearsalPath = await makeHostScratchDirectory('glimmervoid-factory-rehearsal-');
    try {
      const intentWorkId = CoherenceWorkCreated.parse(JSON.parse(await invokeCoherence({ cwd: rehearsalPath, args: buildIntentCreateArgs(intent) }))).work;
      for (const ticket of intent.tickets ?? []) {
        CoherenceTicketCreated.parse(JSON.parse(await invokeCoherence({ cwd: rehearsalPath, args: buildTicketCreateArgs({ intent, intentWorkId, ticket }) })));
      }
    } finally {
      await rm(rehearsalPath, { recursive: true, force: true });
    }
  }

  async function createIntentWork(intent: FactoryQueueIntentRequest, ledgerPath: string): Promise<string> {
    if (intent.tickets) await rehearseTicketCreation(intent);
    return CoherenceWorkCreated.parse(JSON.parse(await runCoherence({ cwd: ledgerPath, args: buildIntentCreateArgs(intent) }))).work;
  }

  async function queueIntent(request: FactoryQueueIntentRequest): Promise<FactoryQueueIntentResult> {
    try {
      const intent = FactoryQueueIntentRequest.parse(request);
      if (!hasValidWriteScopes(intent.writeScopes)) {
        throw new Error('Invalid write scopes: an intent needs at least one, each a relative path inside the repository');
      }
      if (hasWildcardWriteScope(intent.writeScopes)) {
        throw new Error('Invalid write scopes: a write scope is a relative path (a folder covers everything under it) or ** for the whole repository');
      }
      const maxRisk = config.factory?.maxRisk ?? 'medium';
      if (exceedsRiskCeiling(intent.risk, maxRisk)) throw new Error(`Intent risk ${intent.risk} exceeds the factory risk ceiling ${maxRisk}`);
      const ticketProblem = findIntentTicketProblem(intent);
      if (ticketProblem) throw new Error(`Invalid tickets: ${ticketProblem}`);
      requireProject(intent.projectId);
      if (!config.projects?.find((project) => project.id === intent.projectId)?.factoryProfile) {
        const setupResult = await rerunSetup(intent.projectId);
        if (!setupResult.ok) throw new Error(setupResult.reason);
      }
      const outcome = await serializeProject(intent.projectId, async () => {
        const projectPath = requireProject(intent.projectId);
        const ledger = await ensureTrustedLedgerCheckout(intent.projectId, projectPath);
        const intentWorkId = await createIntentWork(intent, ledger.cwd);
        await updateLaneState(intent.projectId, (state) => ({
          trustedIntentIds: [...new Set([...(state.trustedIntentIds ?? []), intentWorkId])],
          intentWriteScopes: { ...state.intentWriteScopes, [intentWorkId]: intent.writeScopes },
          intentFloorAllowances: withIntentFloorAllowances(state.intentFloorAllowances, intentWorkId, intent.floorAllowances),
          ticketedIntentIds: intent.tickets ? [...new Set([...(state.ticketedIntentIds ?? []), intentWorkId])] : state.ticketedIntentIds,
          pendingIntentTickets: intent.tickets && !(state.ticketedIntentIds ?? []).includes(intentWorkId)
            ? { ...state.pendingIntentTickets, [intentWorkId]: { risk: intent.risk, boundary: intent.boundary, tickets: intent.tickets } }
            : state.pendingIntentTickets,
        }));
        await landLedger(intent.projectId, projectPath, ledger, `factory: queue intent ${intentWorkId}`, { intentId: activeIntentIdOf(intent.projectId) });
        return { projectId: intent.projectId, ok: true, workId: intentWorkId };
      });
      await runner.getPoller()?.refreshNow();
      return outcome;
    } catch (error) {
      return { projectId: request.projectId, ok: false, error: errorMessage(error).slice(0, FACTORY_ERROR_MAX_CHARS) };
    }
  }

  async function retryParked(projectId: string, intentId: string): Promise<{ ok: true; reopenedWorkIds: string[] } | { ok: false; error: string }> {
    try {
      const command = FactoryControlRequest.parse({ projectId, intentId, action: 'retry-parked' });
      const outcome = await serializeProject(command.projectId, async () => {
        const projectPath = requireProject(command.projectId);
        const ledger = await ensureTrustedLedgerCheckout(command.projectId, projectPath);
        const laneState = await readLaneState(command.projectId);
        const inspected = CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd: ledger.cwd, args: ['work', 'inspect', '--json'] }))).work;
        const intent = inspected.find((order) => order.work === intentId && order.opened.parent === null);
        if (!intent || !(laneState.trustedIntentIds ?? []).includes(intentId)) throw new Error('Unknown factory intent');
        if (intent.state === 'completed' || intent.state === 'cancelled') throw new Error('Factory intent has already closed');
        const retriedTickets = inspected.filter((order) => order.opened.parent === intentId && (order.state === 'blocked' || order.state === 'open')
          && (laneState.ticketBlockCounts?.[order.work] ?? 0) >= FACTORY_TICKET_BLOCK_CAP);
        const parkedTickets = retriedTickets.filter((ticket) => ticket.state === 'blocked');
        const liveWorkIds = new Set(dispatcher?.getLiveWorkers(command.projectId).map((worker) => worker.workId) ?? []);
        if (parkedTickets.some((ticket) => liveWorkIds.has(ticket.work))) throw new Error('A parked ticket still has a live worker');
        for (const ticket of parkedTickets) {
          const action = decideTicketAction({ verb: 'reopen', intentId, ticket: { parent: ticket.opened.parent, state: ticket.state } });
          if (!action.ok) throw new Error(action.reason);
          if (action.kind !== 'transition') throw new Error('Retry parked requires a reopen transition');
          const reason = 'Factory retry reopened this parked ticket';
          await runCoherence({ cwd: ledger.cwd, args: ['work', 'transition', ticket.work, action.to, '--because', reason, '--session', FACTORY_LEDGER_SESSION, '--evidence', reason] });
        }
        const reopenedWorkIds = retriedTickets.map((ticket) => ticket.work);
        if (reopenedWorkIds.length > 0 || (await readUnlandedFactoryRecords(command.projectId)).length > 0) {
          await landLedger(command.projectId, projectPath, ledger, `factory: retry parked ${intentId}`, { intentId,
            onCommitted: () => updateLaneState(command.projectId, (state) => ({
              ticketBlockCounts: { ...state.ticketBlockCounts, ...Object.fromEntries(reopenedWorkIds.map((workId) => [workId, 0])) },
            })),
          });
        }
        return { ok: true as const, reopenedWorkIds };
      });
      await runner.getPoller()?.refreshNow();
      return outcome;
    } catch (error) {
      return { ok: false, error: errorMessage(error).slice(0, FACTORY_ERROR_MAX_CHARS) };
    }
  }

  async function control(request: FactoryControlRequest): Promise<FactoryControlResult> {
    try {
      const command = FactoryControlRequest.parse(request);
      if (command.action === 'retry-parked') {
        if (!command.intentId) throw new Error('Retry parked requires an intentId');
        return { projectId: command.projectId, action: command.action, ...await retryParked(command.projectId, command.intentId) };
      }
      if (command.action === 'rerun-setup') {
        const outcome = await rerunSetup(command.projectId);
        return { projectId: command.projectId, action: command.action, ok: outcome.ok,
          ...(!outcome.ok ? { error: outcome.reason.slice(0, FACTORY_ERROR_MAX_CHARS) } : {}),
        };
      }
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

  function notifyProject(projectId: string, reason: string): void {
    notify(config.projects.find((project) => project.id === projectId)?.name ?? projectId, FACTORY_NOTIFY_CATEGORY, reason);
  }

  function recordException(projectId: string, reason: string): void {
    void decisionLog.record({ ...factoryDecisionContext(projectId, { intentId: activeIntentIdOf(projectId), reason }), kind: 'exception', outcome: 'raised', failureClass: 'exception' });
  }

  function raiseException(projectId: string, reason: string): void {
    if (exceptions.get(projectId) === reason) return;
    exceptions.set(projectId, reason);
    recordException(projectId, reason);
    notifyProject(projectId, reason);
  }

  const folderTrustRefusals = new Map<string, string>();

  function refuseFolderTrust(projectId: string, reason: string): Error {
    folderTrustRefusals.set(projectId, reason);
    raiseException(projectId, reason);
    return new Error(reason);
  }

  async function trustProjectFolderForClaude(projectId: string, commonGitDir: string): Promise<void> {
    if (!trustClaudeFolder) return;
    const repositoryRoot = repositoryRootOfCommonGitDir(commonGitDir);
    if (!repositoryRoot) return;
    const outcome = await trustClaudeFolder(repositoryRoot).catch((error: unknown) => { throw refuseFolderTrust(projectId, errorMessage(error)); });
    const earlierRefusal = folderTrustRefusals.get(projectId);
    if (earlierRefusal !== undefined && exceptions.get(projectId) === earlierRefusal) exceptions.delete(projectId);
    folderTrustRefusals.delete(projectId);
    if (outcome !== 'granted') return;
    void decisionLog.record({ ...factoryDecisionContext(projectId, { intentId: activeIntentIdOf(projectId), reason: `Trusted ${repositoryRoot} for Claude Code` }), kind: 'trust', outcome: 'granted', failureClass: null });
  }

  const runner = createLaneRunner<FactoryPoller>({
    tag: 'factory',
    gate: () => factoryShouldStart(config),
    cfgKey: () => factoryConfigKey(config),
    emptyStatus: () => ({}),
    createPoller: () => {
      const loggedSpawnExceptions = new Map<string, string>();
      const crashLoopingProjectIds = new Set<string>();
      const notifySpawnException = (projectId: string, reason: string) => {
        if (loggedSpawnExceptions.get(projectId) !== reason) {
          loggedSpawnExceptions.set(projectId, reason);
          recordException(projectId, reason);
        }
        notifyProject(projectId, reason);
      };
      function recordCrashLoopEpisode(projectId: string, orchestratorError: string | null): void {
        if (!orchestratorError?.startsWith(ORCHESTRATOR_EXCEPTION_PREFIX)) {
          crashLoopingProjectIds.delete(projectId);
          return;
        }
        if (crashLoopingProjectIds.has(projectId)) return;
        crashLoopingProjectIds.add(projectId);
        recordException(projectId, orchestratorError);
      }
      const activeOrchestrator = orchestratorOptions && coherenceHookCliPath ? createFactoryOrchestrator({
        ...orchestratorOptions,
        now: pollerDeps.now ?? orchestratorOptions.now,
        nodePath: process.execPath, hookCliPath: coherenceHookCliPath, shimDir: binDir, readTrustedIntentIds, beginIntent: (request) => serializeProject(request.projectId, () => beginIntent(request)), notifyException: notifySpawnException,
        ensureLedger: (projectId) => serializeProject(projectId, async () => {
          const ledger = await ensureLedgerCheckout(projectId, requireProject(projectId));
          const commonGitDir = await readLaneCommonGitDir(ledger.cwd);
          await trustProjectFolderForClaude(projectId, commonGitDir);
          return { ledgerPath: await realpath(ledger.cwd), commonGitDir };
        }),
        commitAndLand: (projectId, intentId) => serializeProject(projectId, async () => {
          const projectPath = requireProject(projectId);
          const ledger = await ensureLedgerCheckout(projectId, projectPath);
          await landLedger(projectId, projectPath, ledger, `factory: orchestrator ledger ${projectId}`, { intentId });
        }),
      }) : null;
      orchestrator = activeOrchestrator;
      const commitAndLand = async (projectId: string, projectPath: string, message: string, { onCommitted }: { onCommitted?: () => Promise<void> } = {}) => {
        const ledger = await ensureLedgerCheckout(projectId, projectPath);
        await landLedger(projectId, projectPath, ledger, message, { intentId: activeIntentIdOf(projectId), onCommitted });
      };
      const landUnlandedFactoryWrites = async (projectId: string) => {
        const projectPath = findFactoryProjectPath(config, projectId);
        if (!projectPath || (await readUnlandedFactoryRecords(projectId)).length === 0) return;
        await serializeProject(projectId, async () => {
          const ledger = await ensureTrustedLedgerCheckout(projectId, projectPath);
          await landLedger(projectId, projectPath, ledger, `factory: land unlanded writes ${projectId}`, { intentId: activeIntentIdOf(projectId) });
        }).catch((error: unknown) => {
          landingErrors.set(projectId, errorMessage(error));
        });
      };
      const readIntegrationSha = async (projectPath: string) => (await runHardenedGit(
        ['rev-parse', `refs/heads/${await resolveIntegrationBranch(projectPath)}`], { cwd: projectPath, timeout: 30_000 })).stdout.trim();
      const hasCodeChangedSince = async (projectPath: string, sinceSha: string) =>
        hasCodeChangedBetween({ projectPath, sinceSha, tipSha: await readIntegrationSha(projectPath) });
      const refreshAfter = (changedSubject: string) => () => {
        void runner.getPoller()?.refreshNow().catch((error: unknown) => {
          log.warn(`[factory] ${changedSubject} refresh failed: ${errorMessage(error)}`);
        });
      };
      const refresh = refreshAfter('state');
      const refusalsByWork = new Map<string, FactoryWorkRefusal & { projectId: string }>();
      const notifyOrchestrator = (projectId: string, event: FactoryDecisionWorkerEvent) => {
        const refusalKey = JSON.stringify([projectId, event.workId]);
        const shouldRecord = event.event !== 'refused' || refusalsByWork.get(refusalKey)?.reason !== (event.detail ?? null);
        if (event.event === 'refused') refusalsByWork.set(refusalKey, { projectId, workId: event.workId, reason: event.detail ?? null });
        if (event.event === 'dispatch available' || event.event === 'dispatched' || event.event === 'ended') refusalsByWork.delete(refusalKey);
        if (shouldRecord) decisionLog.recordEvent(projectId, { ...event, intentId: event.intentId ?? activeIntentIdOf(projectId) ?? undefined });
        if (!isLogOnlyFactoryEvent(event)) activeOrchestrator?.notifyOrchestrator(projectId, event);
      };
      const activeVerifier = spawnVerifier ? createFactoryVerifier({
        config, spawnVerifier, serializeProject, ensureLedger: ensureTrustedLedgerCheckout, ensureControlCheckout, hasCodeChangedSince, readIntentDiff, readLaneState, writeLaneState,
        runCoherence, commitAndLand, pause: (projectId) => serializeProject(projectId, () => updateLaneState(projectId, () => ({ paused: true }))),
        setException: raiseException,
        notifyOrchestrator,
        stopOrchestrator: (projectId) => activeOrchestrator?.releaseProject(projectId), onChanged: refresh,
      }) : null;
      const activeCloseOut = spawnReviewer ? createFactoryCloseOut({
        config, spawnReviewer, gitWorkspace, serializeProject, ensureLedger: ensureTrustedLedgerCheckout, runCoherence, commitAndLand, readIntegrationSha,
        recordFactoryLandedSha, readPaused, readIntentFloorAllowances, countTicketBlock, prepareCheckRunner,
        recordDecision: decisionLog.record,
        recordScopeNeeds: async (worker, files) => {
          let rememberedNeeds: readonly string[] = [];
          await updateLaneState(worker.projectId, (state) => {
            const intentScopeNeeds = withIntentScopeNeeds(state.intentScopeNeeds, worker.intentId, files);
            rememberedNeeds = intentScopeNeeds?.[worker.intentId] ?? [];
            return { intentScopeNeeds };
          });
          return rememberedNeeds;
        },
        recordConfirmedFlakes: (worker, flakes) => serializeProject(worker.projectId, () => updateLaneState(worker.projectId, (state) => ({
          intentConfirmedFlakes: withIntentConfirmedFlakes(state.intentConfirmedFlakes, worker.intentId, flakes),
        }))),
        trustVerification: (projectId, verification) => updateLaneState(projectId, (state) => ({
          trustedVerifications: [...(state.trustedVerifications ?? []).filter(({ id }) => id !== verification.id), verification] })),
        notifyOrchestrator,
        setException: raiseException,
        clearException: (projectId, expectedReason) => {
          if (exceptions.get(projectId) === expectedReason) exceptions.delete(projectId);
        },
        onReviewingChanged: refreshAfter('review state'),
      }) : null;
      const activeDispatcher = orchestratorOptions && coherenceHookCliPath ? createFactoryDispatch({
        ...orchestratorOptions, nodePath: process.execPath, hookCliPath: coherenceHookCliPath, shimDir: binDir,
        now: pollerDeps.now ?? orchestratorOptions.now,
        onWorkerTurnEnd: activeCloseOut?.turnEnded,
        discardLeftoverWorkerBranch: async (projectPath, workerSessionId) => {
          const workerWorktreeRoot = config.worktreeRoot || path.join(path.dirname(path.resolve(projectPath)), '.glimmervoid-worktrees');
          const discarded = await gitWorkspace.discardSessionBranch({ projectPath, teamId: 'session', label: workerSessionId, worktreeBase: workerWorktreeRoot });
          return discarded.ok ? null : `Could not discard the leftover worktree of ${workerSessionId}: ${discarded.err ?? 'git failed'}`;
        },
        getOrchestrator: (sessionId) => activeOrchestrator?.getLiveOrchestrator(sessionId) ?? null,
        serializeProject, ensureLedger: ensureTrustedLedgerCheckout, runCoherence, readTodaySpend: () => todaySpend, readTrustedIntentIds, readIntentWriteScopes, readIntentScopeNeeds, readPaused,
        onReadyIntent: (projectId, intentId) => activeVerifier?.ready(projectId, intentId),
        commitAndLand,
        notifyOrchestrator,
        setException: (projectId, reason, expectedReason) => {
          if (expectedReason !== undefined && exceptions.get(projectId) !== expectedReason) return;
          if (reason === null) { exceptions.delete(projectId); return; }
          raiseException(projectId, reason);
        },
      }) : null;
      dispatcher = activeDispatcher;
      ticketVerbs = activeDispatcher ? createFactoryTicketVerbs({
        getOrchestrator: (sessionId) => activeOrchestrator?.getLiveOrchestrator(sessionId) ?? null,
        findProjectPath: (projectId) => findFactoryProjectPath(config, projectId) ?? null,
        serializeProject, ensureLedger: ensureTrustedLedgerCheckout, runCoherence, commitAndLand,
        hasLiveWorker: (projectId, workId) => activeDispatcher.getLiveWorkers(projectId).some((worker) => worker.workId === workId),
      }) : null;
      let activeStalls = new Map<string, ReturnType<typeof decideFactoryStalls>[number]>();
      const projectIdleSinceMs = new Map<string, number>();
      const stallClock = pollerDeps.now ?? orchestratorOptions?.now ?? Date.now;
      function unraisedRefusalsOf(projectId: string): FactoryWorkRefusal[] {
        return [...refusalsByWork.values()].filter((refusal) => refusal.projectId === projectId && refusal.reason !== exceptions.get(projectId));
      }
      function checkStalls(): void {
        const stalls = decideFactoryStalls({
          sessions: [
            ...(activeOrchestrator?.getStallSessions() ?? []).map((session) => ({ ...session, projectIdleSinceMs: projectIdleSinceMs.get(session.projectId) ?? null,
              projectRefusals: unraisedRefusalsOf(session.projectId) })),
            ...activeDispatcher?.getStallSessions() ?? [],
          ],
          nowMs: stallClock(),
        });
        for (const stall of stalls) {
          if (activeStalls.has(stall.episodeId)) continue;
          void decisionLog.record({ ...factoryDecisionContext(stall.projectId, { intentId: activeIntentIdOf(stall.projectId), reason: stall.reason }), kind: 'exception', outcome: 'stalled', failureClass: 'stall' });
          notifyProject(stall.projectId, stall.reason);
        }
        activeStalls = new Map(stalls.map((stall) => [stall.episodeId, stall]));
      }
      function projectException(projectId: string): string | null {
        const stallReasons = [...activeStalls.values()].filter((stall) => stall.projectId === projectId).map((stall) => stall.reason);
        const reasons = [...new Set([exceptions.get(projectId), ...stallReasons].filter((reason) => reason !== undefined))];
        return reasons.length === 0 ? null : reasons.join('; ').slice(0, FACTORY_ERROR_MAX_CHARS);
      }
      const poller = createPoller({
        log,
        listFactoryProjects: () => (config.projects ?? []).flatMap(({ id, name, path: projectPath }) => {
          if (!id || !projectPath) return [];
          return [{ id, name: name ?? path.basename(projectPath), path: projectPath }];
        }),
        resolveIntegrationBranch,
        readPaused,
        readIntentWriteScopes,
        readIntentConfirmedFlakes: async (projectId) => (await readLaneState(projectId)).intentConfirmedFlakes,
        readTicketBlockCounts: async (projectId) => (await readLaneState(projectId)).ticketBlockCounts,
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
        beforeTick: () => {
          todaySpend = readSpentTodayUsd();
          checkStalls();
          void decisionLog.pruneEveryProject();
        },
        processProjectState: async (project) => {
          await landUnlandedFactoryWrites(project.projectId);
          await activeDispatcher?.reconcileActiveOrders(project);
          if (!project.paused) activeCloseOut?.resumeHeld(project.projectId);
          const verified = activeVerifier ? await activeVerifier.tick(project) : project;
          const updated = activeOrchestrator ? await activeOrchestrator.tick(verified) : verified;
          if (updated.error === null && updated.heading.action !== 'refuse') await notifyIntentOutcomes(updated);
          recordCrashLoopEpisode(project.projectId, activeOrchestrator && verified.error === null ? updated.error : null);
          if (updated.error === null) loggedSpawnExceptions.delete(project.projectId);
          if (activeDispatcher) await activeDispatcher.renudgeRefusedDispatch(updated, (await readLaneState(project.projectId)).ledgerPath);
          const liveWorkers = activeDispatcher?.getLiveWorkers(project.projectId) ?? [];
          const reviewing = liveWorkers.filter((worker) => activeCloseOut?.reviewing.has(worker.workId)).map((worker) => worker.workId);
          const isInFlight = isFactoryProjectInFlight({ ...updated, liveWorkers }) || (activeDispatcher?.hasPendingRefusal(project.projectId) ?? false);
          if (isInFlight) projectIdleSinceMs.delete(project.projectId);
          if (!isInFlight && !projectIdleSinceMs.has(project.projectId)) projectIdleSinceMs.set(project.projectId, stallClock());
          const factoryProfile = resolveFactoryProfile(config.factory, config.projects?.find((entry) => entry.id === project.projectId));
          return { ...updated, reviewing, liveWorkers, factoryProfile: { checks: factoryProfile.checks, focusedTestCommand: factoryProfile.focusedTestCommand, widenableScopes: factoryProfile.widenableScopes },
            spentTodayUsd: todaySpend.status === 'known' ? todaySpend.amountUsd : undefined, dailyBudgetUsd: config.factory?.dailyBudgetUsd ?? null,
            error: updated.error ?? projectException(project.projectId) ?? landingErrors.get(project.projectId) ?? null };
        },
        releaseOrchestrator: (projectId) => {
          activeDispatcher?.releaseProject(projectId);
          activeOrchestrator?.releaseProject(projectId);
          exceptions.delete(projectId);
          projectIdleSinceMs.delete(projectId);
          loggedSpawnExceptions.delete(projectId);
          crashLoopingProjectIds.delete(projectId);
          for (const [refusalKey, refusal] of refusalsByWork) {
            if (refusal.projectId === projectId) refusalsByWork.delete(refusalKey);
          }
        },
        broadcast,
      });
      let stopping: Promise<void> | null = null;
      const stop = async () => {
        await activeVerifier?.stop();
        await activeCloseOut?.stop();
        const stoppingWorkers = activeDispatcher?.stop();
        const stoppingOrchestrator = activeOrchestrator?.stop();
        await poller.stop();
        await stoppingOrchestrator;
        await stoppingWorkers;
        activeStalls = new Map();
        if (dispatcher === activeDispatcher) {
          dispatcher = null;
          ticketVerbs = null;
        }
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
      await setup.stop();
      await Promise.allSettled([...projectChains.values()]);
      await stopped;
      await decisionLog.idle();
    },
    getLiveOrchestrator: (sessionId: string) => factoryShouldStart(config).start ? orchestrator?.getLiveOrchestrator(sessionId) ?? null : null,
    dispatch: async (sessionId: string, payload: Record<string, unknown>) => {
      const outcome = await dispatcher?.dispatch(sessionId, payload) ?? { ok: false as const, reason: 'Factory is not running' };
      await runner.getPoller()?.refreshNow();
      return outcome;
    },
    reopen: (sessionId: string, request: AgentTicketRequest) => changeTicket('reopen', sessionId, request),
    cancel: (sessionId: string, request: AgentTicketRequest) => changeTicket('cancel', sessionId, request),
    queueIntent,
    rerunSetup,
    retryParked,
    control,
    restartIfConfigChanged: () => {
      runner.restartIfConfigChanged();
      if (!factoryShouldStart(config).start) return;
      void runner.getPoller()?.refreshNow().catch((error: unknown) => {
        log.warn(`[factory] config refresh failed: ${errorMessage(error)}`);
      });
    },
    getState: () => runner.isStopped() ? null : runner.getPoller()?.getState() ?? null,
  };
}
