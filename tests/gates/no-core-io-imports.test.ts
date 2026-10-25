import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CALL_IMPORT, EXPORT_FROM, STATIC_IMPORT } from '../../server/core/import-graph-core.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const CORE_DIRECTORY_ROOTS = new Set(['server', 'session', 'notifications', 'detection']);
const CORE_SUFFIX_ROOTS = new Set(['server', 'shared', 'public']);
const SCANNED_ROOTS = [...new Set([...CORE_DIRECTORY_ROOTS, ...CORE_SUFFIX_ROOTS])];
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']);
const FORBIDDEN_NODE_MODULES = new Set([
  'node:fs',
  'node:child_process',
  'node:os',
  'node:http',
  'node:https',
  'node:net',
]);

interface RuntimeImport {
  specifier: string;
  lineNumber: number;
}

function collectSourceFiles(directory: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(path.relative(ROOT, absolutePath).split(path.sep).join('/'));
  }
  return files;
}

function isInCoreDirectory(repoPath: string): boolean {
  const segments = repoPath.split('/');
  return CORE_DIRECTORY_ROOTS.has(segments[0]) && segments.slice(1, -1).includes('core');
}

function isSuffixedCore(repoPath: string): boolean {
  return CORE_SUFFIX_ROOTS.has(repoPath.split('/')[0]) && repoPath.endsWith('-core.ts');
}

function isCore(repoPath: string): boolean {
  return isInCoreDirectory(repoPath) || isSuffixedCore(repoPath);
}

function runtimeImports(sourceText: string): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  for (const pattern of [CALL_IMPORT, STATIC_IMPORT, EXPORT_FROM]) {
    pattern.lastIndex = 0;
    for (const match of sourceText.matchAll(pattern)) {
      if (/^(?:import|export)\s+type\b(?!\s*(?:from\b|,))/.test(match[0])) continue;
      imports.push({ specifier: match[2], lineNumber: sourceText.slice(0, match.index).split('\n').length });
    }
  }
  return imports;
}

const SHARED_IMPORT_ALIAS = '#shared/';

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith(SHARED_IMPORT_ALIAS);
}

function resolveLocal(importerPath: string, specifier: string): string {
  if (specifier.startsWith(SHARED_IMPORT_ALIAS)) return `shared/${specifier.slice(SHARED_IMPORT_ALIAS.length)}`;
  return path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
}

function sharedModuleReachesIo(sharedPath: string): boolean {
  const visitedSharedPaths = new Set([sharedPath]);
  const pendingSharedPaths = [sharedPath];
  for (let index = 0; index < pendingSharedPaths.length; index++) {
    const currentPath = pendingSharedPaths[index];
    for (const { specifier } of runtimeImports(fs.readFileSync(path.join(ROOT, currentPath), 'utf8'))) {
      if (FORBIDDEN_NODE_MODULES.has(specifier)) return true;
      if (!isLocalSpecifier(specifier)) continue;
      const importedPath = resolveLocal(currentPath, specifier);
      if (!importedPath.startsWith('shared/') || visitedSharedPaths.has(importedPath)) continue;
      visitedSharedPaths.add(importedPath);
      pendingSharedPaths.push(importedPath);
    }
  }
  return false;
}

function impurityOf(importerPath: string, specifier: string): string | null {
  if (FORBIDDEN_NODE_MODULES.has(specifier)) return 'an IO module';
  if (!isLocalSpecifier(specifier)) return null;
  const importedPath = resolveLocal(importerPath, specifier);
  if (isCore(importedPath)) return null;
  if (!importedPath.startsWith('shared/')) return 'a module that is neither a core nor in shared/';
  if (sharedModuleReachesIo(importedPath)) return 'a shared module that reaches an IO module';
  return null;
}

test('pure cores import no IO module and nothing outside the cores and shared/', () => {
  const cores = SCANNED_ROOTS.flatMap((root) => collectSourceFiles(path.join(ROOT, root))).filter(isCore);
  assert.ok(cores.length > 200, `expected to scan every pure core, only found ${cores.length} files`);
  assert.ok(cores.some((core) => core.startsWith('public/')), 'expected to scan the browser cores');

  const offenders: string[] = [];
  for (const core of cores) {
    for (const { specifier, lineNumber } of runtimeImports(fs.readFileSync(path.join(ROOT, core), 'utf8'))) {
      const impurity = impurityOf(core, specifier);
      if (!impurity) continue;
      offenders.push(`${core}:${lineNumber}: imports ${specifier}, ${impurity}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Pure cores must receive IO through injected seams:\n  ${offenders.join('\n  ')}`,
  );
});
