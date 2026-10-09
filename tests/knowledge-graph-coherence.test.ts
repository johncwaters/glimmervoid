import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCoherenceDelta, inferRecordKind } from '../knowledge-graph/coherence-delta.ts';
import type { RepoSnapshot, TrackedRecord } from '../knowledge-graph/coherence-delta.ts';
import { readRepoSnapshot } from '../knowledge-graph/coherence-source.ts';

const repo = '/repos/vendor';

const trackedWork = (recordId: string, trackingStatus: string): TrackedRecord => ({
  trackingNodeId: 'T-1', trackingKind: 'task', trackingStatus, recordNodeId: 'C-1', repo, record: 'work', recordId,
});

const snapshotWith = (overrides: Partial<Extract<RepoSnapshot, { isAvailable: true }>>): RepoSnapshot => ({
  isAvailable: true, heading: 'steady', headingReasons: [], workOrders: [], unverifiedCompletedWorkIds: [], decisions: [], ...overrides,
});

const findingKindsFor = (tracked: TrackedRecord, snapshot: RepoSnapshot, since?: string) => {
  const [report] = buildCoherenceDelta([tracked], new Map([[repo, snapshot]]), since);
  assert.ok(report?.isAvailable);
  return report.records[0]?.findings.map((finding) => finding.kind);
};

test('record ids map to their ledger kind and anything else is refused', () => {
  assert.equal(inferRecordKind('wrk-17ea723e85439d2a'), 'work');
  assert.equal(inferRecordKind('d-b136b8e9'), 'decision');
  assert.equal(inferRecordKind('wrk-short'), null);
  assert.equal(inferRecordKind('T-1'), null);
});

test('a completed work order still open in kg diverges and its missing verification is flagged', () => {
  const snapshot = snapshotWith({
    workOrders: [{ id: 'wrk-17ea723e85439d2a', objective: 'Compare prices', state: 'completed', readiness: 'done', lastEventAt: '2026-10-08T10:00:00Z' }],
    unverifiedCompletedWorkIds: ['wrk-17ea723e85439d2a'],
  });
  assert.deepEqual(findingKindsFor(trackedWork('wrk-17ea723e85439d2a', 'todo'), snapshot), ['unverified', 'status-diverges']);
});

test('kg marking a task done ahead of the ledger diverges, while matching states report nothing', () => {
  const openOrder = { id: 'wrk-20ba6a3f9a67cbfb', objective: 'SAML check', state: 'open', readiness: 'ready', lastEventAt: null };
  assert.deepEqual(findingKindsFor(trackedWork(openOrder.id, 'done'), snapshotWith({ workOrders: [openOrder] })), ['status-diverges']);
  assert.deepEqual(findingKindsFor(trackedWork(openOrder.id, 'doing'), snapshotWith({ workOrders: [openOrder] })), []);
});

test('a pointer whose record left the ledger is reported missing instead of failing', () => {
  assert.deepEqual(findingKindsFor(trackedWork('wrk-0000000000000000', 'todo'), snapshotWith({})), ['missing']);
});

test('since narrows to work that moved and decisions made after it', () => {
  const snapshot = snapshotWith({
    workOrders: [{ id: 'wrk-17ea723e85439d2a', objective: 'Compare prices', state: 'active', readiness: 'active', lastEventAt: '2026-10-08T12:00:00Z' }],
    decisions: [
      { id: 'd-00000001', chose: 'old call', because: 'x', at: '2026-10-01T00:00:00Z', workId: 'wrk-17ea723e85439d2a', isRetracted: false },
      { id: 'd-00000002', chose: 'new call', because: 'y', at: '2026-10-08T11:00:00Z', workId: 'wrk-17ea723e85439d2a', isRetracted: false },
    ],
  });
  const [report] = buildCoherenceDelta([trackedWork('wrk-17ea723e85439d2a', 'doing')], new Map([[repo, snapshot]]), '2026-10-05T00:00:00Z');
  assert.ok(report?.isAvailable);
  assert.deepEqual(report.records[0]?.findings.map((finding) => finding.kind), ['moved-since']);
  assert.deepEqual(report.records[0]?.decisions.map((decision) => decision.id), ['d-00000002']);
});

test('a coherence CLI that cannot start leaves the repo unavailable instead of failing', () => {
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'kg-coherence-'));
  mkdirSync(join(fixtureRepo, '.coherence'), { recursive: true });
  const missingCli = () => { throw Object.assign(new Error('spawn coherence ENOENT'), { code: 'ENOENT' }); };
  assert.deepEqual(readRepoSnapshot(fixtureRepo, missingCli), { isAvailable: false, reason: 'coherence CLI not found' });
});

test('an unavailable repo keeps its pointers listed as unchecked', () => {
  const [report] = buildCoherenceDelta([trackedWork('wrk-17ea723e85439d2a', 'todo')], new Map([[repo, { isAvailable: false, reason: 'coherence CLI not found' }]]));
  assert.ok(report && !report.isAvailable);
  assert.equal(report.records.length, 1);
});

test('the journal reader resolves retractions and ignores a row still being appended', () => {
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'kg-coherence-'));
  const journalDirectory = join(fixtureRepo, '.coherence', 'decisions');
  mkdirSync(journalDirectory, { recursive: true });
  mkdirSync(join(fixtureRepo, '.coherence', 'work'), { recursive: true });
  const journalFile = join(journalDirectory, 's-one.jsonl');
  writeFileSync(journalFile, `${[
    JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: 'keep', because: 'ok', work: 'wrk-17ea723e85439d2a' }),
    JSON.stringify({ id: 'd-bbbbbbbb', kind: 'decision', at: '2026-10-08T02:00:00Z', chose: 'cache', because: 'limits' }),
    JSON.stringify({ id: 'd-cccccccc', kind: 'retraction', at: '2026-10-08T03:00:00Z', chose: '(withdrawn)', because: 'limits raised', supersedes: 'd-bbbbbbbb' }),
  ].join('\n')}\n`);
  appendFileSync(journalFile, '{"id":"d-dddddddd","kind":"decis');
  const fakeCoherence = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? '{"work":[]}'
    : '{"action":"steady","reasons":[],"consequences":{"unverifiedCompletedWork":[]}}';
  const snapshot = readRepoSnapshot(fixtureRepo, fakeCoherence);
  assert.ok(snapshot.isAvailable);
  assert.deepEqual(snapshot.decisions.map((decision) => [decision.id, decision.isRetracted, decision.workId]), [
    ['d-aaaaaaaa', false, 'wrk-17ea723e85439d2a'],
    ['d-bbbbbbbb', true, null],
  ]);
});

test('control characters in ledger text are stripped before they reach a snapshot', () => {
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'kg-coherence-'));
  const journalDirectory = join(fixtureRepo, '.coherence', 'decisions');
  mkdirSync(journalDirectory, { recursive: true });
  const escapeCharacter = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  const singleShiftThree = String.fromCharCode(0x8f);
  writeFileSync(join(journalDirectory, 's-one.jsonl'), `${JSON.stringify({
    id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: `keep${escapeCharacter}]0;owned${bell}${escapeCharacter}[31m cache${singleShiftThree}`, because: 'ok',
  })}\n`);
  const fakeCoherence = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? '{"work":[]}'
    : JSON.stringify({ action: `steady${escapeCharacter}[2J`, reasons: [`calm${bell}`], consequences: { unverifiedCompletedWork: [] } });
  const snapshot = readRepoSnapshot(fixtureRepo, fakeCoherence);
  assert.ok(snapshot.isAvailable);
  assert.equal(snapshot.decisions[0]?.chose, 'keep]0;owned[31m cache');
  assert.equal(snapshot.heading, 'steady[2J');
  assert.deepEqual(snapshot.headingReasons, ['calm']);
});

test('an unreadable journal row leaves the repo unavailable with a reason free of control characters', () => {
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'kg-coherence-'));
  const journalDirectory = join(fixtureRepo, '.coherence', 'decisions');
  mkdirSync(journalDirectory, { recursive: true });
  const escapeCharacter = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  writeFileSync(join(journalDirectory, 's-one.jsonl'), `${escapeCharacter}]0;owned${bell}{"id":"d-aaaaaaaa"}\n`);
  const fakeCoherence = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? '{"work":[]}'
    : '{"action":"steady","reasons":[],"consequences":{"unverifiedCompletedWork":[]}}';
  const snapshot = readRepoSnapshot(fixtureRepo, fakeCoherence);
  assert.ok(!snapshot.isAvailable);
  assert.notEqual(snapshot.reason, '');
  assert.doesNotMatch(snapshot.reason, /[\u0000-\u001f\u007f-\u009f]/);
});
