import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCoherenceDelta, inferRecordKind } from '../knowledge-graph/coherence-delta.ts';
import type { DecisionSummary, RepoSnapshot, TrackedRecord } from '../knowledge-graph/coherence-delta.ts';
import { readRepoSnapshot } from '../knowledge-graph/coherence-source.ts';
import { execFileSync } from '../server/child-process-safe.ts';

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

const steadyCoherence = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
  ? '{"work":[]}'
  : '{"action":"steady","reasons":[],"consequences":{"unverifiedCompletedWork":[]}}';

function createJournalRepo(): { fixtureRepo: string; journalDirectory: string } {
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'kg-coherence-'));
  const journalDirectory = join(fixtureRepo, '.coherence', 'decisions');
  mkdirSync(journalDirectory, { recursive: true });
  return { fixtureRepo, journalDirectory };
}

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
      { id: 'd-00000001', chose: 'old call', because: 'x', at: '2026-10-01T00:00:00Z', workId: 'wrk-17ea723e85439d2a', kind: 'decision', standing: 'standing', retractedAt: null },
      { id: 'd-00000002', chose: 'new call', because: 'y', at: '2026-10-08T11:00:00Z', workId: 'wrk-17ea723e85439d2a', kind: 'decision', standing: 'standing', retractedAt: null },
    ],
  });
  const [report] = buildCoherenceDelta([trackedWork('wrk-17ea723e85439d2a', 'doing')], new Map([[repo, snapshot]]), '2026-10-05T00:00:00Z');
  assert.ok(report?.isAvailable);
  assert.deepEqual(report.records[0]?.findings.map((finding) => finding.kind), ['moved-since']);
  assert.deepEqual(report.records[0]?.decisions.map((decision) => decision.id), ['d-00000002']);
});

test('a coherence CLI that cannot start leaves the repo unavailable instead of failing', () => {
  const { fixtureRepo } = createJournalRepo();
  const missingCli = () => { throw Object.assign(new Error('spawn coherence ENOENT'), { code: 'ENOENT' }); };
  assert.deepEqual(readRepoSnapshot(fixtureRepo, missingCli), { isAvailable: false, reason: 'coherence CLI not found' });
});

test('an unavailable repo keeps its pointers listed as unchecked', () => {
  const [report] = buildCoherenceDelta([trackedWork('wrk-17ea723e85439d2a', 'todo')], new Map([[repo, { isAvailable: false, reason: 'coherence CLI not found' }]]));
  assert.ok(report && !report.isAvailable);
  assert.equal(report.records.length, 1);
});

test('the journal reader resolves retractions and ignores a row still being appended', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const journalFile = join(journalDirectory, 's-one.jsonl');
  writeFileSync(journalFile, `${[
    JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: 'keep', because: 'ok', work: 'wrk-17ea723e85439d2a' }),
    JSON.stringify({ id: 'd-bbbbbbbb', kind: 'decision', at: '2026-10-08T02:00:00Z', chose: 'cache', because: 'limits' }),
    JSON.stringify({ id: 'd-cccccccc', kind: 'retraction', at: '2026-10-08T03:00:00Z', chose: '(withdrawn)', because: 'limits raised', supersedes: 'd-bbbbbbbb' }),
  ].join('\n')}\n`);
  appendFileSync(journalFile, '{"id":"d-dddddddd","kind":"decis');
  const snapshot = readRepoSnapshot(fixtureRepo, steadyCoherence);
  assert.ok(snapshot.isAvailable);
  assert.deepEqual(snapshot.decisions.map((decision) => [decision.id, decision.standing, decision.retractedAt, decision.workId]), [
    ['d-aaaaaaaa', 'standing', null, 'wrk-17ea723e85439d2a'],
    ['d-bbbbbbbb', 'retracted', '2026-10-08T03:00:00Z', null],
  ]);
});

test('control characters in ledger text are stripped before they reach a snapshot', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const escapeCharacter = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  const singleShiftThree = String.fromCharCode(0x8f);
  writeFileSync(join(journalDirectory, 's-one.jsonl'), `${JSON.stringify({
    id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: `keep${escapeCharacter}]0;owned${bell}${escapeCharacter}[31m cache${singleShiftThree}`, because: 'ok',
  })}\n`);
  const orientWithControlCharacters = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? '{"work":[]}'
    : JSON.stringify({ action: `steady${escapeCharacter}[2J`, reasons: [`calm${bell}`], consequences: { unverifiedCompletedWork: [] } });
  const snapshot = readRepoSnapshot(fixtureRepo, orientWithControlCharacters);
  assert.ok(snapshot.isAvailable);
  assert.equal(snapshot.decisions[0]?.chose, 'keep]0;owned[31m cache');
  assert.equal(snapshot.heading, 'steady[2J');
  assert.deepEqual(snapshot.headingReasons, ['calm']);
});

test('an unreadable journal row leaves the repo unavailable with a reason free of control characters', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const escapeCharacter = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  writeFileSync(join(journalDirectory, 's-one.jsonl'), `${escapeCharacter}]0;owned${bell}{"id":"d-aaaaaaaa"}\n`);
  const snapshot = readRepoSnapshot(fixtureRepo, steadyCoherence);
  assert.ok(!snapshot.isAvailable);
  assert.notEqual(snapshot.reason, '');
  assert.doesNotMatch(snapshot.reason, /[\u0000-\u001f\u007f-\u009f]/);
});

test('since compares instants, so an offset timestamp still catches events after it', () => {
  const snapshot = snapshotWith({
    workOrders: [{ id: 'wrk-17ea723e85439d2a', objective: 'Compare prices', state: 'active', readiness: 'active', lastEventAt: '2026-10-09T08:00:00Z' }],
    decisions: [{ id: 'd-00000001', chose: 'cache', because: 'x', at: '2026-10-09T07:30:00Z', workId: 'wrk-17ea723e85439d2a', kind: 'decision', standing: 'standing', retractedAt: null }],
  });
  const [report] = buildCoherenceDelta([trackedWork('wrk-17ea723e85439d2a', 'doing')], new Map([[repo, snapshot]]), '2026-10-09T09:00:00+02:00');
  assert.ok(report?.isAvailable);
  assert.deepEqual(report.records[0]?.findings.map((finding) => finding.kind), ['moved-since']);
  assert.deepEqual(report.records[0]?.decisions.map((decision) => decision.id), ['d-00000001']);
});

test('a retraction inside the since window counts as movement for the decision and its work order', () => {
  const retractedOldDecision: DecisionSummary = { id: 'd-00000001', chose: 'old call', because: 'x', at: '2026-10-01T00:00:00Z', workId: 'wrk-17ea723e85439d2a', kind: 'decision', standing: 'retracted', retractedAt: '2026-10-08T00:00:00Z' };
  const snapshot = snapshotWith({
    workOrders: [{ id: 'wrk-17ea723e85439d2a', objective: 'Compare prices', state: 'active', readiness: 'active', lastEventAt: '2026-10-01T00:00:00Z' }],
    decisions: [retractedOldDecision],
  });
  const [workReport] = buildCoherenceDelta([trackedWork('wrk-17ea723e85439d2a', 'doing')], new Map([[repo, snapshot]]), '2026-10-05T00:00:00Z');
  assert.ok(workReport?.isAvailable);
  assert.deepEqual(workReport.records[0]?.decisions.map((decision) => decision.id), ['d-00000001']);
  const trackedDecision: TrackedRecord = { ...trackedWork('d-00000001', 'doing'), trackingKind: 'note', record: 'decision' };
  assert.deepEqual(findingKindsFor(trackedDecision, snapshot, '2026-10-05T00:00:00Z'), ['retracted', 'moved-since']);
  assert.deepEqual(findingKindsFor(trackedDecision, snapshot, '2026-10-09T00:00:00Z'), ['retracted']);
});

test('a symlinked journal file leaves the repo unavailable instead of being followed', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const outsideFile = join(mkdtempSync(join(tmpdir(), 'kg-outside-')), 'elsewhere.jsonl');
  writeFileSync(outsideFile, `${JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: 'outside', because: 'x' })}\n`);
  symlinkSync(outsideFile, join(journalDirectory, 's-link.jsonl'));
  assert.deepEqual(readRepoSnapshot(fixtureRepo, steadyCoherence), { isAvailable: false, reason: 's-link.jsonl is not a regular file' });
});

test('a symlinked directory inside the journal leaves the repo unavailable without being walked', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'kg-outside-'));
  writeFileSync(join(outsideDirectory, 's-outside.jsonl'), `${JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: 'outside', because: 'x' })}\n`);
  symlinkSync(outsideDirectory, join(journalDirectory, 'nested'));
  assert.deepEqual(readRepoSnapshot(fixtureRepo, steadyCoherence), { isAvailable: false, reason: 'nested is a symbolic link' });
});

test('a symlinked decisions directory leaves the repo unavailable without being followed', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'kg-outside-'));
  writeFileSync(join(outsideDirectory, 's-outside.jsonl'), `${JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: 'outside', because: 'x' })}\n`);
  rmSync(journalDirectory, { recursive: true });
  symlinkSync(outsideDirectory, journalDirectory);
  assert.deepEqual(readRepoSnapshot(fixtureRepo, steadyCoherence), { isAvailable: false, reason: '.coherence/decisions is not a directory' });
});

test('journal files in a real subdirectory are still read', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  mkdirSync(join(journalDirectory, 'nested'));
  writeFileSync(join(journalDirectory, 'nested', 's-one.jsonl'), `${JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: 'nested', because: 'x' })}\n`);
  const snapshot = readRepoSnapshot(fixtureRepo, steadyCoherence);
  assert.ok(snapshot.isAvailable);
  assert.deepEqual(snapshot.decisions.map((decision) => decision.chose), ['nested']);
});

test('a directory named like a journal file leaves the repo unavailable', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  mkdirSync(join(journalDirectory, 's-dir.jsonl'));
  assert.deepEqual(readRepoSnapshot(fixtureRepo, steadyCoherence), { isAvailable: false, reason: 's-dir.jsonl is not a regular file' });
});

test('a FIFO named like a journal file leaves the repo unavailable without blocking on it', { skip: process.platform === 'win32' }, () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  execFileSync('mkfifo', [join(journalDirectory, 's-pipe.jsonl')]);
  assert.deepEqual(readRepoSnapshot(fixtureRepo, steadyCoherence), { isAvailable: false, reason: 's-pipe.jsonl is not a regular file' });
});

test('a work ledger refusal reports the text coherence gave', () => {
  const { fixtureRepo } = createJournalRepo();
  const refusingCoherence = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? JSON.stringify({ error: 'stray.txt is an unexpected work-ledger entry; only session .jsonl files belong here', usage: ['usage: coherence work inspect'] })
    : '{"action":"refuse","reasons":[],"consequences":{"unverifiedCompletedWork":[]}}';
  assert.deepEqual(readRepoSnapshot(fixtureRepo, refusingCoherence), {
    isAvailable: false,
    reason: 'work ledger refused: stray.txt is an unexpected work-ledger entry; only session .jsonl files belong here',
  });
});

test('bidi controls in ledger text are stripped before they reach a snapshot', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const formatCharacters = [0x202a, 0x202e, 0x2066, 0x2069, 0x200e, 0x200f, 0x061c].map((code) => String.fromCharCode(code)).join('');
  writeFileSync(join(journalDirectory, 's-one.jsonl'), `${JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: `keep${formatCharacters}cache`, because: 'ok' })}\n`);
  const snapshot = readRepoSnapshot(fixtureRepo, steadyCoherence);
  assert.ok(snapshot.isAvailable);
  assert.equal(snapshot.decisions[0]?.chose, 'keepcache');
});

test('zero width joiners in ledger text survive so Persian words and emoji sequences stay intact', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  const zeroWidthNonJoiner = String.fromCharCode(0x200c);
  const zeroWidthJoiner = String.fromCharCode(0x200d);
  const persianWord = `${String.fromCharCode(0x0645, 0x06cc)}${zeroWidthNonJoiner}${String.fromCharCode(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)}`;
  const familyEmoji = `${String.fromCodePoint(0x1f468)}${zeroWidthJoiner}${String.fromCodePoint(0x1f469)}`;
  writeFileSync(join(journalDirectory, 's-one.jsonl'), `${JSON.stringify({ id: 'd-aaaaaaaa', kind: 'decision', at: '2026-10-08T01:00:00Z', chose: `${persianWord} ${familyEmoji}`, because: 'ok' })}\n`);
  const snapshot = readRepoSnapshot(fixtureRepo, steadyCoherence);
  assert.ok(snapshot.isAvailable);
  assert.equal(snapshot.decisions[0]?.chose, `${persianWord} ${familyEmoji}`);
});

test('coherence output missing a required field names the field instead of a bare bracket', () => {
  const { fixtureRepo } = createJournalRepo();
  const workOrderWithoutState = (ledgerRepo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? JSON.stringify({ work: [{ work: 'wrk-17ea723e85439d2a', readiness: 'ready', opened: { objective: 'Compare prices' }, last: null }] })
    : steadyCoherence(ledgerRepo, commandArguments);
  assert.deepEqual(readRepoSnapshot(fixtureRepo, workOrderWithoutState), {
    isAvailable: false,
    reason: 'unexpected coherence work inspect output at work.0.state: Invalid input: expected string, received undefined',
  });
});

test('an orient refusal whose consequences could not be read reports its reasons', () => {
  const { fixtureRepo } = createJournalRepo();
  const refusingOrient = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? '{"work":[]}'
    : JSON.stringify({ action: 'refuse', reasons: ['consequences: stray.txt is an unexpected consequence-ledger entry'], consequences: null });
  assert.deepEqual(readRepoSnapshot(fixtureRepo, refusingOrient), {
    isAvailable: false,
    reason: 'orient refused: consequences: stray.txt is an unexpected consequence-ledger entry',
  });
});

test('a steady orient whose shape drifted names the drifted field', () => {
  const { fixtureRepo } = createJournalRepo();
  const orientWithoutConsequences = (_repo: string, commandArguments: readonly string[]) => commandArguments[0] === 'work'
    ? '{"work":[]}'
    : JSON.stringify({ action: 'steady', reasons: [] });
  const snapshot = readRepoSnapshot(fixtureRepo, orientWithoutConsequences);
  assert.ok(!snapshot.isAvailable);
  assert.match(snapshot.reason, /^unexpected coherence orient output at consequences: /);
});

test('blocked reports and conjectures are read as journal records with their standing', () => {
  const { fixtureRepo, journalDirectory } = createJournalRepo();
  writeFileSync(join(journalDirectory, 's-one.jsonl'), `${[
    { id: 'd-aaaaaaaa', kind: 'blocked', at: '2026-10-08T01:00:00Z', chose: 'could not reach the vendor API', because: 'no key' },
    { id: 'd-bbbbbbbb', kind: 'conjecture', at: '2026-10-08T02:00:00Z', chose: 'prices doubled overnight', because: '' },
    { id: 'd-cccccccc', kind: 'conjecture', at: '2026-10-08T03:00:00Z', chose: 'latency spiked', because: '' },
    { id: 'd-dddddddd', kind: 'resolution', at: '2026-10-08T04:00:00Z', chose: 'currency bug', because: 'test showed it', supersedes: 'd-bbbbbbbb' },
    { id: 'd-eeeeeeee', kind: 'dismissal', at: '2026-10-08T05:00:00Z', chose: '(dismissed: d-cccccccc)', because: 'noise', supersedes: 'd-cccccccc' },
    { id: 'd-ffffffff', kind: 'retraction', at: '2026-10-08T06:00:00Z', chose: '(withdrawn: d-eeeeeeee)', because: 'not noise', supersedes: 'd-eeeeeeee' },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
  const snapshot = readRepoSnapshot(fixtureRepo, steadyCoherence);
  assert.ok(snapshot.isAvailable);
  assert.deepEqual(snapshot.decisions.map((decision) => [decision.id, decision.kind, decision.standing]), [
    ['d-aaaaaaaa', 'blocked', 'standing'],
    ['d-bbbbbbbb', 'conjecture', 'resolved'],
    ['d-cccccccc', 'conjecture', 'open'],
  ]);
});
