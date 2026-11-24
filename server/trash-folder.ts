import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { chmod, lstat, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, errorMessage, isMissingFileError } from '../shared/text.ts';

const TRASH_FOLDER_PREFIX = '.deleting-';
const PERMISSION_ERROR_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);
const OWNER_FULL_ACCESS = 0o700;

function trashFolderPrefixFor(label: string): string {
  return `${TRASH_FOLDER_PREFIX}${label}-`;
}

function trashFolderPathFor(folder: string, label: string): string {
  return path.join(path.dirname(folder), `${trashFolderPrefixFor(label)}${path.basename(folder)}-${randomUUID()}`);
}

function moveFolderToTrashSync(folder: string, label: string): string | null {
  const trashFolder = trashFolderPathFor(folder, label);
  try {
    renameSync(folder, trashFolder);
    return trashFolder;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function moveFolderToTrash(folder: string, label: string): Promise<string | null> {
  const trashFolder = trashFolderPathFor(folder, label);
  try {
    await rename(folder, trashFolder);
    return trashFolder;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function makeDirectoriesWritable(folder: string): Promise<void> {
  const pendingDirectories = [folder];
  for (let directory = pendingDirectories.pop(); directory !== undefined; directory = pendingDirectories.pop()) {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory()) continue;
    await chmod(directory, directoryStat.mode | OWNER_FULL_ACCESS);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pendingDirectories.push(path.join(directory, entry.name));
    }
  }
}

async function removeFolderTree(folder: string): Promise<void> {
  try {
    await rm(folder, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!PERMISSION_ERROR_CODES.has(errorCode(error) ?? '')) throw error;
  }
  await makeDirectoriesWritable(folder);
  await rm(folder, { recursive: true, force: true });
}

async function deleteTrashFolder(folder: string, log: Pick<Console, 'warn'>): Promise<void> {
  await removeFolderTree(folder).catch((error: unknown) => {
    log.warn(`[trash] could not delete ${folder}: ${errorMessage(error)}`);
  });
}

async function deleteLeftoverTrash(parent: string, label: string, log: Pick<Console, 'warn'>): Promise<void> {
  const prefix = trashFolderPrefixFor(label);
  const entryNames = await readdir(parent).catch(() => []);
  for (const entryName of entryNames) {
    if (!entryName.startsWith(prefix)) continue;
    await deleteTrashFolder(path.join(parent, entryName), log);
  }
}

export { deleteLeftoverTrash, moveFolderToTrash, moveFolderToTrashSync, removeFolderTree };
