import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clock } from '../shared/clock.ts';
import { isMissingFileError } from '../shared/text.ts';
import {
  HANDOFF_FROM_PID_ENV,
  HOME_LOCK_FILE_NAME,
  HOME_LOCK_HANDOFF_WAIT_MS,
  HOME_LOCK_METADATA_FILE_NAME,
  formatHomeLockRefusal,
  formatSharedHomeNotice,
  isSharedHomeAllowed,
  parseHandoffFromPid,
  parseHomeLockHolder,
} from './core/home-lock-core.ts';
import type { HomeLockHolder } from './core/home-lock-core.ts';
import { writeJsonAtomicSync } from './json-file.ts';
import { loadFileLocks } from './session-temp/session-temp-locks.ts';

type FileLocks = NonNullable<ReturnType<typeof loadFileLocks>>;

interface HomeLockHandle {
  readonly mode: 'exclusive' | 'shared';
  updatePort(port: number): void;
  release(): void;
}

interface AcquireHomeLockOptions {
  homeDir: string;
  port: number | null;
  env?: Record<string, string | undefined>;
  startedAt?: string;
  handoffWaitMs?: number;
  log?: Pick<Console, 'warn'>;
}

const HOME_DIR_MODE = 0o700;
const LOCK_METADATA_MODE = 0o600;
const HANDOFF_POLL_INTERVAL_MS = 25;
const HOME_LOCKED_ERROR_CODE = 'GLIMMERVOID_HOME_LOCKED';
const SYNC_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const bootHomeLocksByDir = new Map<string, HomeLockHandle>();

function lockFilePath(homeDir: string): string {
  return path.join(homeDir, HOME_LOCK_FILE_NAME);
}

function metadataFilePath(homeDir: string): string {
  return path.join(homeDir, HOME_LOCK_METADATA_FILE_NAME);
}

function readHomeLockHolder(homeDir: string): HomeLockHolder | null {
  try {
    return parseHomeLockHolder(fs.readFileSync(metadataFilePath(homeDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeHomeLockHolder(homeDir: string, holder: HomeLockHolder): void {
  writeJsonAtomicSync(metadataFilePath(homeDir), holder, { mode: LOCK_METADATA_MODE, enforceMode: true });
}

function homeLockRefusalError(homeDir: string, holder: HomeLockHolder | null): Error & { glimmervoidBoot: true; code: string } {
  return Object.assign(new Error(formatHomeLockRefusal({ homeDir, holder })), {
    glimmervoidBoot: true as const,
    code: HOME_LOCKED_ERROR_CODE,
  });
}

function isHomeLockRefusal(error: unknown): error is Error & { glimmervoidBoot: true; code: string } {
  if (!(error instanceof Error)) return false;
  if (!('code' in error) || error.code !== HOME_LOCKED_ERROR_CODE) return false;
  return 'glimmervoidBoot' in error && error.glimmervoidBoot === true;
}

function tryOpenExistingLockFile(filePath: string): number | null {
  try {
    return fs.openSync(filePath, 'r+');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function tryAcquireExclusiveDescriptor(locks: FileLocks, homeDir: string): number | null {
  const targetPath = lockFilePath(homeDir);
  const existingDescriptor = tryOpenExistingLockFile(targetPath);
  if (existingDescriptor !== null) {
    if (locks.tryLock(existingDescriptor)) return existingDescriptor;
    fs.closeSync(existingDescriptor);
    return null;
  }
  fs.mkdirSync(homeDir, { recursive: true, mode: HOME_DIR_MODE });
  const createdDescriptor = fs.openSync(targetPath, 'a+');
  if (locks.tryLock(createdDescriptor)) return createdDescriptor;
  fs.closeSync(createdDescriptor);
  return null;
}

function createSharedHomeHandle(): HomeLockHandle {
  return {
    mode: 'shared',
    updatePort() {},
    release() {},
  };
}

function releaseDescriptor(locks: FileLocks, descriptor: number): void {
  try {
    locks.unlock(descriptor);
  } catch {
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
    }
  }
}

function createExclusiveHomeHandle(locks: FileLocks, homeDir: string, descriptor: number, initialPort: number | null, startedAt: string): HomeLockHandle {
  let isReleased = false;
  let currentPort = initialPort;
  try {
    writeHomeLockHolder(homeDir, { pid: process.pid, port: currentPort, startedAt });
  } catch (error) {
    releaseDescriptor(locks, descriptor);
    throw error;
  }

  return {
    mode: 'exclusive',
    updatePort(nextPort: number): void {
      if (isReleased || nextPort === currentPort) return;
      currentPort = nextPort;
      try {
        writeHomeLockHolder(homeDir, { pid: process.pid, port: currentPort, startedAt });
      } catch {
      }
    },
    release(): void {
      if (isReleased) return;
      isReleased = true;
      try {
        fs.rmSync(metadataFilePath(homeDir), { force: true });
      } catch {
      }
      releaseDescriptor(locks, descriptor);
    },
  };
}

function consumeHandoffFromPid(env: Record<string, string | undefined>): number | null {
  const handoffFromPid = parseHandoffFromPid(env);
  if (handoffFromPid !== null && env === process.env) delete env[HANDOFF_FROM_PID_ENV];
  return handoffFromPid;
}

function shouldWaitForPredecessor(handoffFromPid: number | null, holder: HomeLockHolder | null): boolean {
  if (handoffFromPid === null) return false;
  return holder === null || holder.pid === handoffFromPid;
}

function handleHeldHomeLock(homeDir: string, env: Record<string, string | undefined>, log: Pick<Console, 'warn'>): HomeLockHandle {
  const holder = readHomeLockHolder(homeDir);
  if (isSharedHomeAllowed(env)) {
    log.warn(formatSharedHomeNotice({ homeDir, holder }));
    return createSharedHomeHandle();
  }
  throw homeLockRefusalError(homeDir, holder);
}

function acquireHomeLockSync({
  homeDir,
  port,
  env = process.env,
  startedAt = clock.now().toISOString(),
  handoffWaitMs = HOME_LOCK_HANDOFF_WAIT_MS,
  log = console,
}: AcquireHomeLockOptions): HomeLockHandle {
  const resolvedHomeDir = path.resolve(homeDir);
  const handoffFromPid = consumeHandoffFromPid(env);
  const locks = loadFileLocks();
  if (locks === null) return createSharedHomeHandle();

  let descriptor = tryAcquireExclusiveDescriptor(locks, resolvedHomeDir);
  if (descriptor !== null) return createExclusiveHomeHandle(locks, resolvedHomeDir, descriptor, port, startedAt);

  if (handoffFromPid !== null) {
    const deadlineMs = clock.nowMs() + handoffWaitMs;
    while (clock.nowMs() < deadlineMs) {
      if (!shouldWaitForPredecessor(handoffFromPid, readHomeLockHolder(resolvedHomeDir))) break;
      Atomics.wait(SYNC_SLEEP_BUFFER, 0, 0, HANDOFF_POLL_INTERVAL_MS);
      descriptor = tryAcquireExclusiveDescriptor(locks, resolvedHomeDir);
      if (descriptor !== null) return createExclusiveHomeHandle(locks, resolvedHomeDir, descriptor, port, startedAt);
    }
  }

  return handleHeldHomeLock(resolvedHomeDir, env, log);
}

async function acquireHomeLockAsync({
  homeDir,
  port,
  env = process.env,
  startedAt = clock.now().toISOString(),
  handoffWaitMs = HOME_LOCK_HANDOFF_WAIT_MS,
  log = console,
}: AcquireHomeLockOptions): Promise<HomeLockHandle> {
  const resolvedHomeDir = path.resolve(homeDir);
  const handoffFromPid = consumeHandoffFromPid(env);
  const locks = loadFileLocks();
  if (locks === null) return createSharedHomeHandle();

  let descriptor = tryAcquireExclusiveDescriptor(locks, resolvedHomeDir);
  if (descriptor !== null) return createExclusiveHomeHandle(locks, resolvedHomeDir, descriptor, port, startedAt);

  if (handoffFromPid !== null) {
    const deadlineMs = clock.nowMs() + handoffWaitMs;
    while (clock.nowMs() < deadlineMs) {
      if (!shouldWaitForPredecessor(handoffFromPid, readHomeLockHolder(resolvedHomeDir))) break;
      await sleep(HANDOFF_POLL_INTERVAL_MS);
      descriptor = tryAcquireExclusiveDescriptor(locks, resolvedHomeDir);
      if (descriptor !== null) return createExclusiveHomeHandle(locks, resolvedHomeDir, descriptor, port, startedAt);
    }
  }

  return handleHeldHomeLock(resolvedHomeDir, env, log);
}

function registerBootHomeLock(homeDir: string, handle: HomeLockHandle): void {
  bootHomeLocksByDir.set(path.resolve(homeDir), handle);
}

function claimBootHomeLock(homeDir: string): HomeLockHandle | null {
  const resolvedHomeDir = path.resolve(homeDir);
  const handle = bootHomeLocksByDir.get(resolvedHomeDir) ?? null;
  if (handle !== null) bootHomeLocksByDir.delete(resolvedHomeDir);
  return handle;
}

export {
  acquireHomeLockAsync,
  acquireHomeLockSync,
  claimBootHomeLock,
  isHomeLockRefusal,
  registerBootHomeLock,
};
export type { HomeLockHandle };
