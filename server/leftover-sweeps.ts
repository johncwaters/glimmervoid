import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { clock } from '../shared/clock.ts';
import { RemovalRecord } from '../shared/contracts/removal-record.ts';
import type { RemovalKind } from '../shared/contracts/removal-record.ts';
import { caseFoldedPathKey } from '../shared/paths.ts';
import { holdsCheckout } from './owned-paths-ledger.ts';
import { pruneAgedFiles } from './prune-files.ts';

const RETURNED_FOLDER_RETAIN_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES_READ_PER_LEFTOVER = 20000;
const FOLDER_REMOVAL_KINDS: ReadonlySet<RemovalKind> = new Set(['folder', 'worktree']);

type OwnedPathsLookup = { ownsAtOrUnder: (folderPath: string) => Promise<boolean> };

function removedFolderPathFrom(journalLine: string): string | null {
  try {
    const record = RemovalRecord.safeParse(JSON.parse(journalLine));
    return record.success && FOLDER_REMOVAL_KINDS.has(record.data.kind) ? record.data.path : null;
  } catch {
    return null;
  }
}

async function removedFolderNamesByRoot(journalPath: string, worktreeRoots: readonly string[]): Promise<Map<string, Set<string>>> {
  const rootByKey = new Map(worktreeRoots.map((worktreeRoot) => [caseFoldedPathKey(path.resolve(worktreeRoot)), path.resolve(worktreeRoot)]));
  const namesByRoot = new Map<string, Set<string>>();
  const journal = fs.createReadStream(journalPath, 'utf8');
  journal.on('error', () => {});
  try {
    for await (const journalLine of readline.createInterface({ input: journal, crlfDelay: Infinity })) {
      const removedPath = removedFolderPathFrom(journalLine);
      const worktreeRoot = removedPath === null ? undefined : rootByKey.get(caseFoldedPathKey(path.dirname(path.resolve(removedPath))));
      if (removedPath === null || worktreeRoot === undefined) continue;
      namesByRoot.set(worktreeRoot, (namesByRoot.get(worktreeRoot) ?? new Set<string>()).add(path.basename(removedPath)));
    }
  } catch {
    return new Map();
  }
  return namesByRoot;
}

async function holdsCheckoutWithinOneLevel(folderPath: string): Promise<boolean> {
  const isCheckout = await fs.promises.lstat(path.join(folderPath, '.git')).then(() => true, () => false);
  return isCheckout || holdsCheckout(folderPath);
}

async function isWholeTreeUntouchedSince(folderPath: string, cutoffMs: number): Promise<boolean> {
  const unreadFolders = [folderPath];
  let entriesRead = 0;
  while (unreadFolders.length > 0) {
    const currentFolder = unreadFolders.pop() ?? folderPath;
    const entries = await fs.promises.readdir(currentFolder, { withFileTypes: true }).catch(() => null);
    if (entries === null) return false;
    for (const entry of entries) {
      entriesRead += 1;
      if (entriesRead > MAX_ENTRIES_READ_PER_LEFTOVER) return false;
      const entryPath = path.join(currentFolder, entry.name);
      const entryStat = await fs.promises.lstat(entryPath).catch(() => null);
      if (entryStat === null || entryStat.mtimeMs >= cutoffMs) return false;
      if (entry.isDirectory()) unreadFolders.push(entryPath);
    }
  }
  return true;
}

async function sweepReturnedWorktreeFolders({ worktreeRoots, journalPath, ledger, log = console }: {
  worktreeRoots: readonly string[];
  journalPath: string;
  ledger: OwnedPathsLookup;
  log?: Pick<Console, 'log'>;
}): Promise<void> {
  const untouchedCutoffMs = clock.nowMs() - RETURNED_FOLDER_RETAIN_DAYS * DAY_MS;
  for (const [worktreeRoot, removedNames] of await removedFolderNamesByRoot(journalPath, worktreeRoots)) {
    const leftoverNames = new Set<string>();
    for (const removedName of removedNames) {
      const folderPath = path.join(worktreeRoot, removedName);
      const folderStat = await fs.promises.lstat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) continue;
      if (await holdsCheckoutWithinOneLevel(folderPath) || await ledger.ownsAtOrUnder(folderPath)) continue;
      if (!(await isWholeTreeUntouchedSince(folderPath, untouchedCutoffMs))) continue;
      leftoverNames.add(removedName);
    }
    if (leftoverNames.size === 0) continue;
    const sweptNames = await pruneAgedFiles({
      directory: worktreeRoot, suffixes: [''], retainDays: RETURNED_FOLDER_RETAIN_DAYS, entryMode: 'directory',
      isRetainedId: (entryName) => !leftoverNames.has(entryName),
    });
    for (const sweptName of sweptNames) log.log(`[leftovers] deleted ${path.join(worktreeRoot, sweptName)}, a removed worktree folder that came back with no checkout in it`);
  }
}

export { sweepReturnedWorktreeFolders };
