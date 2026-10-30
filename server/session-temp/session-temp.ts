import { readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { pruneAgedFiles } from '../prune-files.ts';
import { recordSweptPath } from '../removal-journal.ts';
import { createHeldSessionTempFolder, releaseSessionLock, sessionIdOfLockFile, trashSessionTempFolderOnceUnheld } from './session-temp-locks.ts';

const SESSION_TEMP_FOLDER = 'guardrails-temp';
const SESSION_TEMP_LOCK_FOLDER = 'session-temp-locks';
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_TEMP_RETAIN_DAYS = 7;

function sessionTempLockFolder(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, SESSION_TEMP_LOCK_FOLDER);
}

async function deleteSessionTempFolderOnceUnheld(lockFolder: string, sessionId: string, sessionTempFolder: string, keepWhenNoLockFiles: boolean, log: Pick<Console, 'warn'>): Promise<void> {
  let trashFolder: string | null = null;
  try {
    trashFolder = trashSessionTempFolderOnceUnheld(lockFolder, sessionId, sessionTempFolder, { keepWhenNoLockFiles });
  } catch (error) {
    log.warn(`[session-temp] could not delete session temp folder ${sessionTempFolder}: ${errorMessage(error)}`);
    return;
  }
  if (trashFolder === null) return;
  if (!(await recordSweptPath({ cause: 'session-temp', kind: 'folder', path: sessionTempFolder, sessionId, checksPassed: ['no-lock-held'], log }))) {
    await rename(trashFolder, sessionTempFolder).catch((error: unknown) => {
      log.warn(`[session-temp] could not move session temp folder ${trashFolder} back to ${sessionTempFolder}: ${errorMessage(error)}`);
    });
    return;
  }
  await rm(trashFolder, { recursive: true, force: true }).catch((error: unknown) => {
    log.warn(`[session-temp] could not delete session temp folder ${trashFolder}: ${errorMessage(error)}`);
  });
}

async function pruneLeftoverSessionTempFolders(glimmervoidHome: string, liveSessionIds: ReadonlySet<string>, log: Pick<Console, 'warn'> = console): Promise<void> {
  const lockFolder = sessionTempLockFolder(glimmervoidHome);
  const lockEntryNames = await readdir(lockFolder).catch((error: unknown) => {
    if (isMissingFileError(error)) return [];
    log.warn(`[session-temp] kept every session temp folder because the lock list could not be read: ${errorMessage(error)}`);
    return null;
  });
  if (lockEntryNames === null) return;
  const sessionTempRoot = path.join(glimmervoidHome, SESSION_TEMP_FOLDER);
  const sessionIdsWithLockFiles = new Set(lockEntryNames.map(sessionIdOfLockFile).filter((sessionId) => sessionId !== null));
  for (const sessionId of sessionIdsWithLockFiles) {
    if (liveSessionIds.has(sessionId)) continue;
    await deleteSessionTempFolderOnceUnheld(lockFolder, sessionId, path.join(sessionTempRoot, sessionId), true, log);
  }
  await pruneAgedFiles({
    directory: sessionTempRoot,
    suffixes: [''],
    retainDays: SESSION_TEMP_RETAIN_DAYS,
    entryMode: 'directory',
    isRetainedId: (id) => liveSessionIds.has(id) || sessionIdsWithLockFiles.has(id),
  });
}

function sessionTempFolderFor(sessionId: string): string | null {
  if (!SESSION_ID_SHAPE.test(sessionId)) return null;
  return path.join(glimmervoidHomeDir(), SESSION_TEMP_FOLDER, sessionId);
}

function ensureSessionTempFolder(sessionId: string): string | null {
  const sessionTempFolder = sessionTempFolderFor(sessionId);
  if (!sessionTempFolder) return null;
  createHeldSessionTempFolder(sessionTempLockFolder(glimmervoidHomeDir()), sessionId, sessionTempFolder);
  return sessionTempFolder;
}

async function removeSessionTempFolder(sessionId: string, log: Pick<Console, 'warn'> = console): Promise<void> {
  const sessionTempFolder = sessionTempFolderFor(sessionId);
  if (!sessionTempFolder) return;
  const lockFolder = sessionTempLockFolder(glimmervoidHomeDir());
  let didHoldSessionLock = true;
  try {
    didHoldSessionLock = releaseSessionLock(lockFolder, sessionId);
  } catch (error) {
    log.warn(`[session-temp] could not delete the lock of session ${sessionId}: ${errorMessage(error)}`);
  }
  if (!didHoldSessionLock) return;
  await deleteSessionTempFolderOnceUnheld(lockFolder, sessionId, sessionTempFolder, false, log);
}

export { SESSION_TEMP_FOLDER, ensureSessionTempFolder, pruneLeftoverSessionTempFolders, removeSessionTempFolder };
