import fs from 'node:fs';
import path from 'node:path';

import { runGit } from './git/git-exec.ts';
import { watchTree } from './path-watch.ts';
import type { StopWatching } from './path-watch.ts';

const GIT_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const EDIT_DEBOUNCE_MS = 2_000;
const UNWATCHABLE_RECHECK_MS = 4_000;

interface GitFolderListing {
  ignoredFolders: Set<string>;
  keptFolders: Set<string>;
}

function slashEntriesOf(gitListing: string): string[] {
  return gitListing.split('\0').filter((entry) => entry !== '').map((entry) => entry.replace(/\/$/, ''));
}

function foldersHoldingFiles(filePaths: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const filePath of filePaths) {
    for (let folder = path.posix.dirname(filePath); folder !== '.' && !folders.has(folder); folder = path.posix.dirname(folder)) folders.add(folder);
  }
  return folders;
}

async function readGitFolderListing(root: string): Promise<GitFolderListing | null> {
  const [ignored, kept] = await Promise.all([
    runGit(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: root, maxBuffer: GIT_LIST_MAX_BUFFER_BYTES, trim: false }),
    runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: GIT_LIST_MAX_BUFFER_BYTES, trim: false }),
  ]);
  if (!ignored.ok || !kept.ok) return null;
  const listedFolders = ignored.out.split('\0').filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1));
  const confirmed = listedFolders.length === 0
    ? { ok: true, out: '' }
    : await runGit(['check-ignore', '-z', '--stdin'], { cwd: root, input: listedFolders.map((folder) => `${folder}\0`).join(''), maxBuffer: GIT_LIST_MAX_BUFFER_BYTES, trim: false });
  const ignoredFolders = new Set(confirmed.ok ? slashEntriesOf(confirmed.out) : []);
  return { ignoredFolders, keptFolders: foldersHoldingFiles(slashEntriesOf(kept.out)) };
}

async function isSymbolicLink(candidate: string): Promise<boolean> {
  const linkStats = await fs.promises.lstat(candidate).catch(() => null);
  return linkStats?.isSymbolicLink() ?? false;
}

function createIgnoredFolderJudge(root: string, listing: GitFolderListing): (relativeFolder: string) => Promise<boolean> {
  const isIgnoredByNewFolder = new Map<string, Promise<boolean>>();
  let previousGitAsk: Promise<unknown> = Promise.resolve();
  return async (relativeFolder) => {
    if (relativeFolder.split('/').includes('.git')) return true;
    if (await isSymbolicLink(path.join(root, relativeFolder))) return true;
    if (listing.keptFolders.has(relativeFolder)) return false;
    if (listing.ignoredFolders.has(relativeFolder)) return true;
    const known = isIgnoredByNewFolder.get(relativeFolder);
    if (known) return known;
    const isIgnoredByGit = previousGitAsk.then(() => runGit(['check-ignore', '-q', '--', relativeFolder], { cwd: root })).then((checkIgnore) => checkIgnore.ok);
    previousGitAsk = isIgnoredByGit.catch(() => false);
    isIgnoredByNewFolder.set(relativeFolder, isIgnoredByGit);
    return isIgnoredByGit;
  };
}

function followWorkingTree(root: string, onEdit: () => void, log: Pick<Console, 'warn'> = console): StopWatching {
  let stopTree: StopWatching = () => {};
  let recheckTimer: ReturnType<typeof setInterval> | null = null;
  let isStopped = false;

  async function recheckWhileUnwatchable(target: string, reason: string): Promise<void> {
    const isTargetGone = await fs.promises.stat(target).then(() => false, () => true);
    if (isTargetGone || recheckTimer !== null || isStopped) return;
    log.warn(`[worktree] ${target} cannot be followed (${reason}); rechecking ${root} every ${UNWATCHABLE_RECHECK_MS / 1000} s`);
    recheckTimer = setInterval(onEdit, UNWATCHABLE_RECHECK_MS);
    recheckTimer.unref();
  }

  void readGitFolderListing(root).then((listing) => {
    if (isStopped) return;
    if (listing === null) {
      void recheckWhileUnwatchable(root, 'git could not list its ignored folders');
      return;
    }
    stopTree = watchTree(root, onEdit, { debounceMs: EDIT_DEBOUNCE_MS, isIgnored: createIgnoredFolderJudge(root, listing), onUnwatchable: (target, reason) => { void recheckWhileUnwatchable(target, reason); } });
  });

  return () => {
    isStopped = true;
    stopTree();
    if (recheckTimer !== null) clearInterval(recheckTimer);
    recheckTimer = null;
  };
}

export { followWorkingTree };
