import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANGE_MAP_LIST_CAP,
  BlastRadiusFact,
  UntestedFileFact,
} from '../shared/contracts/change-map.ts';
import {
  CALL_IMPORT,
  STATIC_IMPORT,
  buildImportGraph,
  computeBlastRadius,
  extractImportSpecifiers,
  isTestPath,
  resolveSpecifier,
} from '../server/core/import-graph-core.ts';

test('extraction keeps static, type, call and re-export specifiers in source order without duplicates', () => {
  const sourceText = [
    "import main from './main.ts';",
    "const lazy = import('./lazy.ts');",
    "import type { Shape } from './shape.ts';",
    "export { main } from './main.ts';",
    "const legacy = require('./legacy.js');",
    "export type { Shape } from './shape.ts';",
    "export * from './barrel.ts';",
    "import './side-effect.ts';",
  ].join('\n');

  assert.deepEqual(extractImportSpecifiers(sourceText), [
    './main.ts', './lazy.ts', './shape.ts', './legacy.js', './barrel.ts', './side-effect.ts',
  ]);
  assert.equal(CALL_IMPORT.global, true);
  assert.equal(STATIC_IMPORT.global, true);
  assert.deepEqual(extractImportSpecifiers(sourceText), extractImportSpecifiers(sourceText));
});

test('extraction stays linear on whitespace runs and quote-free export lines', () => {
  const whitespaceRun = `import${' '.repeat(20000)}x from${' '.repeat(20000)}`;
  const quoteFreeExports = Array.from({ length: 5000 }, (_, index) => `export default value${index}`).join('\n');
  const startedAt = performance.now();
  assert.deepEqual(extractImportSpecifiers(whitespaceRun), []);
  assert.deepEqual(extractImportSpecifiers(quoteFreeExports), []);
  assert.deepEqual(extractImportSpecifiers(`${quoteFreeExports}\nexport * from './tail.ts';`), ['./tail.ts']);
  assert.ok(performance.now() - startedAt < 250);
});

test('extraction handles compact and multi-line clauses without matching identifiers that start with import', () => {
  const sourceText = "import{a}from'./compact.ts'\nimport {\n  b,\n  c\n} from \"./multi.ts\"\nimport { importantThing } from './named.ts'\nArray.from('abc');";
  assert.deepEqual(extractImportSpecifiers(sourceText), ['./compact.ts', './multi.ts', './named.ts']);
});

test('specifier resolution checks repo paths and package import aliases', () => {
  const knownPaths = new Set([
    'server/main.ts',
    'server/feature.ts',
    'server/feature.js',
    'server/dynamic.mjs',
    'server/view.tsx',
    'server/widget/index.ts',
    'server/legacy/index.js',
    'shared/contracts/change-map.ts',
    'shared/exact.ts',
  ]);
  const importsMap = { '#shared/*': './shared/*', '#exact': './shared/exact.ts' };
  const resolve = (specifier: string) => resolveSpecifier({
    fromPath: 'server/main.ts', specifier, knownPaths, importsMap,
  });

  assert.equal(resolve('./feature.ts'), 'server/feature.ts');
  assert.equal(resolve('./feature'), 'server/feature.ts');
  assert.equal(resolve('./dynamic'), 'server/dynamic.mjs');
  assert.equal(resolve('./view'), 'server/view.tsx');
  assert.equal(resolve('./widget'), 'server/widget/index.ts');
  assert.equal(resolve('./legacy'), 'server/legacy/index.js');
  assert.equal(resolve('#shared/contracts/change-map'), 'shared/contracts/change-map.ts');
  assert.equal(resolve('#exact'), 'shared/exact.ts');
  assert.equal(resolve('./missing'), null);
  assert.equal(resolve('#unknown/file'), null);
  assert.equal(resolve('express'), null);
  assert.equal(resolve('node:fs'), null);
});

test('graph stores direct reverse edges and blast radius counts unique paths through a cycle', () => {
  const graph = buildImportGraph({
    specifiersByPath: new Map([
      ['src/a.ts', ['./b.ts']],
      ['src/b.ts', ['./a.ts']],
      ['src/c.ts', ['./a.ts']],
      ['tests/a.test.ts', ['../src/c.ts']],
      ['src/lone.ts', []],
    ]),
    importsMap: {},
  });

  assert.deepEqual([...graph.dependentsByPath.get('src/a.ts') ?? []], ['src/b.ts', 'src/c.ts']);
  const facts = computeBlastRadius({
    repoName: 'repo', graph, changedPaths: ['src/a.ts', 'src/lone.ts', 'tests/a.test.ts', 'src/a.ts'],
  });

  assert.deepEqual(facts.blastRadius, [{
    factId: 'blast:repo:src/a.ts',
    path: 'src/a.ts',
    directDependents: ['src/b.ts', 'src/c.ts'],
    directDependentCount: 2,
    transitiveDependentCount: 3,
    dependentTests: ['tests/a.test.ts'],
    dependentTestCount: 1,
  }]);
  assert.deepEqual(facts.untestedFiles, [{ factId: 'untested:repo:src/lone.ts', path: 'src/lone.ts' }]);
  assert.equal(BlastRadiusFact.safeParse(facts.blastRadius[0]).success, true);
  assert.equal(UntestedFileFact.safeParse(facts.untestedFiles[0]).success, true);
});

test('depth bound limits transitive reach and test detection covers directory and file names', () => {
  const graph = buildImportGraph({
    specifiersByPath: new Map([
      ['src/source.ts', []],
      ['src/adapter.ts', ['./source.ts']],
      ['test/source.spec.ts', ['../src/adapter.ts']],
    ]),
    importsMap: {},
  });
  const facts = computeBlastRadius({ repoName: 'repo', graph, changedPaths: ['src/source.ts'], maxDepth: 1 });

  assert.equal(facts.blastRadius[0].directDependentCount, 1);
  assert.equal(facts.blastRadius[0].transitiveDependentCount, 1);
  assert.equal(facts.blastRadius[0].dependentTestCount, 0);
  assert.deepEqual(facts.untestedFiles.map((fact) => fact.path), ['src/source.ts']);
  assert.equal(isTestPath('src/__tests__/source.ts'), true);
  assert.equal(isTestPath('tests/source.ts'), true);
  assert.equal(isTestPath('test/source.ts'), true);
  assert.equal(isTestPath('src/source.test.ts'), true);
  assert.equal(isTestPath('src/source.spec.js'), true);
  assert.equal(isTestPath('src/source.ts'), false);
});

test('blast radius caps sorted lists while preserving full counts', () => {
  const dependents = Array.from({ length: CHANGE_MAP_LIST_CAP + 3 }, (_, index) => `src/dependent-${String(index).padStart(2, '0')}.ts`);
  const tests = Array.from({ length: CHANGE_MAP_LIST_CAP + 3 }, (_, index) => `tests/dependent-${String(index).padStart(2, '0')}.test.ts`);
  const specifiersByPath = new Map<string, string[]>([['src/source.ts', []]]);
  for (const dependentPath of dependents) specifiersByPath.set(dependentPath, ['./source.ts']);
  for (const testPath of tests) specifiersByPath.set(testPath, ['../src/source.ts']);
  const graph = buildImportGraph({ specifiersByPath, importsMap: {} });
  const { blastRadius } = computeBlastRadius({ repoName: 'repo', graph, changedPaths: ['src/source.ts'] });

  assert.equal(blastRadius[0].directDependentCount, dependents.length + tests.length);
  assert.equal(blastRadius[0].transitiveDependentCount, dependents.length + tests.length);
  assert.equal(blastRadius[0].dependentTestCount, tests.length);
  assert.deepEqual(blastRadius[0].directDependents, [...dependents, ...tests].sort().slice(0, CHANGE_MAP_LIST_CAP));
  assert.deepEqual(blastRadius[0].dependentTests, tests.slice(0, CHANGE_MAP_LIST_CAP));
  assert.equal(BlastRadiusFact.safeParse(blastRadius[0]).success, true);
});

test('blast facts sort by reach then path and unknown source paths remain untested', () => {
  const graph = buildImportGraph({
    specifiersByPath: new Map([
      ['src/a.ts', []],
      ['src/b.ts', []],
      ['src/c.ts', []],
      ['src/a-reader.ts', ['./a.ts']],
      ['src/a-reader-two.ts', ['./a.ts']],
      ['src/b-reader.ts', ['./b.ts']],
      ['src/c-reader.ts', ['./c.ts']],
    ]),
    importsMap: {},
  });
  const facts = computeBlastRadius({
    repoName: 'repo', graph, changedPaths: ['src/c.ts', 'src/missing.ts', 'src/b.ts', 'src/a.ts'],
  });

  assert.deepEqual(facts.blastRadius.map((fact) => fact.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(facts.untestedFiles.map((fact) => fact.path), [
    'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/missing.ts',
  ]);
});
