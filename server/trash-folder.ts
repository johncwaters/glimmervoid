import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, isMissingFileError } from '../shared/text.ts';

const TRASH_FOLDER_PREFIX = '.deleting-';

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

async function deleteTrashFolder(folder: string, log: Pick<Console, 'warn'>): Promise<void> {
  await rm(folder, { recursive: true, force: true }).catch((error: unknown) => {
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

export { deleteLeftoverTrash, moveFolderToTrash, moveFolderToTrashSync };
