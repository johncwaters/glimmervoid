import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { containmentRefusalReason } from './core/trace-tail-core.ts';
import { isPathInside } from '../shared/paths.ts';
import type { ContainmentRefusal } from './core/trace-tail-core.ts';
import { isSafePathSegment } from './core/upload-core.ts';

interface OpenedFile {
  handle: FileHandle;
  realPath: string;
  stat: fs.Stats;
}

interface MissingContainedFile {
  realPath: string;
}

type ContainedFileResult<File extends OpenedFile | MissingContainedFile> =
  | { ok: true; file: File }
  | { ok: false; reason: ContainmentRefusal };

async function containedPathForMissingFile(
  candidate: string,
  realRoot: string,
): Promise<ContainedFileResult<MissingContainedFile>> {
  const fileName = path.basename(candidate);
  if (!isSafePathSegment(fileName)) return { ok: false, reason: 'outside-root' };
  try {
    const realDirectory = await fs.promises.realpath(path.dirname(candidate));
    const realPath = path.join(realDirectory, fileName);
    if (!isPathInside(realRoot, realPath, { allowEqual: false })) return { ok: false, reason: 'outside-root' };
    const directoryStat = await fs.promises.lstat(realDirectory);
    if (!directoryStat.isDirectory()) return { ok: false, reason: 'missing' };
    return { ok: true, file: { realPath } };
  } catch (error) {
    return { ok: false, reason: containmentRefusalReason(error) };
  }
}

export function openContainedFile(candidate: string, root: string): Promise<ContainedFileResult<OpenedFile>>;
export function openContainedFile(
  candidate: string,
  root: string,
  allowsMissingFile: true,
): Promise<ContainedFileResult<OpenedFile | MissingContainedFile>>;
export function openContainedFile(
  candidate: string,
  root: string,
  allowsMissingFile: false,
  opensForWriting: true,
): Promise<ContainedFileResult<OpenedFile>>;
export async function openContainedFile(
  candidate: string,
  root: string,
  allowsMissingFile = false,
  opensForWriting = false,
): Promise<ContainedFileResult<OpenedFile | MissingContainedFile>> {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return { ok: false, reason: 'root-unresolvable' };
  }
  let realCandidate: string;
  try {
    realCandidate = await fs.promises.realpath(candidate);
  } catch (error) {
    const reason = containmentRefusalReason(error);
    if (!allowsMissingFile || reason !== 'missing') return { ok: false, reason };
    return containedPathForMissingFile(candidate, realRoot);
  }
  if (!isPathInside(realRoot, realCandidate, { allowEqual: false })) return { ok: false, reason: 'outside-root' };
  let handle: FileHandle | null = null;
  try {
    const accessFlag = opensForWriting ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
    handle = await fs.promises.open(realCandidate, accessFlag | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (stat.isFile()) return { ok: true, file: { handle, realPath: realCandidate, stat } };
    await handle.close().catch(() => {});
    return { ok: false, reason: 'not-a-regular-file' };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    return { ok: false, reason: containmentRefusalReason(error) };
  }
}

export type { OpenedFile };
