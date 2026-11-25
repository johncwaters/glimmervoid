import fs from 'node:fs';
import path from 'node:path';

import { canonicalizePath } from '../shared/canonical-paths.ts';
import { createCoalescedTimer } from '../shared/coalesce-timer.ts';
import { equalsIgnoringCaseOnWindows } from '../shared/paths.ts';
import { errorMessage } from '../shared/text.ts';

type StopWatching = () => void;
type ReportUnwatchable = (target: string, reason: string) => void;
type IsIgnoredFolder = (relativePath: string) => Promise<boolean>;

interface WatchOptions {
  debounceMs?: number;
  onUnwatchable?: ReportUnwatchable;
}

interface FolderEntryWatchOptions {
  onGone?: () => void;
  onUnwatchable?: ReportUnwatchable;
}

interface TreeWatchOptions extends WatchOptions {
  isIgnored?: (relativePath: string) => boolean | Promise<boolean>;
  maxFolders?: number;
}

interface TreeWalk {
  root: string;
  notify: () => void;
  isIgnoredFolder: IsIgnoredFolder;
  maxFolders: number;
  onUnwatchable: ReportUnwatchable;
  watchedRealFolders: Set<string>;
  stopped: AbortSignal;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_TREE_FOLDERS = 20_000;
const HAS_NATIVE_RECURSIVE_WATCH = process.platform === 'darwin' || process.platform === 'win32';

function ignoreUnwatchable(): void {}

async function realFolderOrSame(folder: string): Promise<string> {
  return fs.promises.realpath(folder).catch(() => folder);
}

async function isFolder(candidate: string): Promise<boolean> {
  const stats = await fs.promises.stat(candidate).catch(() => null);
  return stats?.isDirectory() ?? false;
}

async function folderIdentityOf(folder: string): Promise<string | null> {
  const stats = await fs.promises.stat(folder).catch(() => null);
  return stats?.isDirectory() ? `${stats.ino}:${stats.birthtimeMs}` : null;
}

async function nearestExistingFolder(folder: string): Promise<string> {
  if (await isFolder(folder)) return folder;
  const parent = path.dirname(folder);
  if (parent === folder) return folder;
  return nearestExistingFolder(parent);
}

interface FolderListener {
  onEntryChange: (changedName: string | null) => void;
  onGone: () => void;
}

interface SharedFolderWatch {
  watcher: fs.FSWatcher;
  listeners: Set<FolderListener>;
}

const sharedWatchByFolder = new Map<string, SharedFolderWatch>();

function openSharedFolderWatch(realFolder: string): SharedFolderWatch {
  const listeners = new Set<FolderListener>();
  const openedIdentity = folderIdentityOf(realFolder);
  const folderName = path.basename(realFolder);
  const watcher = fs.watch(realFolder, { persistent: false }, (_event, changedName) => {
    const entryName = changedName === null ? null : String(changedName);
    if (entryName === null || equalsIgnoringCaseOnWindows(entryName, folderName)) void closeIfFolderReplaced();
    for (const listener of [...listeners]) listener.onEntryChange(entryName);
  });
  const shared = { watcher, listeners };
  function close(): void {
    watcher.close();
    if (sharedWatchByFolder.get(realFolder) === shared) sharedWatchByFolder.delete(realFolder);
    const goneListeners = [...listeners];
    listeners.clear();
    for (const listener of goneListeners) listener.onGone();
  }
  async function closeIfFolderReplaced(): Promise<void> {
    const [identityAtOpen, identityNow] = await Promise.all([openedIdentity, folderIdentityOf(realFolder)]);
    if (identityNow === null || identityNow !== identityAtOpen) close();
  }
  watcher.on('error', close);
  sharedWatchByFolder.set(realFolder, shared);
  return shared;
}

function watchRealFolderEntries(realFolder: string, onEntryChange: (changedName: string | null) => void, { onGone = () => {}, onUnwatchable = ignoreUnwatchable }: FolderEntryWatchOptions = {}): StopWatching {
  let shared: SharedFolderWatch;
  try {
    shared = sharedWatchByFolder.get(realFolder) ?? openSharedFolderWatch(realFolder);
  } catch (error) {
    onUnwatchable(realFolder, errorMessage(error));
    return () => {};
  }
  const listener: FolderListener = { onEntryChange, onGone };
  shared.listeners.add(listener);
  return () => {
    if (!shared.listeners.delete(listener) || shared.listeners.size > 0) return;
    shared.watcher.close();
    if (sharedWatchByFolder.get(realFolder) === shared) sharedWatchByFolder.delete(realFolder);
  };
}

function watchPath(filePath: string, onChange: () => void, { debounceMs = DEFAULT_DEBOUNCE_MS, onUnwatchable = ignoreUnwatchable }: WatchOptions = {}): StopWatching {
  const target = path.resolve(filePath);
  const targetFolder = path.dirname(target);
  let isStopped = false;
  let armCount = 0;
  let stopCurrent: StopWatching = () => {};
  const changeTimer = createCoalescedTimer({ mode: 'leading', delayMs: debounceMs, run: () => { if (!isStopped) onChange(); } });

  async function arm(): Promise<void> {
    armCount += 1;
    const armNumber = armCount;
    stopCurrent();
    stopCurrent = () => {};
    const folder = await nearestExistingFolder(targetFolder);
    const watchedFolder = await realFolderOrSame(folder);
    if (isStopped || armNumber !== armCount) return;
    const isParent = folder === targetFolder;
    const awaitedName = isParent ? path.basename(target) : path.relative(folder, target).split(path.sep)[0];
    stopCurrent = watchRealFolderEntries(watchedFolder, (changedName) => {
      if (changedName !== null && !equalsIgnoringCaseOnWindows(path.basename(changedName), awaitedName)) return;
      if (isParent) {
        changeTimer.schedule();
        return;
      }
      void arm().then(() => changeTimer.schedule());
    }, { onGone: () => { void arm().then(() => changeTimer.schedule()); }, onUnwatchable });
  }

  void arm();
  return () => {
    isStopped = true;
    changeTimer.cancel();
    stopCurrent();
  };
}

function toSlashPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function isIgnoredUnder(walk: TreeWalk, folder: string): Promise<boolean> {
  const relativePath = path.relative(walk.root, folder);
  return relativePath === '' ? Promise.resolve(false) : walk.isIgnoredFolder(toSlashPath(relativePath));
}

async function isLinkedFolder(candidate: string): Promise<boolean> {
  const linkStats = await fs.promises.lstat(candidate).catch(() => null);
  return (linkStats?.isSymbolicLink() ?? false) && await isFolder(candidate);
}

function watchTreeByFolder(walk: TreeWalk): StopWatching {
  const watchByFolder = new Map<string, { stop: StopWatching; realFolder: string }>();
  let hasReportedCap = false;

  function forgetSubtree(folder: string): void {
    for (const [watchedFolder, watched] of watchByFolder) {
      if (watchedFolder !== folder && !watchedFolder.startsWith(`${folder}${path.sep}`)) continue;
      watched.stop();
      walk.watchedRealFolders.delete(watched.realFolder);
      watchByFolder.delete(watchedFolder);
    }
  }

  async function rewatchIfStillThere(folder: string): Promise<void> {
    forgetSubtree(folder);
    walk.notify();
    if (await isFolder(folder)) await addFolder(folder);
  }

  async function onEntryChange(folder: string, changedName: string | null): Promise<void> {
    if (changedName === null) {
      walk.notify();
      await addFolder(folder);
      return;
    }
    const changedPath = path.join(folder, changedName);
    const isChangedFolder = await isFolder(changedPath);
    if (isChangedFolder && await isIgnoredUnder(walk, changedPath)) return;
    walk.notify();
    if (!isChangedFolder) {
      forgetSubtree(changedPath);
      return;
    }
    const watched = watchByFolder.get(changedPath);
    if (watched !== undefined && watched.realFolder === await realFolderOrSame(changedPath)) return;
    forgetSubtree(changedPath);
    await addFolder(changedPath);
  }

  async function startFolder(folder: string): Promise<boolean> {
    if (watchByFolder.size >= walk.maxFolders) {
      if (!hasReportedCap) walk.onUnwatchable(folder, `more than ${walk.maxFolders} folders under ${walk.root}; the rest are not watched`);
      hasReportedCap = true;
      return false;
    }
    if (await isIgnoredUnder(walk, folder)) return false;
    const realFolder = await realFolderOrSame(folder);
    if (walk.stopped.aborted || watchByFolder.has(folder) || walk.watchedRealFolders.has(realFolder)) return false;
    walk.watchedRealFolders.add(realFolder);
    const stop = watchRealFolderEntries(realFolder, (changedName) => { void onEntryChange(folder, changedName); }, { onGone: () => { void rewatchIfStillThere(folder); }, onUnwatchable: walk.onUnwatchable });
    watchByFolder.set(folder, { stop, realFolder });
    return true;
  }

  async function addFolder(folder: string): Promise<void> {
    if (walk.stopped.aborted) return;
    if (!watchByFolder.has(folder) && !(await startFolder(folder))) return;
    const entries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childFolder = path.join(folder, entry.name);
      if (watchByFolder.has(childFolder)) continue;
      if (entry.isDirectory() || (entry.isSymbolicLink() && await isFolder(childFolder))) await addFolder(childFolder);
    }
  }

  void addFolder(walk.root);
  return () => forgetSubtree(walk.root);
}

function watchLinkedFolders(walk: TreeWalk): { followEntry: (relativePath: string) => Promise<void>; stop: StopWatching } {
  const followedLinks = new Map<string, { stop: StopWatching; realFolder: string }>();

  function linkedWalkOf(link: string): TreeWalk {
    const linkRelativePath = toSlashPath(path.relative(walk.root, link));
    return { ...walk, root: link, isIgnoredFolder: (relativePath) => walk.isIgnoredFolder(`${linkRelativePath}/${relativePath}`) };
  }

  function stopFollowingLink(link: string): void {
    followedLinks.get(link)?.stop();
    followedLinks.delete(link);
  }

  async function followEntry(relativePath: string): Promise<void> {
    const entry = path.join(walk.root, relativePath);
    const isLinked = await isLinkedFolder(entry);
    if (walk.stopped.aborted) return;
    if (!isLinked) {
      stopFollowingLink(entry);
      return;
    }
    const realFolder = await realFolderOrSame(entry);
    if (followedLinks.get(entry)?.realFolder === realFolder || await isIgnoredUnder(walk, entry)) return;
    stopFollowingLink(entry);
    const linkStopping = new AbortController();
    const stopLinkedWalk = watchTreeByFolder({ ...linkedWalkOf(entry), stopped: AbortSignal.any([walk.stopped, linkStopping.signal]) });
    followedLinks.set(entry, {
      realFolder,
      stop: () => {
        linkStopping.abort();
        stopLinkedWalk();
      },
    });
  }

  async function findLinks(folder: string): Promise<void> {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(folder, entry.name);
      if (walk.stopped.aborted || await isIgnoredUnder(walk, child)) continue;
      if (entry.isSymbolicLink()) await followEntry(path.relative(walk.root, child));
      if (entry.isDirectory()) await findLinks(child);
    }
  }

  void findLinks(walk.root);
  return {
    followEntry,
    stop: () => {
      for (const link of [...followedLinks.keys()]) stopFollowingLink(link);
    },
  };
}

function watchTreeNatively(walk: TreeWalk): StopWatching {
  let watcher: fs.FSWatcher | null = null;
  const linkedFolders = watchLinkedFolders(walk);
  async function isUnderIgnoredFolder(relativePath: string): Promise<boolean> {
    const segments = toSlashPath(relativePath).split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      if (await walk.isIgnoredFolder(segments.slice(0, depth).join('/'))) return true;
    }
    return false;
  }
  const realFolder = walk.root;
  try {
    watcher = fs.watch(realFolder, { persistent: false, recursive: true }, (_event, changedName) => {
      if (changedName === null) {
        walk.notify();
        return;
      }
      const relativePath = String(changedName);
      void isUnderIgnoredFolder(relativePath).then((isIgnored) => {
        if (isIgnored) return;
        walk.notify();
        void linkedFolders.followEntry(relativePath);
      });
    });
  } catch (error) {
    walk.onUnwatchable(walk.root, errorMessage(error));
    linkedFolders.stop();
    return () => {};
  }
  watcher.on('error', (error) => {
    walk.onUnwatchable(walk.root, errorMessage(error));
    watcher?.close();
    watcher = null;
  });
  return () => {
    watcher?.close();
    watcher = null;
    linkedFolders.stop();
  };
}

function watchTree(root: string, onChange: () => void, { debounceMs = DEFAULT_DEBOUNCE_MS, onUnwatchable = ignoreUnwatchable, isIgnored = () => false, maxFolders = DEFAULT_MAX_TREE_FOLDERS }: TreeWatchOptions = {}): StopWatching {
  const resolvedRoot = path.resolve(root);
  const watchStopping = new AbortController();
  let stopTreeWatch: StopWatching | null = null;
  let watchedRootIdentity: string | null = null;
  let followCount = 0;
  const changeTimer = createCoalescedTimer({ mode: 'leading', delayMs: debounceMs, run: () => { if (!watchStopping.signal.aborted) onChange(); } });
  function isIgnoredFolder(relativePath: string): Promise<boolean> {
    return Promise.resolve(isIgnored(relativePath)).catch(() => false);
  }
  function stopFollowingTree(): void {
    stopTreeWatch?.();
    stopTreeWatch = null;
    watchedRootIdentity = null;
  }
  async function followRoot(): Promise<void> {
    followCount += 1;
    const followNumber = followCount;
    const [rootIdentity, watchedRoot] = await Promise.all([folderIdentityOf(resolvedRoot), realFolderOrSame(resolvedRoot)]);
    if (watchStopping.signal.aborted || followNumber !== followCount) return;
    if (stopTreeWatch !== null && rootIdentity === watchedRootIdentity) return;
    stopFollowingTree();
    if (rootIdentity === null) return;
    watchedRootIdentity = rootIdentity;
    const treeStopping = new AbortController();
    const walk: TreeWalk = { root: watchedRoot, notify: () => changeTimer.schedule(), isIgnoredFolder, maxFolders, onUnwatchable, watchedRealFolders: new Set(), stopped: treeStopping.signal };
    const stopWalk = HAS_NATIVE_RECURSIVE_WATCH ? watchTreeNatively(walk) : watchTreeByFolder(walk);
    stopTreeWatch = () => {
      treeStopping.abort();
      stopWalk();
    };
  }
  const stopRootWatch = watchPath(resolvedRoot, () => {
    changeTimer.schedule();
    void followRoot();
  }, { debounceMs, onUnwatchable });
  void followRoot();
  return () => {
    watchStopping.abort();
    changeTimer.cancel();
    stopRootWatch();
    stopFollowingTree();
  };
}

function watchFolderEntries(folder: string, onEntryChange: (changedName: string | null) => void, options: FolderEntryWatchOptions = {}): StopWatching {
  return watchRealFolderEntries(canonicalizePath(folder), onEntryChange, options);
}

export { watchFolderEntries, watchPath, watchTree };
export type { StopWatching };
