import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..');
const knowledgeGraphRoot = path.join(repoRoot, 'knowledge-graph');
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git']);
const EXCLUDED_TOP_LEVEL_PATHS = new Set(['dist', 'knowledge-graph']);
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)(['"`])([^'"`]+)\1/g;
const PROCESS_ESCAPE_MODULES = new Set(['node:child_process', 'node:module', 'node:worker_threads']);
const ALLOWED_KNOWLEDGE_GRAPH_IMPORTERS = /^(server\/knowledge-graph-cli\.ts|tests\/knowledge-graph-[a-z-]+\.test\.ts)$/;

function relativeToRepo(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function isExcludedDirectory(directoryPath: string, directoryName: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(directoryName) || EXCLUDED_TOP_LEVEL_PATHS.has(relativeToRepo(directoryPath));
}

function typeScriptFilesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return isExcludedDirectory(fullPath, entry.name) ? [] : typeScriptFilesUnder(fullPath);
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function importSpecifiersOf(filePath: string): string[] {
  return [...fs.readFileSync(filePath, 'utf8').matchAll(IMPORT_SPECIFIER)].map((match) => match[2] ?? '');
}

test('the knowledge graph imports nothing from glimmervoid and never spawns a process itself', () => {
  const offenders = typeScriptFilesUnder(knowledgeGraphRoot).flatMap((filePath) => importSpecifiersOf(filePath)
    .filter((specifier) => {
      if (PROCESS_ESCAPE_MODULES.has(specifier)) return true;
      if (specifier === 'zod' || specifier.startsWith('node:')) return false;
      if (!specifier.startsWith('.')) return true;
      return !path.resolve(path.dirname(filePath), specifier).startsWith(knowledgeGraphRoot + path.sep);
    })
    .map((specifier) => `${relativeToRepo(filePath)}: ${specifier}`));
  assert.deepEqual(offenders, []);
});

test('the knowledge graph never reaches a builtin module by name at runtime', () => {
  const offenders = typeScriptFilesUnder(knowledgeGraphRoot)
    .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('getBuiltinModule'))
    .map(relativeToRepo);
  assert.deepEqual(offenders, []);
});

test('glimmervoid reaches the knowledge graph only through its CLI wiring', () => {
  const offenders = typeScriptFilesUnder(repoRoot)
    .filter((filePath) => !ALLOWED_KNOWLEDGE_GRAPH_IMPORTERS.test(relativeToRepo(filePath)))
    .flatMap((filePath) => importSpecifiersOf(filePath)
      .filter((specifier) => specifier.startsWith('.') && path.resolve(path.dirname(filePath), specifier).startsWith(knowledgeGraphRoot + path.sep))
      .map((specifier) => `${relativeToRepo(filePath)}: ${specifier}`));
  assert.deepEqual(offenders, []);
});
