import { capFactoryDecisionChecks, capFactoryDecisionOutput, factoryCloseOutFailureClass, factoryDecisionContext } from './core/factory-decision-log-core.ts';
import type { FactoryDecisionInput, FactoryDecisionWorkerEvent } from './core/factory-decision-log-core.ts';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../../session/sessions.ts';
import { GLIMMERVOID_SECRET_KEYS } from '../../session/core/spawn-env.ts';
import { DEFAULT_FACTORY_CHECKS, DEFAULT_FACTORY_PROTECTED_PATHS } from '../../shared/contracts/browser-config.ts';
import type { Config } from '../../shared/contracts/config.ts';
import { CoherenceWorkInspect } from '../../shared/contracts/coherence.ts';
import { FactoryReviewVerdict } from '../../shared/contracts/factory.ts';
import { factoryFailureText as failureText, prepareGuardedCheckRunner, runChecksInCleanCheckout } from './factory-check-guardrails.ts';
import type { FactoryCheckoutRun, PrepareFactoryCheckRunner } from './factory-check-guardrails.ts';
import { DEFAULT_CONFIG } from '../config-store.ts';
import { FACTORY_LEDGER_SESSION, FACTORY_REVIEW_DIFF_MAX_CHARS, FACTORY_TICKET_BLOCK_CAP, buildFactoryCheckEnv, buildFactoryReviewerPrompt, buildWorkerCommitMessage, checkFence, decideCloseOut, isInheritedCheckFailure, findWorkerCommitRefusal, listStagedGuardrailsPlaceholders, inheritedSecretValues, listUncommittedWorkPaths, parseFactoryStructuredOutput, planScopeNeedRecovery, redactSecretLines, reviewerOutputTail, withIntentScopeNeeds, withTicketBlockCount } from './core/factory-core.ts';
import { resolveFactoryProfile } from './core/factory-profile-core.ts';
import type { FactoryCheck, FactoryFence } from './core/factory-core.ts';
import { LANE_CONFIG_EDIT_DENY_RULES } from '../lanes/core/lane-permissions-core.ts';
import { GUARDRAILS_PLACEHOLDER_NAMES } from '../guardrails/core/guardrails-policy-core.ts';
import { nulSeparatedPaths } from '../git/core/git-changed-paths-core.ts';
import { prepareHardenedGitCommand, runHardenedGit } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import type { GitWorkspaceInstance } from '../git/git-workspace.ts';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import { writeJsonAtomic, writeTextAtomic } from '../json-file.ts';
import { z } from 'zod';
import type { LaneSpawn } from '../lanes/lane-spawn.ts';

export const FACTORY_REVIEWER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Bash']);
export const FACTORY_REVIEWER_PERMISSIONS = Object.freeze({
  defaultMode: 'dontAsk',
  allow: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
  deny: ['Edit', 'Write', 'NotebookEdit', ...LANE_CONFIG_EDIT_DENY_RULES],
});
export const FACTORY_REVIEWER_SPAWN_ENV: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0' });
const CASE_INSENSITIVE_LEDGER_PATHSPEC = ':(icase).coherence';
const WORK_OUTSIDE_LEDGER_PATHSPECS = ['.', ':(exclude,icase).coherence'];
const FACTORY_REVIEW_TOO_LARGE_FEEDBACK ='change too large for review; split it into smaller tickets';

type FactoryCapCounter = (projectId: string, id: string, shouldPark?: boolean) => Promise<number>;

function createMemoryCapCounter(): FactoryCapCounter {
  let counts: Record<string, number> = {};
  return async (projectId, id, shouldPark) => {
    const key = JSON.stringify([projectId, id]);
    counts = withTicketBlockCount(counts, key, shouldPark);
    return counts[key];
  };
}

type FactoryScopeNeedRecorder = (worker: FactoryCloseOutWorker, files: string[]) => Promise<readonly string[]> | readonly string[];

function createMemoryScopeNeedRecorder(): FactoryScopeNeedRecorder {
  let needsByIntent: Record<string, string[]> | undefined;
  return (worker, files) => {
    const key = JSON.stringify([worker.projectId, worker.intentId]);
    needsByIntent = withIntentScopeNeeds(needsByIntent, key, files);
    return needsByIntent?.[key] ?? [];
  };
}

type FactoryWorkerSession = Pick<Session, 'destroy' | 'pasteTextWhenReady' | 'write' | '_destroyed'>
  & Partial<Pick<Session, 'id' | 'worktreeDir' | 'baseSha' | 'mergeWorktree'>>
  & { _guardrailsLaunch?: Pick<NonNullable<Session['_guardrailsLaunch']>, 'env'> | null };

export interface FactoryCloseOutWorker {
  workId: string;
  intentId: string;
  projectId: string;
  projectPath: string;
  baseSha: string | null;
  objective: string;
  criteria: string[];
  writeScopes: string[];
  intentWriteScopes?: readonly string[];
  session: FactoryWorkerSession;
}

export interface FactoryCloseOutDeps {
  config: Pick<Config, 'factory' | 'worktreeShare'> & Partial<Pick<Config, 'projects'>>;
  spawnReviewer: LaneSpawn;
  gitWorkspace: Pick<GitWorkspaceInstance, 'stageDetachedWorktree' | 'populate' | 'removeWorktreeByPath' | 'pruneWorktrees'>;
  serializeProject: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  ensureLedger: (projectId: string, projectPath: string) => Promise<{ cwd: string }>;
  runCoherence: (request: { cwd: string; args: string[] }) => Promise<string>;
  commitAndLand: (projectId: string, projectPath: string, message: string) => Promise<void>;
  readIntegrationSha: (projectPath: string) => Promise<string>;
  recordFactoryLandedSha: (projectId: string, integrationSha: string) => Promise<void>;
  readPaused: (projectId: string) => Promise<boolean>;
  readIntentFloorAllowances?: (projectId: string, intentId: string) => Promise<readonly string[]>;
  countTicketBlock?: FactoryCapCounter;
  trustVerification: (projectId: string, verification: { id: string; sha: string }) => Promise<void>;
  notifyOrchestrator: (projectId: string, event: FactoryDecisionWorkerEvent) => void;
  setException: (projectId: string, reason: string) => void;
  clearException?: (projectId: string, expectedReason: string) => void;
  recordDecision?: (decision: Extract<FactoryDecisionInput, { kind: 'closeout' | 'merge' }>) => Promise<void>;
  recordConfirmedFlakes?: (worker: FactoryCloseOutWorker, flakes: string[]) => Promise<void> | void;
  recordScopeNeeds?: FactoryScopeNeedRecorder;
  onReviewingChanged?: () => void;
  baseEnv?: NodeJS.ProcessEnv;
  prepareCheckRunner?: PrepareFactoryCheckRunner;
}

export function factorySecretValues(baseEnv: NodeJS.ProcessEnv): (string | undefined)[] {
  return [...GLIMMERVOID_SECRET_KEYS.map((key) => baseEnv[key]), ...inheritedSecretValues(baseEnv)];
}

const EMPTY_CHECKOUT_RUN: FactoryCheckoutRun = { confirmedFlakes: [], checks: [], loggedChecks: [], decisionReasonChecks: [], checkoutSecretValues: [], failingFilesOutsideScopesByCommand: new Map(), failureTextByCommand: new Map(), outputPathsByCommand: new Map(), checkoutPaths: [] };

function chargeableChecks(checks: readonly FactoryCheck[], inheritedCommands: readonly string[]): FactoryCheck[] {
  return checks.map((check) => !check.pass && inheritedCommands.includes(check.command) ? { ...check, pass: true } : check);
}

function chargeableFailingFilesOutsideScopes(run: FactoryCheckoutRun, inheritedCommands: readonly string[]): string[] {
  const outsideFiles = [...run.failingFilesOutsideScopesByCommand].filter(([command]) => !inheritedCommands.includes(command)).flatMap(([, files]) => files);
  return [...new Set(outsideFiles)].sort();
}

function inheritedChecksNote(baseSha: string, inheritedCommands: readonly string[]): string | null {
  if (inheritedCommands.length === 0) return null;
  return `Not charged for checks already failing at base ${baseSha.slice(0, 12)}: ${inheritedCommands.join(', ')}`;
}

function closeOutFailureText(decision: ReturnType<typeof decideCloseOut>): string | null {
  if (decision.action === 'retry') return decision.feedback;
  if (decision.action === 'block') return decision.reason;
  return null;
}

type FactoryStructuredAgentOptions<Value> = {
  spawnReviewer: LaneSpawn; model: string | null; signal: AbortSignal;
  buildPrompt: (resultPath: string) => string; name: string; extraArgs?: string[]; readablePaths?: string[];
  schema: z.ZodType<Value>; prompt?: string;
  failureMessages?: { missingOutput: (output: string) => string; invalidFile: string };
};

export async function runFactoryStructuredAgent<Value>({ spawnReviewer, model, signal, buildPrompt, name, extraArgs = [], readablePaths = [], schema,
  prompt = 'Read the assigned factory task and return its structured output.',
  failureMessages = { missingOutput: (output) => `Agent returned no structured output. Output tail: ${reviewerOutputTail(output) || '(empty)'}`, invalidFile: 'Agent result file is missing or invalid' },
}: FactoryStructuredAgentOptions<Value>): Promise<{ ok: true; value: Value } | { ok: false; reason: string }> {
  const reviewDirectory = await makeHostScratchDirectory('glimmervoid-factory-review-');
  try {
    const resultPath = path.join(reviewDirectory, 'verdict.json');
    const promptPath = path.join(reviewDirectory, 'prompt.txt');
    const reviewerCwd = path.join(reviewDirectory, 'workspace');
    await mkdir(reviewerCwd);
    await writeTextAtomic(promptPath, buildPrompt(resultPath));
    let reviewerOutput = '';
    let hasOutputOverflow = false;
    await spawnReviewer({
      id: `factory-review-${crypto.randomUUID()}`, name, cwd: reviewerCwd,
      prompt, agent: 'claude-code',
      model, signal, readablePaths: [promptPath, ...readablePaths],
      extraArgs: [...extraArgs, '--append-system-prompt-file', promptPath, '--output-format', 'json', '--json-schema', JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' })), '--permission-mode', 'dontAsk'],
      onOutput: (chunk) => {
        if (reviewerOutput.length + chunk.length > 16 * 1024 * 1024) { hasOutputOverflow = true; return; }
        reviewerOutput += chunk;
      },
    });
    const capturedValue = hasOutputOverflow ? null : parseFactoryStructuredOutput(reviewerOutput, schema);
    if (capturedValue === null) return { ok: false, reason: failureMessages.missingOutput(reviewerOutput) };
    await writeJsonAtomic(resultPath, capturedValue);
    const parsedValue = schema.safeParse(await readLaneResultFile(resultPath));
    if (!parsedValue.success || JSON.stringify(parsedValue.data) !== JSON.stringify(capturedValue)) return { ok: false, reason: failureMessages.invalidFile };
    return { ok: true, value: parsedValue.data };
  } catch (error) {
    return { ok: false, reason: failureText(error) };
  } finally {
    await rm(reviewDirectory, { recursive: true, force: true });
  }
}

export async function runFactoryReview(options: Omit<FactoryStructuredAgentOptions<FactoryReviewVerdict>, 'schema' | 'prompt' | 'failureMessages'>): Promise<FactoryReviewVerdict> {
  const review = await runFactoryStructuredAgent({ ...options, schema: FactoryReviewVerdict,
    prompt: 'Review the assigned factory ticket and return its structured verdict.',
    failureMessages: {
      missingOutput: (output) => `Reviewer returned no structured verdict. Output tail: ${reviewerOutputTail(output) || '(empty)'}`,
      invalidFile: 'Reviewer verdict file is missing or invalid',
    },
  });
  if (!review.ok) return { pass: false, findings: [review.reason] };
  return review.value;
}

export function createFactoryCloseOut({
  config, spawnReviewer, gitWorkspace, serializeProject, ensureLedger, runCoherence, commitAndLand, readIntegrationSha, recordFactoryLandedSha, readPaused, readIntentFloorAllowances = async () => [],
  countTicketBlock = createMemoryCapCounter(), trustVerification, notifyOrchestrator, setException, clearException = () => {}, recordDecision = async () => {}, recordConfirmedFlakes = () => {}, recordScopeNeeds = createMemoryScopeNeedRecorder(), onReviewingChanged = () => {}, baseEnv = process.env, prepareCheckRunner = prepareGuardedCheckRunner,
}: FactoryCloseOutDeps) {
  const reviewing = new Set<string>();
  const attempts = new Map<string, number>();
  const failingFilesOutsideScopesByWork = new Map<string, string[]>();
  const blockExceptionByProject = new Map<string, string>();
  const pending = new Map<string, Promise<void>>();
  const held = new Map<string, FactoryCloseOutWorker>();
  const reviewController = new AbortController();
  let stopped = false;
  const isLive = (worker: FactoryCloseOutWorker) => !stopped && config.factory?.enabled === true && !worker.session._destroyed;
  const sharedEntries = () => config.worktreeShare ?? DEFAULT_CONFIG.worktreeShare;
  const secretValues = () => factorySecretValues(baseEnv);
  const checkOutput = (text: string) => redactSecretLines(text, secretValues()).slice(-4000);
  const checkEnv = () => buildFactoryCheckEnv(baseEnv, process.platform);
  const untrustedCheckoutIsolation = () => ({ disableHooks: true, disableRepoCommands: true, replaceEnv: checkEnv() });
  const attemptOf = (worker: FactoryCloseOutWorker) => attempts.get(worker.workId) ?? 1;

  async function runGit(cwd: string, args: string[], indexFile?: string): Promise<string> {
    return (await runHardenedGit(args, { cwd, env: checkEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024, indexFile })).stdout;
  }

  async function probeUncommittedWorkPaths(cwd: string): Promise<string[]> {
    return listUncommittedWorkPaths(await runGit(cwd, ['--no-optional-locks', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']), GUARDRAILS_PLACEHOLDER_NAMES);
  }

  async function isIgnoredInProject(projectPath: string, sharedEntry: string): Promise<boolean> {
    try {
      await runGit(projectPath, ['check-ignore', '-q', '--', sharedEntry]);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 1) return false;
      throw error;
    }
  }

  async function sharedEntriesIgnoredInProject(projectPath: string): Promise<string[]> {
    const ignoredSharedEntries: string[] = [];
    for (const sharedEntry of sharedEntries()) {
      if (sharedEntry === '' || sharedEntry.includes('..')) continue;
      if (await isIgnoredInProject(projectPath, sharedEntry)) ignoredSharedEntries.push(sharedEntry);
    }
    return ignoredSharedEntries;
  }

  async function stageWorkerTreeInGuardrails(cwd: string, indexDirectory: string, stagingIndexFile: string): Promise<void> {
    const objectsDirectory = (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).replace(/\r?\n$/, '');
    const gitOptions = { cwd, env: checkEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
    const stagingCommand = await prepareHardenedGitCommand(['-C', cwd, 'add', '--all', '--', ...WORK_OUTSIDE_LEDGER_PATHSPECS], { ...gitOptions, indexFile: stagingIndexFile });
    const stagingGuardrails = await prepareCheckRunner({ scratchParent: indexDirectory, writablePaths: [indexDirectory, objectsDirectory], readablePaths: [cwd] });
    try {
      await stagingGuardrails.runCheck(['git', ...stagingCommand.args], { ...gitOptions, cwd: indexDirectory, env: stagingCommand.env, signal: reviewController.signal });
    } finally {
      await stagingGuardrails.dispose();
    }
  }

  async function commitWorkerChanges(worker: FactoryCloseOutWorker, cwd: string): Promise<string | null> {
    if ((await probeUncommittedWorkPaths(cwd)).length === 0) return null;
    const worktreeGitDirectory = (await runGit(cwd, ['rev-parse', '--absolute-git-dir'])).replace(/\r?\n$/, '');
    const indexDirectory = await mkdtemp(path.join(worktreeGitDirectory, 'glimmervoid-factory-index-'));
    try {
      const stagingIndexFile = path.join(indexDirectory, 'index');
      const headSha = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
      await runGit(cwd, ['read-tree', headSha], stagingIndexFile);
      await stageWorkerTreeInGuardrails(cwd, indexDirectory, stagingIndexFile);
      const readStagedChanges = async () => {
        const tree = (await runGit(cwd, ['write-tree'], stagingIndexFile)).trim();
        return { tree, rawDiff: await runGit(cwd, ['diff', '--raw', '--no-renames', '--no-abbrev', '--ignore-submodules=none', '-z', headSha, tree]) };
      };
      const stagedWithPlaceholders = await readStagedChanges();
      const placeholderPaths = listStagedGuardrailsPlaceholders(stagedWithPlaceholders.rawDiff, GUARDRAILS_PLACEHOLDER_NAMES);
      if (placeholderPaths.length > 0) await runGit(cwd, ['update-index', '--force-remove', '--', ...placeholderPaths], stagingIndexFile);
      const { tree: stagedTree, rawDiff: stagedChanges } = placeholderPaths.length > 0 ? await readStagedChanges() : stagedWithPlaceholders;
      if (!stagedChanges) {
        await runGit(cwd, ['read-tree', headSha]);
        return null;
      }
      const refusal = findWorkerCommitRefusal({ rawDiff: stagedChanges, sharedEntries: await sharedEntriesIgnoredInProject(worker.projectPath) });
      if (refusal) return refusal;
      const commitSha = (await runGit(cwd, ['commit-tree', stagedTree, '-p', headSha, '-m', buildWorkerCommitMessage(worker)])).trim();
      await runGit(cwd, ['update-ref', 'HEAD', commitSha, headSha]);
      await runGit(cwd, ['read-tree', commitSha]);
      return null;
    } finally {
      await rm(indexDirectory, { recursive: true, force: true });
    }
  }

  async function writeFailedCheckOutputFile(worker: FactoryCloseOutWorker, outputText: string): Promise<string | null> {
    const workerTempDirectory = worker.session._guardrailsLaunch?.env.CLAUDE_CODE_TMPDIR;
    if (!workerTempDirectory) return null;
    const outputPath = path.join(workerTempDirectory, `failed-check-${crypto.randomUUID()}.log`);
    await writeTextAtomic(outputPath, outputText, { mode: 0o600 });
    return outputPath;
  }

  function runWorkerChecks(worker: FactoryCloseOutWorker, sha: string, { commands, rerunFailedChecks = false }: {
    commands?: readonly string[]; rerunFailedChecks?: boolean;
  } = {}): Promise<FactoryCheckoutRun | null> {
    const profile = resolveFactoryProfile(config.factory, config.projects?.find((project) => project.path === worker.projectPath));
    return runChecksInCleanCheckout({
      projectPath: worker.projectPath, sha, commands: commands ?? profile.checks ?? DEFAULT_FACTORY_CHECKS, writeScopes: worker.writeScopes, gitWorkspace,
      sharedEntries: sharedEntries(), baseEnv, secretValues: secretValues(), signal: reviewController.signal,
      isLive: () => isLive(worker), prepareCheckRunner, rerunFailedChecks,
      writeFailedCheckOutputFile: (outputText) => writeFailedCheckOutputFile(worker, outputText),
    });
  }

  async function listInheritedCheckCommands(worker: FactoryCloseOutWorker, baseSha: string, headRun: FactoryCheckoutRun): Promise<string[] | null> {
    const failedCommands = headRun.checks.filter((check) => !check.pass && headRun.failureTextByCommand.has(check.command)).map((check) => check.command);
    if (failedCommands.length === 0) return [];
    const baseRun = await runWorkerChecks(worker, baseSha, { commands: failedCommands }).catch(() => EMPTY_CHECKOUT_RUN);
    if (baseRun === null) return null;
    return failedCommands.filter((command) => isInheritedCheckFailure({
      headOutput: headRun.failureTextByCommand.get(command) ?? '', headCheckoutPaths: headRun.checkoutPaths,
      baseOutput: baseRun.failureTextByCommand.get(command) ?? null, baseCheckoutPaths: baseRun.checkoutPaths,
    }));
  }

  async function recordMergeVerification(worker: FactoryCloseOutWorker, ledgerCwd: string, mergedSha: string): Promise<void> {
    const verificationId = `merged-${worker.workId}`;
    await runCoherence({ cwd: ledgerCwd, args: ['consequence', 'add', `verification:${verificationId}`, 'verifies', `work:${worker.workId}`,
      '--evidence', `Merged at ${mergedSha} after the fence, checks and independent review passed`, '--session', FACTORY_LEDGER_SESSION, '--json'] });
    await trustVerification(worker.projectId, { id: verificationId, sha: mergedSha });
  }

  async function discardUncommittedLedgerChanges(cwd: string): Promise<void> {
    await runGit(cwd, ['clean', '-ffdxq', '--', CASE_INSENSITIVE_LEDGER_PATHSPEC]);
    if ((await runGit(cwd, ['--no-optional-locks', 'status', '--porcelain', '--', CASE_INSENSITIVE_LEDGER_PATHSPEC])).trim()) {
      await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', CASE_INSENSITIVE_LEDGER_PATHSPEC]);
    }
  }

  async function discardWorkerLedgerChanges(worker: FactoryCloseOutWorker, cwd: string, baseSha: string): Promise<void> {
    await discardUncommittedLedgerChanges(cwd);
    const committedLedgerPaths = nulSeparatedPaths(await runGit(cwd, ['diff', '--name-only', '--no-renames', '-z', baseSha, 'HEAD', '--', CASE_INSENSITIVE_LEDGER_PATHSPEC]));
    if (committedLedgerPaths.length === 0) return;
    await runGit(cwd, ['restore', `--source=${baseSha}`, '--staged', '--worktree', '--', ...committedLedgerPaths]);
    await runGit(cwd, ['commit', '-m', `factory: drop worker ledger changes ${worker.workId}`, '--', ...committedLedgerPaths]);
  }

  async function listTrackedRegularFiles(cwd: string, sha: string, files: readonly string[]): Promise<string[]> {
    if (files.length === 0) return [];
    const treeEntries = (await runGit(cwd, ['ls-tree', '-z', '--full-tree', sha, '--', ...files])).split('\0');
    return treeEntries.flatMap((treeEntry) => {
      const regularFileEntry = /^10(?:0644|0755) blob [0-9a-f]+\t(.+)$/s.exec(treeEntry);
      return regularFileEntry && files.includes(regularFileEntry[1]) ? [regularFileEntry[1]] : [];
    });
  }

  async function readWorkState(cwd: string, workId: string): Promise<string | undefined> {
    const inspected = CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd, args: ['work', 'inspect', '--json'] })));
    return inspected.work.find((order) => order.work === workId)?.state;
  }

  async function applyFailure(worker: FactoryCloseOutWorker, decision: ReturnType<typeof decideCloseOut>, failureClass: FactoryDecisionInput['failureClass'] = 'closeout',
    trackedScopeNeeds: readonly string[] = [], isUnretryable = false): Promise<boolean> {
    if (decision.action === 'merge' || !isLive(worker)) return false;
    if (decision.action === 'retry') {
      const pasted = worker.session.pasteTextWhenReady(decision.feedback);
      if (pasted.ok && !pasted.deferred) worker.session.write('\r');
      return true;
    }
    return serializeProject(worker.projectId, async () => {
      if (!isLive(worker)) return false;
      const ledger = await ensureLedger(worker.projectId, worker.projectPath);
      const ledgerReason = decision.reason.replace(/\s+/g, ' ').trim().slice(0, 3999).trimEnd();
      if (await readWorkState(ledger.cwd, worker.workId) !== 'blocked') {
        await runCoherence({ cwd: ledger.cwd, args: [
          'work', 'transition', worker.workId, 'blocked', '--because', ledgerReason,
          '--session', FACTORY_LEDGER_SESSION, '--evidence', ledgerReason,
        ] });
      }
      const scopeNeeds = decision.reason.startsWith('Needs write scope:') ? failingFilesOutsideScopesByWork.get(worker.workId) ?? [] : [];
      const profile = resolveFactoryProfile(config.factory, config.projects?.find((project) => project.id === worker.projectId));
      const { widenedNeeds, isRecoverable } = planScopeNeedRecovery({ scopeNeeds, trackedFiles: trackedScopeNeeds, intentWriteScopes: worker.intentWriteScopes,
        widenableScopes: profile.widenableScopes, protectedPaths: profile.protectedPaths });
      const rememberedNeeds = widenedNeeds.length > 0 ? await recordScopeNeeds(worker, widenedNeeds) : [];
      const shouldPark = isUnretryable || !isRecoverable || widenedNeeds.some((file) => !rememberedNeeds.includes(file));
      const blockCount = await countTicketBlock(worker.projectId, worker.workId, shouldPark);
      const blockedAttempt = attemptOf(worker);
      attempts.delete(worker.workId);
      failingFilesOutsideScopesByWork.delete(worker.workId);
      worker.session.destroy();
      const detail = blockCount >= FACTORY_TICKET_BLOCK_CAP
        ? `Parked ${worker.workId} after ${blockCount} blocks. Leave it parked. Need: ${decision.reason}`
        : decision.reason;
      blockExceptionByProject.set(worker.projectId, detail);
      notifyOrchestrator(worker.projectId, { workId: worker.workId, intentId: worker.intentId, sessionId: worker.session.id, attempt: blockedAttempt, event: 'blocked', failureClass, detail });
      setException(worker.projectId, detail);
      await commitAndLand(worker.projectId, worker.projectPath, `factory: block ${worker.workId}`).catch(() => {});
      return true;
    });
  }

  async function closeOut(worker: FactoryCloseOutWorker): Promise<void> {
    if (!isLive(worker)) return;
    const cwd = worker.session.worktreeDir;
    const baseSha = worker.session.baseSha ?? worker.baseSha;
    if (!cwd || !baseSha) {
      setException(worker.projectId, `Factory worker for ${worker.workId} has no worktree base, so close-out cannot judge its change`);
      return;
    }
    if (await readPaused(worker.projectId)) {
      held.set(worker.workId, worker);
      return;
    }
    held.delete(worker.workId);
    attempts.set(worker.workId, (attempts.get(worker.workId) ?? 0) + 1);
    reviewing.add(worker.workId);
    onReviewingChanged();
    const attemptStartedAtMs = Date.now();
    const attempt = attemptOf(worker);
    let fence: FactoryFence | null = null;
    let loggedChecks: FactoryCheck[] = [];
    let checkoutSecretValues: string[] = [];
    let verdict: FactoryReviewVerdict | null = null;
    let decision: ReturnType<typeof decideCloseOut> | null = null;
    let loggedReason: string | null = null;
    let attemptFailureClass: FactoryDecisionInput['failureClass'] = null;
    let inheritedNote: string | null = null;
    let confirmedFlakesNote: string | null = null;
    let hasMerged = false;
    const loggedText = (text: string) => redactSecretLines(text, [...secretValues(), ...checkoutSecretValues]);
    const loggedVerdict = () => verdict ? { ...verdict, findings: verdict.findings.map(loggedText) } : null;
    const failedAttempt = async (command: string, output: string, isUnretryable = false): Promise<void> => {
      const failure = decideCloseOut({ fence: { ok: true }, checks: [{ command, pass: false, output }], review: null, attempt: attemptOf(worker) });
      const loggedCheck = { command, pass: false, output: capFactoryDecisionOutput(loggedText(output)) };
      loggedChecks = [...loggedChecks, loggedCheck];
      loggedReason = closeOutFailureText(decideCloseOut({ fence: { ok: true }, checks: [loggedCheck], review: null, attempt }));
      attemptFailureClass = 'closeout';
      decision = null;
      if (await applyFailure(worker, failure, attemptFailureClass, [], isUnretryable)) decision = failure;
    };
    try {
      await discardWorkerLedgerChanges(worker, cwd, baseSha);
      const commitRefusal = await commitWorkerChanges(worker, cwd);
      if (commitRefusal) {
        await failedAttempt('Worker change', commitRefusal);
        return;
      }
      const headSha = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
      const changedPaths = nulSeparatedPaths(await runGit(cwd, ['diff', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', `${baseSha}...${headSha}`]));
      if (changedPaths.length === 0) {
        await failedAttempt('Worker change', 'No change was found in the worktree. Make the change, then finish the turn.', true);
        return;
      }
      const profile = resolveFactoryProfile(config.factory, config.projects?.find((project) => project.id === worker.projectId));
      fence = checkFence({ changedPaths, writeScopes: worker.writeScopes, intentWriteScopes: worker.intentWriteScopes,
        protectedPaths: profile.protectedPaths ?? DEFAULT_FACTORY_PROTECTED_PATHS,
        floorAllowances: await readIntentFloorAllowances(worker.projectId, worker.intentId) });
      const reviewDiff = fence.ok ? await runGit(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--ignore-submodules=none', `${baseSha}...${headSha}`]) : '';
      if (reviewDiff.length > FACTORY_REVIEW_DIFF_MAX_CHARS) {
        await failedAttempt('Review size', FACTORY_REVIEW_TOO_LARGE_FEEDBACK);
        return;
      }
      const captured = fence.ok ? await runWorkerChecks(worker, headSha, { rerunFailedChecks: true }) : EMPTY_CHECKOUT_RUN;
      if (captured === null || !isLive(worker)) return;
      if (captured.confirmedFlakes.length > 0) {
        confirmedFlakesNote = `Confirmed flakes, not charged: ${captured.confirmedFlakes.join(', ')}`;
        await recordConfirmedFlakes(worker, captured.confirmedFlakes);
      }
      const inheritedCommands = await listInheritedCheckCommands(worker, baseSha, captured);
      if (inheritedCommands === null || !isLive(worker)) return;
      inheritedNote = inheritedChecksNote(baseSha, inheritedCommands);
      const checks = chargeableChecks(captured.checks, inheritedCommands);
      const failingFilesOutsideScopes = chargeableFailingFilesOutsideScopes(captured, inheritedCommands);
      loggedChecks = captured.loggedChecks;
      checkoutSecretValues = captured.checkoutSecretValues;
      const shouldReview = fence.ok && checks.every((check) => check.pass);
      verdict = shouldReview ? await runFactoryReview({ spawnReviewer, model: config.factory?.reviewerModel ?? null, signal: reviewController.signal,
        name: `Factory review ${worker.workId}`, buildPrompt: (resultPath) => buildFactoryReviewerPrompt({ ...worker, baseSha }, headSha, resultPath, reviewDiff) }) : null;
      if (!isLive(worker)) return;
      attemptFailureClass = factoryCloseOutFailureClass(fence, checks, verdict);
      const outsideScopes = { failingFilesOutsideScopes, previousFailingFilesOutsideScopes: failingFilesOutsideScopesByWork.get(worker.workId) ?? [],
        checkOutputPaths: [...captured.outputPathsByCommand].filter(([command]) => !inheritedCommands.includes(command)).map(([, outputPath]) => outputPath) };
      failingFilesOutsideScopesByWork.set(worker.workId, failingFilesOutsideScopes);
      const closeOutDecision = decideCloseOut({ fence, checks, review: verdict, attempt: attemptOf(worker), ...outsideScopes });
      loggedReason = closeOutFailureText(decideCloseOut({ fence, checks: chargeableChecks(captured.decisionReasonChecks, inheritedCommands), review: loggedVerdict(), attempt, ...outsideScopes }));
      if (closeOutDecision.action !== 'merge') {
        const trackedScopeNeeds = await listTrackedRegularFiles(cwd, headSha, failingFilesOutsideScopes);
        if (await applyFailure(worker, closeOutDecision, attemptFailureClass, trackedScopeNeeds)) decision = closeOutDecision;
        return;
      }
      decision = closeOutDecision;
      await serializeProject(worker.projectId, async () => {
        if (!isLive(worker)) { decision = null; return; }
        if (await readPaused(worker.projectId)) {
          decision = null;
          attempts.set(worker.workId, Math.max(0, attemptOf(worker) - 1));
          held.set(worker.workId, worker);
          return;
        }
        const currentHead = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
        if (currentHead !== headSha || (await probeUncommittedWorkPaths(cwd)).length > 0) {
          throw new Error('Worker changed during close-out; finish the turn once the worktree is settled');
        }
        if (!worker.session.mergeWorktree) throw new Error('Worker cannot merge its worktree');
        await discardUncommittedLedgerChanges(cwd);
        const merged = await worker.session.mergeWorktree(untrustedCheckoutIsolation());
        if (!merged.merged) throw new Error(merged.reason ?? (merged.conflicts?.join(', ') || 'Worker merge did not merge'));
        hasMerged = true;
        const blockException = blockExceptionByProject.get(worker.projectId);
        blockExceptionByProject.delete(worker.projectId);
        if (blockException !== undefined) clearException(worker.projectId, blockException);
        attempts.delete(worker.workId);
        failingFilesOutsideScopesByWork.delete(worker.workId);
        const mergedSha = await readIntegrationSha(worker.projectPath);
        void recordDecision({
          ...factoryDecisionContext(worker.projectId, { workId: worker.workId, intentId: worker.intentId, sessionId: worker.session.id, attempt, reason: `at ${mergedSha}` }),
          kind: 'merge', outcome: 'merged', failureClass: null, mergedSha,
        });
        await recordFactoryLandedSha(worker.projectId, mergedSha);
        const ledger = await ensureLedger(worker.projectId, worker.projectPath);
        await runCoherence({ cwd: ledger.cwd, args: [
          'work', 'close', worker.workId, 'completed', '--because', 'Factory fence, checks, and independent review passed',
          '--session', FACTORY_LEDGER_SESSION, '--evidence', mergedSha,
        ] });
        await recordMergeVerification(worker, ledger.cwd, mergedSha).catch((error: unknown) => {
          setException(worker.projectId, `Factory finalization failed after merge: the merged work at ${mergedSha} is unverified: ${failureText(error)}`);
        });
        worker.session.destroy();
        notifyOrchestrator(worker.projectId, { workId: worker.workId, event: 'merged', detail: [`at ${mergedSha}`, inheritedNote, confirmedFlakesNote].filter((part) => part !== null).join('. ') });
        await commitAndLand(worker.projectId, worker.projectPath, `factory: complete ${worker.workId}`);
      });
    } catch (error) {
      if (hasMerged) { setException(worker.projectId, `Factory finalization failed after merge: ${failureText(error)}`); return; }
      await failedAttempt('Close-out', checkOutput(failureText(error)));
    } finally {
      if (decision) void recordDecision({
        ...factoryDecisionContext(worker.projectId, { workId: worker.workId, intentId: worker.intentId,
          sessionId: worker.session.id, reason: [decision.action === 'merge' ? inheritedNote : loggedReason, confirmedFlakesNote].filter((part) => part !== null).join('. ') || null }),
        kind: 'closeout', outcome: decision.action, attempt, durationMs: Math.max(0, Date.now() - attemptStartedAtMs),
        failureClass: decision.action === 'merge' ? null : attemptFailureClass,
        fence, checks: capFactoryDecisionChecks(loggedChecks), review: loggedVerdict(),
      });
      reviewing.delete(worker.workId);
      onReviewingChanged();
    }
  }

  function turnEnded(worker: FactoryCloseOutWorker): Promise<void> {
    if (!isLive(worker) || pending.has(worker.workId)) return Promise.resolve();
    const closing = closeOut(worker).catch((error: unknown) => { setException(worker.projectId, failureText(error)); });
    pending.set(worker.workId, closing);
    void closing.then(() => pending.delete(worker.workId));
    return closing;
  }

  function resumeHeld(projectId: string): Promise<void>[] {
    return [...held.values()].filter((worker) => worker.projectId === projectId).map((worker) => {
      held.delete(worker.workId);
      return turnEnded(worker);
    });
  }

  async function stop(): Promise<void> {
    stopped = true;
    reviewController.abort();
    await Promise.allSettled([...pending.values()]);
    held.clear();
  }

  return { turnEnded, resumeHeld, reviewing, stop };
}
