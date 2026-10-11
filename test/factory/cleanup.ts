import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../../shared/paths.ts';
import { isMissingFileError } from '../../shared/text.ts';

async function canonicalPathOf(resolvedPath: string): Promise<string> {
  try { return await realpath(resolvedPath); }
  catch (error) {
    if (!isMissingFileError(error)) throw error;
    return path.join(await realpath(path.dirname(resolvedPath)), path.basename(resolvedPath));
  }
}

export async function resolveInside(directory: string, candidate: string): Promise<string> {
  const parentPath = await realpath(directory);
  const canonicalPath = await canonicalPathOf(path.resolve(candidate));
  if (!isPathInside(parentPath, canonicalPath, { allowEqual: false })) throw new Error(`Refusing path outside ${parentPath}: ${canonicalPath}`);
  return canonicalPath;
}

export async function removeInside(directory: string, candidate: string): Promise<void> {
  const canonicalPath = await resolveInside(directory, candidate);
  try { await lstat(canonicalPath); }
  catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  await rm(canonicalPath, { recursive: true, force: true });
}
