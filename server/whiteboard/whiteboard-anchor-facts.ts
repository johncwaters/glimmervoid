import path from 'node:path';

import { openContainedFile } from '../contained-file.ts';
import type { ContainmentRefusal } from '../core/trace-tail-core.ts';
import type { AnchorFacts, FileFact } from '../../shared/whiteboard-anchor-core.ts';

const MAX_ANCHOR_FILE_BYTES = 512 * 1024;
const NEWLINE_BYTE = 0x0a;

const PROBLEM_BY_REFUSAL: Readonly<Record<ContainmentRefusal, string>> = {
  missing: 'no such file',
  unreadable: 'the file could not be read',
  'outside-root': 'the path leads outside the code session worktree, so it was not read',
  'not-a-regular-file': 'it is not a file',
  'root-unresolvable': 'the code session worktree could not be read',
};

function lineCountOf(bytes: Uint8Array): number {
  let newlineCount = 0;
  for (const byte of bytes) if (byte === NEWLINE_BYTE) newlineCount += 1;
  const hasUnterminatedLastLine = bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE_BYTE;
  return newlineCount + (hasUnterminatedLastLine ? 1 : 0);
}

async function fileFactOf(root: string, refPath: string): Promise<FileFact> {
  const opened = await openContainedFile(path.join(root, refPath), root);
  if (!opened.ok) return { problem: PROBLEM_BY_REFUSAL[opened.reason] };
  const { handle, stat } = opened.file;
  try {
    if (stat.size > MAX_ANCHOR_FILE_BYTES) return { lineCount: null };
    return { lineCount: lineCountOf(await handle.readFile()) };
  } catch {
    return { problem: PROBLEM_BY_REFUSAL.unreadable };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readAnchorFacts(root: string, refPaths: readonly string[]): Promise<AnchorFacts> {
  const fileFactByPath = new Map<string, FileFact>();
  for (const refPath of refPaths) {
    fileFactByPath.set(refPath, await fileFactOf(root, refPath));
  }
  return { fileFactByPath };
}

export { readAnchorFacts };
