import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runKnowledgeGraphCli } from '../knowledge-graph/cli.ts';
import type { KnowledgeGraphCliDependencies } from '../knowledge-graph/cli.ts';
import type { CoherenceRunner } from '../knowledge-graph/coherence-source.ts';

const TRACKED_WORK_ID = 'wrk-17ea723e85439d2a';

const ledgerWithOneWorkOrder: CoherenceRunner = (_repo, commandArguments) => commandArguments[0] === 'work'
  ? JSON.stringify({ work: [{ work: TRACKED_WORK_ID, state: 'open', readiness: 'ready', opened: { objective: 'Compare prices' }, last: null }] })
  : JSON.stringify({ action: 'steady', reasons: [], consequences: { unverifiedCompletedWork: [] } });

function createCli(runCoherence: CoherenceRunner = ledgerWithOneWorkOrder) {
  const databaseDirectory = join(mkdtempSync(join(tmpdir(), 'kg-commands-')), 'home');
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies: KnowledgeGraphCliDependencies = {
    defaultDatabaseDirectory: databaseDirectory,
    runCoherence,
    writeOutput: (text) => output.push(text),
    writeError: (text) => errors.push(text),
  };
  const run = (...commandArguments: string[]) => runKnowledgeGraphCli(commandArguments, dependencies);
  return { run, output, errors, databaseDirectory };
}

function createLedgerRepo(directoryName = 'repo'): string {
  const repo = join(mkdtempSync(join(tmpdir(), 'kg-ledger-')), directoryName);
  mkdirSync(join(repo, '.coherence'), { recursive: true });
  return realpathSync(repo);
}

test('a since that is not an offset ISO timestamp is refused', () => {
  const cli = createCli();
  for (const since of ['yesterday', '2026-10-09', '2026-10-09T09:00:00']) {
    assert.equal(cli.run('delta', '--since', since), 1, since);
  }
  assert.match(cli.errors.join(''), /--since needs an ISO 8601 timestamp/);
  assert.equal(cli.run('delta', '--since', '2026-10-09T09:00:00+02:00'), 0);
});

test('an empty db path is refused and creates nothing', () => {
  const cli = createCli();
  assert.equal(cli.run('add', 'task', 'Lost task', '--db', ''), 1);
  assert.equal(cli.run('add', 'task', 'Lost task', '--db='), 1);
  assert.match(cli.errors.join(''), /--db needs a database file path/);
  assert.equal(existsSync(cli.databaseDirectory), false);
});

test('a read-only command refuses a missing db path and creates nothing there', () => {
  const cli = createCli();
  const missingDirectory = join(mkdtempSync(join(tmpdir(), 'kg-missing-')), 'typo');
  for (const command of ['ls', 'show', 'find', 'next', 'chain', 'check', 'export', 'delta', 'schema']) {
    assert.equal(cli.run(command, 'T-1', '--db', join(missingDirectory, 'graph.sqlite')), 1, command);
  }
  assert.equal(existsSync(missingDirectory), false);
  assert.match(cli.errors.join(''), /no knowledge graph database at .*typo/);
});

test('a write command creates a missing db path, and read-only commands then use it', () => {
  const cli = createCli();
  const databasePath = join(mkdtempSync(join(tmpdir(), 'kg-new-')), 'nested', 'graph.sqlite');
  assert.equal(cli.run('add', 'task', 'First task', '--db', databasePath), 0);
  assert.equal(cli.run('ls', '--db', databasePath), 0);
  assert.match(cli.output.join(''), /T-1 +task +First task/);
});

test('a read-only command on a fresh default database reports an empty graph', () => {
  const cli = createCli();
  assert.equal(cli.run('next'), 0);
  assert.equal(cli.output.join(''), '(nothing actionable)\n');
});

test('an unknown kind, filter field or edge type is an error', () => {
  const cli = createCli();
  assert.equal(cli.run('add', 'task', 'Real task'), 0);
  assert.equal(cli.run('ls', 'badkey'), 1);
  assert.equal(cli.run('ls', 'task', 'bogus=x'), 1);
  assert.equal(cli.run('chain', 'T-1', 'nonsense'), 1);
  assert.match(cli.errors.join(''), /unknown kind "badkey"[\s\S]*unknown field "bogus"[\s\S]*unknown edge type "nonsense"/);
  assert.equal(cli.run('ls', 'task', 'status=todo'), 0);
});

test('a failed track leaves no orphan coherence pointer behind', () => {
  const cli = createCli();
  const repo = createLedgerRepo();
  assert.equal(cli.run('add', 'reference', 'Vendor sheet'), 0);
  assert.equal(cli.run('track', 'R-1', repo, TRACKED_WORK_ID), 1);
  assert.match(cli.errors.join(''), /cannot start at a reference/);
  assert.equal(cli.run('ls', 'coherence_record', '--json'), 0);
  assert.deepEqual(JSON.parse(cli.output.at(-1) ?? ''), []);
});

test('delta text output strips control characters from the repo path', { skip: process.platform === 'win32' }, () => {
  const escapeCharacter = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  const cli = createCli();
  const repo = createLedgerRepo(`repo${escapeCharacter}]0;owned${bell}`);
  assert.equal(cli.run('add', 'task', 'Compare prices'), 0);
  assert.equal(cli.run('track', 'T-1', repo, TRACKED_WORK_ID), 0);
  assert.equal(cli.run('delta'), 0);
  const deltaText = cli.output.at(-1) ?? '';
  assert.match(deltaText, /repo\]0;owned {2}heading: steady/);
  assert.equal(deltaText.includes(escapeCharacter) || deltaText.includes(bell), false);
});
