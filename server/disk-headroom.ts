import fsp from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../shared/text.ts';
import { clock } from '../shared/clock.ts';
import { reclaimBuildCaches } from './build-cache-reclaim.ts';
import { diskAlertStep, isDiskShort, isReclaimDue, largestSessionTempNotice, reclaimNotice } from './core/disk-headroom-core.ts';
import type { DiskReading, SessionTempUse } from './core/disk-headroom-core.ts';

const DISK_NOTIFY_NAME = 'Disk space';
const DISK_NOTIFY_CATEGORY = 'disk-space';
const DEFAULT_READ_EVERY_MS = 60_000;
const RECLAIM_COOLDOWN_MS = 30 * 60_000;
const MAX_LISTED_SESSION_TEMP_FOLDERS = 3;
const SESSION_TEMP_SIZE_ENTRY_CAP = 200_000;

async function nearestExistingDirectory(startPath: string): Promise<string | null> {
  let candidate = path.resolve(startPath);
  for (;;) {
    const stats = await fsp.stat(candidate).catch(() => null);
    if (stats?.isDirectory()) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function readDiskHeadroom(targetPath: string): Promise<DiskReading> {
  try {
    const directory = await nearestExistingDirectory(targetPath);
    if (directory === null) return { ok: false, reason: `no existing folder above ${targetPath}` };
    const [filesystem, directoryStats] = await Promise.all([fsp.statfs(directory), fsp.stat(directory)]);
    return {
      ok: true,
      freeBytes: filesystem.bavail * filesystem.bsize,
      totalBytes: filesystem.blocks * filesystem.bsize,
      filesystemId: String(directoryStats.dev),
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

interface BuildCacheReclaimDeps {
  worktreeRoots: () => string[];
  projectPaths: () => string[];
  liveWorktreePaths: () => Promise<Set<string>>;
}

async function worktreeRootsOnFilesystem(worktreeRoots: readonly string[], filesystemId: string): Promise<string[]> {
  const rootsOnFilesystem: string[] = [];
  for (const worktreeRoot of new Set(worktreeRoots)) {
    const rootStats = await fsp.stat(worktreeRoot).catch(() => null);
    if (rootStats !== null && String(rootStats.dev) === filesystemId) rootsOnFilesystem.push(worktreeRoot);
  }
  return rootsOnFilesystem;
}

function startDiskAlerts({ watchedPaths, reserveBytes, notify, reclaim, measureSessionTemp, readEveryMs = DEFAULT_READ_EVERY_MS, log = console }: {
  watchedPaths: () => string[];
  reserveBytes: () => number;
  notify: (name: string, category: string, message: string) => void;
  reclaim?: BuildCacheReclaimDeps;
  measureSessionTemp?: (maxEntriesPerFolder: number) => Promise<SessionTempUse[]>;
  readEveryMs?: number;
  log?: Pick<Console, 'warn'>;
}): { stop(): void; check(): Promise<void> } {
  const shortFilesystemIds = new Set<string>();
  const lastReclaimAtMsByFilesystemId = new Map<string, number>();
  let lastCheck: Promise<void> = Promise.resolve();

  async function reclaimWhileShort(watchedPath: string, reading: Extract<DiskReading, { ok: true }>, reserve: number, isNewlyShort: boolean): Promise<{ freedBytes: number; reclaimedFolderCount: number; isStillShort: boolean } | null> {
    if (reclaim === undefined) return null;
    const lastReclaimAtMs = lastReclaimAtMsByFilesystemId.get(reading.filesystemId) ?? null;
    if (!isReclaimDue(isNewlyShort, lastReclaimAtMs, clock.nowMs(), RECLAIM_COOLDOWN_MS)) return null;
    lastReclaimAtMsByFilesystemId.set(reading.filesystemId, clock.nowMs());
    const { reclaimedFolders } = await reclaimBuildCaches({
      worktreeRoots: await worktreeRootsOnFilesystem(reclaim.worktreeRoots(), reading.filesystemId),
      projectPaths: reclaim.projectPaths(),
      liveWorktreePaths: reclaim.liveWorktreePaths,
      isStillShort: async () => isDiskShort(await readDiskHeadroom(watchedPath), reserve),
      log,
    });
    const after = await readDiskHeadroom(watchedPath);
    if (!after.ok) return { freedBytes: 0, reclaimedFolderCount: reclaimedFolders.length, isStillShort: true };
    return { freedBytes: after.freeBytes - reading.freeBytes, reclaimedFolderCount: reclaimedFolders.length, isStillShort: isDiskShort(after, reserve) };
  }

  async function checkOnce(): Promise<void> {
    const reserve = reserveBytes();
    if (reserve <= 0) {
      shortFilesystemIds.clear();
      return;
    }
    const readFilesystemIds = new Set<string>();
    for (const watchedPath of new Set(watchedPaths())) {
      const reading = await readDiskHeadroom(watchedPath);
      if (!reading.ok || readFilesystemIds.has(reading.filesystemId)) continue;
      readFilesystemIds.add(reading.filesystemId);
      const step = diskAlertStep(watchedPath, reading, reserve, shortFilesystemIds.has(reading.filesystemId));
      if (!step.isShort) {
        shortFilesystemIds.delete(reading.filesystemId);
        continue;
      }
      const reclaimed = await reclaimWhileShort(watchedPath, reading, reserve, step.message !== null);
      const reclaimedMessage = reclaimed !== null && reclaimed.reclaimedFolderCount > 0 ? reclaimNotice(reclaimed.freedBytes, reclaimed.reclaimedFolderCount) : null;
      const isStillShort = reclaimed?.isStillShort ?? true;
      if (isStillShort) shortFilesystemIds.add(reading.filesystemId);
      if (!isStillShort) shortFilesystemIds.delete(reading.filesystemId);
      const shortMessage = isStillShort ? step.message : null;
      const sessionTempMessage = shortMessage !== null && measureSessionTemp !== undefined
        ? largestSessionTempNotice(await measureSessionTemp(SESSION_TEMP_SIZE_ENTRY_CAP), MAX_LISTED_SESSION_TEMP_FOLDERS)
        : null;
      const message = [shortMessage, reclaimedMessage, sessionTempMessage].filter((part) => part !== null).join(' ');
      if (message !== '') notify(DISK_NOTIFY_NAME, DISK_NOTIFY_CATEGORY, message);
    }
  }

  function check(): Promise<void> {
    lastCheck = lastCheck.then(checkOnce).catch((checkError: unknown) => log.warn(`[disk-headroom] check failed: ${errorMessage(checkError)}`));
    return lastCheck;
  }

  void check();
  const interval = setInterval(() => { void check(); }, readEveryMs);
  interval.unref();
  return { stop: () => clearInterval(interval), check };
}

export { readDiskHeadroom, startDiskAlerts };
