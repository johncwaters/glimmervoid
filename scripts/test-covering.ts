import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readImportsMap } from '../server/change-map/core/change-map-core.ts';
import { buildImportGraph, extractImportSpecifiers } from '../server/core/import-graph-core.ts';
import { clock } from '../shared/clock.ts';
import {
  ISOLATE_HOME_PATH,
  extractFixtureKeys,
  globalInfrastructureTriggerOf,
  selectCoveringTests,
} from './core/test-selection-core.ts';
import type { TestSelectionResult } from './core/test-selection-core.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mjs', '*.js', '*.jsx', '*.json'];
const USAGE = 'usage: node scripts/test-covering.ts [--since <ref> | --changed <path>... | --all] [--list] [--no-gates]';

type DiffChoice = { kind: 'all' } | { kind: 'since'; commit: string | null } | { kind: 'changed'; paths: string[] };

interface RunRequest {
  choice: DiffChoice;
  isListOnly: boolean;
  includeGates: boolean;
}

function gitLines(gitArguments: readonly string[]): string[] | null {
  const run = spawnSync('git', gitArguments, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return null;
  return run.stdout.split('\n').filter((line) => line !== '');
}

function scrubInheritedGitLocalEnv(): void {
  const localEnvVars = gitLines(['rev-parse', '--local-env-vars']) ?? [];
  for (const name of localEnvVars) delete process.env[name];
}

function listRepoSourcePaths(): string[] | null {
  const listed = gitLines(['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_GLOBS]);
  if (listed === null) return null;
  return listed.filter((sourcePath) => !sourcePath.startsWith('site/') && fs.existsSync(path.join(REPO_ROOT, sourcePath)));
}

function normalizeChangedPath(rawPath: string): string {
  const posixRaw = rawPath.replaceAll('\\', '/');
  const resolved = path.resolve(REPO_ROOT, posixRaw);
  return path.relative(REPO_ROOT, resolved).replaceAll('\\', '/');
}

function partitionTestFiles(sourcePaths: readonly string[]): { testFiles: string[]; gateTestFiles: string[] } {
  const testFiles: string[] = [];
  const gateTestFiles: string[] = [];
  for (const sourcePath of sourcePaths) {
    if (!sourcePath.startsWith('tests/') || !sourcePath.endsWith('.test.ts')) continue;
    if (sourcePath.startsWith('tests/gates/')) {
      gateTestFiles.push(sourcePath);
      continue;
    }
    testFiles.push(sourcePath);
  }
  return { testFiles: testFiles.sort(), gateTestFiles: gateTestFiles.sort() };
}

function defaultBaseRef(): string | null {
  for (const candidate of ['main', 'origin/main']) {
    const resolved = gitLines(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (resolved !== null && resolved.length > 0) return candidate;
  }
  return null;
}

function changedPathsSince(requestedCommit: string | null): string[] | null {
  const targetRef = requestedCommit ?? defaultBaseRef();
  if (targetRef === null) return null;
  const mergeBase = gitLines(['merge-base', targetRef, 'HEAD'])?.[0];
  if (mergeBase === undefined) return null;
  const changedTrackedPaths = gitLines(['diff', '--name-only', mergeBase]);
  const untrackedPaths = gitLines(['ls-files', '--others', '--exclude-standard']);
  if (changedTrackedPaths === null || untrackedPaths === null) return null;
  return [...new Set([...changedTrackedPaths, ...untrackedPaths])];
}

function scanRepoGraphAndFixtures(sourcePaths: readonly string[], changedPaths: readonly string[]): {
  dependentsByPath: Map<string, Set<string>>;
  filesByFixtureKey: Map<string, string[]>;
} {
  const specifiersByPath = new Map<string, string[]>();
  const filesByFixtureKey = new Map<string, string[]>();
  for (const sourcePath of sourcePaths) {
    if (sourcePath.endsWith('.json')) {
      specifiersByPath.set(sourcePath, []);
      continue;
    }
    const sourceText = fs.readFileSync(path.join(REPO_ROOT, sourcePath), 'utf8');
    const specifiers = sourcePath === ISOLATE_HOME_PATH ? [] : extractImportSpecifiers(sourceText);
    specifiersByPath.set(sourcePath, specifiers);
    if (!sourcePath.startsWith('tests/') || sourcePath.startsWith('tests/gates/') || sourcePath.startsWith('tests/fixtures/')) continue;
    for (const fixtureKey of extractFixtureKeys(sourceText)) {
      const linkedFiles = filesByFixtureKey.get(fixtureKey) ?? [];
      linkedFiles.push(sourcePath);
      filesByFixtureKey.set(fixtureKey, linkedFiles);
    }
  }
  for (const changedPath of changedPaths) {
    if (!specifiersByPath.has(changedPath)) specifiersByPath.set(changedPath, []);
  }
  const packageJsonText = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const { dependentsByPath } = buildImportGraph({ specifiersByPath, importsMap: readImportsMap(packageJsonText) });
  return { dependentsByPath, filesByFixtureKey };
}

function fullSuiteResult(testFiles: readonly string[], gateTestFiles: readonly string[], reason: string): TestSelectionResult {
  const allTests = [...new Set([...gateTestFiles, ...testFiles])].sort();
  return {
    selected: allTests.map((testFile) => ({ testFile, reasons: [reason] })),
    escalatedToFullSuite: true,
    escalationReason: reason,
    uncoveredPaths: [],
    changedPublicFolders: [],
  };
}

function selectForRequest(choice: DiffChoice, sourcePaths: readonly string[], includeGates: boolean): { result: TestSelectionResult; hadChangedPaths: boolean } {
  const { testFiles, gateTestFiles } = partitionTestFiles(sourcePaths);
  const activeGateTestFiles = includeGates ? gateTestFiles : [];
  if (choice.kind === 'all') {
    return { result: fullSuiteResult(testFiles, activeGateTestFiles, '--all'), hadChangedPaths: true };
  }
  const changedPaths = choice.kind === 'changed' ? choice.paths.map(normalizeChangedPath) : changedPathsSince(choice.commit);
  if (changedPaths === null) {
    const refLabel = choice.kind === 'since' ? (choice.commit ?? 'main') : 'the change';
    return { result: fullSuiteResult(testFiles, activeGateTestFiles, `git could not diff against ${refLabel}, so the full suite runs`), hadChangedPaths: true };
  }
  if (changedPaths.length === 0) {
    return {
      result: { selected: [], escalatedToFullSuite: false, escalationReason: null, uncoveredPaths: [], changedPublicFolders: [] },
      hadChangedPaths: false,
    };
  }
  if (globalInfrastructureTriggerOf(changedPaths) !== null) {
    return {
      result: selectCoveringTests({ changedPaths, testFiles, gateTestFiles: activeGateTestFiles, dependentsByPath: new Map() }),
      hadChangedPaths: true,
    };
  }
  const { dependentsByPath, filesByFixtureKey } = scanRepoGraphAndFixtures(sourcePaths, changedPaths);
  return {
    result: selectCoveringTests({ changedPaths, testFiles, gateTestFiles: activeGateTestFiles, dependentsByPath, filesByFixtureKey }),
    hadChangedPaths: true,
  };
}

function parseRunRequest(argumentList: readonly string[]): RunRequest | null {
  let isListOnly = false;
  let includeGates = true;
  const positionalFlags: string[] = [];
  for (const argument of argumentList) {
    if (argument === '--list') {
      isListOnly = true;
      continue;
    }
    if (argument === '--no-gates') {
      includeGates = false;
      continue;
    }
    positionalFlags.push(argument);
  }
  if (positionalFlags.length === 0) return { choice: { kind: 'since', commit: null }, isListOnly, includeGates };
  const [flag, ...values] = positionalFlags;
  if (flag === '--all' && values.length === 0) return { choice: { kind: 'all' }, isListOnly, includeGates };
  if (flag === '--since' && values.length === 1) return { choice: { kind: 'since', commit: values[0] }, isListOnly, includeGates };
  if (flag === '--changed' && values.length > 0) return { choice: { kind: 'changed', paths: values }, isListOnly, includeGates };
  return null;
}

function runTestFiles(testFiles: readonly string[]): number {
  const startedAt = clock.nowMs();
  const run = spawnSync(
    process.execPath,
    ['--import', './tests/helpers/isolate-home.ts', '--test', ...testFiles],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  console.log(`[test:covering] ran ${testFiles.length} test file(s) in ${clock.nowMs() - startedAt} ms`);
  return run.status ?? 1;
}

function main(argumentList: readonly string[]): number {
  const request = parseRunRequest(argumentList);
  if (request === null) {
    console.error(USAGE);
    return 2;
  }

  scrubInheritedGitLocalEnv();
  const selectStartedAt = clock.nowMs();
  const sourcePaths = listRepoSourcePaths();
  if (sourcePaths === null) {
    console.error('[test:covering] git ls-files failed; cannot determine covering tests');
    return 1;
  }
  const { gateTestFiles } = partitionTestFiles(sourcePaths);
  const { result, hadChangedPaths } = selectForRequest(request.choice, sourcePaths, request.includeGates);
  const selectMs = clock.nowMs() - selectStartedAt;

  if (!hadChangedPaths) {
    console.log(`[test:covering] no changed files (${selectMs} ms)`);
    return 0;
  }

  const selectedNonGateOrAll = result.selected.map((entry) => entry.testFile);
  const filesToRun = result.escalatedToFullSuite
    ? selectedNonGateOrAll
    : [...new Set([...(request.includeGates ? gateTestFiles : []), ...selectedNonGateOrAll])].sort();

  if (result.escalatedToFullSuite && result.escalationReason !== null) {
    console.log(`[test:covering] full suite: ${result.escalationReason}`);
  }
  if (!result.escalatedToFullSuite) {
    for (const entry of result.selected) {
      console.log(`[test:covering] ${entry.testFile}: ${entry.reasons.join('; ')}`);
    }
    if (request.includeGates && gateTestFiles.length > 0) {
      console.log(`[test:covering] + ${gateTestFiles.length} gate test file(s)`);
    }
  }
  for (const uncoveredPath of result.uncoveredPaths) {
    console.log(`[test:covering] no test covers ${uncoveredPath}`);
  }
  if (result.changedPublicFolders.length > 0) {
    console.log(`[test:covering] public/ folders changed (browser cases not selected): ${result.changedPublicFolders.join(', ')}`);
  }
  console.log(`[test:covering] selected ${filesToRun.length} test file(s) in ${selectMs} ms`);

  if (request.isListOnly || filesToRun.length === 0) return 0;
  return runTestFiles(filesToRun);
}

process.exitCode = main(process.argv.slice(2));
