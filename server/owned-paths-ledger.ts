import fs from 'node:fs/promises';
import path from 'node:path';
import { createJsonStateStore } from './json-file.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { appendRemovalRecord, removalsJournalPath } from './removal-journal.ts';
import { sessionIdFromOwner } from './core/removal-guard-core.ts';
import { OwnedPathsLedger } from '../shared/contracts/owned-paths.ts';
import type { OwnedPathEntry } from '../shared/contracts/owned-paths.ts';
import { caseFoldedPathKey } from '../shared/paths.ts';
import { errorMessage } from '../shared/text.ts';
import { PARKED_REF_RETAIN_DAYS, holdsKeptPath, orphanedOwnedPaths } from './core/owned-paths-core.ts';
import { clock } from '../shared/clock.ts';

type OwnedPathsLedgerHandle = ReturnType<typeof createOwnedPathsLedger>;

type OwnedPathsReconcileGit = {
  describeWorkspaceMemberWork: (args: { projectPath: string; cwd: string; branch: string }) => Promise<string | null>;
  removeWorkspaceMember: (args: { projectPath: string; cwd: string; branch: string; shareList: string[]; cause: 'owned-paths'; discardWork?: boolean }) => Promise<{ ok: boolean; err?: string; removalKept?: string }>;
  parkWorkspaceMemberWork: (args: { projectPath: string; cwd: string; branch: string; owner: string }) => Promise<{ ok: true; ref: string } | { ok: false; reason: string }>;
  dropExpiredParkedWork: (args: { projectPath: string }) => Promise<string[]>;
};

function ledgerKey(ownedPath: string): string {
  return caseFoldedPathKey(path.resolve(ownedPath));
}

async function canonicalOwnedPath(ownedPath: string): Promise<string> {
  const resolvedPath = path.resolve(ownedPath);
  const missingSegments: string[] = [];
  let existingAncestor = resolvedPath;
  while (true) {
    const realAncestor = await fs.realpath(existingAncestor).catch(() => null);
    if (realAncestor !== null) return path.join(realAncestor, ...missingSegments);
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return resolvedPath;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
}

function createOwnedPathsLedger({ filePath, log = console }: { filePath: string; log?: Pick<Console, 'warn'> }) {
  const entriesByPath = new Map<string, OwnedPathEntry>();
  const keysRecordedThisRun = new Set<string>();
  let isLoaded = false;
  const store = createJsonStateStore({
    name: 'owned paths ledger',
    filePath,
    parse: (raw) => OwnedPathsLedger.safeParse(raw).data ?? null,
    adopt: (ledger) => {
      entriesByPath.clear();
      for (const entry of ledger?.entries ?? []) entriesByPath.set(ledgerKey(entry.path), entry);
      isLoaded = true;
    },
    warn: (message, fields) => log.warn(`[owned-paths] ${message} ${JSON.stringify(fields)}`),
  });

  async function persist(): Promise<void> {
    const ledger: OwnedPathsLedger = { version: 1, entries: [...entriesByPath.values()] };
    await store.write(ledger, () => `${JSON.stringify(ledger, null, 2)}\n`);
  }

  async function record(entry: OwnedPathEntry): Promise<void> {
    await store.load();
    if (!isLoaded) return;
    const canonicalEntry = { ...entry, path: await canonicalOwnedPath(entry.path) };
    const canonicalKey = ledgerKey(canonicalEntry.path);
    keysRecordedThisRun.add(canonicalKey);
    entriesByPath.set(canonicalKey, canonicalEntry);
    await persist();
  }

  async function forget(ownedPath: string): Promise<void> {
    await store.load();
    if (!isLoaded || !entriesByPath.delete(ledgerKey(await canonicalOwnedPath(ownedPath)))) return;
    await persist();
  }

  async function ownerOf(ownedPath: string): Promise<string | null> {
    await store.load();
    return entriesByPath.get(ledgerKey(await canonicalOwnedPath(ownedPath)))?.owner ?? null;
  }

  async function entriesOwnedBy(owner: string): Promise<OwnedPathEntry[]> {
    await store.load();
    return [...entriesByPath.values()].filter((entry) => entry.owner === owner);
  }

  async function loadEarlierRunEntries(): Promise<{ ok: true; entries: OwnedPathEntry[] } | { ok: false }> {
    await store.load();
    if (!isLoaded) return { ok: false };
    return { ok: true, entries: [...entriesByPath.entries()].filter(([key]) => !keysRecordedThisRun.has(key)).map(([, entry]) => entry) };
  }

  return { loadEarlierRunEntries, record, forget, ownerOf, entriesOwnedBy, idle: () => store.idle() };
}

async function pathExists(ownedPath: string): Promise<boolean> {
  return fs.lstat(ownedPath).then(() => true, () => false);
}

async function holdsCheckout(folderPath: string): Promise<boolean> {
  const children = await fs.readdir(folderPath).catch(() => []);
  const checkoutMarkers = await Promise.all(children.map((child) => pathExists(path.join(folderPath, child, '.git'))));
  return checkoutMarkers.includes(true);
}

async function removeOrphanedWorktree(entry: OwnedPathEntry, git: OwnedPathsReconcileGit, shareList: string[], log: Pick<Console, 'log'>): Promise<string | null> {
  if (!entry.projectPath || !entry.branch) return 'it names no repository and branch to check its work against';
  const member = { projectPath: entry.projectPath, cwd: entry.path, branch: entry.branch };
  const work = await git.describeWorkspaceMemberWork(member);
  const parked = work ? await git.parkWorkspaceMemberWork({ ...member, owner: entry.owner }) : null;
  if (work && parked && !parked.ok) return `${work}, not parked because ${parked.reason}`;
  if (parked?.ok) log.log(`[owned-paths] parked the work in ${entry.path} (${work}) on ${parked.ref}; restore it with: git -C ${entry.projectPath} worktree add ${entry.path} ${parked.ref}`);
  const removed = await git.removeWorkspaceMember({ ...member, shareList, cause: 'owned-paths', discardWork: parked?.ok === true });
  if (removed.removalKept) return `the removal guard kept it: ${removed.removalKept}`;
  if (!removed.ok || await pathExists(entry.path)) return `git could not remove it: ${removed.err || 'the folder is still there'}`;
  return null;
}

async function dropExpiredParkedWork(projectPaths: Iterable<string>, git: OwnedPathsReconcileGit, log: Pick<Console, 'log'>): Promise<void> {
  for (const projectPath of new Set(projectPaths)) {
    for (const droppedRef of await git.dropExpiredParkedWork({ projectPath })) log.log(`[owned-paths] dropped ${droppedRef} in ${projectPath}, parked more than ${PARKED_REF_RETAIN_DAYS} days ago`);
  }
}

async function removeOrphanedFolder(entry: OwnedPathEntry, ledger: Pick<OwnedPathsLedgerHandle, 'forget'>, keptPaths: string[], journalPath: string, log: Pick<Console, 'warn'>): Promise<string | null> {
  if (holdsKeptPath(entry.path, keptPaths)) return 'it holds a checkout that was kept';
  if (await holdsCheckout(entry.path)) return 'it still holds a checkout';
  const isRecorded = await appendRemovalRecord(journalPath, {
    ts: clock.nowMs(), cause: 'owned-paths', kind: 'folder', path: entry.path, branch: null, projectPath: entry.projectPath,
    sessionId: sessionIdFromOwner(entry.owner), checksPassed: ['session-not-configured', 'holds-no-checkout'], pid: process.pid,
  }, log);
  if (!isRecorded) return 'its removal record could not be written';
  const removal = await fs.rm(entry.path, { recursive: true, force: true }).then(() => null, (error: unknown) => `it could not be deleted: ${errorMessage(error)}`);
  if (removal) return removal;
  await ledger.forget(entry.path);
  return null;
}

async function reconcileOwnedPaths({ ledger, configuredSessionIds, git, shareList, projectPaths = [], journalPath = removalsJournalPath(glimmervoidHomeDir()), log = console }: {
  ledger: Pick<OwnedPathsLedgerHandle, 'loadEarlierRunEntries' | 'forget'>;
  configuredSessionIds: ReadonlySet<string>;
  git: OwnedPathsReconcileGit;
  shareList: string[];
  projectPaths?: string[];
  journalPath?: string;
  log?: Pick<Console, 'log' | 'warn'>;
}): Promise<void> {
  const loaded = await ledger.loadEarlierRunEntries();
  if (!loaded.ok) {
    log.warn('[owned-paths] deleted nothing at startup because the owned paths ledger could not be read');
    return;
  }
  const keptPaths: string[] = [];
  for (const entry of orphanedOwnedPaths(loaded.entries, configuredSessionIds)) {
    if (!(await pathExists(entry.path))) {
      await ledger.forget(entry.path);
      continue;
    }
    const keepReason = entry.kind === 'folder'
      ? await removeOrphanedFolder(entry, ledger, keptPaths, journalPath, log)
      : await removeOrphanedWorktree(entry, git, shareList, log);
    if (!keepReason) {
      log.log(`[owned-paths] deleted ${entry.path}, left by ${entry.owner}`);
      continue;
    }
    keptPaths.push(entry.path);
    log.warn(`[owned-paths] kept ${entry.path}, left by ${entry.owner}, because ${keepReason}`);
  }
  await dropExpiredParkedWork([...projectPaths, ...loaded.entries.flatMap((entry) => (entry.projectPath ? [entry.projectPath] : []))], git, log);
}

export { createOwnedPathsLedger, holdsCheckout, reconcileOwnedPaths };
export type { OwnedPathsLedgerHandle };
