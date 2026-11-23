import fsp from 'node:fs/promises';
import path from 'node:path';
import { comparableDirectoryPath } from '../shared/canonical-paths.ts';
import { clock } from '../shared/clock.ts';
import { isPathInside } from '../shared/paths.ts';
import { errorMessage } from '../shared/text.ts';
import { CACHEDIR_TAG_SIGNATURE, hasCacheDirSignature, orderIdleWorktrees } from './core/disk-headroom-core.ts';
import { SESSION_WORK_RECENCY_FLOOR_MS as BUILD_CACHE_UNTOUCHED_FLOOR_MS } from './core/removal-guard-core.ts';
import { runGit } from './git/git-exec.ts';
import { recordSweptPath } from './removal-journal.ts';

const CACHEDIR_TAG_FILE = 'CACHEDIR.TAG';
const MAX_SEARCH_DEPTH = 4;
const TOUCH_PROBE_DEPTH = 2;
const SKIPPED_FOLDER_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

async function hasValidCacheDirTag(folderPath: string): Promise<boolean> {
  const tagFile = await fsp.open(path.join(folderPath, CACHEDIR_TAG_FILE), 'r').catch(() => null);
  if (tagFile === null) return false;
  try {
    const head = Buffer.alloc(CACHEDIR_TAG_SIGNATURE.length);
    const { bytesRead } = await tagFile.read(head, 0, head.length, 0);
    return hasCacheDirSignature(head.subarray(0, bytesRead).toString('latin1'));
  } catch {
    return false;
  } finally {
    await tagFile.close().catch(() => {});
  }
}

async function findTaggedCacheFolders(worktreePath: string): Promise<string[]> {
  const taggedFolders: string[] = [];
  const unreadFolders: { folderPath: string; depth: number }[] = [{ folderPath: worktreePath, depth: 0 }];
  while (unreadFolders.length > 0) {
    const current = unreadFolders.pop();
    if (current === undefined) break;
    const entries = await fsp.readdir(current.folderPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_FOLDER_NAMES.has(entry.name)) continue;
      const childPath = path.join(current.folderPath, entry.name);
      if (await hasValidCacheDirTag(childPath)) {
        taggedFolders.push(childPath);
        continue;
      }
      if (current.depth + 1 < MAX_SEARCH_DEPTH) unreadFolders.push({ folderPath: childPath, depth: current.depth + 1 });
    }
  }
  return taggedFolders;
}

function isHeldByLiveSession(worktreePath: string, livePaths: ReadonlySet<string>): boolean {
  return [...livePaths].some((livePath) => isPathInside(worktreePath, livePath) || isPathInside(livePath, worktreePath));
}

async function newestMtimeMsNear(folderPath: string): Promise<number | null> {
  const folderStat = await fsp.lstat(folderPath).catch(() => null);
  if (folderStat === null) return null;
  let newestMtimeMs = folderStat.mtimeMs;
  const unreadFolders = [{ currentPath: folderPath, depth: 0 }];
  while (unreadFolders.length > 0) {
    const current = unreadFolders.pop();
    if (current === undefined) break;
    const entries = await fsp.readdir(current.currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current.currentPath, entry.name);
      const entryStat = await fsp.lstat(entryPath).catch(() => null);
      if (entryStat === null) continue;
      newestMtimeMs = Math.max(newestMtimeMs, entryStat.mtimeMs);
      if (entry.isDirectory() && current.depth + 1 < TOUCH_PROBE_DEPTH) unreadFolders.push({ currentPath: entryPath, depth: current.depth + 1 });
    }
  }
  return newestMtimeMs;
}

async function holdsTrackedFiles(worktreePath: string, cacheFolder: string): Promise<boolean> {
  const listing = await runGit(['ls-files', '-z', '--', path.relative(worktreePath, cacheFolder)], { cwd: worktreePath });
  return !listing.ok || listing.out.length > 0;
}

async function isSafeToReclaim(worktreePath: string, cacheFolder: string, nowMs: number): Promise<boolean> {
  const newestMtimeMs = await newestMtimeMsNear(cacheFolder);
  if (newestMtimeMs === null || nowMs - newestMtimeMs < BUILD_CACHE_UNTOUCHED_FLOOR_MS) return false;
  return !(await holdsTrackedFiles(worktreePath, cacheFolder));
}

async function readLinkedWorktree(worktreePath: string): Promise<{ gitdir: string; lastActivityMs: number } | null> {
  const dotGitPath = path.join(worktreePath, '.git');
  const dotGitStat = await fsp.lstat(dotGitPath).catch(() => null);
  if (dotGitStat === null || !dotGitStat.isFile()) return null;
  const gitdirMatch = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(dotGitPath, 'utf8').catch(() => ''));
  if (gitdirMatch === null) return null;
  const gitdir = await comparableDirectoryPath(path.resolve(worktreePath, gitdirMatch[1].trim()));
  const indexStat = await fsp.stat(path.join(gitdir, 'index')).catch(() => null);
  return { gitdir, lastActivityMs: (indexStat ?? dotGitStat).mtimeMs };
}

async function listWorktreesUnder(worktreeRoots: readonly string[], projectPaths: readonly string[], livePaths: ReadonlySet<string>): Promise<{ path: string; lastActivityMs: number; isLive: boolean }[]> {
  const worktrees: { path: string; lastActivityMs: number; isLive: boolean }[] = [];
  const comparableProjectPaths = await Promise.all(projectPaths.map((projectPath) => comparableDirectoryPath(projectPath)));
  for (const worktreeRoot of worktreeRoots) {
    const entries = await fsp.readdir(worktreeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const worktreePath = await comparableDirectoryPath(path.join(worktreeRoot, entry.name));
      const linkedWorktree = await readLinkedWorktree(worktreePath);
      if (linkedWorktree === null) continue;
      if (!comparableProjectPaths.some((projectPath) => isPathInside(projectPath, linkedWorktree.gitdir))) continue;
      const { lastActivityMs } = linkedWorktree;
      const isLive = isHeldByLiveSession(worktreePath, livePaths);
      worktrees.push({ path: worktreePath, lastActivityMs, isLive });
    }
  }
  return worktrees;
}

async function reclaimBuildCaches({ worktreeRoots, projectPaths, liveWorktreePaths, isStillShort, log = console }: {
  worktreeRoots: readonly string[];
  projectPaths: readonly string[];
  liveWorktreePaths: () => Promise<Set<string>>;
  isStillShort: () => Promise<boolean>;
  log?: Pick<Console, 'warn'>;
}): Promise<{ reclaimedFolders: string[] }> {
  const reclaimedFolders: string[] = [];
  const idleWorktreePaths = orderIdleWorktrees(await listWorktreesUnder(worktreeRoots, projectPaths, await liveWorktreePaths()));
  for (const worktreePath of idleWorktreePaths) {
    if (!(await isStillShort())) break;
    if (isHeldByLiveSession(worktreePath, await liveWorktreePaths())) continue;
    for (const cacheFolder of await findTaggedCacheFolders(worktreePath)) {
      if (!(await isSafeToReclaim(worktreePath, cacheFolder, clock.nowMs()))) continue;
      if (!(await recordSweptPath({ cause: 'build-cache', kind: 'folder', path: cacheFolder, checksPassed: ['cachedir-tag', 'no-live-session', 'untouched-24h', 'untracked'], log }))) continue;
      try {
        await fsp.rm(cacheFolder, { recursive: true, force: true });
        reclaimedFolders.push(cacheFolder);
      } catch (error) {
        log.warn(`[disk-headroom] could not delete build cache ${cacheFolder}: ${errorMessage(error)}`);
      }
    }
  }
  return { reclaimedFolders };
}

async function folderSizeAtLeast(folderPath: string, maxEntries: number): Promise<{ bytes: number; isCapped: boolean }> {
  let bytes = 0;
  let entriesRead = 0;
  const unreadFolders = [folderPath];
  while (unreadFolders.length > 0) {
    const currentFolder = unreadFolders.pop();
    if (currentFolder === undefined) break;
    const entries = await fsp.readdir(currentFolder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      entriesRead += 1;
      if (entriesRead > maxEntries) return { bytes, isCapped: true };
      const entryPath = path.join(currentFolder, entry.name);
      if (entry.isDirectory()) {
        unreadFolders.push(entryPath);
        continue;
      }
      const entryStat = await fsp.lstat(entryPath).catch(() => null);
      bytes += entryStat?.size ?? 0;
    }
  }
  return { bytes, isCapped: false };
}

export { folderSizeAtLeast, reclaimBuildCaches };
