import { capFactoryDecisionChecks, capFactoryDecisionOutput, envFileSecretValues, factoryCloseOutFailureClass, factoryDecisionContext } from './core/factory-decision-log-core.ts';
import type { FactoryDecisionInput, FactoryDecisionWorkerEvent } from './core/factory-decision-log-core.ts';
import crypto from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../session/sessions.ts';
import { GLIMMERVOID_SECRET_KEYS } from '../session/core/spawn-env.ts';
import { DEFAULT_FACTORY_CHECKS, DEFAULT_FACTORY_PROTECTED_PATHS } from '../shared/contracts/browser-config.ts';
import type { Config } from '../shared/contracts/config.ts';
import { FactoryReviewVerdict } from '../shared/contracts/factory.ts';
import type { FactoryWatchEntry } from '../shared/contracts/factory.ts';
import { prepareSandboxedCheckRunner } from './factory-check-sandbox.ts';
import type { FactoryCheckSandbox, PrepareFactoryCheckRunner } from './factory-check-sandbox.ts';
import { DEFAULT_CONFIG } from './config-store.ts';
import { FACTORY_LEDGER_SESSION, FACTORY_REVIEW_DIFF_MAX_CHARS, buildFactoryCheckEnv, buildFactoryReviewerPrompt, buildWorkerCommitMessage, checkFence, decideCloseOut, findWorkerCommitRefusal, listStagedSandboxPlaceholders, inheritedSecretValues, listUncommittedWorkPaths, parseCheckCommand, parseFactoryReviewerOutput, redactSecretLines, reviewerOutputTail, summarizeFailedCheckOutput } from './core/factory-core.ts';
import type { FactoryCheck, FactoryFence } from './core/factory-core.ts';
import { LANE_CONFIG_EDIT_DENY_RULES } from './core/lane-permissions-core.ts';
import { SANDBOX_PLACEHOLDER_NAMES } from './core/sandbox-policy-core.ts';
import { nulSeparatedPaths } from './core/git-changed-paths-core.ts';
import { prepareHardenedGitCommand, runHardenedGit } from './git-workspace.ts';
import { makeHostScratchDirectory } from './host-scratch.ts';
import type { GitWorkspaceInstance } from './git-workspace.ts';
import { readLaneResultFile } from './lane-spawn.ts';
import { writeJsonAtomic, writeTextAtomic } from './json-file.ts';
import { z } from 'zod';
import type { LaneSpawn } from './lane-spawn.ts';

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
const FAILED_CHECK_FEEDBACK_MAX_CHARS = 3500;

type FactoryWorkerSession = Pick<Session, 'destroy' | 'pasteTextWhenReady' | 'write' | '_destroyed'>
  & Partial<Pick<Session, 'id' | 'worktreeDir' | 'baseSha' | 'mergeWorktree'>>;

export interface FactoryCloseOutWorker {
  workId: string;
  intentId: string;
  projectId: string;
  projectPath: string;
  baseSha: string | null;
  objective: string;
  criteria: string[];
  writeScopes: string[];
  session: FactoryWorkerSession;
}

export interface FactoryCloseOutDeps {
  config: Pick<Config, 'factory' | 'worktreeShare'>;
  spawnReviewer: LaneSpawn;
  gitWorkspace: Pick<GitWorkspaceInstance, 'stageDetachedWorktree' | 'populate' | 'removeWorktreeByPath' | 'pruneWorktrees'>;
  serializeProject: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  ensureLedger: (projectId: string, projectPath: string) => Promise<{ cwd: string }>;
  runCoherence: (request: { cwd: string; args: string[] }) => Promise<string>;
  commitAndLand: (projectId: string, projectPath: string, message: string) => Promise<void>;
  readIntegrationSha: (projectPath: string) => Promise<string>;
  recordFactoryLandedSha: (projectId: string, integrationSha: string) => Promise<void>;
  readPaused: (projectId: string) => Promise<boolean>;
  appendWatch: (entry: FactoryWatchEntry) => Promise<void>;
  notifyOrchestrator: (projectId: string, event: FactoryDecisionWorkerEvent) => void;
  setException: (projectId: string, reason: string) => void;
  recordDecision?: (decision: Extract<FactoryDecisionInput, { kind: 'closeout' | 'merge' }>) => Promise<void>;
  onReviewingChanged?: () => void;
  baseEnv?: NodeJS.ProcessEnv;
  prepareCheckRunner?: PrepareFactoryCheckRunner;
}

export function factorySecretValues(baseEnv: NodeJS.ProcessEnv): (string | undefined)[] {
  return [...GLIMMERVOID_SECRET_KEYS.map((key) => baseEnv[key]), ...inheritedSecretValues(baseEnv)];
}

function closeOutFailureText(decision: ReturnType<typeof decideCloseOut>): string | null {
  if (decision.action === 'retry') return decision.feedback;
  if (decision.action === 'block') return decision.reason;
  return null;
}

function failureText(error: unknown, maxChars = 4000): string {
  if (!(error instanceof Error)) return String(error).slice(-maxChars);
  const output = ['stdout', 'stderr'].flatMap((key) => {
    if (!(key in error)) return [];
    const value = Reflect.get(error, key);
    return typeof value === 'string' ? [value] : [];
  }).join('\n');
  return `${error.message}\n${output}`.slice(-maxChars);
}

export async function runFactoryReview({ spawnReviewer, model, signal, buildPrompt, name, extraArgs = [], readablePaths = [] }: {
  spawnReviewer: LaneSpawn; model: string | null; signal: AbortSignal;
  buildPrompt: (resultPath: string) => string; name: string; extraArgs?: string[]; readablePaths?: string[];
}): Promise<FactoryReviewVerdict> {
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
      prompt: 'Review the assigned factory ticket and return its structured verdict.', agent: 'claude-code',
      model, signal, readablePaths: [promptPath, ...readablePaths],
      extraArgs: [...extraArgs, '--append-system-prompt-file', promptPath, '--output-format', 'json', '--json-schema', JSON.stringify(z.toJSONSchema(FactoryReviewVerdict, { target: 'draft-7' })), '--permission-mode', 'dontAsk'],
      onOutput: (chunk) => {
        if (reviewerOutput.length + chunk.length > 16 * 1024 * 1024) { hasOutputOverflow = true; return; }
        reviewerOutput += chunk;
      },
    });
    const capturedVerdict = hasOutputOverflow ? null : parseFactoryReviewerOutput(reviewerOutput);
    if (!capturedVerdict) return { pass: false, findings: [`Reviewer returned no structured verdict. Output tail: ${reviewerOutputTail(reviewerOutput) || '(empty)'}`] };
    await writeJsonAtomic(resultPath, capturedVerdict);
    const parsed = FactoryReviewVerdict.safeParse(await readLaneResultFile(resultPath));
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(capturedVerdict)) return { pass: false, findings: ['Reviewer verdict file is missing or invalid'] };
    return parsed.data;
  } catch (error) {
    return { pass: false, findings: [failureText(error)] };
  } finally {
    await rm(reviewDirectory, { recursive: true, force: true });
  }
}

export function createFactoryCloseOut({
  config, spawnReviewer, gitWorkspace, serializeProject, ensureLedger, runCoherence, commitAndLand, readIntegrationSha, recordFactoryLandedSha, readPaused,
  appendWatch, notifyOrchestrator, setException, recordDecision = async () => {}, onReviewingChanged = () => {}, baseEnv = process.env, prepareCheckRunner = prepareSandboxedCheckRunner,
}: FactoryCloseOutDeps) {
  const reviewing = new Set<string>();
  const attempts = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const held = new Map<string, FactoryCloseOutWorker>();
  const reviewController = new AbortController();
  let stopped = false;
  const isLive = (worker: FactoryCloseOutWorker) => !stopped && config.factory?.enabled === true && !worker.session._destroyed;
  const sharedEntries = () => config.worktreeShare ?? DEFAULT_CONFIG.worktreeShare;
  const secretValues = () => factorySecretValues(baseEnv);
  const checkOutput = (text: string) => redactSecretLines(text, secretValues()).slice(-4000);
  const failedCheckOutput = (error: unknown) => summarizeFailedCheckOutput(redactSecretLines(failureText(error, 16 * 1024 * 1024), secretValues()), FAILED_CHECK_FEEDBACK_MAX_CHARS);
  const checkEnv = () => buildFactoryCheckEnv(baseEnv, process.platform);
  const untrustedCheckoutIsolation = () => ({ disableHooks: true, disableRepoCommands: true, replaceEnv: checkEnv() });
  const attemptOf = (worker: FactoryCloseOutWorker) => attempts.get(worker.workId) ?? 1;

  async function runGit(cwd: string, args: string[], indexFile?: string): Promise<string> {
    return (await runHardenedGit(args, { cwd, env: checkEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024, indexFile })).stdout;
  }

  async function probeUncommittedWorkPaths(cwd: string): Promise<string[]> {
    return listUncommittedWorkPaths(await runGit(cwd, ['--no-optional-locks', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']), SANDBOX_PLACEHOLDER_NAMES);
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

  async function stageWorkerTreeInSandbox(cwd: string, indexDirectory: string, stagingIndexFile: string): Promise<void> {
    const objectsDirectory = (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).replace(/\r?\n$/, '');
    const gitOptions = { cwd, env: checkEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
    const stagingCommand = await prepareHardenedGitCommand(['-C', cwd, 'add', '--all', '--', ...WORK_OUTSIDE_LEDGER_PATHSPECS], { ...gitOptions, indexFile: stagingIndexFile });
    const stagingSandbox = await prepareCheckRunner({ scratchParent: indexDirectory, writablePaths: [indexDirectory, objectsDirectory], readablePaths: [cwd] });
    try {
      await stagingSandbox.runCheck(['git', ...stagingCommand.args], { ...gitOptions, cwd: indexDirectory, env: stagingCommand.env, signal: reviewController.signal });
    } finally {
      await stagingSandbox.dispose();
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
      await stageWorkerTreeInSandbox(cwd, indexDirectory, stagingIndexFile);
      const readStagedChanges = async () => {
        const tree = (await runGit(cwd, ['write-tree'], stagingIndexFile)).trim();
        return { tree, rawDiff: await runGit(cwd, ['diff', '--raw', '--no-renames', '--no-abbrev', '--ignore-submodules=none', '-z', headSha, tree]) };
      };
      const stagedWithPlaceholders = await readStagedChanges();
      const placeholderPaths = listStagedSandboxPlaceholders(stagedWithPlaceholders.rawDiff, SANDBOX_PLACEHOLDER_NAMES);
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

  async function removeCheckCheckout(projectPath: string, checkoutPath: string): Promise<void> {
    const removed = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: checkoutPath, ...untrustedCheckoutIsolation() });
    if (removed.ok) return;
    await rm(checkoutPath, { recursive: true, force: true });
    await gitWorkspace.pruneWorktrees({ projectPath, ...untrustedCheckoutIsolation() });
  }

  async function readCheckoutSecretValues(checkoutPath: string): Promise<string[]> {
    const sharedEnvFiles = sharedEntries().filter((sharedEntry) => !sharedEntry.includes('..') && path.basename(sharedEntry).startsWith('.env'));
    const envFileTexts = await Promise.all(sharedEnvFiles.map(async (sharedEnvFile) => {
      try {
        const envFilePath = path.join(checkoutPath, sharedEnvFile);
        return (await lstat(envFilePath)).isFile() ? await readFile(envFilePath, 'utf8') : '';
      } catch {
        return '';
      }
    }));
    return envFileTexts.flatMap(envFileSecretValues);
  }

  async function runChecksInCleanCheckout(worker: FactoryCloseOutWorker, headSha: string): Promise<{ checks: FactoryCheck[]; loggedChecks: FactoryCheck[]; decisionReasonChecks: FactoryCheck[]; checkoutSecretValues: string[] } | null> {
    const checkoutParent = await makeHostScratchDirectory('glimmervoid-factory-checks-');
    const checkoutPath = path.join(checkoutParent, 'checkout');
    let checkSandbox: FactoryCheckSandbox | null = null;
    try {
      const staged = await gitWorkspace.stageDetachedWorktree({ projectPath: worker.projectPath, worktreePath: checkoutPath, sha: headSha, ...untrustedCheckoutIsolation() });
      if (!staged.ok) throw new Error(`Could not stage the factory check checkout: ${staged.err}`);
      await gitWorkspace.populate({ projectPath: worker.projectPath, wtDir: checkoutPath, shareList: sharedEntries(), ...untrustedCheckoutIsolation() });
      checkSandbox = await prepareCheckRunner({ scratchParent: checkoutParent, writablePaths: [checkoutPath] });
      const { runCheck } = checkSandbox;
      const env = checkEnv();
      const checkoutSecretValues = await readCheckoutSecretValues(checkoutPath);
      const checks: FactoryCheck[] = [];
      const loggedChecks: FactoryCheck[] = [];
      const decisionReasonChecks: FactoryCheck[] = [];
      const loggedText = (capturedText: string) => redactSecretLines(capturedText, [...secretValues(), ...checkoutSecretValues]);
      for (const command of config.factory?.checks ?? DEFAULT_FACTORY_CHECKS) {
        if (!isLive(worker)) return null;
        const argv = parseCheckCommand(command);
        if (!argv) {
          const refusedCheck = { command, pass: false, output: 'Check command contains shell syntax or is empty' };
          checks.push(refusedCheck);
          loggedChecks.push(refusedCheck);
          decisionReasonChecks.push(refusedCheck);
          continue;
        }
        try {
          const output = await runCheck(argv, { cwd: checkoutPath, env, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, signal: reviewController.signal });
          checks.push({ command, pass: true, output: checkOutput(`${output.stdout}\n${output.stderr}`) });
          const loggedCheck = { command, pass: true, output: capFactoryDecisionOutput(loggedText(`${output.stdout}\n${output.stderr}`)) };
          loggedChecks.push(loggedCheck);
          decisionReasonChecks.push(loggedCheck);
        } catch (error) {
          checks.push({ command, pass: false, output: failedCheckOutput(error) });
          const loggedFailureText = loggedText(failureText(error, 16 * 1024 * 1024));
          loggedChecks.push({ command, pass: false, output: capFactoryDecisionOutput(loggedFailureText) });
          decisionReasonChecks.push({ command, pass: false, output: summarizeFailedCheckOutput(loggedFailureText, FAILED_CHECK_FEEDBACK_MAX_CHARS) });
        }
      }
      return { checks, loggedChecks, decisionReasonChecks, checkoutSecretValues };
    } finally {
      try {
        await removeCheckCheckout(worker.projectPath, checkoutPath);
        await rm(checkoutParent, { recursive: true, force: true });
      } finally {
        await checkSandbox?.dispose();
      }
    }
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

  async function applyFailure(worker: FactoryCloseOutWorker, decision: ReturnType<typeof decideCloseOut>, failureClass: FactoryDecisionInput['failureClass'] = 'closeout'): Promise<boolean> {
    if (decision.action === 'merge' || !isLive(worker)) return false;
    if (decision.action === 'retry') {
      const pasted = worker.session.pasteTextWhenReady(decision.feedback);
      if (pasted.ok && !pasted.deferred) worker.session.write('\r');
      return true;
    }
    return serializeProject(worker.projectId, async () => {
      if (!isLive(worker)) return false;
      const ledger = await ensureLedger(worker.projectId, worker.projectPath);
      const ledgerReason = decision.reason.replace(/\s+/g, ' ').trim().slice(0, 1000);
      await runCoherence({ cwd: ledger.cwd, args: [
        'work', 'transition', worker.workId, 'blocked', '--because', ledgerReason,
        '--session', FACTORY_LEDGER_SESSION, '--evidence', ledgerReason,
      ] });
      await commitAndLand(worker.projectId, worker.projectPath, `factory: block ${worker.workId}`);
      worker.session.destroy();
      notifyOrchestrator(worker.projectId, { workId: worker.workId, intentId: worker.intentId, sessionId: worker.session.id, attempt: attemptOf(worker), event: 'blocked', failureClass, detail: decision.reason });
      setException(worker.projectId, decision.reason);
      return true;
    });
  }

  async function closeOut(worker: FactoryCloseOutWorker): Promise<void> {
    if (!isLive(worker)) return;
    const cwd = worker.session.worktreeDir;
    const baseSha = worker.session.baseSha ?? worker.baseSha;
    if (!cwd || !baseSha) return;
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
    let hasMerged = false;
    const loggedText = (text: string) => redactSecretLines(text, [...secretValues(), ...checkoutSecretValues]);
    const loggedVerdict = () => verdict ? { ...verdict, findings: verdict.findings.map(loggedText) } : null;
    const failedAttempt = async (command: string, output: string): Promise<void> => {
      const failure = decideCloseOut({ fence: { ok: true }, checks: [{ command, pass: false, output }], review: null, attempt: attemptOf(worker) });
      const loggedCheck = { command, pass: false, output: capFactoryDecisionOutput(loggedText(output)) };
      loggedChecks = [...loggedChecks, loggedCheck];
      loggedReason = closeOutFailureText(decideCloseOut({ fence: { ok: true }, checks: [loggedCheck], review: null, attempt }));
      attemptFailureClass = 'closeout';
      decision = null;
      if (await applyFailure(worker, failure, attemptFailureClass)) decision = failure;
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
        await failedAttempt('Worker change', 'No change was found in the worktree. Make the change, then finish the turn.');
        return;
      }
      fence = checkFence({ changedPaths, writeScopes: worker.writeScopes,
        protectedPaths: config.factory?.protectedPaths ?? DEFAULT_FACTORY_PROTECTED_PATHS });
      const reviewDiff = fence.ok ? await runGit(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--ignore-submodules=none', `${baseSha}...${headSha}`]) : '';
      if (reviewDiff.length > FACTORY_REVIEW_DIFF_MAX_CHARS) {
        await failedAttempt('Review size', FACTORY_REVIEW_TOO_LARGE_FEEDBACK);
        return;
      }
      const captured = fence.ok ? await runChecksInCleanCheckout(worker, headSha) : { checks: [], loggedChecks: [], decisionReasonChecks: [], checkoutSecretValues: [] };
      if (captured === null || !isLive(worker)) return;
      const { checks } = captured;
      loggedChecks = captured.loggedChecks;
      checkoutSecretValues = captured.checkoutSecretValues;
      const shouldReview = fence.ok && checks.every((check) => check.pass);
      verdict = shouldReview ? await runFactoryReview({ spawnReviewer, model: config.factory?.reviewerModel ?? null, signal: reviewController.signal,
        name: `Factory review ${worker.workId}`, buildPrompt: (resultPath) => buildFactoryReviewerPrompt({ ...worker, baseSha }, headSha, resultPath, reviewDiff) }) : null;
      if (!isLive(worker)) return;
      attemptFailureClass = factoryCloseOutFailureClass(fence, checks, verdict);
      const closeOutDecision = decideCloseOut({ fence, checks, review: verdict, attempt: attemptOf(worker) });
      loggedReason = closeOutFailureText(decideCloseOut({ fence, checks: captured.decisionReasonChecks, review: loggedVerdict(), attempt }));
      if (closeOutDecision.action !== 'merge') {
        if (await applyFailure(worker, closeOutDecision, attemptFailureClass)) decision = closeOutDecision;
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
        await appendWatch({ workId: worker.workId, intentId: worker.intentId, projectId: worker.projectId,
          mergedSha, mergedAt: new Date().toISOString(), writeScopes: worker.writeScopes }).catch((error: unknown) => {
          setException(worker.projectId, `Factory finalization failed after merge: the merged work at ${mergedSha} is unwatched: ${failureText(error)}`);
        });
        worker.session.destroy();
        notifyOrchestrator(worker.projectId, { workId: worker.workId, event: 'merged', detail: `at ${mergedSha}` });
        await commitAndLand(worker.projectId, worker.projectPath, `factory: complete ${worker.workId}`);
      });
    } catch (error) {
      if (hasMerged) { setException(worker.projectId, `Factory finalization failed after merge: ${failureText(error)}`); return; }
      await failedAttempt('Close-out', checkOutput(failureText(error)));
    } finally {
      if (decision) void recordDecision({
        ...factoryDecisionContext(worker.projectId, { workId: worker.workId, intentId: worker.intentId,
          sessionId: worker.session.id, reason: decision.action === 'merge' ? null : loggedReason }),
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
