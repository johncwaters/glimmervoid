import path from 'node:path';

import { openContainedFile } from '../contained-file.ts';
import type { ContainmentRefusal } from '../core/trace-tail-core.ts';
import { buildChangeMapView } from '../../shared/change-map-view-core.ts';
import type { ChangeMap } from '../../shared/contracts/change-map.ts';
import type { ChangeFacts, FileFact } from '../../shared/whiteboard-anchor-core.ts';
import { errorMessage } from '../../shared/text.ts';

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

async function readFileFacts(root: string, refPaths: readonly string[]): Promise<Map<string, FileFact>> {
  const fileFactByPath = new Map<string, FileFact>();
  for (const refPath of refPaths) {
    fileFactByPath.set(refPath, await fileFactOf(root, refPath));
  }
  return fileFactByPath;
}

function changeFactsOf(map: ChangeMap): ChangeFacts | null {
  if (map.repos.length === 0 && !map.error) return null;
  const changedPaths = map.repos.flatMap((repo) => repo.files.map((file) => ({ path: `${repo.sessionPathPrefix}${file.path}`, isCommitted: file.isCommitted })));
  const worthALookPaths = buildChangeMapView(map).worthALook.flatMap((group) => group.lines.map((line) => line.openPath));
  return { changedPaths, worthALookPaths, error: map.error ?? null };
}

async function readChangeFacts(buildChangeMap: () => Promise<ChangeMap>): Promise<ChangeFacts | null> {
  try {
    return changeFactsOf(await buildChangeMap());
  } catch (error) {
    return { changedPaths: [], worthALookPaths: [], error: errorMessage(error) };
  }
}

export { readChangeFacts, readFileFacts };
