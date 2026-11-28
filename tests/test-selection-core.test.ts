import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildImportGraph, extractImportSpecifiers } from '../server/core/import-graph-core.ts';
import {
  ISOLATE_HOME_PATH,
  extractFixtureKeys,
  selectCoveringTests,
} from '../scripts/core/test-selection-core.ts';

test('selectCoveringTests resolves transitive imports, direct test edits, fixtures, cap escalation, uncovered paths, and public folder notices', () => {
  const sourcesByPath = new Map<string, string>([
    ['shared/leaf.ts', 'export const leaf = 1;'],
    ['server/mid.ts', "import { leaf } from '../shared/leaf.ts'; export const mid = leaf + 1;"],
    ['server/other.ts', 'export const other = 2;'],
    ['public/board-session/card.ts', 'export const card = true;'],
    [ISOLATE_HOME_PATH, "import '../../server/other.ts';"],
    ['tests/alpha.test.ts', "import './helpers/isolate-home.ts'; import { mid } from '../server/mid.ts'; void mid;"],
    ['tests/beta.test.ts', "import './helpers/isolate-home.ts'; const f = 'tests/fixtures/agent-models/agy.txt'; void f;"],
    ['tests/gamma.test.ts', "import './helpers/isolate-home.ts'; import { other } from '../server/other.ts'; void other;"],
    ['tests/delta.test.ts', "import './helpers/isolate-home.ts';"],
  ]);

  const specifiersByPath = new Map(
    [...sourcesByPath].map(([filePath, sourceText]): [string, string[]] => [
      filePath,
      filePath === ISOLATE_HOME_PATH ? [] : extractImportSpecifiers(sourceText),
    ]),
  );
  const { dependentsByPath } = buildImportGraph({ specifiersByPath, importsMap: {} });
  const testFiles = ['tests/alpha.test.ts', 'tests/beta.test.ts', 'tests/gamma.test.ts', 'tests/delta.test.ts'];
  const gateTestFiles = ['tests/gates/sample.test.ts'];
  const filesByFixtureKey = new Map<string, string[]>();
  for (const testFile of testFiles) {
    for (const key of extractFixtureKeys(sourcesByPath.get(testFile) ?? '')) {
      filesByFixtureKey.set(key, [...(filesByFixtureKey.get(key) ?? []), testFile]);
    }
  }

  const transitive = selectCoveringTests({
    changedPaths: ['shared/leaf.ts', 'docs/notes.md', 'public/board-session/card.ts'],
    testFiles,
    gateTestFiles,
    dependentsByPath,
    filesByFixtureKey,
  });
  assert.equal(transitive.escalatedToFullSuite, false);
  assert.deepEqual(transitive.selected.map((entry) => entry.testFile), ['tests/alpha.test.ts']);
  assert.deepEqual(transitive.uncoveredPaths, ['docs/notes.md', 'public/board-session/card.ts']);
  assert.deepEqual(transitive.changedPublicFolders, ['public/board-session']);

  const directAndFixture = selectCoveringTests({
    changedPaths: ['tests/delta.test.ts', 'tests/fixtures/agent-models/agy.txt'],
    testFiles,
    gateTestFiles,
    dependentsByPath,
    filesByFixtureKey,
    fullSuiteRatioCap: 0.75,
  });
  assert.equal(directAndFixture.escalatedToFullSuite, false);
  assert.deepEqual(directAndFixture.selected.map((entry) => entry.testFile), ['tests/beta.test.ts', 'tests/delta.test.ts']);
  assert.deepEqual(directAndFixture.uncoveredPaths, []);

  const isolatedFromBootstrap = selectCoveringTests({
    changedPaths: ['server/other.ts'],
    testFiles,
    gateTestFiles,
    dependentsByPath,
    filesByFixtureKey,
  });
  assert.deepEqual(isolatedFromBootstrap.selected.map((entry) => entry.testFile), ['tests/gamma.test.ts']);

  const escalatedByCap = selectCoveringTests({
    changedPaths: ['shared/leaf.ts', 'server/other.ts'],
    testFiles,
    gateTestFiles,
    dependentsByPath,
    filesByFixtureKey,
    fullSuiteRatioCap: 0.5,
  });
  assert.equal(escalatedByCap.escalatedToFullSuite, true);
  assert.equal(escalatedByCap.selected.length, testFiles.length + gateTestFiles.length);

  const escalatedByInfra = selectCoveringTests({
    changedPaths: [ISOLATE_HOME_PATH],
    testFiles,
    gateTestFiles,
    dependentsByPath,
    filesByFixtureKey,
  });
  assert.equal(escalatedByInfra.escalatedToFullSuite, true);
});
