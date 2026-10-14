import { constants } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isMissingFileError } from '../../shared/text.ts';
import { runHardenedGit } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { FACTORY_INTEGRATION_MOVED_OUTSIDE, appendedLedgerLines, factoryRecordIdOf, findForbiddenLedgerWrites, isFactoryLedgerLineOfWrite } from './core/factory-core.ts';
import type { FactoryDeclaredRecord, FactoryLedgerChange } from './core/factory-core.ts';
import type { FactoryUnlandedRecord } from '../../shared/contracts/factory.ts';
import { nulSeparatedPaths } from '../git/core/git-changed-paths-core.ts';
import type { GitWorkspaceInstance } from '../git/git-workspace.ts';

const LEDGER_GIT_OPTIONS = { encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };

async function readCommittedText(cwd: string, revision: string, relativePath: string): Promise<string | null> {
  const gitOptions = { ...LEDGER_GIT_OPTIONS, cwd, maxBuffer: 64 * 1024 * 1024 };
  const { stdout: treeEntry } = await runHardenedGit(['ls-tree', '-z', revision, '--', relativePath], gitOptions);
  if (!treeEntry) return null;
  const blobSha = treeEntry.split('\t')[0].split(' ')[2];
  return (await runHardenedGit(['cat-file', 'blob', blobSha], gitOptions)).stdout;
}

async function readWorkingText(cwd: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(cwd, relativePath), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function listTrackedLedgerChanges(cwd: string, revision: string): Promise<string[]> {
  const { stdout: trackedChanges } = await runHardenedGit(['diff', '--name-only', '--no-renames', '-z', revision, '--', '.coherence'], { ...LEDGER_GIT_OPTIONS, cwd });
  return nulSeparatedPaths(trackedChanges);
}

async function readLedgerChangesSince(cwd: string, revision: string): Promise<FactoryLedgerChange[]> {
  const trackedPaths = await listTrackedLedgerChanges(cwd, revision);
  const { stdout: untrackedChanges } = await runHardenedGit(['ls-files', '--others', '--exclude-standard', '-z', '--', '.coherence'], { ...LEDGER_GIT_OPTIONS, cwd });
  const changedPaths = [...new Set([...trackedPaths, ...nulSeparatedPaths(untrackedChanges)])];
  return Promise.all(changedPaths.map(async (changedPath) => ({
    path: changedPath, previousText: await readCommittedText(cwd, revision, changedPath), currentText: await readWorkingText(cwd, changedPath),
  })));
}

async function listTreeChangedPaths(cwd: string, previousRevision: string, currentRevision: string, pathspec: string[]): Promise<string[]> {
  const { stdout } = await runHardenedGit(['diff', '--name-only', '--no-renames', '-z', previousRevision, currentRevision, '--', ...pathspec], { ...LEDGER_GIT_OPTIONS, cwd });
  return nulSeparatedPaths(stdout);
}

async function readLedgerTreeChanges(cwd: string, previousRevision: string, currentRevision: string, changedPaths?: string[]): Promise<FactoryLedgerChange[]> {
  const ledgerPaths = changedPaths ?? await listTreeChangedPaths(cwd, previousRevision, currentRevision, ['.coherence']);
  return Promise.all(ledgerPaths.map(async (relativePath) => ({
    path: relativePath, previousText: await readCommittedText(cwd, previousRevision, relativePath),
    currentText: await readCommittedText(cwd, currentRevision, relativePath),
  })));
}

async function fetchOriginIntegrationRef(projectPath: string, targetBranch: string): Promise<string> {
  const originTrackingRef = `refs/remotes/origin/${targetBranch}`;
  await runHardenedGit(['fetch', '--no-tags', 'origin', `+refs/heads/${targetBranch}:${originTrackingRef}`], { ...LEDGER_GIT_OPTIONS, cwd: projectPath });
  return originTrackingRef;
}

async function isAncestorRevision(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runHardenedGit(['merge-base', '--is-ancestor', ancestor, descendant], { ...LEDGER_GIT_OPTIONS, cwd });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

function isLedgerPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').startsWith('.coherence/');
}

export async function hasCodeChangedBetween({ projectPath, sinceSha, tipSha }: { projectPath: string; sinceSha: string; tipSha: string }): Promise<boolean> {
  if (tipSha === sinceSha) return false;
  const changedPaths = await runHardenedGit(['diff', '--name-only', '--no-renames', '-z', sinceSha, tipSha], { ...LEDGER_GIT_OPTIONS, cwd: projectPath });
  return nulSeparatedPaths(changedPaths.stdout).some((changedPath) => !isLedgerPath(changedPath));
}

export async function readCodeDiffBetween({ projectPath, sinceSha, tipSha }: { projectPath: string; sinceSha: string; tipSha: string }): Promise<string> {
  const diff = await runHardenedGit(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--ignore-submodules=none', sinceSha, tipSha, '--', '.', ':(exclude).coherence'],
    { ...LEDGER_GIT_OPTIONS, maxBuffer: 64 * 1024 * 1024, cwd: projectPath });
  return diff.stdout;
}

export async function captureFactoryLedgerRecord(cwd: string, recordId: string, write: { args: readonly string[]; output: string }): Promise<FactoryUnlandedRecord | null> {
  const matches = (await readLedgerChangesSince(cwd, 'HEAD')).flatMap((change) => appendedLedgerLines(change)
    .filter((appended) => factoryRecordIdOf(appended.record) === recordId).map(({ line }) => ({ id: recordId, path: change.path, line })));
  if (matches.length > 1) throw new Error(`Factory ledger record ${recordId} was appended ${matches.length} times`);
  const captured = matches[0] ?? null;
  if (captured && !isFactoryLedgerLineOfWrite(captured.line, write)) throw new Error(`Factory ledger record ${recordId} does not match what the factory wrote`);
  return captured;
}

export async function listRecordsMissingFromHead(cwd: string, records: readonly FactoryUnlandedRecord[]): Promise<FactoryUnlandedRecord[]> {
  const missingRecords: FactoryUnlandedRecord[] = [];
  for (const record of records) {
    const headText = await readCommittedText(cwd, 'HEAD', record.path);
    if (!(headText ?? '').split('\n').includes(record.line)) missingRecords.push(record);
  }
  return missingRecords;
}

function declaredFactoryRecordsById(records: readonly FactoryUnlandedRecord[]): ReadonlyMap<string, FactoryDeclaredRecord> {
  return new Map(records.map(({ id, path: recordPath, line }) => [id, { path: recordPath, line }]));
}

export async function discardPendingLedgerWrites(cwd: string, keptRecords: readonly FactoryUnlandedRecord[] = []): Promise<void> {
  const gitOptions = { ...LEDGER_GIT_OPTIONS, cwd };
  const trackedPaths = await listTrackedLedgerChanges(cwd, 'HEAD');
  if (trackedPaths.length > 0) await runHardenedGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...trackedPaths], gitOptions);
  await runHardenedGit(['clean', '-fdq', '--', '.coherence'], gitOptions);
  for (const record of await listRecordsMissingFromHead(cwd, keptRecords.filter((keptRecord) => isLedgerPath(keptRecord.path)))) {
    const recordPath = path.join(cwd, record.path);
    await mkdir(path.dirname(recordPath), { recursive: true });
    const ledgerFile = await open(recordPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0));
    try {
      await ledgerFile.appendFile(`${record.line}\n`);
    } finally {
      await ledgerFile.close();
    }
  }
}

export async function screenPendingLedgerWrites({ cwd, intentId, declaredFactoryRecords = [], onRefused }: {
  cwd: string; intentId: string | null; declaredFactoryRecords?: readonly FactoryUnlandedRecord[]; onRefused: (reason: string) => void;
}): Promise<void> {
  const changes = await readLedgerChangesSince(cwd, 'HEAD');
  if (changes.length === 0) return;
  const forbiddenWrites = findForbiddenLedgerWrites(changes, { intentId, declaredFactoryRecords: declaredFactoryRecordsById(declaredFactoryRecords) });
  if (forbiddenWrites.length === 0) return;
  await discardPendingLedgerWrites(cwd, declaredFactoryRecords);
  onRefused(`Factory discarded pending orchestrator ledger writes: ${forbiddenWrites.join('; ')}`);
}

async function pushIntegrationToOrigin(projectPath: string, targetBranch: string): Promise<void> {
  await runHardenedGit(['push', 'origin', `refs/heads/${targetBranch}:refs/heads/${targetBranch}`], { ...LEDGER_GIT_OPTIONS, cwd: projectPath });
}

export async function commitAndLandFactoryLedger({ projectPath, ledger, targetBranch, message, gitWorkspace,
  declaredFactoryRecords = [], intentId = null, retryLanding = false, factoryLandedShas = new Set<string>(),
  onRefused = () => {}, onCommitted = async () => {}, onIntegrationLanded = async () => {} }: {
  projectPath: string;
  ledger: { cwd: string; branch?: string | null; base?: string | null; isGit: boolean };
  targetBranch: string;
  message: string;
  gitWorkspace: Pick<GitWorkspaceInstance, 'mergeKeep'>;
  declaredFactoryRecords?: readonly FactoryUnlandedRecord[];
  intentId?: string | null;
  retryLanding?: boolean;
  factoryLandedShas?: ReadonlySet<string>;
  onRefused?: (reason: string) => void;
  onCommitted?: () => Promise<void>;
  onIntegrationLanded?: (integrationSha: string) => Promise<void>;
}): Promise<void> {
  const gitOptions = { ...LEDGER_GIT_OPTIONS, cwd: ledger.cwd };
  const indexDirectory = await makeHostScratchDirectory('glimmervoid-factory-index-');
  try {
    const indexOptions = { ...gitOptions, indexFile: path.join(indexDirectory, 'index') };
    const headSha = (await runHardenedGit(['rev-parse', 'HEAD'], gitOptions)).stdout.trim();
    await runHardenedGit(['read-tree', headSha], indexOptions);
    await runHardenedGit(['add', '--', '.coherence'], indexOptions);
    const stagedTree = (await runHardenedGit(['write-tree'], indexOptions)).stdout.trim();
    const pendingChanges = await readLedgerTreeChanges(ledger.cwd, headSha, stagedTree);
    if (pendingChanges.length === 0 && !retryLanding) {
      await onCommitted();
      return;
    }
    const integrationRef = `refs/heads/${targetBranch}`;
    const originIntegrationRef = await fetchOriginIntegrationRef(projectPath, targetBranch);
    let isIntegrationOnOrigin = await isAncestorRevision(ledger.cwd, integrationRef, originIntegrationRef);
    const localIntegrationSha = (await runHardenedGit(['rev-parse', integrationRef], gitOptions)).stdout.trim();
    if (!isIntegrationOnOrigin && factoryLandedShas.has(localIntegrationSha)) {
      await pushIntegrationToOrigin(projectPath, targetBranch);
      await fetchOriginIntegrationRef(projectPath, targetBranch);
      isIntegrationOnOrigin = true;
    }
    if (!isIntegrationOnOrigin && !await isAncestorRevision(ledger.cwd, integrationRef, headSha)) {
      const reason = `Factory refused to land ledger writes: ${FACTORY_INTEGRATION_MOVED_OUTSIDE} (local ${targetBranch} holds commits that neither origin/${targetBranch} nor the factory ledger has)`;
      onRefused(reason);
      throw new Error(reason);
    }
    const integrationBase = (await runHardenedGit(['merge-base', headSha, originIntegrationRef], gitOptions)).stdout.trim();
    const unlandedPaths = await listTreeChangedPaths(ledger.cwd, integrationBase, stagedTree, []);
    const unlandedLedgerPaths = unlandedPaths.filter(isLedgerPath);
    const forbiddenWrites = [
      ...unlandedPaths.filter((changedPath) => !isLedgerPath(changedPath)).map((changedPath) => `${changedPath} is outside the .coherence ledger`),
      ...findForbiddenLedgerWrites(await readLedgerTreeChanges(ledger.cwd, integrationBase, stagedTree, unlandedLedgerPaths), { intentId, declaredFactoryRecords: declaredFactoryRecordsById(declaredFactoryRecords) }),
    ];
    if (forbiddenWrites.length > 0) {
      const reason = `Factory refused to land ledger writes: ${forbiddenWrites.join('; ')}`;
      onRefused(reason);
      throw new Error(reason);
    }
    if (pendingChanges.length > 0) {
      const commitSha = (await runHardenedGit(['commit-tree', stagedTree, '-p', headSha, '-m', message], gitOptions)).stdout.trim();
      await runHardenedGit(['update-ref', 'HEAD', commitSha, headSha], gitOptions);
      await runHardenedGit(['read-tree', commitSha], gitOptions);
    }
    await onCommitted();
    const landed = await gitWorkspace.mergeKeep({ projectPath, workspace: ledger, targetBranch, disableRepoCommands: true });
    if (landed.merged) await onIntegrationLanded((await runHardenedGit(['rev-parse', integrationRef], gitOptions)).stdout.trim());
    if (landed.merged && landed.pushed) return;
    if (landed.reason === 'nothing-to-commit') {
      await runHardenedGit(['merge-base', '--is-ancestor', 'HEAD', integrationRef], gitOptions);
      await pushIntegrationToOrigin(projectPath, targetBranch);
      return;
    }
    throw new Error(landed.reason ?? landed.warning ?? 'Could not push the factory ledger to origin');
  } finally {
    await rm(indexDirectory, { recursive: true, force: true });
  }
}
