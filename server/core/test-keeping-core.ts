import type { RemovedTestLine } from '../../shared/contracts/verification.ts';

export const TEST_FILE_PATHSPECS = [
  ':(glob)**/tests/**',
  ':(glob)**/test/**',
  ':(glob)**/__tests__/**',
  ':(glob)**/*.test.*',
  ':(glob)**/*.spec.*',
  ':(glob)**/test_*.py',
  ':(glob)**/*_test.py',
  ':(glob)**/*_test.go',
  ':(glob)**/*Test.java',
  ':(exclude,glob)**/*.md',
];

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const HUNK_STARTS = /^@@ -(\d+)(?:,\d+)? \+(\d+)/;
const TEST_DECLARATION = /\b(it|test|describe)\s*[.(]|^\s*def\s+test_?\w*\s*\(|^\s*func\s+Test\w*\s*\(|@Test\b/;
const ASSERTION = /\b(expect|assert)\w*\s*[.(]|\bassert\s|\b(strictEqual|deepStrictEqual|notStrictEqual|deepEqual|notEqual|equal|ok|throws|doesNotThrow|rejects|match)\s*\(|\.should\b|\bshould\.|\bt\.(Error|Fatal|Fail)/;
const SKIP_MARK = /\.(skip|todo)\s*\(|\b(xit|xdescribe|xtest)\s*\(|\b(skip|todo)\s*:\s*true\b|@pytest\.mark\.(skip|xfail)|\bt\.Skip\b|@(Disabled|Ignore)\b/;
const MAX_TEXT_LENGTH = 200;

type MarkedKind = 'test' | 'assertion' | 'skip';
type MarkedLine = { line: number; text: string; kind: MarkedKind };

interface FileChanges {
  oldPath: string | null;
  newPath: string | null;
  removed: MarkedLine[];
  added: MarkedLine[];
}

interface TestKeepingScanner {
  pushLine(patchLine: string): boolean;
  finish(): RemovedTestLine[];
}

const REPORTED_KIND_OF_REMOVED: Record<Exclude<MarkedKind, 'skip'>, RemovedTestLine['kind']> = { test: 'removed-test', assertion: 'removed-assertion' };

function pathOf(headerLine: string, prefix: string): string | null {
  const rawPath = headerLine.slice(4).replace(/\t.*$/, '');
  if (rawPath === '/dev/null') return null;
  return rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
}

function markOf(text: string): MarkedKind | null {
  if (TEST_DECLARATION.test(text) && !SKIP_MARK.test(text)) return 'test';
  if (SKIP_MARK.test(text)) return 'skip';
  if (ASSERTION.test(text)) return 'assertion';
  return null;
}

const COUNTERPART_KINDS: Record<MarkedKind, readonly MarkedKind[]> = { test: ['test', 'skip'], assertion: ['assertion'], skip: ['skip'] };

function unpairedOf(lines: readonly MarkedLine[], counterparts: readonly MarkedLine[], kind: MarkedKind): MarkedLine[] {
  const ofKind = lines.filter((line) => line.kind === kind);
  const counterpartsOfKind = counterparts.filter((line) => COUNTERPART_KINDS[kind].includes(line.kind));
  const unmatchedCounterpartTexts = counterpartsOfKind.map((line) => line.text);
  const withoutSameText = ofKind.filter((line) => {
    const matchIndex = unmatchedCounterpartTexts.indexOf(line.text);
    if (matchIndex === -1) return true;
    unmatchedCounterpartTexts.splice(matchIndex, 1);
    return false;
  });
  const pairedByEditCount = Math.min(withoutSameText.length, unmatchedCounterpartTexts.length);
  return withoutSameText.slice(pairedByEditCount);
}

function netChangesOf(file: FileChanges): RemovedTestLine[] {
  const removedPath = file.oldPath ?? file.newPath;
  const removedLines = removedPath === null ? [] : (['test', 'assertion'] as const).flatMap((kind) =>
    unpairedOf(file.removed, file.added, kind).map((line) => ({ path: removedPath, line: line.line, text: line.text, kind: REPORTED_KIND_OF_REMOVED[kind] })));
  const addedSkips = file.newPath === null ? [] : unpairedOf(file.added, file.removed, 'skip').map((line) => ({ path: file.newPath ?? '', line: line.line, text: line.text, kind: 'added-skip' as const }));
  return [...removedLines, ...addedSkips].sort((first, second) => first.line - second.line);
}

export function createTestKeepingScanner(limit: number): TestKeepingScanner {
  const found: RemovedTestLine[] = [];
  let file: FileChanges | null = null;
  let oldLinesLeft = 0;
  let newLinesLeft = 0;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  const settleFile = () => {
    if (file) found.push(...netChangesOf(file));
    file = null;
  };

  const readHeader = (patchLine: string) => {
    if (patchLine.startsWith('diff --git ')) {
      settleFile();
      file = { oldPath: null, newPath: null, removed: [], added: [] };
      return;
    }
    if (!file) return;
    if (patchLine.startsWith('--- ')) file.oldPath = pathOf(patchLine, 'a/');
    if (patchLine.startsWith('+++ ')) file.newPath = pathOf(patchLine, 'b/');
    const hunk = HUNK_HEADER.exec(patchLine);
    const starts = HUNK_STARTS.exec(patchLine);
    if (!hunk || !starts) return;
    oldLinesLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
    newLinesLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    oldLineNumber = Number(starts[1]);
    newLineNumber = Number(starts[2]);
  };

  const readHunkLine = (changes: FileChanges, patchLine: string) => {
    const text = patchLine.slice(1).trim().slice(0, MAX_TEXT_LENGTH);
    const kind = markOf(text);
    if (patchLine.startsWith('-')) {
      if (kind) changes.removed.push({ line: oldLineNumber, text, kind });
      oldLineNumber += 1;
      oldLinesLeft -= 1;
      return;
    }
    if (patchLine.startsWith('+')) {
      if (kind) changes.added.push({ line: newLineNumber, text, kind });
      newLineNumber += 1;
      newLinesLeft -= 1;
    }
  };

  return {
    pushLine(patchLine) {
      if (found.length >= limit) return true;
      const isInHunk = oldLinesLeft > 0 || newLinesLeft > 0;
      if (file && isInHunk && !patchLine.startsWith('\\')) {
        readHunkLine(file, patchLine);
        return false;
      }
      if (isInHunk) return false;
      readHeader(patchLine);
      return found.length >= limit;
    },
    finish() {
      settleFile();
      return found.slice(0, limit);
    },
  };
}
