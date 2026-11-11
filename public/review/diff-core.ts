import { diffHeaderPathsOf } from '#shared/git-text.ts';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
  oldBlobId: string | null;
  patch: string;
}

interface ParsingFile extends Omit<DiffFile, 'patch'> {
  patchLines: string[];
  isInHunk: boolean;
}

function startFile(header: string): ParsingFile {
  const file: ParsingFile = { path: '', oldPath: null, status: 'modified', added: 0, removed: 0, binary: false, oldBlobId: null, patchLines: [], isInHunk: false };
  const headerPaths = diffHeaderPathsOf(header);
  if (headerPaths) {
    file.oldPath = headerPaths.oldPath;
    file.path = headerPaths.path;
  }
  return file;
}

function readHeaderLine(file: ParsingFile, line: string) {
  if (line.startsWith('new file mode') || line === '--- /dev/null') { file.status = 'added'; return; }
  if (line.startsWith('deleted file mode') || line === '+++ /dev/null') { file.status = 'deleted'; return; }
  if (line.startsWith('rename from ')) { file.oldPath = line.slice('rename from '.length); file.status = 'renamed'; return; }
  if (line.startsWith('rename to ')) { file.path = line.slice('rename to '.length); file.status = 'renamed'; return; }
  if (line.startsWith('Binary files')) { file.binary = true; return; }
  const indexBlobIds = /^index ([0-9a-f]+)\.\./.exec(line);
  if (indexBlobIds) { file.oldBlobId = /^0+$/.test(indexBlobIds[1] ?? '') ? null : indexBlobIds[1] ?? null; return; }
  if (file.path) return;
  if (line.startsWith('--- a/')) file.oldPath = file.oldPath || line.slice('--- a/'.length);
  if (line.startsWith('+++ b/')) file.path = line.slice('+++ b/'.length);
}

function readHunkLine(file: ParsingFile, line: string) {
  if (line.startsWith('+')) file.added++;
  if (line.startsWith('-')) file.removed++;
}

function finishFile(file: ParsingFile): DiffFile {
  return {
    path: file.path || file.oldPath || '(unknown)',
    oldPath: file.oldPath,
    status: file.status,
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    oldBlobId: file.oldBlobId,
    patch: `${file.patchLines.join('\n')}\n`,
  };
}

export function parseUnifiedDiff(diff: string | null | undefined): DiffFile[] {
  const files: ParsingFile[] = [];
  if (!diff) return [];
  for (const line of String(diff).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      files.push(startFile(line));
      files[files.length - 1]?.patchLines.push(line);
      continue;
    }
    const file = files[files.length - 1];
    if (!file) continue;
    if (line === '' && file.isInHunk) continue;
    file.patchLines.push(line);
    if (line.startsWith('@@')) { file.isInHunk = true; continue; }
    if (file.isInHunk) { readHunkLine(file, line); continue; }
    readHeaderLine(file, line);
  }
  return files.map(finishFile);
}

export function shouldDropDiffCache(prevStatus: string | null | undefined, nextStatus: string | null | undefined) {
  if (nextStatus === 'merged' || nextStatus === 'none') return true;
  return prevStatus === 'parked' && nextStatus === 'pending-review';
}

export function summarizeFiles(files: readonly Pick<DiffFile, 'added' | 'removed'>[] | null | undefined) {
  let added = 0, removed = 0;
  for (const f of (files || [])) { added += f.added || 0; removed += f.removed || 0; }
  return { files: (files || []).length, added, removed };
}
