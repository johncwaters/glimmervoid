import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { runKnowledgeGraphCli } from '../knowledge-graph/cli.ts';
import type { KnowledgeGraphCliDependencies } from '../knowledge-graph/cli.ts';
import { execFileSync, spawn } from '../server/child-process-safe.ts';
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

test('a config.json that cannot be read or parsed is named in the refusal instead of a bare parser error', () => {
  const homeDirectory = isolatedGlimmervoidHome(null);
  const configPath = path.join(homeDirectory, 'config.json');
  fs.writeFileSync(configPath, '{"knowledgeGraph":');
  const capturedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message: string) => { capturedErrors.push(message); };
  try {
    assert.equal(runKnowledgeGraphCommand(['next']), 1);
    fs.rmSync(configPath);
    fs.mkdirSync(configPath);
    assert.equal(runKnowledgeGraphCommand(['next']), 1);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(capturedErrors.length, 2);
  assert.match(capturedErrors[0], new RegExp(`^kg: Could not load ${configPath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}: .*JSON`));
  assert.match(capturedErrors[1], /^kg: Could not load .*config\.json: .*EISDIR/);
});

function commitTrackedFileThenMakeItStatDirty(repo: string): string {
  const trackedFilePath = path.join(repo, 'tracked.txt');
  fs.writeFileSync(trackedFilePath, 'unchanged content\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=kg', '-c', 'user.email=kg@example.invalid', 'commit', '-q', '-m', 'track a file'], { cwd: repo, encoding: 'utf8' });
  const shiftedTime = new Date(Date.now() - 3_600_000);
  fs.utimesSync(trackedFilePath, shiftedTime, shiftedTime);
  return path.join(repo, '.git', 'index');
}

test('tracking and delta never rewrite the tracked repo git index, so concurrent git add cannot hit index.lock', () => {
  const { repo, workId } = createLedgerRepoWithOpenWorkOrder();
  const indexPath = commitTrackedFileThenMakeItStatDirty(repo);
  const indexBytesBefore = fs.readFileSync(indexPath);
  const indexModifiedMsBefore = fs.statSync(indexPath).mtimeMs;
  isolatedGlimmervoidHome({ projects: [], knowledgeGraph: { enabled: true } });
  assert.equal(runCapturingStdout(['add', 'task', 'Compare vendor prices']).exitCode, 0);
  assert.equal(runCapturingStdout(['track', 'T-1', repo, workId]).exitCode, 0);
  assert.equal(runCapturingStdout(['delta', '--json']).exitCode, 0);
  assert.equal(fs.statSync(indexPath).mtimeMs, indexModifiedMsBefore);
  assert.deepEqual(fs.readFileSync(indexPath), indexBytesBefore);
});

function spawnEntry(entryArgs: string[], scratchHome: string, stderr: 'inherit' | 'pipe') {
  return spawn(process.execPath, ['bin/glimmervoid.ts', ...entryArgs], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, HOME: scratchHome, USERPROFILE: scratchHome, GLIMMERVOID_HOME: scratchHome, GLIMMERVOID_CONFIG: '' },
    stdio: ['ignore', 'pipe', stderr],
  });
}

function createEnabledHomeWithLongTasks(taskCount: number): { scratchHome: string; databasePath: string } {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-pipe-'));
  fs.writeFileSync(path.join(scratchHome, 'config.json'), JSON.stringify({ knowledgeGraph: { enabled: true } }));
  const databaseDirectory = path.join(scratchHome, 'graph');
  const { dependencies } = capturingDependencies(databaseDirectory);
  const longBody = 'b'.repeat(2000);
  for (let taskNumber = 1; taskNumber <= taskCount; taskNumber += 1) {
    assert.equal(runKnowledgeGraphCli(['add', 'task', `Task ${taskNumber}`, '--body', longBody], dependencies), 0);
  }
  return { scratchHome, databasePath: path.join(databaseDirectory, 'personal.sqlite') };
}

async function runEntryThroughSlowPipeReader(entryArgs: string[], scratchHome: string): Promise<{ exitCode: number | null; stdout: string }> {
  const child = spawnEntry(entryArgs, scratchHome, 'inherit');
  const childStdout = child.stdout;
  assert.ok(childStdout);
  childStdout.pause();
  await Promise.race([once(child, 'exit'), delay(1500)]);
  const stdoutChunks: Buffer[] = [];
  childStdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  childStdout.resume();
  const [exitCode] = await once(child, 'close');
  return { exitCode, stdout: Buffer.concat(stdoutChunks).toString('utf8') };
}

test('kg output larger than a pipe buffer reaches a slow piped reader in full', async () => {
  const taskCount = 200;
  const { scratchHome, databasePath } = createEnabledHomeWithLongTasks(taskCount);
  try {
    const listing = await runEntryThroughSlowPipeReader(['kg', 'ls', '--json', '--db', databasePath], scratchHome);
    assert.equal(listing.exitCode, 0);
    assert.ok(Buffer.byteLength(listing.stdout) > 256 * 1024);
    assert.equal(JSON.parse(listing.stdout).length, taskCount);
  } finally {
    fs.rmSync(scratchHome, { recursive: true, force: true });
  }
});

async function runEntryIntoReaderThatClosesEarly(entryArgs: string[], scratchHome: string): Promise<{ stderr: string }> {
  const child = spawnEntry(entryArgs, scratchHome, 'pipe');
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  assert.ok(childStdout);
  assert.ok(childStderr);
  const stderrChunks: Buffer[] = [];
  childStderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  childStdout.once('data', () => childStdout.destroy());
  await once(child, 'close');
  return { stderr: Buffer.concat(stderrChunks).toString('utf8') };
}

test('kg output piped into a reader that closes early ends quietly instead of crashing on EPIPE', async () => {
  const { scratchHome, databasePath } = createEnabledHomeWithLongTasks(100);
  try {
    const { stderr } = await runEntryIntoReaderThatClosesEarly(['kg', 'export', '--db', databasePath], scratchHome);
    assert.doesNotMatch(stderr, /Unhandled 'error'|EPIPE/);
  } finally {
    fs.rmSync(scratchHome, { recursive: true, force: true });
  }
});

test('delta names the reasons when coherence orient refuses without a consequence ledger to read', () => {
  const { repo, workId } = createLedgerRepoWithOpenWorkOrder();
  isolatedGlimmervoidHome({ projects: [], knowledgeGraph: { enabled: true } });
  assert.equal(runCapturingStdout(['add', 'task', 'Compare vendor prices']).exitCode, 0);
  assert.equal(runCapturingStdout(['track', 'T-1', repo, workId]).exitCode, 0);
  fs.mkdirSync(path.join(repo, '.coherence', 'consequences'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.coherence', 'consequences', 'stray.txt'), 'not a ledger row\n');
  const delta = runCapturingStdout(['delta', '--json']);
  assert.equal(delta.exitCode, 0);
  const [repoReport] = JSON.parse(delta.stdout);
  assert.equal(repoReport.isAvailable, false);
  assert.match(repoReport.reason, /^orient refused: consequences: .*stray\.txt/);
});

function journalRecordIdFrom(coherenceOutput: string): string {
  const recordId = coherenceOutput.match(/^d-[0-9a-f]{8}/)?.[0];
  assert.ok(recordId, coherenceOutput);
  return recordId;
}

test('blocked reports and conjectures written by coherence can be tracked and show their kind in delta', () => {
  const { repo } = createLedgerRepoWithOpenWorkOrder();
  const blockedId = journalRecordIdFrom(runBundledCoherenceIn(repo, ['blocked', 'could not reach the vendor API', '--because', 'no key', '--session', 's-kg-test']));
  const conjectureId = journalRecordIdFrom(runBundledCoherenceIn(repo, ['conjecture', 'prices doubled overnight', '--discriminated-by', 'compare currencies', '--session', 's-kg-test']));
  runBundledCoherenceIn(repo, ['resolved', conjectureId, '--because', 'the currency was wrong', '--session', 's-kg-test']);
  isolatedGlimmervoidHome({ projects: [], knowledgeGraph: { enabled: true } });
  assert.equal(runCapturingStdout(['add', 'task', 'Get a vendor key']).exitCode, 0);
  assert.equal(runCapturingStdout(['add', 'question', 'Why did prices double?']).exitCode, 0);
  assert.equal(runCapturingStdout(['track', 'T-1', repo, blockedId]).exitCode, 0);
  assert.equal(runCapturingStdout(['track', 'Q-1', repo, conjectureId]).exitCode, 0);
  const delta = runCapturingStdout(['delta', '--json']);
  assert.equal(delta.exitCode, 0);
  const [repoReport] = JSON.parse(delta.stdout);
  assert.deepEqual(repoReport.records.map((recordReport: { tracked: { recordId: string }; state: string }) => [recordReport.tracked.recordId, recordReport.state]), [
    [blockedId, 'blocked/standing'],
    [conjectureId, 'conjecture/resolved'],
  ]);
});
