import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync } from './child-process-safe.ts';
import { findForbiddenLedgerWrites } from './core/factory-core.ts';
import type { FactoryLedgerChange } from './core/factory-core.ts';
import { nulSeparatedPaths } from './core/git-changed-paths-core.ts';
import type { GitWorkspaceInstance } from './git-workspace.ts';

async function readCommittedText(cwd: string, revision: string, relativePath: string): Promise<string | null> {
  try {
    return (await execFileAsync('git', ['show', `${revision}:${relativePath}`], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

async function readWorkingText(cwd: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(cwd, relativePath), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

const LEDGER_GIT_OPTIONS = { encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };

async function readLedgerChangesSince(cwd: string, revision: string): Promise<{ trackedPaths: string[]; changes: FactoryLedgerChange[] }> {
  const gitOptions = { ...LEDGER_GIT_OPTIONS, cwd };
  const { stdout: trackedChanges } = await execFileAsync('git', ['diff', '--name-only', '--no-renames', '-z', revision, '--', '.coherence'], gitOptions);
  const { stdout: untrackedChanges } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.coherence'], gitOptions);
  const trackedPaths = nulSeparatedPaths(trackedChanges);
  const changedPaths = [...new Set([...trackedPaths, ...nulSeparatedPaths(untrackedChanges)])];
  const changes = await Promise.all(changedPaths.map(async (changedPath) => ({
    path: changedPath, previousText: await readCommittedText(cwd, revision, changedPath), currentText: await readWorkingText(cwd, changedPath),
  })));
  return { trackedPaths, changes };
}

async function readLedgerBranchChanges(cwd: string, targetBranch: string): Promise<FactoryLedgerChange[]> {
  const integrationBase = (await execFileAsync('git', ['merge-base', 'HEAD', `refs/heads/${targetBranch}`], { ...LEDGER_GIT_OPTIONS, cwd })).stdout.trim();
  return (await readLedgerChangesSince(cwd, integrationBase)).changes;
}

export async function screenPendingLedgerWrites({ cwd, intentId, onRefused }: {
  cwd: string; intentId: string | null; onRefused: (reason: string) => void;
}): Promise<void> {
  const { trackedPaths, changes } = await readLedgerChangesSince(cwd, 'HEAD');
  if (changes.length === 0) return;
  const forbiddenWrites = findForbiddenLedgerWrites(changes, { trusted: false, intentId });
  if (forbiddenWrites.length === 0) return;
  const gitOptions = { ...LEDGER_GIT_OPTIONS, cwd };
  if (trackedPaths.length > 0) await execFileAsync('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...trackedPaths], gitOptions);
  await execFileAsync('git', ['clean', '-fdq', '--', '.coherence'], gitOptions);
  onRefused(`Factory discarded pending orchestrator ledger writes: ${forbiddenWrites.join('; ')}`);
}

export async function commitAndLandFactoryLedger({ projectPath, ledger, targetBranch, message, gitWorkspace, trusted, intentId = null, retryLanding = false, onRefused = () => {} }: {
  projectPath: string;
  ledger: { cwd: string; branch?: string | null; base?: string | null; isGit: boolean };
  targetBranch: string;
  message: string;
  gitWorkspace: Pick<GitWorkspaceInstance, 'mergeKeep'>;
  trusted: boolean;
  intentId?: string | null;
  retryLanding?: boolean;
  onRefused?: (reason: string) => void;
}): Promise<void> {
  const gitOptions = { cwd: ledger.cwd, encoding: 'utf8' as const, timeout: 30_000 };
  const { stdout: ledgerChanges } = await execFileAsync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--', '.coherence'], gitOptions);
  if (!ledgerChanges.trim() && !retryLanding) return;
  const forbiddenWrites = findForbiddenLedgerWrites(await readLedgerBranchChanges(ledger.cwd, targetBranch), { trusted, intentId });
  if (forbiddenWrites.length > 0) {
    const reason = `Factory refused to land ledger writes: ${forbiddenWrites.join('; ')}`;
    onRefused(reason);
    throw new Error(reason);
  }
  if (ledgerChanges.trim()) {
    await execFileAsync('git', ['add', '--', '.coherence'], gitOptions);
    await execFileAsync('git', ['commit', '--only', '-m', message, '--', '.coherence'], gitOptions);
  }
  const landed = await gitWorkspace.mergeKeep({ projectPath, workspace: ledger, targetBranch });
  if (landed.merged && landed.pushed) return;
  if (landed.reason === 'nothing-to-commit') {
    await execFileAsync('git', ['merge-base', '--is-ancestor', 'HEAD', `refs/heads/${targetBranch}`], gitOptions);
    await execFileAsync('git', ['push', 'origin', `refs/heads/${targetBranch}:refs/heads/${targetBranch}`], { ...gitOptions, cwd: projectPath });
    return;
  }
  throw new Error(landed.reason ?? landed.warning ?? 'Could not push the factory ledger to origin');
}
