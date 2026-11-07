import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CALL_IMPORT, EXPORT_FROM, STATIC_IMPORT } from '../../server/core/import-graph-core.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const WATCHEES_ROOT = 'cloud/watchees';
const IMPORT_CALL_WITHOUT_LITERAL = /\b(?:import|require)\s*\(\s*(?!['"][^'"]*['"]\s*\))/g;
const ALLOWED_IMPORT_PREFIXES = [
  'shared/',
  'cloud/watchees/',
  'server/core/',
  'server/github/core/',
  'server/github/github-store-poller.ts',
  'server/github/pr-gh.ts',
];

function sourceFilesUnder(repoDirectory: string): string[] {
  const absoluteDirectory = path.join(ROOT, repoDirectory);
  return fs.readdirSync(absoluteDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

function isPackageOrBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || /^@?[a-z0-9][^:]*$/i.test(specifier);
}

function strayImportsOf(repoPath: string): string[] {
  const sourceText = fs.readFileSync(path.join(ROOT, repoPath), 'utf8');
  const unreadableImports = [...sourceText.matchAll(IMPORT_CALL_WITHOUT_LITERAL)].map(() => `${repoPath} imports a path no gate can read`);
  const specifiers = [CALL_IMPORT, STATIC_IMPORT, EXPORT_FROM].flatMap((pattern) => [...sourceText.matchAll(pattern)].map((match) => match[2]));
  const resolvedPaths = specifiers
    .filter((specifier) => !isPackageOrBuiltin(specifier))
    .map((specifier) => specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), specifier)) : specifier.replace(/^#shared\//, 'shared/'));
  const disallowedImports = resolvedPaths
    .filter((importedPath) => !ALLOWED_IMPORT_PREFIXES.some((prefix) => importedPath.startsWith(prefix)))
    .map((importedPath) => `${repoPath} imports ${importedPath}`);
  return [...unreadableImports, ...disallowedImports];
}

test('a watchee imports only shared contracts, other watchee code, pure cores and the GitHub store, never server or session state', () => {
  const watcheeFiles = sourceFilesUnder(WATCHEES_ROOT);
  assert.ok(watcheeFiles.length > 0, `${WATCHEES_ROOT} holds no watchee`);
  assert.deepEqual(watcheeFiles.flatMap(strayImportsOf), []);
});
