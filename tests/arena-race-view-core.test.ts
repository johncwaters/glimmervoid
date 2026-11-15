import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RaceRecord } from '../shared/contracts/race.ts';
import type { LiveContestant } from '../public/arena/race-view-core.ts';
import {
  costCell, diffCell, footHint, rowActions, rowDoing, rowStatus, rowTimeText, rowTrack, orderedContestants, raceClock, raceStage, scoreArea, scoreHeadings, splitUnifiedDiff, stepsOf, trackAxisMs, unsettledCount,
} from '../public/arena/race-view-core.ts';

const MINUTE = 60_000;
const START = 1_000_000;
const setup = { agent: 'claude-code', model: null, options: [], instructions: '' };

function race(overrides: Partial<RaceRecord> = {}): RaceRecord {
  return {
    id: 'race-1',
    spec: { version: 1, title: 'Fix add', prompt: 'Fix add.', repoPath: '/repo', judges: [{ setup }], timeLimitMinutes: 30, rounds: 1, reviewCase: null, check: null, contestants: [{ id: 'a', label: 'Claude Code opus', setup, home: 'operator' }, { id: 'b', label: 'Codex', setup: { ...setup, instructions: 'Be brief' }, home: 'clean' }, { id: 'c', label: 'Kimi', setup, home: 'operator' }] },
    startSha: 'a'.repeat(40), baseBranch: 'main', createdAt: START, phase: 'running', diffStatsByContestant: {}, checkByContestant: {}, metricsByContestant: {}, finishByContestant: {}, judge: null, panel: null, judgeError: null, recallByContestant: {}, winnerContestantId: null, series: null,
    sessionIdByContestant: { a: 's-a', b: 's-b', c: 's-c' },
    ...overrides,
  };
}

const working: LiveContestant = { state: 'RUNNING', stateSince: START, taskTitle: 'Rewriting the backoff test', isMonitoring: false };
const finishedAt5: LiveContestant = { state: 'COMPLETE', stateSince: START + 5 * MINUTE, taskTitle: 'Fixed add', isMonitoring: false };
const waiting: LiveContestant = { state: 'WAITING', stateSince: START + 7 * MINUTE, taskTitle: null, isMonitoring: false };
const lives: Record<string, LiveContestant | null> = { a: working, b: waiting, c: finishedAt5 };
const liveOf = (id: string) => lives[id] ?? null;

const PASS = { reason: 'ok', pass: true };
const judged = race({
  phase: 'judged',
  metricsByContestant: { a: { elapsedMs: 11 * MINUTE, tokens: 212_000, costUSD: 1.84, waits: 0 }, c: { elapsedMs: 5 * MINUTE, tokens: 900, costUSD: 0.62, waits: 1 } },
  panel: {
    verdicts: [{ judge: { agent: 'claude-code', model: null, label: 'claude-code' }, contestants: { c: { criteria: { correctness: PASS, completeness: PASS, scope: PASS, quality: PASS }, tier: 1, notes: 'Add the edge case' } } }],
    failures: [],
    standing: [
      { contestantId: 'c', rank: 1, criteriaPassed: 4, criteria: { correctness: 'pass', completeness: 'pass', scope: 'pass', quality: 'pass' }, meanTier: 1, summary: 'Smallest change' },
      { contestantId: 'a', rank: 2, criteriaPassed: 2.5, criteria: { correctness: 'pass', completeness: 'fail', scope: 'split', quality: 'pass' }, meanTier: 2, summary: 'Too broad' },
    ],
    firstPlaceAgreement: { agreeing: 1, judges: 1 },
  },
});

test('a running race shows its clock against the time limit and the settled count in its first step', () => {
  const now = START + 8 * MINUTE + 42_000;
  assert.deepEqual(raceClock(race(), liveOf, now), { value: '8:42', caption: '30m limit, 21:18 left', limitFraction: (8 * MINUTE + 42_000) / (30 * MINUTE) });
  assert.equal(raceClock(race(), liveOf, START + 31 * MINUTE).caption, '30m limit reached');
  assert.equal(raceClock(race({ spec: { ...race().spec, timeLimitMinutes: null } }), liveOf, now).caption, 'No time limit');
  assert.deepEqual(stepsOf(race(), liveOf).map((step) => [step.label, step.status]), [['Running, 1 of 3 settled', 'now'], ['Judging', 'next'], ['Judged', 'next'], ['Winner', 'next']]);
  assert.equal(unsettledCount(race(), liveOf), 2);
});

test('rows share one time axis, so a contestant that finished first stops short of one still working', () => {
  const now = START + 10 * MINUTE;
  const axis = trackAxisMs(race(), liveOf, now);
  assert.equal(axis, 30 * MINUTE, 'the time limit sets the axis while the race is inside it');
  assert.deepEqual(rowTrack(race(), 'c', finishedAt5, now, axis), { fraction: 5 / 30, isFinished: true });
  assert.deepEqual(rowTrack(race(), 'a', working, now, axis), { fraction: 10 / 30, isFinished: false });
  assert.equal(rowTimeText(race(), 'c', finishedAt5, now), '5:00');
  assert.equal(rowTimeText(race(), 'a', working, now), '10:00');
});

test('each row names its state with the shared status icon, and says what the contestant is doing', () => {
  const now = START + 8 * MINUTE + 12_000;
  assert.deepEqual(rowStatus(race(), 'a', working, false), { stateKey: 'RUNNING', icon: 'working', label: 'Working' });
  assert.deepEqual(rowStatus(race(), 'a', { ...working, isMonitoring: true }, false), { stateKey: 'RUNNING', icon: 'monitoring', label: 'Monitoring' });
  assert.deepEqual(rowStatus(race(), 'b', waiting, false), { stateKey: 'WAITING', icon: 'needs-input', label: 'Needs Input' });
  assert.deepEqual(rowStatus(race(), 'c', finishedAt5, false), { stateKey: 'COMPLETE', icon: 'complete', label: 'Finished' });
  assert.deepEqual(rowStatus(race(), 'a', null, false), { stateKey: 'REMOVED', icon: 'exited', label: 'Removed' });
  assert.equal(rowDoing(race(), 'a', working, now), 'Rewriting the backoff test');
  assert.equal(rowDoing(race(), 'b', waiting, now), 'Needs input for 1:12');
  assert.equal(rowDoing(race(), 'a', null, now), 'Session removed');
  const stalled = race({ phase: 'judged', finishByContestant: { b: { status: 'did-not-finish', reason: 'out of time' } } });
  assert.deepEqual(rowStatus(stalled, 'b', waiting, false), { stateKey: 'FAILED', icon: 'failed', label: 'Did not finish' });
  assert.equal(rowDoing(stalled, 'b', waiting, now), 'Did not finish: out of time');
});

test('while running a row can be opened and its diff read, and no one can be picked as winner yet', () => {
  assert.deepEqual(rowActions(race(), 'a', working, false), { canOpen: true, detailsLabel: 'Diff', pick: null });
  assert.deepEqual(rowActions(race(), 'a', null, false), { canOpen: false, detailsLabel: null, pick: null });
  assert.match(footHint(race(), liveOf), /Judging starts once every contestant settles/);
  assert.match(footHint(race({ spec: { ...race().spec, judges: [] } }), liveOf), /No judges/);
});

test('a judged race ranks its rows, shows criteria as cells, and offers the top contestant as the primary pick', () => {
  assert.equal(raceStage(judged), 'judged');
  assert.deepEqual(orderedContestants(judged).map((contestant) => contestant.id), ['c', 'a', 'b']);
  assert.deepEqual(scoreHeadings(judged), ['Correct', 'Complete', 'Scope', 'Quality']);
  const judgedArea = scoreArea(judged, 'a');
  assert.equal(judgedArea.kind, 'criteria');
  if (judgedArea.kind === 'criteria') assert.deepEqual(judgedArea.cells.map((cell) => cell.standing), ['pass', 'fail', 'split', 'pass']);
  assert.deepEqual(scoreArea(judged, 'b'), { kind: 'note', text: 'not ranked' });
  assert.equal(rowActions(judged, 'c', finishedAt5, false).pick, 'primary');
  assert.equal(rowActions(judged, 'a', working, false).pick, 'secondary');
  assert.equal(rowActions(judged, 'c', finishedAt5, false).detailsLabel, 'Details');
  assert.equal(rowActions(judged, 'c', finishedAt5, false).canOpen, false, 'a judged row opens its session from the details drawer');
  assert.equal(rowActions(judged, 'b', finishedAt5, false).pick, null, 'an unranked contestant is not offered as winner');
  assert.equal(rowDoing(judged, 'c', finishedAt5, START), 'Smallest change');
  assert.deepEqual(raceClock(judged, liveOf, START + 60 * MINUTE), { value: '11:00', caption: 'First Kimi', limitFraction: null });
  assert.deepEqual(stepsOf({ ...judged, winnerContestantId: 'c' }, liveOf).map((step) => step.status), ['done', 'done', 'done', 'now']);
  assert.deepEqual(rowActions({ ...judged, winnerContestantId: 'c' }, 'c', finishedAt5, false).pick, null);
});

test('a judged race with a check command shows the check as a criteria column', () => {
  const checked = { ...judged, spec: { ...judged.spec, check: { program: 'npm', args: ['test'], timeoutSeconds: 600 } }, checkByContestant: { c: { status: 'passed' as const, exitCode: 0, reason: null, durationMs: 1, outputTail: '' } } };
  assert.deepEqual(scoreHeadings(checked), ['Correct', 'Complete', 'Scope', 'Quality', 'Check']);
  const area = scoreArea(checked, 'a');
  if (area.kind !== 'criteria') assert.fail('expected criteria');
  assert.deepEqual(area.cells.map((cell) => `${cell.key}=${cell.standing}`), ['correctness=pass', 'completeness=fail', 'scope=split', 'quality=pass', 'check=none']);
});

test('a review case race ranks by recall instead of criteria', () => {
  const reviewCase = { caseId: 'pr-12', repo: 'acme/app', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), changedFiles: ['a.ts'], references: [{ id: 'r1', text: 'Off by one', tags: [], path: 'a.ts', line: 1 }] };
  const reviewed = race({ phase: 'judged', spec: { ...race().spec, reviewCase }, recallByContestant: { a: 0.5, c: 1 } });
  assert.deepEqual(scoreArea(reviewed, 'c'), { kind: 'recall', fraction: 1, text: 'recall 100%' });
  assert.deepEqual(scoreHeadings(reviewed), ['Recall']);
  assert.deepEqual(orderedContestants(reviewed).map((contestant) => contestant.id).slice(0, 2), ['c', 'a']);
});

test('diff, check and cost cells read as a value with a caption', () => {
  const failedCheck = { status: 'failed' as const, exitCode: 1, reason: null, durationMs: 5, outputTail: '' };
  assert.deepEqual(diffCell({ filesChanged: 2, linesAdded: 38, linesRemoved: 12 }, failedCheck, false), { value: '+38 -12', caption: '2 files, check failed, exit 1' });
  assert.deepEqual(diffCell({ filesChanged: 1, linesAdded: 3, linesRemoved: 0 }, failedCheck, true), { value: '+3 -0', caption: '1 file' }, 'a judged race shows the check in its own column instead');
  assert.deepEqual(diffCell(undefined, undefined, false), { value: '-', caption: '' });
  assert.deepEqual(costCell({ elapsedMs: 1, tokens: 212_000, costUSD: 0.625, waits: 2 }), { value: '$0.63', caption: '212k tokens, 2 waits' });
});

test('a contestant diff splits into one patch per file with its own line counts', () => {
  const text = [
    'diff --git a/add.ts b/add.ts', 'index 1..2 100644', '--- a/add.ts', '+++ b/add.ts', '@@ -1 +1 @@', '-a - b', '+a + b',
    'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two', '',
  ].join('\n');
  const files = splitUnifiedDiff(text);
  assert.deepEqual(files.map((file) => [file.path, file.added, file.removed]), [['add.ts', 1, 1], ['gone.ts', 0, 2]]);
  assert.ok(files[0]?.patch.startsWith('diff --git a/add.ts'));
  assert.deepEqual(splitUnifiedDiff('No changes.'), []);
});
