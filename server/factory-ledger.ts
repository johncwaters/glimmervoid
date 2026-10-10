import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFactoryGit } from './git-workspace.ts';
import { findForbiddenLedgerWrites } from './core/factory-core.ts';
import type { FactoryLedgerChange } from './core/factory-core.ts';
import { nulSeparatedPaths } from './core/git-changed-paths-core.ts';
import type { GitWorkspaceInstance } from './git-workspace.ts';

async function readCommittedText(cwd: string, revision: string, relativePath: string): Promise<string | null> {
  const gitOptions = { cwd, encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };
  const { stdout: treeEntry } = await runFactoryGit(['ls-tree', '-z', revision, '--', relativePath], gitOptions);
  if (!treeEntry) return null;
  const blobSha = treeEntry.split('\t')[0].split(' ')[2];
  return (await runFactoryGit(['cat-file', 'blob', blobSha], gitOptions)).stdout;
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
  const { stdout: trackedChanges } = await runFactoryGit(['diff', '--name-only', '--no-renames', '-z', revision, '--', '.coherence'], gitOptions);
  const { stdout: untrackedChanges } = await runFactoryGit(['ls-files', '--others', '--exclude-standard', '-z', '--', '.coherence'], gitOptions);
  const trackedPaths = nulSeparatedPaths(trackedChanges);
  const changedPaths = [...new Set([...trackedPaths, ...nulSeparatedPaths(untrackedChanges)])];
  const changes = await Promise.all(changedPaths.map(async (changedPath) => ({
    path: changedPath, previousText: await readCommittedText(cwd, revision, changedPath), currentText: await readWorkingText(cwd, changedPath),
  })));
  return { trackedPaths, changes };
}

async function listTreeChangedPaths(cwd: string, previousRevision: string, currentRevision: string, pathspec: string[]): Promise<string[]> {
  const { stdout } = await runFactoryGit(['diff', '--name-only', '--no-renames', '-z', previousRevision, currentRevision, '--', ...pathspec], { ...LEDGER_GIT_OPTIONS, cwd });
  return nulSeparatedPaths(stdout);
}

async function readLedgerTreeChanges(cwd: string, previousRevision: string, currentRevision: string, changedPaths?: string[]): Promise<FactoryLedgerChange[]> {
  const ledgerPaths = changedPaths ?? await listTreeChangedPaths(cwd, previousRevision, currentRevision, ['.coherence']);
  return Promise.all(ledgerPaths.map(async (relativePath) => ({
    path: relativePath, previousText: await readCommittedText(cwd, previousRevision, relativePath),
    currentText: await readCommittedText(cwd, currentRevision, relativePath),
  })));
}

function isLedgerPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').startsWith('.coherence/');
}

export async function screenPendingLedgerWrites({ cwd, intentId, onRefused }: {
  cwd: string; intentId: string | null; onRefused: (reason: string) => void;
}): Promise<void> {
  const { trackedPaths, changes } = await readLedgerChangesSince(cwd, 'HEAD');
  if (changes.length === 0) return;
  const forbiddenWrites = findForbiddenLedgerWrites(changes, { trusted: false, intentId });
  if (forbiddenWrites.length === 0) return;
  const gitOptions = { ...LEDGER_GIT_OPTIONS, cwd };
  if (trackedPaths.length > 0) await runFactoryGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...trackedPaths], gitOptions);
  await runFactoryGit(['clean', '-fdq', '--', '.coherence'], gitOptions);
  onRefused(`Factory discarded pending orchestrator ledger writes: ${forbiddenWrites.join('; ')}`);
}

export async function commitAndLandFactoryLedger({ projectPath, ledger, targetBranch, message, gitWorkspace, trusted,
  writtenRecordIds = new Set<string>(), intentId = null, retryLanding = false, onRefused = () => {}, onCommitted = async () => {} }: {
  projectPath: string;
  ledger: { cwd: string; branch?: string | null; base?: string | null; isGit: boolean };
  targetBranch: string;
  message: string;
  gitWorkspace: Pick<GitWorkspaceInstance, 'mergeKeep'>;
  trusted: boolean;
  writtenRecordIds?: ReadonlySet<string>;
  intentId?: string | null;
  retryLanding?: boolean;
  onRefused?: (reason: string) => void;
  onCommitted?: () => Promise<void>;
}): Promise<void> {
  const gitOptions = { ...LEDGER_GIT_OPTIONS, cwd: ledger.cwd };
  const indexDirectory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-factory-index-'));
  try {
    const indexOptions = { ...gitOptions, indexFile: path.join(indexDirectory, 'index') };
    const headSha = (await runFactoryGit(['rev-parse', 'HEAD'], gitOptions)).stdout.trim();
    await runFactoryGit(['read-tree', headSha], indexOptions);
    await runFactoryGit(['add', '--', '.coherence'], indexOptions);
    const stagedTree = (await runFactoryGit(['write-tree'], indexOptions)).stdout.trim();
    const pendingChanges = await readLedgerTreeChanges(ledger.cwd, headSha, stagedTree);
    if (pendingChanges.length === 0 && !retryLanding) {
      await onCommitted();
      return;
    }
    const integrationBase = (await runFactoryGit(['merge-base', headSha, `refs/heads/${targetBranch}`], gitOptions)).stdout.trim();
    const unlandedPaths = await listTreeChangedPaths(ledger.cwd, integrationBase, stagedTree, []);
    const unlandedLedgerPaths = unlandedPaths.filter(isLedgerPath);
    const forbiddenWrites = [
      ...unlandedPaths.filter((changedPath) => !isLedgerPath(changedPath)).map((changedPath) => `${changedPath} is outside the .coherence ledger`),
      ...findForbiddenLedgerWrites(await readLedgerTreeChanges(ledger.cwd, integrationBase, stagedTree, unlandedLedgerPaths), { trusted, intentId, writtenRecordIds }),
    ];
    if (forbiddenWrites.length > 0) {
      const reason = `Factory refused to land ledger writes: ${forbiddenWrites.join('; ')}`;
      onRefused(reason);
      throw new Error(reason);
    }
    if (pendingChanges.length > 0) {
      const commitSha = (await runFactoryGit(['commit-tree', stagedTree, '-p', headSha, '-m', message], gitOptions)).stdout.trim();
      await runFactoryGit(['update-ref', 'HEAD', commitSha, headSha], gitOptions);
      await runFactoryGit(['read-tree', commitSha], gitOptions);
    }
    await onCommitted();
    const landed = await gitWorkspace.mergeKeep({ projectPath, workspace: ledger, targetBranch, disableRepoCommands: true });
    if (landed.merged && landed.pushed) return;
    if (landed.reason === 'nothing-to-commit') {
      await runFactoryGit(['merge-base', '--is-ancestor', 'HEAD', `refs/heads/${targetBranch}`], gitOptions);
      await runFactoryGit(['push', 'origin', `refs/heads/${targetBranch}:refs/heads/${targetBranch}`], { ...gitOptions, cwd: projectPath });
      return;
    }
    throw new Error(landed.reason ?? landed.warning ?? 'Could not push the factory ledger to origin');
  } finally {
    await rm(indexDirectory, { recursive: true, force: true });
  }
}
