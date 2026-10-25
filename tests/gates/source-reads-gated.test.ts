import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const nonGateTest = /^tests\/(?!gates\/).+\.test\.[cm]?[jt]s$/;
const inlineRepoAnchor = /import\.meta\.(?:dirname|url)|new URL\(|process\.cwd\(\)/;
const anchorAssignment = /\b(?:const|let)\s+(\w+)\s*=\s*([^;\n]+)/g;
const baseReadNames = ['readFileSync', 'readFile', 'readTracked'];
const fsImport = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g;
const aliasedReadImport = /\b(?:readFileSync|readFile)\s+as\s+(\w+)/g;
const allowedTarget = /fixtures|\.json['"`]/;
const leadingStringLiteral = /^\s*(['"`])([^'"`$]+)\1/;

function argumentTextAt(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index++) {
    if (source[index] === '(') depth++;
    if (source[index] === ')') depth--;
    if (depth === 0) return source.slice(openParenIndex + 1, index);
  }
  return source.slice(openParenIndex + 1);
}

function mentionsName(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

function readCallNamesIn(source: string): string[] {
  const names = [...baseReadNames];
  for (const [, specifiers] of source.matchAll(fsImport)) {
    for (const [, alias] of specifiers.matchAll(aliasedReadImport)) names.push(alias);
  }
  return names;
}

function repoAnchorNames(source: string): string[] {
  const names = ['REPO_ROOT', 'repoRoot'];
  const assignments = [...source.matchAll(anchorAssignment)].filter(([, , initializer]) => !allowedTarget.test(initializer));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [, name, initializer] of assignments) {
      if (names.includes(name)) continue;
      if (!inlineRepoAnchor.test(initializer) && !names.some((anchorName) => mentionsName(initializer, anchorName))) continue;
      names.push(name);
      grew = true;
    }
  }
  return names;
}

function namesTrackedPath(argumentText: string, trackedPaths: Set<string>): boolean {
  const literal = leadingStringLiteral.exec(argumentText)?.[2];
  if (literal === undefined) return false;
  return trackedPaths.has(path.posix.normalize(literal));
}

function sourceReadsIn(repoPath: string, trackedPaths: Set<string>): string[] {
  const source = readTracked(repoPath);
  const anchorNames = repoAnchorNames(source);
  const readCall = new RegExp(`\\b(${readCallNamesIn(source).join('|')})\\s*\\(`, 'g');
  const reads: string[] = [];
  for (const match of source.matchAll(readCall)) {
    const openParenIndex = (match.index ?? 0) + match[0].length - 1;
    const argumentText = argumentTextAt(source, openParenIndex);
    const lineNumber = source.slice(0, match.index).split('\n').length;
    const isRepoRooted = match[1] === 'readTracked'
      || inlineRepoAnchor.test(argumentText)
      || namesTrackedPath(argumentText, trackedPaths)
      || anchorNames.some((name) => mentionsName(argumentText, name));
    if (isRepoRooted && !allowedTarget.test(argumentText)) reads.push(`${repoPath}:${lineNumber}`);
  }
  return reads;
}

test('only tests/gates/ reads tracked source text', () => {
  const testFiles = trackedFiles(nonGateTest);
  assert.ok(testFiles.length > 0, 'no test file outside tests/gates/ matched: the path pattern no longer matches');
  const trackedPaths = new Set(trackedFiles(/./));
  const offenders = testFiles.flatMap((repoPath) => sourceReadsIn(repoPath, trackedPaths));
  assert.deepEqual(offenders, [], 'a test that reads one module\'s source pins its text, not its behavior: drive the module, or write a repo-wide gate in tests/gates/');
});
