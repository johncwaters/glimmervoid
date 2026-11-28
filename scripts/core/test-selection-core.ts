import { originByDependentPath } from '../../server/core/import-graph-core.ts';

const FULL_SUITE_RATIO_CAP = 0.5;
const ISOLATE_HOME_PATH = 'tests/helpers/isolate-home.ts';
const FIXTURES_PREFIX = 'tests/fixtures/';
const GATES_PREFIX = 'tests/gates/';
const PUBLIC_PREFIX = 'public/';

const GLOBAL_TEST_INFRASTRUCTURE_PATHS: readonly string[] = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  ISOLATE_HOME_PATH,
];

const FIXTURE_PATH_PATTERN = /(?:tests\/)?fixtures\/([A-Za-z0-9._/-]+)/g;
const FIXTURE_JOIN_PATTERN = /['"]fixtures['"]\s*,\s*['"]([A-Za-z0-9._-]+)['"]/g;
const FIXTURE_FILENAME_PATTERN = /['"]([A-Za-z0-9._-]+\.(?:jsonl|json|txt|toml|pptx|py|go|rs|scip|md|yaml|yml|ts|js))['"]/g;
const FIXTURE_DIR_TOKEN = /['"]fixtures['"]|(?:tests\/)?fixtures\b/;

interface SelectedTest {
  testFile: string;
  reasons: readonly string[];
}

interface TestSelectionInput {
  changedPaths: readonly string[];
  testFiles: readonly string[];
  gateTestFiles: readonly string[];
  dependentsByPath: ReadonlyMap<string, ReadonlySet<string>>;
  filesByFixtureKey?: ReadonlyMap<string, readonly string[]>;
  fullSuiteRatioCap?: number;
}

interface TestSelectionResult {
  selected: SelectedTest[];
  escalatedToFullSuite: boolean;
  escalationReason: string | null;
  uncoveredPaths: string[];
  changedPublicFolders: string[];
}

function globalInfrastructureTriggerOf(changedPaths: readonly string[]): string | null {
  const triggerSet = new Set(GLOBAL_TEST_INFRASTRUCTURE_PATHS);
  return changedPaths.find((changedPath) => triggerSet.has(changedPath)) ?? null;
}

function changedPublicFoldersOf(changedPaths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const changedPath of changedPaths) {
    if (!changedPath.startsWith(PUBLIC_PREFIX)) continue;
    const segments = changedPath.split('/');
    if (segments.length < 3) continue;
    folders.add(`${PUBLIC_PREFIX}${segments[1]}`);
  }
  return [...folders].sort();
}

function fixtureLookupKeysOf(changedPath: string): string[] {
  if (!changedPath.startsWith(FIXTURES_PREFIX)) return [];
  const relativeFixture = changedPath.slice(FIXTURES_PREFIX.length);
  const segments = relativeFixture.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return [];
  const firstSegment = segments[0];
  const basename = segments[segments.length - 1];
  return [...new Set([`${FIXTURES_PREFIX}${relativeFixture}`, `${FIXTURES_PREFIX}${firstSegment}`, `basename:${basename}`])];
}

function extractFixtureKeys(sourceText: string): string[] {
  const keys = new Set<string>();
  const mentionsFixtures = FIXTURE_DIR_TOKEN.test(sourceText);
  if (mentionsFixtures) {
    for (const match of sourceText.matchAll(FIXTURE_PATH_PATTERN)) {
      const matchedPath = match[1].replace(/\/+$/, '');
      if (!matchedPath) continue;
      keys.add(`${FIXTURES_PREFIX}${matchedPath}`);
      const firstSegment = matchedPath.split('/')[0];
      if (firstSegment) keys.add(`${FIXTURES_PREFIX}${firstSegment}`);
    }
    for (const match of sourceText.matchAll(FIXTURE_JOIN_PATTERN)) {
      keys.add(`${FIXTURES_PREFIX}${match[1]}`);
    }
  }
  for (const match of sourceText.matchAll(FIXTURE_FILENAME_PATTERN)) {
    keys.add(`basename:${match[1]}`);
  }
  return [...keys];
}

function pathsReachingAnyTest(
  dependentsByPath: ReadonlyMap<string, ReadonlySet<string>>,
  testFiles: readonly string[],
): Set<string> {
  const importsByDependent = new Map<string, string[]>();
  for (const [importedPath, dependents] of dependentsByPath) {
    for (const dependentPath of dependents) {
      const imported = importsByDependent.get(dependentPath) ?? [];
      imported.push(importedPath);
      importsByDependent.set(dependentPath, imported);
    }
  }
  const visited = new Set<string>(testFiles);
  const queue = [...testFiles];
  for (let index = 0; index < queue.length; index++) {
    const currentPath = queue[index];
    for (const importedPath of importsByDependent.get(currentPath) ?? []) {
      if (visited.has(importedPath)) continue;
      visited.add(importedPath);
      queue.push(importedPath);
    }
  }
  return visited;
}

function fullSuiteSelection(testFiles: readonly string[], gateTestFiles: readonly string[], reason: string, changedPublicFolders: string[]): TestSelectionResult {
  const allTests = [...new Set([...gateTestFiles, ...testFiles])].sort();
  return {
    selected: allTests.map((testFile) => ({ testFile, reasons: [reason] })),
    escalatedToFullSuite: true,
    escalationReason: reason,
    uncoveredPaths: [],
    changedPublicFolders,
  };
}

function selectCoveringTests({
  changedPaths,
  testFiles,
  gateTestFiles,
  dependentsByPath,
  filesByFixtureKey = new Map(),
  fullSuiteRatioCap = FULL_SUITE_RATIO_CAP,
}: TestSelectionInput): TestSelectionResult {
  const uniqueChanged = [...new Set(changedPaths)].sort();
  const changedPublicFolders = changedPublicFoldersOf(uniqueChanged);
  if (uniqueChanged.length === 0) {
    return { selected: [], escalatedToFullSuite: false, escalationReason: null, uncoveredPaths: [], changedPublicFolders };
  }

  const infrastructureTrigger = globalInfrastructureTriggerOf(uniqueChanged);
  if (infrastructureTrigger !== null) {
    return fullSuiteSelection(testFiles, gateTestFiles, `${infrastructureTrigger} changed (global test infrastructure)`, changedPublicFolders);
  }

  const sortedTestFiles = [...testFiles].sort();
  const changedOriginByPath = originByDependentPath(dependentsByPath, uniqueChanged);
  const coveredOrigins = new Set<string>();
  const reasonsByTest = new Map<string, string[]>();

  const recordReason = (testFile: string, reason: string, origin: string) => {
    const existing = reasonsByTest.get(testFile) ?? [];
    if (!existing.includes(reason)) existing.push(reason);
    reasonsByTest.set(testFile, existing);
    coveredOrigins.add(origin);
  };

  for (const testFile of sortedTestFiles) {
    const origin = changedOriginByPath.get(testFile);
    if (origin !== undefined) {
      recordReason(testFile, origin === testFile ? `${testFile} changed` : `imports ${origin}`, origin);
    }
  }

  for (const changedPath of uniqueChanged) {
    if (changedPath.startsWith(GATES_PREFIX)) {
      coveredOrigins.add(changedPath);
      continue;
    }
    const fixtureOwners = new Set<string>();
    for (const fixtureKey of fixtureLookupKeysOf(changedPath)) {
      for (const ownerFile of filesByFixtureKey.get(fixtureKey) ?? []) fixtureOwners.add(ownerFile);
    }
    if (fixtureOwners.size === 0) continue;
    const dependentOrigins = originByDependentPath(dependentsByPath, fixtureOwners);
    for (const testFile of sortedTestFiles) {
      if (!dependentOrigins.has(testFile)) continue;
      recordReason(testFile, `reads fixture ${changedPath}`, changedPath);
    }
  }

  const selected: SelectedTest[] = [...reasonsByTest.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([testFile, reasons]) => ({ testFile, reasons }));

  if (testFiles.length > 0 && selected.length / testFiles.length >= fullSuiteRatioCap) {
    const percent = Math.round((selected.length / testFiles.length) * 100);
    const capPercent = Math.round(fullSuiteRatioCap * 100);
    const reason = `${selected.length}/${testFiles.length} non-gate tests (${percent}%) reached by diff (cap ${capPercent}%)`;
    return fullSuiteSelection(testFiles, gateTestFiles, reason, changedPublicFolders);
  }

  const potentiallyUncovered = uniqueChanged.filter((changedPath) => !coveredOrigins.has(changedPath));
  const reachingAnyTest = potentiallyUncovered.length === 0 ? new Set<string>() : pathsReachingAnyTest(dependentsByPath, testFiles);
  const uncoveredPaths = potentiallyUncovered.filter((changedPath) => !reachingAnyTest.has(changedPath));
  return { selected, escalatedToFullSuite: false, escalationReason: null, uncoveredPaths, changedPublicFolders };
}

export {
  ISOLATE_HOME_PATH,
  extractFixtureKeys,
  globalInfrastructureTriggerOf,
  selectCoveringTests,
};
export type { SelectedTest, TestSelectionInput, TestSelectionResult };
