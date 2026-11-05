import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PACK_FILE_NAME } from '../../shared/contracts/pack.ts';
import type { PackOnDisk } from '../../shared/contracts/pack.ts';
import { canonicalizePath } from '../../shared/canonical-paths.ts';
import { errorMessage } from '../../shared/text.ts';
import { PACKS_DIR_NAME, packDirsUnder, readPackDir } from './pack-files.ts';

const PACK_RELOAD_DEBOUNCE_MS = 300;

type PackRead = Awaited<ReturnType<typeof readPackDir>>;
type PackStoreLogger = { warn: (...parts: unknown[]) => void };
type PackSnapshot = { packs: PackOnDisk[]; warnings: string[] };

type PackStore = EventEmitter & {
  start(): Promise<void>;
  stop(): void;
  setListedPaths(listedPaths: readonly string[]): void;
  snapshot(): PackSnapshot;
  refresh(): Promise<PackSnapshot>;
};

export function createPackStore({ homeDir, env, log, reloadDebounceMs = PACK_RELOAD_DEBOUNCE_MS }: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  log: PackStoreLogger;
  reloadDebounceMs?: number;
}): PackStore {
  const emitter = new EventEmitter();
  const packsDir = path.join(homeDir, PACKS_DIR_NAME);
  const readsByDir = new Map<string, PackRead>();
  const reloadTimersByDir = new Map<string, NodeJS.Timeout>();
  const listedWatchersByDir = new Map<string, fs.FSWatcher | null>();
  let homePackDirs: string[] = [];
  let homeWarning: string | null = null;
  let homeWatcher: fs.FSWatcher | null = null;
  let isStopped = false;

  function watchQuietly(target: string, onChange: (changedName: string | null) => void, isRecursive: boolean): fs.FSWatcher | null {
    try {
      const watcher = fs.watch(canonicalizePath(target), { recursive: isRecursive }, (_event, changedName) => onChange(changedName === null ? null : String(changedName)));
      watcher.on('error', (error) => log.warn(`[packs] stopped watching ${target}: ${errorMessage(error)}`));
      return watcher;
    } catch (error) {
      const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      if (!isMissing) log.warn(`[packs] could not watch ${target}: ${errorMessage(error)}`);
      return null;
    }
  }

  async function rereadPack(packDir: string): Promise<void> {
    const isListed = listedWatchersByDir.has(packDir);
    const isUnderHome = path.dirname(packDir) === packsDir;
    const hasManifest = await fs.promises.access(path.join(packDir, PACK_FILE_NAME)).then(() => true, () => false);
    if (isStopped) return;
    if (isUnderHome) homePackDirs = hasManifest ? [...new Set([...homePackDirs, packDir])].sort() : homePackDirs.filter((dir) => dir !== packDir);
    if (!hasManifest && !isListed) {
      readsByDir.delete(packDir);
      emitter.emit('changed');
      return;
    }
    readsByDir.set(packDir, await readPackDir(packDir, env));
    if (!isStopped) emitter.emit('changed');
  }

  function scheduleReread(packDir: string): void {
    const pending = reloadTimersByDir.get(packDir);
    if (pending) clearTimeout(pending);
    reloadTimersByDir.set(packDir, setTimeout(() => {
      reloadTimersByDir.delete(packDir);
      void rereadPack(packDir);
    }, reloadDebounceMs));
  }

  async function refresh(): Promise<PackSnapshot> {
    const found = await packDirsUnder(homeDir);
    const knownDirs = [...new Set([...found.packDirs, ...listedWatchersByDir.keys()])];
    const freshReads = await Promise.all(knownDirs.map(async (packDir) => [packDir, await readPackDir(packDir, env)] as const));
    if (isStopped) return snapshot();
    homeWarning = found.warning;
    homePackDirs = found.packDirs;
    readsByDir.clear();
    for (const [packDir, read] of freshReads) readsByDir.set(packDir, read);
    return snapshot();
  }

  async function rescanHomePacks(): Promise<void> {
    await refresh();
    if (!isStopped) emitter.emit('changed');
  }

  function onHomePacksChange(changedName: string | null): void {
    const topSegment = changedName?.split(/[\\/]/)[0] ?? '';
    if (topSegment === '') {
      void rescanHomePacks();
      return;
    }
    scheduleReread(path.join(packsDir, topSegment));
  }

  function watchHomePacks(): void {
    homeWatcher?.close();
    homeWatcher = watchQuietly(packsDir, onHomePacksChange, true);
    if (homeWatcher) return;
    homeWatcher = watchQuietly(homeDir, (changedName) => {
      if (changedName !== PACKS_DIR_NAME) return;
      watchHomePacks();
      void rescanHomePacks();
    }, false);
  }

  function setListedPaths(listedPaths: readonly string[]): void {
    const wantedDirs = new Set(listedPaths.map((listedPath) => path.resolve(homeDir, listedPath)));
    for (const [packDir, watcher] of listedWatchersByDir) {
      if (wantedDirs.has(packDir)) continue;
      watcher?.close();
      listedWatchersByDir.delete(packDir);
      if (!homePackDirs.includes(packDir)) readsByDir.delete(packDir);
      emitter.emit('changed');
    }
    for (const packDir of wantedDirs) {
      if (listedWatchersByDir.has(packDir) || isStopped) continue;
      listedWatchersByDir.set(packDir, watchQuietly(packDir, () => scheduleReread(packDir), true));
      void rereadPack(packDir);
    }
  }

  function snapshot(): PackSnapshot {
    const packs: PackOnDisk[] = [];
    const warnings = homeWarning === null ? [] : [homeWarning];
    for (const packDir of [...new Set([...homePackDirs, ...listedWatchersByDir.keys()])]) {
      const read = readsByDir.get(packDir);
      if (!read) continue;
      if (!read.ok) {
        warnings.push(`The pack at ${packDir} was skipped: ${read.errors[0] ?? 'unreadable'}`);
        continue;
      }
      if (packs.some((loaded) => loaded.header.name === read.pack.header.name)) {
        warnings.push(`The pack at ${packDir} was skipped: another pack is already named '${read.pack.header.name}'`);
        continue;
      }
      packs.push(read.pack);
    }
    return { packs, warnings };
  }

  async function start(): Promise<void> {
    watchHomePacks();
    await rescanHomePacks();
  }

  function stop(): void {
    isStopped = true;
    homeWatcher?.close();
    for (const watcher of listedWatchersByDir.values()) watcher?.close();
    for (const timer of reloadTimersByDir.values()) clearTimeout(timer);
    listedWatchersByDir.clear();
    reloadTimersByDir.clear();
    emitter.removeAllListeners();
  }

  return Object.assign(emitter, { start, stop, setListedPaths, snapshot, refresh });
}
