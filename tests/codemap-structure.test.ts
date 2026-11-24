import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { grownShallowModulesOf, newShallowModulesOf, newTanglesOf, shallowModulesOf, splicedGraphOf, symbolGraphOfIndex, tanglesOf } from '../server/core/codemap-structure-core.ts';
import type { SymbolGraph } from '../server/core/codemap-structure-core.ts';
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

test('a module already shallow on mainline that shows two more symbols on the branch is not refused, only noted as grown', () => {
  const mainlineShown = Array.from({ length: 9 }, (_, index) => `contracts symbol ${index}`);
  const mainline = [{ module: 'shared/contracts', shown: mainlineShown, hiddenCount: 5 }];
  const head = [{ module: 'shared/contracts', shown: [...mainlineShown, 'contracts symbol 9', 'contracts symbol 10'], hiddenCount: 5 }];
  assert.deepEqual(newShallowModulesOf(head, mainline, []), []);
  assert.deepEqual(grownShallowModulesOf(head, mainline), [{ ...head[0], mainlineShownCount: 9 }]);
});

const shapeOf = (graph: SymbolGraph) => ({
  symbolFiles: graph.symbols.map((symbol, symbolId) => `${symbol} @ ${graph.files[graph.fileOfSymbol[symbolId]]}`),
  edges: Array.from(graph.edgesFrom, (from, edge) => `${graph.symbols[from]} > ${graph.symbols[graph.edgesTo[edge]]}`).sort(),
});

test('splicing a re-indexed or deleted file into a full graph gives the graph a full index of that tree gives', () => {
  const documents = [...scipDocumentsOf(fs.readFileSync(TYPESCRIPT_FIXTURE_INDEX))];
  const full = symbolGraphOfIndex('fixture', documents, isTestPath);
  const pongPath = 'src/beta/pong.ts';

  const reindexed = splicedGraphOf(full, symbolGraphOfIndex('fixture', documents.filter((document) => document.relativePath === pongPath), isTestPath, true), new Set([pongPath]));
  assert.deepEqual(shapeOf(reindexed.graph), shapeOf(full));
  assert.deepEqual(reindexed.staleOwnerFiles, []);
  assert.deepEqual(tanglesOf(reindexed.graph, folderOf), tanglesOf(full, folderOf));

  const deleted = splicedGraphOf(full, symbolGraphOfIndex('fixture', [], isTestPath, true), new Set([pongPath]));
  assert.deepEqual(shapeOf(deleted.graph), shapeOf(symbolGraphOfIndex('fixture', documents.filter((document) => document.relativePath !== pongPath), isTestPath)));
  assert.deepEqual(deleted.staleOwnerFiles, ['src/alpha/ping.ts']);
});
