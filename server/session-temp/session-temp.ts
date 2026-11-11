import { readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, errorMessage, isMissingFileError } from '../../shared/text.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { pruneAgedFiles } from '../prune-files.ts';
import { recordSweptPath } from '../removal-journal.ts';
import { createHeldSessionTempFolder, releaseSessionLock, sessionIdOfLockFile, trashSessionTempFoldersOnceUnheld } from './session-temp-locks.ts';

const SESSION_TEMP_FOLDER = 'sane-yolo-temp';
const RETIRED_SESSION_TEMP_FOLDER = 'guardrails-temp';
const SESSION_TEMP_FOLDERS: readonly string[] = Object.freeze([SESSION_TEMP_FOLDER, RETIRED_SESSION_TEMP_FOLDER]);
const ABSENT_OR_NOT_EMPTY_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST']);
const SESSION_TEMP_LOCK_FOLDER = 'session-temp-locks';
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_TEMP_RETAIN_DAYS = 7;

function sessionTempLockFolder(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, SESSION_TEMP_LOCK_FOLDER);
}

function sessionTempFoldersOf(glimmervoidHome: string, sessionId: string): string[] {
  return SESSION_TEMP_FOLDERS.map((folderName) => path.join(glimmervoidHome, folderName, sessionId));
}

async function deleteSessionTempFoldersOnceUnheld(glimmervoidHome: string, sessionId: string, keepWhenNoLockFiles: boolean, log: Pick<Console, 'warn'>): Promise<void> {
  const lockFolder = sessionTempLockFolder(glimmervoidHome);
  let trashedFolders: { sessionTempFolder: string; trashFolder: string }[] = [];
  try {
    trashedFolders = trashSessionTempFoldersOnceUnheld(lockFolder, sessionId, sessionTempFoldersOf(glimmervoidHome, sessionId), { keepWhenNoLockFiles });
  } catch (error) {
    log.warn(`[session-temp] could not delete the temp folder of session ${sessionId}: ${errorMessage(error)}`);
    return;
  }
  for (const { sessionTempFolder, trashFolder } of trashedFolders) await deleteTrashedSessionTempFolder(sessionId, sessionTempFolder, trashFolder, log);
}

async function deleteTrashedSessionTempFolder(sessionId: string, sessionTempFolder: string, trashFolder: string, log: Pick<Console, 'warn'>): Promise<void> {
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
  const sessionIdsWithLockFiles = new Set(lockEntryNames.map(sessionIdOfLockFile).filter((sessionId) => sessionId !== null));
  for (const sessionId of sessionIdsWithLockFiles) {
    if (liveSessionIds.has(sessionId)) continue;
    await deleteSessionTempFoldersOnceUnheld(glimmervoidHome, sessionId, true, log);
  }
  for (const folderName of SESSION_TEMP_FOLDERS) {
    await pruneAgedFiles({
      directory: path.join(glimmervoidHome, folderName),
      suffixes: [''],
      retainDays: SESSION_TEMP_RETAIN_DAYS,
      entryMode: 'directory',
      isRetainedId: (id) => liveSessionIds.has(id) || sessionIdsWithLockFiles.has(id),
    });
  }
  await removeRetiredSessionTempRootOnceEmpty(glimmervoidHome, log);
}

async function removeRetiredSessionTempRootOnceEmpty(glimmervoidHome: string, log: Pick<Console, 'warn'>): Promise<void> {
  const retiredRoot = path.join(glimmervoidHome, RETIRED_SESSION_TEMP_FOLDER);
  await rmdir(retiredRoot).catch((error: unknown) => {
    if (ABSENT_OR_NOT_EMPTY_CODES.has(errorCode(error) ?? '')) return;
    log.warn(`[session-temp] could not delete the retired ${RETIRED_SESSION_TEMP_FOLDER} folder: ${errorMessage(error)}`);
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
  if (!SESSION_ID_SHAPE.test(sessionId)) return;
  const glimmervoidHome = glimmervoidHomeDir();
  const lockFolder = sessionTempLockFolder(glimmervoidHome);
  let didHoldSessionLock = true;
  try {
    didHoldSessionLock = releaseSessionLock(lockFolder, sessionId);
  } catch (error) {
    log.warn(`[session-temp] could not delete the lock of session ${sessionId}: ${errorMessage(error)}`);
  }
  if (!didHoldSessionLock) return;
  await deleteSessionTempFoldersOnceUnheld(glimmervoidHome, sessionId, false, log);
}

export { SESSION_TEMP_FOLDERS, ensureSessionTempFolder, pruneLeftoverSessionTempFolders, removeSessionTempFolder };
