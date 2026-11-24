import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { newShallowModulesOf, newTanglesOf, shallowModulesOf, symbolGraphOfIndex, tanglesOf } from '../server/core/codemap-structure-core.ts';
import { isTestPath } from '../server/core/import-graph-core.ts';
import { scipDocumentsOf } from '../server/core/scip-index-core.ts';

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
