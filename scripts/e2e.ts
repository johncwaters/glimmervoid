import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readImportsMap } from '../server/change-map/core/change-map-core.ts';
import { buildImportGraph, extractImportSpecifiers } from '../server/core/import-graph-core.ts';
import { selectScenarios } from './core/e2e-selection-core.ts';
import type { ScenarioSeeds, SelectedScenario } from './core/e2e-selection-core.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCENARIO_DIRECTORY = 'tests/e2e';
const SCENARIO_SUFFIX = '.e2e.ts';
const SHARED_SUPPORT_PATHS = ['tests/e2e/support/', 'tests/helpers/', 'scripts/e2e.ts', 'scripts/core/e2e-selection-core.ts', 'package.json', 'package-lock.json', '.nvmrc'];
const SCENARIO_SEEDS_DECLARATION = /const SCENARIO_SEEDS = \[([^\]]*)\]/;
const COHERENCE_CLI = 'node_modules/@posthog/coherence/dist/cli.js';
const COHERENCE_DEADLINE_MS = 120_000;
const USAGE = 'usage: node scripts/e2e.ts --all | --since <commit> | --changed <path>... [--list]';

type ScenarioChoice = { kind: 'all' } | { kind: 'since'; commit: string } | { kind: 'changed'; paths: string[] };

interface RunRequest {
  choice: ScenarioChoice;
  isListOnly: boolean;
}

function gitLines(gitArguments: readonly string[]): string[] | null {
  const run = spawnSync('git', gitArguments, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return null;
  return run.stdout.split('\n').filter((line) => line !== '');
}

function listScenarioFiles(): string[] {
  return fs.readdirSync(path.join(REPO_ROOT, SCENARIO_DIRECTORY))
    .filter((entryName) => entryName.endsWith(SCENARIO_SUFFIX))
    .sort()
    .map((entryName) => `${SCENARIO_DIRECTORY}/${entryName}`);
}

function scenarioSeedsOf(scenarioFile: string): ScenarioSeeds {
  const declaration = SCENARIO_SEEDS_DECLARATION.exec(fs.readFileSync(path.join(REPO_ROOT, scenarioFile), 'utf8'));
  if (declaration === null) throw new Error(`${scenarioFile} declares no SCENARIO_SEEDS`);
  const seeds = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return { scenario: scenarioFile, seeds, supportPaths: [scenarioFile, ...SHARED_SUPPORT_PATHS] };
}

function dependentsByPathOfRepo(): Map<string, Set<string>> {
  const sourcePaths = gitLines(['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.mjs', '*.js']) ?? [];
  const specifiersByPath = new Map(sourcePaths
    .filter((sourcePath) => !sourcePath.startsWith('site/') && fs.existsSync(path.join(REPO_ROOT, sourcePath)))
    .map((sourcePath): [string, string[]] => [sourcePath, extractImportSpecifiers(fs.readFileSync(path.join(REPO_ROOT, sourcePath), 'utf8'))]));
  const packageJsonText = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  return buildImportGraph({ specifiersByPath, importsMap: readImportsMap(packageJsonText) }).dependentsByPath;
}

function changedPathsSince(commit: string): string[] | null {
  const mergeBase = gitLines(['merge-base', commit, 'HEAD'])?.[0];
  if (mergeBase === undefined) return null;
  const changedTrackedPaths = gitLines(['diff', '--name-only', mergeBase]);
  const untrackedPaths = gitLines(['ls-files', '--others', '--exclude-standard']);
  if (changedTrackedPaths === null || untrackedPaths === null) return null;
  return [...new Set([...changedTrackedPaths, ...untrackedPaths])];
}

function economyClosureOf(changedPaths: readonly string[]): Set<string> | null {
  const presentPaths = changedPaths.filter((changedPath) => fs.statSync(path.join(REPO_ROOT, changedPath), { throwIfNoEntry: false })?.isFile() === true);
  if (presentPaths.length === 0 || !fs.existsSync(path.join(REPO_ROOT, COHERENCE_CLI))) return null;
  const run = spawnSync(process.execPath, [COHERENCE_CLI, 'economy', ...presentPaths, '--json'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: COHERENCE_DEADLINE_MS,
  });
  if (run.status !== 0) {
    console.log('[e2e] coherence economy did not answer, so imports and the harness alone decide');
    return null;
  }
  const economy: { given?: string[]; entries?: { file: string }[] } = JSON.parse(run.stdout);
  return new Set([...(economy.given ?? []), ...(economy.entries ?? []).map((entry) => entry.file)]);
}

function selectionFor(choice: ScenarioChoice, scenarioFiles: readonly string[]): SelectedScenario[] {
  if (choice.kind === 'all') return scenarioFiles.map((scenario) => ({ scenario, reasons: ['--all'] }));
  const changedPaths = choice.kind === 'changed' ? choice.paths : changedPathsSince(choice.commit);
  if (changedPaths === null) return scenarioFiles.map((scenario) => ({ scenario, reasons: [`git could not diff against ${choice.kind === 'since' ? choice.commit : 'the change'}, so every scenario runs`] }));
  return selectScenarios({
    changedPaths,
    scenarios: scenarioFiles.map(scenarioSeedsOf),
    dependentsByPath: dependentsByPathOfRepo(),
    economyClosure: economyClosureOf(changedPaths),
  });
}

function runScenarios(scenarioFiles: readonly string[]): number {
  const startedAt = Date.now();
  const run = spawnSync(
    process.execPath,
    ['--import', './tests/helpers/isolate-home.ts', '--test', '--test-concurrency=1', ...scenarioFiles],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  console.log(`[e2e] ${scenarioFiles.length} scenario files in ${Date.now() - startedAt} ms`);
  return run.status ?? 1;
}

function parseRunRequest(argumentList: readonly string[]): RunRequest | null {
  const isListOnly = argumentList.includes('--list');
  const choiceArguments = argumentList.filter((argument) => argument !== '--list');
  const [flag, ...values] = choiceArguments;
  if (flag === '--all' && values.length === 0) return { choice: { kind: 'all' }, isListOnly };
  if (flag === '--since' && values.length === 1) return { choice: { kind: 'since', commit: values[0] }, isListOnly };
  if (flag === '--changed' && values.length > 0) return { choice: { kind: 'changed', paths: values }, isListOnly };
  return null;
}

function main(argumentList: readonly string[]): number {
  if (process.platform === 'win32') {
    console.log('[e2e] skipped: the synthetic end-to-end runs support Linux and macOS only');
    return 0;
  }
  const request = parseRunRequest(argumentList);
  if (request === null) {
    console.error(USAGE);
    return 2;
  }
  const scenarioFiles = listScenarioFiles();
  const selected = selectionFor(request.choice, scenarioFiles);
  const selectedFiles = selected.map((selection) => selection.scenario);
  for (const selection of selected) console.log(`[e2e] ${selection.scenario}: ${selection.reasons.join('; ')}`);
  for (const scenarioFile of scenarioFiles.filter((file) => !selectedFiles.includes(file))) console.log(`[e2e] skipped ${scenarioFile}: nothing it covers changed`);
  if (request.isListOnly || selectedFiles.length === 0) return 0;
  return runScenarios(selectedFiles);
}

process.exitCode = main(process.argv.slice(2));
