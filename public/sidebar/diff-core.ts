interface DiffLine {
  type: string;
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export function parseHunkHeader(header: string): { oldStart: number; newStart: number } | null {
  const match = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const newStart = Number(match[2]);
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null;
  return { oldStart, newStart };
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
  hunks: DiffHunk[];
}

export function parseUnifiedDiff(diff: string | null | undefined): DiffFile[] {
  const files: DiffFile[] = [];
  if (!diff) return files;
  const lines = String(diff).split(/\r?\n/);
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let nextOldLineNumber: number | null = null;
  let nextNewLineNumber: number | null = null;

  const takeOldLineNumber = () => {
    if (nextOldLineNumber === null) return null;
    const taken = nextOldLineNumber;
    nextOldLineNumber = taken + 1;
    return taken;
  };

  const takeNewLineNumber = () => {
    if (nextNewLineNumber === null) return null;
    const taken = nextNewLineNumber;
    nextNewLineNumber = taken + 1;
    return taken;
  };

  const startFile = (header: string) => {
    const file: DiffFile = { path: '', oldPath: null, status: 'modified', added: 0, removed: 0, binary: false, hunks: [] };
    files.push(file);
    hunk = null;
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    if (m) { file.oldPath = m[1] ?? null; file.path = m[2] ?? ''; }
    return file;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) { cur = startFile(line); continue; }
    if (!cur) {
      if (!line.startsWith('--- ') && !line.startsWith('@@')) continue;
      cur = startFile('diff --git a/ b/');
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { cur.oldPath = line.slice('rename from '.length); cur.status = 'renamed'; continue; }
    if (line.startsWith('rename to ')) { cur.path = line.slice('rename to '.length); cur.status = 'renamed'; continue; }
    if (line.startsWith('Binary files')) { cur.binary = true; continue; }
    if (line.startsWith('index ') || line.startsWith('similarity index')
        || line.startsWith('dissimilarity index') || line.startsWith('old mode') || line.startsWith('new mode')) {
      continue;
    }
    if (line.startsWith('--- ')) {
      if (line === '--- /dev/null') { cur.status = 'added'; continue; }
      if (!cur.path) { const p = line.slice(4).replace(/^a\//, ''); if (p && p !== '/dev/null') cur.oldPath = cur.oldPath || p; }
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') { cur.status = 'deleted'; continue; }
      if (!cur.path) { const p = line.slice(4).replace(/^b\//, ''); if (p && p !== '/dev/null') cur.path = p; }
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      const range = parseHunkHeader(line);
      nextOldLineNumber = range ? range.oldStart : null;
      nextNewLineNumber = range ? range.newStart : null;
      continue;
    }
    if (hunk) {
      if (line === '') continue;
      const c = line[0];
      if (c === '+') {
        hunk.lines.push({ type: 'add', text: line.slice(1), oldLineNumber: null, newLineNumber: takeNewLineNumber() });
        cur.added++;
        continue;
      }
      if (c === '-') {
        hunk.lines.push({ type: 'del', text: line.slice(1), oldLineNumber: takeOldLineNumber(), newLineNumber: null });
        cur.removed++;
        continue;
      }
      if (c === '\\') {
        hunk.lines.push({ type: 'meta', text: line.slice(1).trim(), oldLineNumber: null, newLineNumber: null });
        continue;
      }
      hunk.lines.push({
        type: 'context',
        text: c === ' ' ? line.slice(1) : line,
        oldLineNumber: takeOldLineNumber(),
        newLineNumber: takeNewLineNumber(),
      });
    }
  }
  for (const f of files) { if (!f.path) f.path = f.oldPath || '(unknown)'; }
  return files;
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
