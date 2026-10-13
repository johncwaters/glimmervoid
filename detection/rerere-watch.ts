import fs from 'node:fs';
import path from 'node:path';

import { createWatchDebounce } from './watch-debounce.ts';
import type { WatchDebounce } from './watch-debounce.ts';

const RR_CACHE_DIR = 'rr-cache';
const RESOLUTION_FILE_PREFIX = 'postimage';
const CACHE_ROOT = '.';

interface RerereCacheScan {
  resolutions: Set<string>;
  unresolvedEntries: string[];
}

async function scanRerereCache(cacheDir: string): Promise<RerereCacheScan> {
  const cachedPaths = await fs.promises.readdir(cacheDir, { recursive: true }).catch(() => []);
  const entries = cachedPaths.filter((cachedPath) => path.dirname(cachedPath) === CACHE_ROOT);
  const resolutionFiles = cachedPaths.filter((cachedPath) => (
    path.dirname(cachedPath) !== CACHE_ROOT && path.basename(cachedPath).startsWith(RESOLUTION_FILE_PREFIX)
  ));
  const resolvedEntries = new Set(resolutionFiles.map((resolutionFile) => path.dirname(resolutionFile)));
  return {
    resolutions: new Set(resolutionFiles),
    unresolvedEntries: entries.filter((entry) => !resolvedEntries.has(entry)),
  };
}

function createRerereWatcher(
  { commonGitDir, onChange, debounceMs = 400 }:
    { commonGitDir: string | null | undefined; onChange: () => void; debounceMs?: number },
) {
  const cacheDir = commonGitDir ? path.join(commonGitDir, RR_CACHE_DIR) : null;
  const inner = createWatchDebounce({ onChange: reportNewResolutions, debounceMs });
  const entryWatches = new Map<string, WatchDebounce>();
  let knownResolutions: Set<string> | null = null;

  let outer: WatchDebounce | null = null;

  function watchUnresolvedEntries(watchedCacheDir: string, unresolvedEntries: readonly string[]): void {
    for (const [entry, entryWatch] of entryWatches) {
      if (unresolvedEntries.includes(entry)) continue;
      entryWatch.stop();
      entryWatches.delete(entry);
    }
    for (const entry of unresolvedEntries) {
      if (entryWatches.has(entry)) continue;
      const entryWatch = createWatchDebounce({ onChange: reportNewResolutions, debounceMs });
      if (entryWatch.watch(path.join(watchedCacheDir, entry))) entryWatches.set(entry, entryWatch);
    }
  }

  async function scanForNewResolutions(): Promise<void> {
    if (!cacheDir || inner.stopped) return;
    const { resolutions, unresolvedEntries } = await scanRerereCache(cacheDir);
    if (inner.stopped) return;
    const previouslyKnown = knownResolutions;
    knownResolutions = resolutions;
    watchUnresolvedEntries(cacheDir, unresolvedEntries);
    if (previouslyKnown === null) return;
    if ([...resolutions].some((resolution) => !previouslyKnown.has(resolution))) onChange();
  }

  function reportNewResolutions(): void {
    scanForNewResolutions().catch(() => {});
  }

  function watchCache(): boolean {
    if (!cacheDir) return false;
    return inner.watch(cacheDir);
  }

  function startOuter(): boolean {
    outer = createWatchDebounce({
      onChange: () => {
        if (!watchCache()) return;
        knownResolutions = new Set();
        reportNewResolutions();
        if (outer) outer.stop();
      },
      debounceMs,
    });
    const outerWatch = outer;
    if (!outerWatch || !commonGitDir) return false;
    return outerWatch.watch(commonGitDir, (_evt, filename) => {
      if (!filename || filename === RR_CACHE_DIR) outerWatch.fire();
    });
  }

  function start(): boolean {
    if (inner.active || inner.stopped || !cacheDir) return inner.active;
    let exists: boolean;
    try { exists = fs.existsSync(cacheDir); } catch { exists = false; }
    if (!exists) return startOuter();
    const isWatchingCache = watchCache();
    if (isWatchingCache) reportNewResolutions();
    return isWatchingCache;
  }

  function stop(): void {
    if (outer) outer.stop();
    inner.stop();
    for (const entryWatch of entryWatches.values()) entryWatch.stop();
    entryWatches.clear();
  }

  return { start, stop, get active() { return inner.active || Boolean(outer?.active); } };
}

export { createRerereWatcher, RR_CACHE_DIR };
