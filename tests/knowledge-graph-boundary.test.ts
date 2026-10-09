import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..');
const knowledgeGraphRoot = path.join(repoRoot, 'knowledge-graph');
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git']);
const EXCLUDED_TOP_LEVEL_PATHS = new Set(['dist', 'knowledge-graph']);
const SOURCE_FILE_EXTENSION = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const LITERAL_MODULE_NAME = String.raw`'([^'\n]*)'|"([^"\n]*)"|\`((?:[^\`$\\]|\$(?!\{))*)\``;
const IMPORT_SPECIFIER = new RegExp(String.raw`(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)(?:${LITERAL_MODULE_NAME})`, 'g');
const LITERAL_ONLY_CALL = String.raw`\s*\(\s*(?:${LITERAL_MODULE_NAME})\s*[,)]`;
const WHITESPACE_OR_COMMENTS = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*`;
const RUNTIME_MODULE_REACHES = [
  { name: 'non-literal import', pattern: new RegExp(String.raw`(?<![\w$])import(?![\w$])(?=${WHITESPACE_OR_COMMENTS}[(.])(?!${LITERAL_ONLY_CALL})(?!\s*\.\s*meta(?![\w$]))`) },
  { name: 'non-literal require', pattern: new RegExp(String.raw`(?<![\w$])require(?![\w$])(?!${LITERAL_ONLY_CALL})`) },
  { name: 'computed process member', pattern: /\bprocess\s*(?:\?\.\s*)?\[/ },
  { name: 'process.binding', pattern: /\bprocess\s*\??\.\s*binding\b/ },
  { name: 'process._linkedBinding', pattern: /\bprocess\s*\??\.\s*_linkedBinding\b/ },
  { name: 'process.dlopen', pattern: /\bprocess\s*\??\.\s*dlopen\b/ },
  { name: 'getBuiltinModule', pattern: /getBuiltinModule/ },
];
const ALLOWED_KNOWLEDGE_GRAPH_DEPENDENCIES = new Set(['zod', 'node:fs', 'node:path', 'node:sqlite', 'node:util']);
const ALLOWED_KNOWLEDGE_GRAPH_IMPORTERS = /^(server\/knowledge-graph-cli\.ts|tests\/knowledge-graph-[a-z-]+\.test\.ts)$/;

function relativeToRepo(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function isExcludedDirectory(directoryPath: string, directoryName: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(directoryName) || EXCLUDED_TOP_LEVEL_PATHS.has(relativeToRepo(directoryPath));
}

function sourceFilesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return isExcludedDirectory(fullPath, entry.name) ? [] : sourceFilesUnder(fullPath);
    return SOURCE_FILE_EXTENSION.test(entry.name) ? [fullPath] : [];
  });
}

function importSpecifiersOf(filePath: string): string[] {
  return [...fs.readFileSync(filePath, 'utf8').matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function findRuntimeModuleReaches(directory: string): string[] {
  return sourceFilesUnder(directory).flatMap((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    return RUNTIME_MODULE_REACHES
      .filter((reach) => reach.pattern.test(source))
      .map((reach) => `${path.relative(directory, filePath)}: ${reach.name}`);
  });
}

function resolvesInside(importerPath: string, specifier: string, directory: string): boolean {
  return specifier.startsWith('.') && path.resolve(path.dirname(importerPath), specifier).startsWith(directory + path.sep);
}

function findImportsLeaving(directory: string): string[] {
  return sourceFilesUnder(directory).flatMap((filePath) => importSpecifiersOf(filePath)
    .filter((specifier) => !ALLOWED_KNOWLEDGE_GRAPH_DEPENDENCIES.has(specifier) && !resolvesInside(filePath, specifier, directory))
    .map((specifier) => `${path.relative(directory, filePath)}: ${specifier}`));
}

test('the knowledge graph imports only its siblings, zod and the node builtins it is allowed', () => {
  assert.deepEqual(findImportsLeaving(knowledgeGraphRoot), []);
});

test('the import allow-list catches every source extension, bare builtins and requires that leave the folder', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-boundary-'));
  const fixtureDirectory = path.join(fixtureRoot, 'knowledge-graph');
  fs.mkdirSync(fixtureDirectory);
  fs.writeFileSync(path.join(fixtureDirectory, 'allowed.ts'), "import { join } from 'node:path';\nimport { helper } from './sibling.ts';\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'network.mjs'), "import net from 'node:net';\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'bare.js'), "import fs from 'fs';\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'outside.cjs'), "const host = require('../server.cjs');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'spawner.cts'), "import { spawn } from 'node:child_process';\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'workers.mts'), "const workers = await import('node:worker_threads');\n");
  assert.deepEqual(findImportsLeaving(fixtureDirectory).toSorted(), [
    'bare.js: fs',
    'network.mjs: node:net',
    'outside.cjs: ../server.cjs',
    'spawner.cts: node:child_process',
    'workers.mts: node:worker_threads',
  ]);
});

test('the knowledge graph never reaches a module by a computed name or a process binding at runtime', () => {
  assert.deepEqual(findRuntimeModuleReaches(knowledgeGraphRoot), []);
});

test('the runtime reach scan catches computed imports and requires, process bindings, dlopen and getBuiltinModule', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-boundary-'));
  const fixtureDirectory = path.join(fixtureRoot, 'knowledge-graph');
  fs.mkdirSync(fixtureDirectory);
  fs.writeFileSync(path.join(fixtureDirectory, 'allowed.ts'), "import { join } from 'node:path';\nconst sibling = await import('./sibling.ts');\nconst required = require('zod');\nconst plain = await import(`./plain.ts`);\nconst withOptions = await import('./json.ts', { with: { type: 'json' } });\nconst strict = z.object({}).required();\nconst node = store.requireNode(id);\nconst here = import.meta.dirname;\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'require-call.cjs'), "const moduleName = 'node:net';\nconst net = require.call(null, moduleName);\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'require-apply.cjs'), "const moduleName = 'node:net';\nconst net = require.apply(null, [moduleName]);\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'require-comment.cjs'), "const net = require/**/('node:net');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'import-comment.mjs'), "const net = await import/**/('node:net');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'template-import.ts'), `const target = '../server/index.ts';\nconst host = await import(\`./\${target}\`);\n`);
  fs.writeFileSync(path.join(fixtureDirectory, 'concatenated-require.cjs'), "const host = require('./' + target);\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'module-require.cjs'), "const moduleName = 'node:net';\nconst net = module.require(moduleName);\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'bracket-binding.js'), "const tcp = process['binding']('tcp_wrap');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'bracket-dlopen.mjs'), "process[\"dlopen\"](module, '/tmp/addon.node');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'bracket-computed.ts'), "const member = 'binding';\nconst tcp = process[member]('tcp_wrap');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'computed-import.ts'), "const moduleName = 'node:net';\nconst net = await import(moduleName);\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'computed-require.cjs'), "const moduleName = 'node:net';\nconst net = require( moduleName);\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'binding.js'), "const tcp = process.binding('tcp_wrap');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'linked.mjs'), "const linked = process._linkedBinding('custom');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'native.mts'), "process.dlopen(module, '/tmp/addon.node');\n");
  fs.writeFileSync(path.join(fixtureDirectory, 'builtin.cts'), "const net = process.getBuiltinModule('node:net');\n");
  assert.deepEqual(findRuntimeModuleReaches(fixtureDirectory).toSorted(), [
    'binding.js: process.binding',
    'bracket-binding.js: computed process member',
    'bracket-computed.ts: computed process member',
    'bracket-dlopen.mjs: computed process member',
    'builtin.cts: getBuiltinModule',
    'computed-import.ts: non-literal import',
    'computed-require.cjs: non-literal require',
    'concatenated-require.cjs: non-literal require',
    'import-comment.mjs: non-literal import',
    'linked.mjs: process._linkedBinding',
    'module-require.cjs: non-literal require',
    'native.mts: process.dlopen',
    'require-apply.cjs: non-literal require',
    'require-call.cjs: non-literal require',
    'require-comment.cjs: non-literal require',
    'template-import.ts: non-literal import',
  ]);
});

test('glimmervoid reaches the knowledge graph only through its CLI wiring', () => {
  const offenders = sourceFilesUnder(repoRoot)
    .filter((filePath) => !ALLOWED_KNOWLEDGE_GRAPH_IMPORTERS.test(relativeToRepo(filePath)))
    .flatMap((filePath) => importSpecifiersOf(filePath)
      .filter((specifier) => resolvesInside(filePath, specifier, knowledgeGraphRoot))
      .map((specifier) => `${relativeToRepo(filePath)}: ${specifier}`));
  assert.deepEqual(offenders, []);
});
