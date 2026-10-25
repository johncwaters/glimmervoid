import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isMissingFileError } from '../../shared/text.ts';

type FileLocks = Pick<typeof import('fs-native-extensions'), 'tryLock' | 'unlock' | 'waitForLockSync'>;

interface UnheldSessionTrashOptions {
  keepWhenNoLockFiles: boolean;
}

const LOCK_FILE_SUFFIX = '.lock';
const SESSION_TEMP_GATE_FILE_NAME = 'session-temp.gate';
const TRASH_FOLDER_PREFIX = '.deleting-';
const LOCK_INSTANCE_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const requireFromHere = createRequire(import.meta.url);
const heldLockDescriptorsBySessionId = new Map<string, number>();
let fileLocks: FileLocks | null | undefined;
let ownInstanceId: string | undefined;

function loadFileLocks(): FileLocks | null {
  if (fileLocks !== undefined) return fileLocks;
  fileLocks = requireNativeFileLocks();
  return fileLocks;
}

function requireNativeFileLocks(): FileLocks | null {
  try {
    return requireFromHere('fs-native-extensions');
  } catch {
    return null;
  }
}

function readOwnInstanceId(): string {
  ownInstanceId ??= randomUUID();
  return ownInstanceId;
}

function ownSessionLockPath(policyDir: string, sessionId: string): string {
  return path.join(policyDir, `${sessionId}.${readOwnInstanceId()}${LOCK_FILE_SUFFIX}`);
}

function sessionIdOfLockFile(entryName: string): string | null {
  if (!entryName.endsWith(LOCK_FILE_SUFFIX)) return null;
  const lockName = entryName.slice(0, -LOCK_FILE_SUFFIX.length);
  const instanceSeparatorIndex = lockName.lastIndexOf('.');
  if (instanceSeparatorIndex < 0) return null;
  const sessionId = lockName.slice(0, instanceSeparatorIndex);
  if (!SESSION_ID_SHAPE.test(sessionId) || !LOCK_INSTANCE_SHAPE.test(lockName.slice(instanceSeparatorIndex + 1))) return null;
  return sessionId;
}

function openSessionTempGate(policyDir: string): number {
  mkdirSync(policyDir, { recursive: true, mode: 0o700 });
  return openSync(path.join(policyDir, SESSION_TEMP_GATE_FILE_NAME), 'a+');
}

function closeSessionTempGate(locks: FileLocks, gateDescriptor: number): void {
  try {
    locks.unlock(gateDescriptor);
  } finally {
    closeSync(gateDescriptor);
  }
}

function lockOwnSessionFile(locks: FileLocks, lockPath: string): number | null {
  const lockDescriptor = openSync(lockPath, 'a+');
  if (locks.tryLock(lockDescriptor)) return lockDescriptor;
  closeSync(lockDescriptor);
  return null;
}

function holdSessionLockWhileGated(locks: FileLocks, policyDir: string, sessionId: string, sessionTempFolder: string): void {
  const gateDescriptor = openSessionTempGate(policyDir);
  try {
    locks.waitForLockSync(gateDescriptor, { shared: true });
    const lockDescriptor = lockOwnSessionFile(locks, ownSessionLockPath(policyDir, sessionId));
    if (lockDescriptor !== null) heldLockDescriptorsBySessionId.set(sessionId, lockDescriptor);
    mkdirSync(sessionTempFolder, { recursive: true });
  } finally {
    closeSessionTempGate(locks, gateDescriptor);
  }
}

function createHeldSessionTempFolder(policyDir: string, sessionId: string, sessionTempFolder: string): void {
  const locks = loadFileLocks();
  if (locks === null || heldLockDescriptorsBySessionId.has(sessionId)) {
    mkdirSync(sessionTempFolder, { recursive: true });
    return;
  }
  holdSessionLockWhileGated(locks, policyDir, sessionId, sessionTempFolder);
}

function releaseSessionLock(policyDir: string, sessionId: string): boolean {
  const lockDescriptor = heldLockDescriptorsBySessionId.get(sessionId);
  if (lockDescriptor === undefined) return false;
  heldLockDescriptorsBySessionId.delete(sessionId);
  try {
    unlinkSync(ownSessionLockPath(policyDir, sessionId));
  } finally {
    loadFileLocks()?.unlock(lockDescriptor);
    closeSync(lockDescriptor);
  }
  return true;
}

function openExistingLockFile(lockPath: string): number | null {
  try {
    return openSync(lockPath, 'r+');
  } catch {
    return null;
  }
}

function tryLockOrFalse(locks: FileLocks, lockDescriptor: number): boolean {
  try {
    return locks.tryLock(lockDescriptor);
  } catch {
    return false;
  }
}

function lockIfUnheld(locks: FileLocks, lockPath: string): number | null {
  const lockDescriptor = openExistingLockFile(lockPath);
  if (lockDescriptor === null) return null;
  if (tryLockOrFalse(locks, lockDescriptor)) return lockDescriptor;
  closeSync(lockDescriptor);
  return null;
}

function releaseLockDescriptors(locks: FileLocks, lockDescriptors: readonly number[]): void {
  for (const lockDescriptor of lockDescriptors) {
    locks.unlock(lockDescriptor);
    closeSync(lockDescriptor);
  }
}

function sessionLockPathsIn(policyDir: string, sessionId: string): string[] {
  return readdirSync(policyDir)
    .filter((entryName) => sessionIdOfLockFile(entryName) === sessionId)
    .map((entryName) => path.join(policyDir, entryName));
}

function moveFolderToTrash(sessionTempFolder: string, sessionId: string): string | null {
  const trashFolder = path.join(path.dirname(sessionTempFolder), `${TRASH_FOLDER_PREFIX}${sessionId}-${randomUUID()}`);
  try {
    renameSync(sessionTempFolder, trashFolder);
    return trashFolder;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function trashFolderIfEveryLockIsFree(locks: FileLocks, policyDir: string, sessionId: string, sessionTempFolder: string, { keepWhenNoLockFiles }: UnheldSessionTrashOptions): string | null {
  const lockPaths = sessionLockPathsIn(policyDir, sessionId);
  if (keepWhenNoLockFiles && lockPaths.length === 0) return null;
  const claimedLockDescriptors = lockPaths.map((lockPath) => lockIfUnheld(locks, lockPath)).filter((lockDescriptor) => lockDescriptor !== null);
  try {
    if (claimedLockDescriptors.length !== lockPaths.length) return null;
    const trashFolder = moveFolderToTrash(sessionTempFolder, sessionId);
    for (const lockPath of lockPaths) rmSync(lockPath, { force: true });
    return trashFolder;
  } finally {
    releaseLockDescriptors(locks, claimedLockDescriptors);
  }
}

function trashSessionTempFolderOnceUnheld(policyDir: string, sessionId: string, sessionTempFolder: string, options: UnheldSessionTrashOptions): string | null {
  const locks = loadFileLocks();
  if (locks === null) return null;
  const gateDescriptor = openSessionTempGate(policyDir);
  try {
    if (!locks.tryLock(gateDescriptor)) return null;
    return trashFolderIfEveryLockIsFree(locks, policyDir, sessionId, sessionTempFolder, options);
  } finally {
    closeSessionTempGate(locks, gateDescriptor);
  }
}

export { createHeldSessionTempFolder, releaseSessionLock, sessionIdOfLockFile, trashSessionTempFolderOnceUnheld };
