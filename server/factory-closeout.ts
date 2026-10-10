import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../session/sessions.ts';
import { GLIMMERVOID_SECRET_KEYS } from '../session/core/spawn-env.ts';
import { DEFAULT_FACTORY_CHECKS, DEFAULT_FACTORY_PROTECTED_PATHS } from '../shared/contracts/browser-config.ts';
import type { Config } from '../shared/contracts/config.ts';
import { FactoryReviewVerdict } from '../shared/contracts/factory.ts';
import type { FactoryWatchEntry, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import { execFileAsync } from './child-process-safe.ts';
import { DEFAULT_CONFIG } from './config-store.ts';
import { FACTORY_REVIEW_DIFF_MAX_CHARS, buildFactoryCheckEnv, buildFactoryReviewerPrompt, checkFence, decideCloseOut, inheritedSecretValues, listDirtyPaths, parseCheckCommand, parseFactoryReviewerOutput, redactSecretLines } from './core/factory-core.ts';
import type { FactoryCheck, FactoryFence } from './core/factory-core.ts';
import { nulSeparatedPaths } from './core/git-changed-paths-core.ts';
import type { GitWorkspaceInstance } from './git-workspace.ts';
import { readLaneResultFile } from './lane-spawn.ts';
import { writeJsonAtomic, writeTextAtomic } from './json-file.ts';
import { z } from 'zod';
import type { LaneSpawn } from './lane-spawn.ts';

export const FACTORY_REVIEWER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Bash']);
export const FACTORY_REVIEWER_PERMISSIONS = Object.freeze({
  defaultMode: 'dontAsk',
  allow: ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
  deny: ['Edit', 'Write', 'NotebookEdit'],
});
export const FACTORY_REVIEWER_SPAWN_ENV: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0' });
export const FACTORY_REVIEW_TOO_LARGE_FEEDBACK = 'change too large for review; split it into smaller orders';

type FactoryWorkerSession = Pick<Session, 'destroy' | 'pasteTextWhenReady' | 'write' | '_destroyed'>
  & Partial<Pick<Session, 'worktreeDir' | 'baseSha' | 'mergeWorktree'>>;

export interface FactoryCloseOutWorker {
  workId: string;
  intentId: string;
  projectId: string;
  projectPath: string;
  claudeSessionId: string;
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
  readPaused: (projectId: string) => Promise<boolean>;
  appendWatch: (entry: FactoryWatchEntry) => Promise<void>;
  notifyOrchestrator: (projectId: string, event: FactoryWorkerEvent) => void;
  setException: (projectId: string, reason: string) => void;
  onReviewingChanged?: () => void;
  baseEnv?: NodeJS.ProcessEnv;
}

function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(-4000);
  const output = ['stdout', 'stderr'].flatMap((key) => {
    if (!(key in error)) return [];
    const value = Reflect.get(error, key);
    return typeof value === 'string' ? [value] : [];
  }).join('\n');
  return `${error.message}\n${output}`.slice(-4000);
}

export async function runFactoryReview({ spawnReviewer, model, signal, buildPrompt, name, extraArgs = [] }: {
  spawnReviewer: LaneSpawn; model: string | null; signal: AbortSignal;
  buildPrompt: (resultPath: string) => string; name: string; extraArgs?: string[];
}): Promise<FactoryReviewVerdict> {
  const reviewDirectory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-factory-review-'));
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
      prompt: 'Review the assigned factory order and return its structured verdict.', agent: 'claude-code',
      model, signal,
      extraArgs: ['--append-system-prompt-file', promptPath, '--output-format', 'json', '--json-schema', JSON.stringify(z.toJSONSchema(FactoryReviewVerdict)), '--permission-mode', 'dontAsk', ...extraArgs],
      onOutput: (chunk) => {
        if (reviewerOutput.length + chunk.length > 16 * 1024 * 1024) { hasOutputOverflow = true; return; }
        reviewerOutput += chunk;
      },
    });
    const capturedVerdict = hasOutputOverflow ? null : parseFactoryReviewerOutput(reviewerOutput);
    if (!capturedVerdict) return { pass: false, findings: ['Reviewer verdict file is missing or invalid'] };
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
  config, spawnReviewer, gitWorkspace, serializeProject, ensureLedger, runCoherence, commitAndLand, readIntegrationSha, readPaused,
  appendWatch, notifyOrchestrator, setException, onReviewingChanged = () => {}, baseEnv = process.env,
}: FactoryCloseOutDeps) {
  const reviewing = new Set<string>();
  const attempts = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const held = new Map<string, FactoryCloseOutWorker>();
  const reviewController = new AbortController();
  let stopped = false;
  const isLive = (worker: FactoryCloseOutWorker) => !stopped && config.factory?.enabled === true && !worker.session._destroyed;
  const sharedEntries = () => config.worktreeShare ?? DEFAULT_CONFIG.worktreeShare;
  const secretValues = () => [...GLIMMERVOID_SECRET_KEYS.map((key) => baseEnv[key]), ...inheritedSecretValues(baseEnv)];
  const checkOutput = (text: string) => redactSecretLines(text, secretValues()).slice(-4000);
  const untrustedCheckoutIsolation = () => ({ disableHooks: true, replaceEnv: buildFactoryCheckEnv(baseEnv, process.platform) });

  async function runGit(cwd: string, args: string[]): Promise<string> {
    return (await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  }

  async function probeDirtyPaths(cwd: string): Promise<string[]> {
    return listDirtyPaths(await runGit(cwd, ['--no-optional-locks', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']));
  }

  async function removeCheckCheckout(projectPath: string, checkoutPath: string): Promise<void> {
    const removed = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: checkoutPath, ...untrustedCheckoutIsolation() });
    if (removed.ok) return;
    await rm(checkoutPath, { recursive: true, force: true });
    await gitWorkspace.pruneWorktrees({ projectPath, ...untrustedCheckoutIsolation() });
  }

  async function runChecksInCleanCheckout(worker: FactoryCloseOutWorker, headSha: string): Promise<FactoryCheck[] | null> {
    const checkoutParent = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-factory-checks-'));
    const checkoutPath = path.join(checkoutParent, 'checkout');
    try {
      const staged = await gitWorkspace.stageDetachedWorktree({ projectPath: worker.projectPath, worktreePath: checkoutPath, sha: headSha, ...untrustedCheckoutIsolation() });
      if (!staged.ok) throw new Error(`Could not stage the factory check checkout: ${staged.err}`);
      await gitWorkspace.populate({ projectPath: worker.projectPath, wtDir: checkoutPath, shareList: sharedEntries() });
      const checkEnv = buildFactoryCheckEnv(baseEnv, process.platform);
      const checks: FactoryCheck[] = [];
      for (const command of config.factory?.checks ?? DEFAULT_FACTORY_CHECKS) {
        if (!isLive(worker)) return null;
        const argv = parseCheckCommand(command);
        if (!argv) {
          checks.push({ command, pass: false, output: 'Check command contains shell syntax or is empty' });
          continue;
        }
        try {
          const output = await execFileAsync(argv[0], argv.slice(1), { cwd: checkoutPath, env: checkEnv, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, signal: reviewController.signal });
          checks.push({ command, pass: true, output: checkOutput(`${output.stdout}\n${output.stderr}`) });
        } catch (error) {
          checks.push({ command, pass: false, output: checkOutput(failureText(error)) });
        }
      }
      return checks;
    } finally {
      await removeCheckCheckout(worker.projectPath, checkoutPath);
      await rm(checkoutParent, { recursive: true, force: true });
    }
  }

  async function discardWorkerLedgerChanges(worker: FactoryCloseOutWorker, cwd: string, baseSha: string): Promise<void> {
    await runGit(cwd, ['clean', '-ffdxq', '--', '.coherence']);
    if ((await runGit(cwd, ['--no-optional-locks', 'status', '--porcelain', '--', '.coherence'])).trim()) {
      await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.coherence']);
    }
    const committedLedgerPaths = nulSeparatedPaths(await runGit(cwd, ['diff', '--name-only', '--no-renames', '-z', baseSha, 'HEAD', '--', '.coherence']));
    if (committedLedgerPaths.length === 0) return;
    await runGit(cwd, ['restore', `--source=${baseSha}`, '--staged', '--worktree', '--', ...committedLedgerPaths]);
    const hooklessDirectory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-factory-hookless-'));
    try {
      await runGit(cwd, ['-c', `core.hooksPath=${hooklessDirectory}`, 'commit', '--no-verify', '-m', `factory: drop worker ledger changes ${worker.workId}`, '--', ...committedLedgerPaths]);
    } finally {
      await rm(hooklessDirectory, { recursive: true, force: true });
    }
  }

  function holdWhilePaused(worker: FactoryCloseOutWorker): void {
    held.set(worker.workId, worker);
  }

  async function applyFailure(worker: FactoryCloseOutWorker, fence: FactoryFence, checks: FactoryCheck[], verdict: FactoryReviewVerdict | null): Promise<void> {
    const attempt = attempts.get(worker.workId) ?? 1;
    const decision = decideCloseOut({ fence, checks, review: verdict, attempt });
    if (decision.action === 'merge' || !isLive(worker)) return;
    if (decision.action === 'retry') {
      const pasted = worker.session.pasteTextWhenReady(decision.feedback);
      if (pasted.ok && !pasted.deferred) worker.session.write('\r');
      return;
    }
    await serializeProject(worker.projectId, async () => {
      if (!isLive(worker)) return;
      const ledger = await ensureLedger(worker.projectId, worker.projectPath);
      const ledgerReason = decision.reason.replace(/\s+/g, ' ').trim().slice(0, 1000);
      await runCoherence({ cwd: ledger.cwd, args: [
        'work', 'transition', worker.workId, 'blocked', '--because', ledgerReason,
        '--session', 'glimmervoid-factory', '--evidence', ledgerReason,
      ] });
      await commitAndLand(worker.projectId, worker.projectPath, `factory: block ${worker.workId}`);
      worker.session.destroy();
      notifyOrchestrator(worker.projectId, { workId: worker.workId, event: 'blocked', detail: decision.reason });
      setException(worker.projectId, decision.reason);
    });
  }

  function failedAttempt(worker: FactoryCloseOutWorker, command: string, output: string): Promise<void> {
    return applyFailure(worker, { ok: true }, [{ command, pass: false, output }], null);
  }

  async function closeOut(worker: FactoryCloseOutWorker): Promise<void> {
    if (!isLive(worker)) return;
    const cwd = worker.session.worktreeDir;
    const baseSha = worker.session.baseSha ?? worker.baseSha;
    if (!cwd || !baseSha) return;
    if (await readPaused(worker.projectId)) {
      holdWhilePaused(worker);
      return;
    }
    held.delete(worker.workId);
    attempts.set(worker.workId, (attempts.get(worker.workId) ?? 0) + 1);
    reviewing.add(worker.workId);
    onReviewingChanged();
    let hasMerged = false;
    try {
      await discardWorkerLedgerChanges(worker, cwd, baseSha);
      if ((await probeDirtyPaths(cwd)).length > 0) {
        await failedAttempt(worker, 'Working tree', 'commit your work');
        return;
      }
      const headSha = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
      const changedPaths = nulSeparatedPaths(await runGit(cwd, ['diff', '--name-only', '--no-renames', '-z', `${baseSha}...${headSha}`]));
      if (changedPaths.length === 0) {
        await failedAttempt(worker, 'Committed change', 'No change was committed. Commit your work on the current branch, then finish the turn.');
        return;
      }
      const fence = checkFence({ changedPaths, writeScopes: worker.writeScopes,
        protectedPaths: config.factory?.protectedPaths ?? DEFAULT_FACTORY_PROTECTED_PATHS });
      const reviewDiff = fence.ok ? await runGit(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${baseSha}...${headSha}`]) : '';
      if (reviewDiff.length > FACTORY_REVIEW_DIFF_MAX_CHARS) {
        await failedAttempt(worker, 'Review size', FACTORY_REVIEW_TOO_LARGE_FEEDBACK);
        return;
      }
      const checks = fence.ok ? await runChecksInCleanCheckout(worker, headSha) : [];
      if (checks === null || !isLive(worker)) return;
      const shouldReview = fence.ok && checks.every((check) => check.pass);
      const verdict = shouldReview ? await runFactoryReview({ spawnReviewer, model: config.factory?.reviewerModel ?? null, signal: reviewController.signal,
        name: `Factory review ${worker.workId}`, buildPrompt: (resultPath) => buildFactoryReviewerPrompt({ ...worker, baseSha }, headSha, resultPath, reviewDiff) }) : null;
      const decision = decideCloseOut({ fence, checks, review: verdict, attempt: attempts.get(worker.workId) ?? 1 });
      if (decision.action !== 'merge') {
        await applyFailure(worker, fence, checks, verdict);
        return;
      }
      await serializeProject(worker.projectId, async () => {
        if (!isLive(worker)) return;
        if (await readPaused(worker.projectId)) {
          attempts.set(worker.workId, Math.max(0, (attempts.get(worker.workId) ?? 1) - 1));
          holdWhilePaused(worker);
          return;
        }
        const currentHead = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
        if (currentHead !== headSha || (await probeDirtyPaths(cwd)).length > 0) {
          throw new Error('Worker changed during close-out; commit your work and finish the turn');
        }
        if (!worker.session.mergeWorktree) throw new Error('Worker cannot merge its worktree');
        const merged = await worker.session.mergeWorktree();
        if (!merged.merged) throw new Error(merged.reason ?? (merged.conflicts?.join(', ') || 'Worker merge did not merge'));
        hasMerged = true;
        const mergedSha = await readIntegrationSha(worker.projectPath);
        const ledger = await ensureLedger(worker.projectId, worker.projectPath);
        await runCoherence({ cwd: ledger.cwd, args: [
          'work', 'close', worker.workId, 'completed', '--because', 'Factory fence, checks, and independent review passed',
          '--session', 'glimmervoid-factory', '--evidence', mergedSha,
        ] });
        await commitAndLand(worker.projectId, worker.projectPath, `factory: complete ${worker.workId}`);
        await appendWatch({ workId: worker.workId, intentId: worker.intentId, projectId: worker.projectId,
          mergedSha, mergedAt: new Date().toISOString(), writeScopes: worker.writeScopes });
        worker.session.destroy();
        notifyOrchestrator(worker.projectId, { workId: worker.workId, event: 'merged', detail: `at ${mergedSha}` });
      });
    } catch (error) {
      if (hasMerged) { setException(worker.projectId, `Factory finalization failed after merge: ${failureText(error)}`); return; }
      await failedAttempt(worker, 'Close-out', checkOutput(failureText(error)));
    } finally {
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
