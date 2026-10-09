import fs from 'node:fs';

import { configSiblingPath } from './pairings-store.ts';
import { pruneAgedFiles } from './prune-files.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../shared/timer-deps.ts';
import type { ClearIntervalFn, SetIntervalFn } from '../shared/timer-deps.ts';

const UPLOAD_RETAIN_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createUploadsWiring({
  configPath,
  liveSessionIds,
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn,
  clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
}: {
  configPath: string | null;
  liveSessionIds: () => Set<string>;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
}) {
  const uploadsRoot = configSiblingPath(configPath, 'uploads');
  let timer: NodeJS.Timeout | null = null;
  async function prune(): Promise<void> {
    const retainedSessionIds = liveSessionIds();
    await pruneAgedFiles({
      directory: uploadsRoot,
      suffixes: [''],
      retainDays: UPLOAD_RETAIN_DAYS,
      entryMode: 'directory',
      isRetainedId: (id) => retainedSessionIds.has(id),
      fsPromises: fs.promises,
    });
  }
  async function start(): Promise<void> {
    if (timer) return;
    await prune();
    timer = setIntervalFn(() => { void prune(); }, PRUNE_INTERVAL_MS);
    unrefTimer(timer);
  }
  function stop(): void {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }
  return { start, stop, prune };
}

export { createUploadsWiring };
