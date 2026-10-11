import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FactoryState } from '../shared/contracts/factory.ts';
import { decideVerdict, matchedProductText, pidsStillNamingSameProcess, processesUsingBuildOutput, unexpectedAcceptanceError } from '../test/factory/verdict.ts';
import type { VerdictInput } from '../test/factory/verdict.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const verifyCloseSubject = `${matchedProductText.verifyCloseSubject.text}intent`;

const startedAt = '2026-10-11T00:00:00.000Z';
const endedAt = '2026-10-11T00:01:00.000Z';
const workerSha = 'a'.repeat(40);
const completedBroadcast = {
  arrivedAt: endedAt,
  state: FactoryState.parse({ type: 'factory-state', ts: Date.parse(endedAt), projects: [{
    projectId: 'seed', projectName: 'Seed', headSha: workerSha, paused: false, orchestrator: null, error: null,
    heading: { action: 'steady', reasons: [] }, orders: [{
      id: 'intent', objective: 'Add subtract', openedAt: startedAt, criteria: ['subtract works'], boundary: 'Seed',
      risk: 'low', state: 'completed', readiness: 'ready', parent: null, dependsOn: [], writeScopes: ['src'], owner: null, lastEvent: null,
    }], conflicts: [], unverifiedCompletedWork: [],
  }] }),
};

function decision(overrides: Record<string, unknown>) {
  return JSON.stringify({ timestamp: endedAt, projectId: 'seed', outcome: 'raised', workId: 'worker', intentId: 'intent', sessionId: 'session', attempt: 1, durationMs: 0, failureClass: 'exception', reason: 'Failure', kind: 'exception', ...overrides });
}

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return { intentName: 'one-file-change', expectedEnd: 'completed', expectedRefusal: null, projectId: 'seed', startedAt, endedAt,
    queueReply: { projectId: 'seed', ok: true, workId: 'intent' }, queueRepliedAt: startedAt,
    broadcasts: [], decisionLines: [], originCommits: [], sessionIds: [], stopReason: 'timeout', errors: [], ...overrides };
}

function completingInput(): VerdictInput {
  return input({ stopReason: 'completed', broadcasts: [completedBroadcast],
    decisionLines: [decision({ kind: 'merge', outcome: 'merged', failureClass: null, reason: null, mergedSha: workerSha })],
    originCommits: [{ sha: workerSha, subject: 'Add subtract' }, { sha: 'b'.repeat(40), subject: verifyCloseSubject }],
  });
}

test('completion requires steady completion and both worker and verify-close commits on origin', () => {
  const verdict = decideVerdict(completingInput());
  assert.equal(verdict.outcome, 'pass');
  assert.equal(verdict.failureClass, null);
  assert.equal(verdict.milestonesMs.completed, 60_000);
  assert.equal(verdict.sessionCount, 1);
  assert.deepEqual(verdict.attemptsPerOrder, { worker: 1 });
  const missingWorker = decideVerdict({ ...completingInput(), originCommits: [{ sha: 'b'.repeat(40), subject: verifyCloseSubject }] });
  assert.equal(missingWorker.outcome, 'fail');
  assert.equal(missingWorker.failureClass, 'exception');
});

test('the refusal expected end passes only the expected refusal and fails another refusal or an accepted intent', () => {
  const refusal = (error: string) => decideVerdict(input({ expectedEnd: 'refused', expectedRefusal: 'Unknown factory project', stopReason: 'refused', queueReply: { projectId: 'seed', ok: false, error } }));
  const refused = refusal('Unknown factory project');
  assert.equal(refused.outcome, 'pass');
  assert.equal(refused.failureClass, null);
  const mismatched = refusal('Factory is not running');
  assert.equal(mismatched.outcome, 'fail');
  assert.equal(mismatched.failureClass, 'queue-refused');
  assert.equal(mismatched.queueReplyError, 'Factory is not running');
  const accepted = decideVerdict({ ...completingInput(), expectedEnd: 'refused' });
  assert.equal(accepted.outcome, 'fail');
  assert.equal(accepted.failureClass, 'exception');
  assert.match(unexpectedAcceptanceError('refused', completingInput().queueReply) ?? '', /accepted an intent it was expected to refuse/);
});

test('the product source still contains every literal the verdict matches', () => {
  for (const { sourceFile, text } of Object.values(matchedProductText)) {
    assert.ok(fs.readFileSync(path.join(repoRoot, sourceFile), 'utf8').includes(text), `${sourceFile} no longer contains "${text}"`);
  }
});

test('a process running from the dist of this checkout, or one that could with an unreadable working directory, blocks the batch build', () => {
  const buildOutput = { directory: '/checkout/dist', entryPaths: ['/checkout/dist', '/checkout/dist/server', '/checkout/dist/server/index.js', '/checkout/dist/bin', '/checkout/dist/bin/glimmervoid.js'] };
  const located = (pid: number, resolvedArguments: string[], unresolvedRelativeArguments: string[] = []) => ({ pid, command: '', resolvedArguments, unresolvedRelativeArguments });
  const conflicts = processesUsingBuildOutput([
    located(1, ['/usr/bin/node', '/checkout/dist/server/index.js']),
    located(2, ['/usr/bin/node', '/other-checkout/dist/server/index.js']),
    located(3, ['/usr/bin/node', '/checkout/dist/bin/glimmervoid.js']),
    located(4, ['/usr/bin/node'], ['dist/server/index.js']),
    located(5, ['/usr/bin/node'], ['../bin/glimmervoid.js']),
    located(6, ['/usr/sbin/sshd'], ['listener', 'startups']),
    located(7, ['/usr/bin/node', '/checkout/test/factory/run.ts']),
    located(8, ['/usr/bin/node', '/checkout/dist/server/index.js']),
    { ...located(9, []), command: 'node /checkout/dist/server/index.js' },
  ], buildOutput, 8);
  assert.deepEqual(conflicts.map((conflict) => conflict.pid), [1, 3, 4, 5, 9]);
});

test('a recorded descendant is signalled only while its pid still carries the recorded start time', () => {
  const recordedStart = 'Sun Oct 11 14:35:27 2026';
  const recorded = [{ pid: 10, startedAt: recordedStart }, { pid: 11, startedAt: recordedStart }, { pid: 12, startedAt: recordedStart }, { pid: 13, startedAt: '' }];
  const current = [{ pid: 10, startedAt: recordedStart }, { pid: 11, startedAt: 'Sun Oct 11 14:35:33 2026' }, { pid: 13, startedAt: '' }];
  assert.deepEqual(pidsStillNamingSameProcess(recorded, current), [10]);
});

test('failure precedence is interrupted, queue-refused, stalled, checks, review, exception, timeout', () => {
  const closeout = (failureClass: 'check' | 'review') => decision({ kind: 'closeout', outcome: 'block', failureClass, fence: null, checks: [], review: null });
  const failures = [decision({ outcome: 'stalled', failureClass: 'stall' }), closeout('check'), closeout('review'), decision({})];
  const competing = input({ stopReason: 'interrupted', queueReply: { projectId: 'seed', ok: false }, decisionLines: failures });
  assert.equal(decideVerdict(competing).failureClass, 'interrupted');
  assert.equal(decideVerdict({ ...competing, stopReason: 'timeout' }).failureClass, 'queue-refused');
  for (const [index, expected] of ['stalled', 'checks', 'review', 'exception', 'timeout'].entries()) {
    assert.equal(decideVerdict(input({ decisionLines: failures.slice(index) })).failureClass, expected);
  }
  assert.equal(decideVerdict({ ...completingInput(), stopReason: 'interrupted' }).failureClass, 'interrupted');
});

test('malformed and schema-invalid decision lines are counted and reported without throwing', () => {
  const verdict = decideVerdict(input({ decisionLines: ['{', JSON.stringify({ kind: 'invented' })] }));
  assert.equal(verdict.invalidDecisionLineCount, 2);
  assert.deepEqual(verdict.invalidDecisionLines.map((line) => line.line), [1, 2]);
  assert.ok(verdict.invalidDecisionLines.every((line) => line.error.length > 0));
  assert.equal(verdict.failureClass, 'exception');
});
