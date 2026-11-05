import fs from 'node:fs';
import path from 'node:path';

import { configSiblingPath } from './pairings-store.ts';
import { pruneAgedFiles } from './prune-files.ts';
import { pruneLeftoverSessionTempFolders } from './session-temp/session-temp.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../shared/timer-deps.ts';
import type { ClearIntervalFn, SetIntervalFn } from '../shared/timer-deps.ts';

const RETIRED_SHOWN_FOLDER_NAME = 'shown';
const RETIRED_SHOWN_INDEX_FILENAME = 'index.json';
const RETIRED_SHOWN_STORE_FILE_RE = /^(index\.json(\.[0-9a-f]{8}\.tmp)?|\.incoming-[0-9a-f]{16}|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.(png|jpg|gif|webp|svg|mp4|webm|html)(\.thumb\.webp)?)$/;
const UPLOAD_RETAIN_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isMissingOrNotEmpty(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'ENOTEMPTY';
}

async function removeRetiredShownSessionFolder(sessionFolder: string): Promise<void> {
  const fileNames = await fs.promises.readdir(sessionFolder);
  if (!fileNames.includes(RETIRED_SHOWN_INDEX_FILENAME)) return;
  const storeFileNames = fileNames.filter((fileName) => RETIRED_SHOWN_STORE_FILE_RE.test(fileName));
  await Promise.all(storeFileNames.map((fileName) => fs.promises.rm(path.join(sessionFolder, fileName), { force: true })));
  await fs.promises.rmdir(sessionFolder).catch((error: NodeJS.ErrnoException) => { if (!isMissingOrNotEmpty(error)) throw error; });
}

async function removeRetiredShownFiles(shownRoot: string): Promise<void> {
  const entries = await fs.promises.readdir(shownRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory()) await removeRetiredShownSessionFolder(path.join(shownRoot, entry.name));
  }
  await fs.promises.rmdir(shownRoot).catch((error: NodeJS.ErrnoException) => { if (!isMissingOrNotEmpty(error)) throw error; });
}

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
    await pruneLeftoverSessionTempFolders(path.dirname(uploadsRoot), retainedSessionIds);
  }
  async function start(): Promise<void> {
    if (timer) return;
    await prune();
    timer = setIntervalFn(() => { void prune(); }, PRUNE_INTERVAL_MS);
    unrefTimer(timer);
    await removeRetiredShownFiles(configSiblingPath(configPath, RETIRED_SHOWN_FOLDER_NAME));
  }
  function stop(): void {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }
  return { start, stop, prune };
}

export { createUploadsWiring };
