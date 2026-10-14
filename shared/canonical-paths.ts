import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { equalsIgnoringCaseOnWindows } from './paths.ts';

const realpathNative = promisify(fs.realpath.native);

export function canonicalizePath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export function isSameDirectoryPath(a: unknown, b: unknown): boolean {
  const resolvedA = path.resolve(String(a || ''));
  const resolvedB = path.resolve(String(b || ''));
  if (equalsIgnoringCaseOnWindows(resolvedA, resolvedB)) return true;

  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;

  return equalsIgnoringCaseOnWindows(canonicalizePath(resolvedA), canonicalizePath(resolvedB));
}

export async function comparableDirectoryPath(candidatePath: unknown): Promise<string> {
  const resolvedPath = path.resolve(String(candidatePath || ''));
  let canonicalPath: string;
  try {
    canonicalPath = await realpathNative(resolvedPath);
  } catch {
    canonicalPath = resolvedPath;
  }
  if (process.platform !== 'win32') return canonicalPath;
  return canonicalPath.toLowerCase();
}
