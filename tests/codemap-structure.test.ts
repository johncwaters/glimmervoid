import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { newShallowModulesOf, newTanglesOf, shallowModulesOf, symbolGraphOfIndex, tanglesOf } from '../server/core/codemap-structure-core.ts';
import { isTestPath } from '../server/core/import-graph-core.ts';
import { scipDocumentsOf } from '../server/core/scip-index-core.ts';
import { indexerPinOf } from '../server/codemap/scip-indexers.ts';

const TYPESCRIPT_FIXTURE_INDEX = path.join(import.meta.dirname, 'fixtures', 'codemap-structure', 'typescript', 'index.scip');
const folderOf = (repoPath: string): string => path.posix.dirname(repoPath);

test('A scip-typescript index yields the cross-module tangle and the shallow module, and neither is new against itself', () => {
  const graph = symbolGraphOfIndex('fixture', scipDocumentsOf(fs.readFileSync(TYPESCRIPT_FIXTURE_INDEX)), isTestPath);
  const tangles = tanglesOf(graph, folderOf);
  const shallowModules = shallowModulesOf(graph, folderOf);

  assert.deepEqual(
    tangles.map(({ symbols, modules }) => ({ symbols, modules })),
    [{ symbols: ['structure-fixture src/alpha/`ping.ts`/ping().', 'structure-fixture src/beta/`pong.ts`/pong().'], modules: ['src/alpha', 'src/beta'] }],
  );
  assert.deepEqual(
    shallowModules.map(({ module, shown, hiddenCount }) => ({ module, shownCount: shown.length, hiddenCount })),
    [{ module: 'src/wide', shownCount: 8, hiddenCount: 1 }],
  );
  assert.deepEqual(newTanglesOf(tangles, tangles, []), []);
  assert.deepEqual(newShallowModulesOf(shallowModules, shallowModules, []), []);
  assert.deepEqual(newTanglesOf(tangles, [], []), tangles);
  assert.deepEqual(newTanglesOf(tangles, [], [tangles[0].key]), []);
  assert.deepEqual(newShallowModulesOf(shallowModules, [], ['src/wide']), []);
});

test('each pinned indexer has a fixture index made by that pin, and each yields its tangle', () => {
  const expectedTangleByLanguage = {
    python: { modules: ['alpha', 'beta'], symbolCount: 2 },
    go: { modules: ['ring'], symbolCount: 8 },
    rust: { modules: ['src/alpha', 'src/beta'], symbolCount: 2 },
  };
  for (const language of ['typescript', 'python', 'go', 'rust'] as const) {
    const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'codemap-structure', language);
    assert.equal(fs.readFileSync(path.join(fixtureDir, 'indexer.txt'), 'utf8').trim(), indexerPinOf(language), `regenerate ${language}/index.scip with the pinned indexer`);
  }
  for (const [language, expected] of Object.entries(expectedTangleByLanguage)) {
    const indexPath = path.join(import.meta.dirname, 'fixtures', 'codemap-structure', language, 'index.scip');
    const graph = symbolGraphOfIndex('fixture', scipDocumentsOf(fs.readFileSync(indexPath)), isTestPath);
    const tangles = tanglesOf(graph, folderOf).map(({ modules, symbols }) => ({ modules, symbolCount: symbols.length }));
    assert.deepEqual(tangles, [expected], language);
  }
});
