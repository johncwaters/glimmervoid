import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runKnowledgeGraphCli } from '../knowledge-graph/cli.ts';
import type { KnowledgeGraphCliDependencies } from '../knowledge-graph/cli.ts';
import { execFileSync } from '../server/child-process-safe.ts';
import { runKnowledgeGraphCommand } from '../server/knowledge-graph-cli.ts';
import { resolvePackageBin } from '../server/runtime-paths.ts';

function isolatedGlimmervoidHome(config: Record<string, unknown> | null): string {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-home-'));
  if (config) fs.writeFileSync(path.join(homeDirectory, 'config.json'), JSON.stringify(config));
  process.env.GLIMMERVOID_HOME = homeDirectory;
  delete process.env.GLIMMERVOID_CONFIG;
  return homeDirectory;
}

function capturingDependencies(databaseDirectory: string) {
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies: KnowledgeGraphCliDependencies = {
    defaultDatabaseDirectory: databaseDirectory,
    runCoherence: () => { throw new Error('coherence is not reachable in this test'); },
    writeOutput: (text) => output.push(text),
    writeError: (text) => errors.push(text),
  };
  return { dependencies, output, errors };
}

test('glimmervoid kg refuses and creates nothing while the setting is off', () => {
  for (const config of [null, { projects: [] }, { projects: [], knowledgeGraph: { enabled: false } }]) {
    const homeDirectory = isolatedGlimmervoidHome(config);
    assert.equal(runKnowledgeGraphCommand(['next']), 1);
    assert.equal(fs.existsSync(path.join(homeDirectory, 'knowledge-graph')), false);
  }
});

test('glimmervoid kg keeps its database under the Glimmervoid home once enabled', () => {
  const homeDirectory = isolatedGlimmervoidHome({ projects: [], knowledgeGraph: { enabled: true } });
  assert.equal(runKnowledgeGraphCommand(['check']), 0);
  assert.equal(fs.existsSync(path.join(homeDirectory, 'knowledge-graph', 'personal.sqlite')), true);
});

test('the CLI reports a typed refusal as an exit code instead of throwing', () => {
  const { dependencies, output, errors } = capturingDependencies(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-db-')));
  assert.equal(runKnowledgeGraphCli(['add', 'task', 'Draft the plan', 'priority=p1'], dependencies), 0);
  assert.match(output.join(''), /^T-1 /);
  assert.equal(runKnowledgeGraphCli(['add', 'task', 'Bad', 'priority=urgent'], dependencies), 1);
  assert.match(errors.join(''), /^kg: .*priority/s);
});

test('tracking is refused when the ledger cannot be read, and the rest of the graph keeps working', () => {
  const { dependencies, output } = capturingDependencies(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-db-')));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-repo-')));
  fs.mkdirSync(path.join(repo, '.coherence'));
  assert.equal(runKnowledgeGraphCli(['add', 'task', 'Ship it'], dependencies), 0);
  assert.equal(runKnowledgeGraphCli(['track', 'T-1', repo, 'wrk-17ea723e85439d2a'], dependencies), 1);
  assert.equal(runKnowledgeGraphCli(['next'], dependencies), 0);
  assert.match(output.join(''), /T-1 +p2 todo +Ship it/);
});

function runBundledCoherenceIn(repo: string, commandArguments: readonly string[]): string {
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(coherenceCliPath);
  return execFileSync(process.execPath, [coherenceCliPath, ...commandArguments], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function createLedgerRepoWithOpenWorkOrder(): { repo: string; workId: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-ledger-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'coherence.config.json'), '{}\n');
  const openedEvent = JSON.parse(runBundledCoherenceIn(repo, [
    'work', 'create', 'Compare vendor prices',
    '--success', 'prices compared', '--risk', 'low', '--authority', 'user-directed',
    '--granted-by', 'operator', '--boundary', 'this repo', '--session', 's-kg-test', '--json',
  ]));
  assert.equal(typeof openedEvent.work, 'string');
  return { repo, workId: openedEvent.work };
}

function runCapturingStdout(commandArguments: string[]): { exitCode: number; stdout: string } {
  const capturedChunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    capturedChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    const exitCode = runKnowledgeGraphCommand(commandArguments);
    return { exitCode, stdout: capturedChunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('tracking a real ledger work order reuses its pointer and delta reports the ledger state', () => {
  const { repo, workId } = createLedgerRepoWithOpenWorkOrder();
  isolatedGlimmervoidHome({ projects: [], knowledgeGraph: { enabled: true } });
  assert.equal(runCapturingStdout(['add', 'task', 'Compare vendor prices']).exitCode, 0);
  assert.equal(runCapturingStdout(['track', 'T-1', repo, workId]).exitCode, 0);
  assert.equal(runCapturingStdout(['track', 'T-1', repo, workId]).exitCode, 0);
  const pointerListing = runCapturingStdout(['ls', 'coherence_record', '--json']);
  assert.equal(pointerListing.exitCode, 0);
  assert.equal(JSON.parse(pointerListing.stdout).length, 1);
  const delta = runCapturingStdout(['delta', '--json']);
  assert.equal(delta.exitCode, 0);
  const [repoReport] = JSON.parse(delta.stdout);
  assert.equal(repoReport.repo, repo);
  assert.equal(repoReport.isAvailable, true);
  assert.equal(repoReport.records.length, 1);
  assert.equal(repoReport.records[0].tracked.recordId, workId);
  assert.equal(repoReport.records[0].state, 'open/ready');
});

test('delta reads the refusal coherence orient prints when it exits on a damaged sibling ledger', () => {
  const { repo, workId } = createLedgerRepoWithOpenWorkOrder();
  fs.mkdirSync(path.join(repo, '.coherence', 'defects'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.coherence', 'defects', 'stray.txt'), 'not a ledger row\n');
  isolatedGlimmervoidHome({ projects: [], knowledgeGraph: { enabled: true } });
  assert.equal(runCapturingStdout(['add', 'task', 'Compare vendor prices']).exitCode, 0);
  assert.equal(runCapturingStdout(['track', 'T-1', repo, workId]).exitCode, 0);
  const delta = runCapturingStdout(['delta', '--json']);
  assert.equal(delta.exitCode, 0);
  const [repoReport] = JSON.parse(delta.stdout);
  assert.equal(repoReport.isAvailable, true);
  assert.equal(repoReport.heading, 'refuse');
  assert.match(repoReport.headingReasons.join(' '), /defect ledger refused/);
});
