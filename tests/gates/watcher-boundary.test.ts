import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CALL_IMPORT, EXPORT_FROM, STATIC_IMPORT } from '../../server/core/import-graph-core.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const WATCHER_ROOT = 'cloud/watcher';
const CODE_FILE = /\.(?:[cm]?ts|[cm]?js)$/;
const MODULE_LOADER = /\bcreateRequire\b|['"](?:node:)?module['"]/;
const IMPORT_CALL_WITHOUT_LITERAL = /\b(?:import|require)\s*\(\s*(?!['"][^'"]*['"]\s*\))/g;
const ALLOWED_IMPORT_PREFIXES = [
  'shared/clock.ts',
  'shared/contracts/watcher-link.ts',
  'shared/loopback-hosts.ts',
  'cloud/link/core/',
  'cloud/watcher/',
];

function sourceFilesUnder(repoDirectory: string): string[] {
  const absoluteDirectory = path.join(ROOT, repoDirectory);
  return fs.readdirSync(absoluteDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && CODE_FILE.test(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

function isPackageOrBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || /^@?[a-z0-9][^:]*$/i.test(specifier);
}

function strayImportsOf(repoPath: string): string[] {
  const sourceText = fs.readFileSync(path.join(ROOT, repoPath), 'utf8');
  const unreadableImports = [...sourceText.matchAll(IMPORT_CALL_WITHOUT_LITERAL)].map(() => `${repoPath} imports a path no gate can read`);
  const moduleLoaders = MODULE_LOADER.test(sourceText) ? [`${repoPath} builds its own module loader`] : [];
  const nonTypescriptFiles = repoPath.endsWith('.ts') ? [] : [`${repoPath} is not a .ts file`];
  const specifiers = [CALL_IMPORT, STATIC_IMPORT, EXPORT_FROM].flatMap((pattern) => [...sourceText.matchAll(pattern)].map((match) => match[2]));
  const resolvedPaths = specifiers
    .filter((specifier) => !isPackageOrBuiltin(specifier))
    .map((specifier) => specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), specifier)) : specifier.replace(/^#shared\//, 'shared/'));
  const disallowedImports = resolvedPaths
    .filter((importedPath) => !ALLOWED_IMPORT_PREFIXES.some((prefix) => importedPath.startsWith(prefix)))
    .map((importedPath) => `${repoPath} imports ${importedPath}`);
  return [...unreadableImports, ...moduleLoaders, ...nonTypescriptFiles, ...disallowedImports];
}

test('the watcher imports only the link contract, the link signing core and its own code, so it can run on a box with no server', () => {
  const watcherFiles = sourceFilesUnder(WATCHER_ROOT);
  assert.ok(watcherFiles.length > 0, `${WATCHER_ROOT} holds no watcher`);
  const reachableFiles = [...watcherFiles, ...sourceFilesUnder('cloud/link/core'), ...ALLOWED_IMPORT_PREFIXES.filter((prefix) => CODE_FILE.test(prefix))];
  assert.deepEqual(reachableFiles.flatMap(strayImportsOf), []);
});
