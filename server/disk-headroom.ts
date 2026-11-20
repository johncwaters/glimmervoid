import fsp from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../shared/text.ts';
import { diskAlertStep } from './core/disk-headroom-core.ts';
import type { DiskReading } from './core/disk-headroom-core.ts';

const DISK_NOTIFY_NAME = 'Disk space';
const DISK_NOTIFY_CATEGORY = 'disk-space';
const DEFAULT_READ_EVERY_MS = 60_000;

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

function startDiskAlerts({ watchedPaths, reserveBytes, notify, readEveryMs = DEFAULT_READ_EVERY_MS, log = console }: {
  watchedPaths: () => string[];
  reserveBytes: () => number;
  notify: (name: string, category: string, message: string) => void;
  readEveryMs?: number;
  log?: Pick<Console, 'warn'>;
}): { stop(): void; check(): Promise<void> } {
  const shortFilesystemIds = new Set<string>();
  let lastCheck: Promise<void> = Promise.resolve();

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
      if (step.isShort) shortFilesystemIds.add(reading.filesystemId);
      if (!step.isShort) shortFilesystemIds.delete(reading.filesystemId);
      if (step.message !== null) notify(DISK_NOTIFY_NAME, DISK_NOTIFY_CATEGORY, step.message);
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
