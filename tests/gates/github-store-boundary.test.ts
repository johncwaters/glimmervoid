import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '../..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'public',
  'tests',
  'harness',
  'scripts',
  '.git',
  '.omc',
  '.glimmervoid',
  '.claude',
  '.glimmervoid-worktrees',
]);

const ALLOWED = new Set([
  path.join(ROOT, 'server', 'github', 'pr-gh.ts'),
  path.join(ROOT, 'server', 'github', 'github-store-poller.ts'),
  path.join(ROOT, 'server', 'github', 'github-store-wiring.ts'),
  path.join(ROOT, 'server', 'github', 'core', 'github-store-core.ts'),
]);

const WRITE_METHODS = new Set([
  'addPrLabel',
  'commentOnPr',
  'setIssueState',
  'rebasePr',
  'mergePr',
  'resolveReviewThread',
  'postReview',
  'dismissReview',
]);

const QUOTED_KEY = /'(\w+)'|"(\w+)"/g;
const QUOTED_KEY_PICK_PR_GH = /\bPick\s*<\s*PrGh\s*,\s*((?:'\w+'|"\w+")(?:\s*\|\s*(?:'\w+'|"\w+"))*)\s*>/g;
const QUOTED_KEY_INDEXED_PR_GH = /\bPrGh\s*\[\s*('\w+'|"\w+")\s*\]/g;
const NAMED_IMPORT = /\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g;
const METHOD_CALL = /\.\s*(\w+)\s*(?:\?\.\s*)?\(/g;

function collectJsFiles(directory: string, files: string[]): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && /\.(js|mjs|cjs|ts|mts|cts)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function namesOnlyWriteMethods(quotedKeys: string): boolean {
  return [...quotedKeys.matchAll(QUOTED_KEY)].every((key) => WRITE_METHODS.has(key[1] ?? key[2]));
}

function hasGithubRead(source: string, readMethods: Set<string>): boolean {
  for (const pick of source.matchAll(QUOTED_KEY_PICK_PR_GH)) {
    if (!namesOnlyWriteMethods(pick[1])) return true;
  }
  for (const indexedAccess of source.matchAll(QUOTED_KEY_INDEXED_PR_GH)) {
    if (!namesOnlyWriteMethods(indexedAccess[1])) return true;
  }
  const unnarrowedSource = source
    .replace(NAMED_IMPORT, '')
    .replace(QUOTED_KEY_PICK_PR_GH, '')
    .replace(QUOTED_KEY_INDEXED_PR_GH, '');
  if (/\bPrGh\b/.test(unnarrowedSource)) return true;
  if (/\btypeof\s+createPrGh\b/.test(source)) return true;
  if (!/\bcreatePrGh\b/.test(source)) return false;
  return [...source.matchAll(METHOD_CALL)].some((call) => readMethods.has(call[1]));
}

test('only the shared GitHub store modules can reach PrGh read methods', () => {
  const clientSource = fs.readFileSync(path.join(ROOT, 'server', 'github', 'pr-gh.ts'), 'utf8');
  const clientInterface = /\binterface\s+PrGh\s*\{([\s\S]*?)^\}/m.exec(clientSource);
  assert.ok(clientInterface, 'pr-gh.ts must declare interface PrGh');
  const methods = new Set([...clientInterface[1].matchAll(/^\s+(\w+)\s*\(/gm)].map((method) => method[1]));
  assert.ok(methods.size > 10, `expected to parse the PrGh methods, only found ${methods.size}`);
  for (const method of WRITE_METHODS) assert.ok(methods.has(method), `PrGh must declare write method ${method}`);
  const readMethods = new Set([...methods].filter((method) => !WRITE_METHODS.has(method)));

  const files = collectJsFiles(ROOT, []);
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);
  const offenders: string[] = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    if (hasGithubRead(fs.readFileSync(file, 'utf8'), readMethods)) offenders.push(path.relative(ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules must go through the shared GitHub store instead of reaching PrGh reads directly:\n  ${offenders.join('\n  ')}`,
  );
});
