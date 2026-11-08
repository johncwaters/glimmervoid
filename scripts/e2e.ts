import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCENARIO_DIRECTORY = path.join('tests', 'e2e');
const SCENARIO_SUFFIX = '.e2e.ts';
const USAGE = 'usage: node scripts/e2e.ts [--all]';

function listScenarioFiles(): string[] {
  return fs.readdirSync(path.join(REPO_ROOT, SCENARIO_DIRECTORY))
    .filter((entryName) => entryName.endsWith(SCENARIO_SUFFIX))
    .sort()
    .map((entryName) => path.join(SCENARIO_DIRECTORY, entryName));
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

function main(argumentList: readonly string[]): number {
  if (process.platform === 'win32') {
    console.log('[e2e] skipped: the synthetic end-to-end runs support Linux and macOS only');
    return 0;
  }
  const unknownArguments = argumentList.filter((argument) => argument !== '--all');
  if (unknownArguments.length > 0) {
    console.error(`${USAGE}\nunknown arguments: ${unknownArguments.join(' ')}`);
    return 2;
  }
  const scenarioFiles = listScenarioFiles();
  for (const scenarioFile of scenarioFiles) console.log(`[e2e] ${scenarioFile}: --all`);
  return runScenarios(scenarioFiles);
}

process.exitCode = main(process.argv.slice(2));
