import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../shared/text.ts';
import { cgroupAncestorPaths, cgroupLimitBytes, headroomFromReadings, parseCgroupBytes, parseCgroupV2Path, parseMemAvailableBytes } from './core/memory-admission-core.ts';
import type { CgroupLevel, MemoryReading } from './core/memory-admission-core.ts';

const CGROUP_ROOT = '/sys/fs/cgroup';
const MACOS_FREE_MEMORY_REASON = 'macOS reports only never-used pages as free, so headroom is not measured there';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readCgroupLevel(cgroupPath: string): Promise<CgroupLevel> {
  const cgroupDirectory = path.posix.join(CGROUP_ROOT, cgroupPath);
  const [memoryHighText, memoryMaxText, memoryCurrentText] = await Promise.all(
    ['memory.high', 'memory.max', 'memory.current'].map((fileName) => readTextIfPresent(path.posix.join(cgroupDirectory, fileName))),
  );
  return { limitBytes: cgroupLimitBytes(memoryHighText ?? null, memoryMaxText ?? null), currentBytes: parseCgroupBytes(memoryCurrentText ?? null) };
}

async function readLinuxHeadroom(): Promise<MemoryReading> {
  const [procSelfCgroupText, meminfoText] = await Promise.all([readTextIfPresent('/proc/self/cgroup'), readTextIfPresent('/proc/meminfo')]);
  const cgroupPath = procSelfCgroupText === null ? null : parseCgroupV2Path(procSelfCgroupText);
  const cgroupLevels = cgroupPath === null ? [] : await Promise.all(cgroupAncestorPaths(cgroupPath).map(readCgroupLevel));
  const hostAvailableBytes = meminfoText === null ? null : parseMemAvailableBytes(meminfoText);
  const headroomBytes = headroomFromReadings({ cgroupLevels, hostAvailableBytes });
  if (headroomBytes === null) return { ok: false, reason: 'neither cgroup v2 nor /proc/meminfo reported memory' };
  return { ok: true, headroomBytes };
}

export async function readMemoryHeadroom(): Promise<MemoryReading> {
  if (process.platform === 'darwin') return { ok: false, reason: MACOS_FREE_MEMORY_REASON };
  if (process.platform !== 'linux') return { ok: true, headroomBytes: os.freemem() };
  try {
    return await readLinuxHeadroom();
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}
