import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeIssues, buildIssuesSinceQuery, buildVerifierPrompt, checkFence, decideAdmission, decideIntentClose, evidenceNamesOnlySha, watchesDue } from '../server/core/factory-core.ts';
import type { FactoryWorkOrder } from '../server/core/factory-core.ts';
import type { FactoryIssue, FactoryProjectState, FactoryWatchEntry } from '../shared/contracts/factory.ts';

const mergedAt = '2026-10-08T12:00:00.000Z';
const mergedAtMs = Date.parse(mergedAt);
const watch: FactoryWatchEntry = { workId: 'child', intentId: 'intent', projectId: 'project', mergedSha: 'a'.repeat(40), mergedAt, writeScopes: ['src/retry.ts'] };
const intent: FactoryProjectState['orders'][number] = {
  id: 'intent', objective: 'Ship retries', openedAt: mergedAt, criteria: ['Retries work'], boundary: 'This repo', risk: 'medium',
  state: 'open', readiness: 'ready', parent: null, dependsOn: [], writeScopes: ['src'], owner: null, lastEvent: null,
};
const child = { ...intent, id: 'child', parent: 'intent', state: 'completed' as const };

for (const rootScope of ['.', '**']) {
  test(`canonical root scope ${rootScope} contains nested admission and fence paths`, () => {
    const root: FactoryWorkOrder = { work: 'intent', state: 'open', readiness: 'ready', owner: { session: 'factory', agent: 'claude-code' }, last: null,
      opened: { at: mergedAt, objective: 'Ship retries', criteria: [], authority: { boundary: 'repo' }, risk: 'medium', parent: null,
        dependsOn: [], readScopes: [], writeScopes: [rootScope] } };
    const order = { ...root, work: 'child', opened: { ...root.opened, parent: 'intent', writeScopes: ['src/retry.ts'] } };
    assert.deepEqual(decideAdmission({ intent: root, order, trustedIntentIds: new Set([root.work]), liveWorkers: [], spentTodayUsd: 0, dailyBudgetUsd: null }), { admit: true });
    assert.deepEqual(checkFence({ changedPaths: ['src/retry.ts'], writeScopes: [rootScope], protectedPaths: [] }), { ok: true });
    assert.equal(checkFence({ changedPaths: ['.coherence/work.jsonl'], writeScopes: [rootScope], protectedPaths: [] }).ok, false);
    assert.equal(decideAdmission({ intent: root, order, trustedIntentIds: new Set([root.work]), liveWorkers: [{ writeScopes: [rootScope] }], spentTodayUsd: 0, dailyBudgetUsd: null }).admit, false);
  });
}

test('watch windows split at the elapsed boundary and keep future merges open', () => {
  const future = { ...watch, workId: 'future', mergedAt: '2026-10-08T13:00:00.000Z' };
  assert.deepEqual(watchesDue([watch, future], mergedAtMs + 60_000, 60_000), { stillOpen: [future], elapsed: [watch] });
  assert.deepEqual(watchesDue([watch], mergedAtMs + 59_999, 60_000), { stillOpen: [watch], elapsed: [] });
  assert.deepEqual(watchesDue([], mergedAtMs, 60_000), { stillOpen: [], elapsed: [] });
});

for (const framePath of ['src/retry.ts', '/srv/app/src/retry.ts', 'dist/src/retry.ts', 'webpack:///./src/retry.ts',
  'app:///dist/src/retry.ts', 'C:\\build\\src\\retry.ts:23:4', 'file:///srv/src/retry.ts?version=2']) {
  test(`issue attribution accepts normalized frame ${framePath}`, () => {
    const issue = { issueId: 'issue', firstSeenMs: mergedAtMs + 1, framePaths: [framePath] };
    assert.deepEqual(attributeIssues({ watches: [watch], issues: [issue] }), [{ watch, issue }]);
  });
}

test('issue attribution respects path boundaries, merge time, longest suffix and multiple watches', () => {
  const issues: FactoryIssue[] = [
    { issueId: 'old', firstSeenMs: mergedAtMs - 1, framePaths: ['src/retry.ts'] },
    { issueId: 'same-time', firstSeenMs: mergedAtMs, framePaths: ['src/retry.ts'] },
    { issueId: 'boundary', firstSeenMs: mergedAtMs + 1, framePaths: ['src/retry.tsx', 'src2/retry.ts', 'src/../retry.ts'] },
    { issueId: 'new', firstSeenMs: mergedAtMs + 1, framePaths: ['/srv/src/retry.ts'] },
  ];
  const nestedWatch = { ...watch, workId: 'nested', writeScopes: ['srv/src'] };
  const futureWatch = { ...watch, workId: 'future', mergedAt: '2026-10-08T12:01:00.000Z' };
  assert.deepEqual(attributeIssues({ watches: [watch, nestedWatch, futureWatch], issues }), [{ watch, issue: issues[3] }, { watch: nestedWatch, issue: issues[3] }]);
  for (const scope of ['.', '**']) assert.equal(attributeIssues({ watches: [{ ...watch, writeScopes: [scope] }], issues: [issues[3]] }).length, 1);
});

test('issue query bounds output, extracts nested frame sources and preserves global first seen', () => {
  const query = buildIssuesSinceQuery(mergedAt);
  for (const text of ["event = '$exception'", 'min(timestamp) AS firstSeen', '$exception_issue_id', '$exception_list', "'stacktrace', 'frames'", "JSONExtractString(frame, 'source')", 'arrayDistinct', mergedAt, 'HAVING firstSeen >', 'LIMIT 500']) assert.ok(query.includes(text), text);
  assert.ok(query.indexOf('timestamp >=') > query.indexOf('IN (SELECT'));
  assert.ok(buildIssuesSinceQuery('2026-10-08T12:00:00Z').includes('2026-10-08T12:00:00Z'));
  assert.ok(buildIssuesSinceQuery('2026-10-08T12:00:00.123456Z').includes('2026-10-08T12:00:00.123456Z'));
});

for (const sinceIso of ['', 'yesterday', '2026-02-30T12:00:00.000Z', '2026-10-08', "2026-10-08T12:00:00.000Z'); DROP TABLE events", '2026-10-08T12:00:00+00:00']) {
  test(`issue query rejects timestamp ${JSON.stringify(sinceIso)}`, () => { assert.throws(() => buildIssuesSinceQuery(sinceIso), /Invalid/); });
}

test('intent close requires ready signal, completed verified children, and independent root verification', () => {
  const input = { intent, children: [child], verifiedWorkIds: new Set(['child']), orchestratorSaidReady: true };
  assert.equal(decideIntentClose(input), 'verify');
  assert.equal(decideIntentClose({ ...input, orchestratorSaidReady: false }), 'wait');
  assert.equal(decideIntentClose({ ...input, children: [] }), 'verify');
  assert.equal(decideIntentClose({ ...input, children: [{ ...child, state: 'active' }] }), 'wait');
  assert.equal(decideIntentClose({ ...input, children: [{ ...child, parent: 'another' }] }), 'wait');
  assert.equal(decideIntentClose({ ...input, verifiedWorkIds: new Set() }), 'wait');
  assert.equal(decideIntentClose({ ...input, intent: { ...intent, state: 'cancelled' } }), 'wait');
  assert.equal(decideIntentClose({ ...input, intent: { ...intent, state: 'completed' } }), 'close-without-verifier');
  assert.equal(decideIntentClose({ ...input, intent: { ...intent, state: 'completed' }, verifiedWorkIds: new Set(['intent', 'child']) }), 'wait');
});

test('verifier prompt pins all criteria, children, tip, read-only posture and independent identity', () => {
  const prompt = buildVerifierPrompt({ projectName: 'Factory', intent, children: [child], tipSha: 'b'.repeat(40), checkoutPath: '/factory/control' });
  for (const text of ['Factory', 'intent', 'child', 'Ship retries', 'Retries work', 'This repo', 'b'.repeat(40), 'never wrote', 'read-only', 'Never edit', '"pass": boolean', '"findings": string[]', 'untrusted task data', '"/factory/control"']) assert.ok(prompt.includes(text), text);
  assert.match(prompt, /<<<GLIMMERVOID-FACTORY-VERIFIER-INTENT/);
});

test('verification evidence counts only when every sha it names is the sha the trust was issued for', () => {
  const issuedSha = 'a'.repeat(40);
  const otherSha = 'b'.repeat(40);
  assert.equal(evidenceNamesOnlySha(`Independent verifier passed every intent criterion at ${issuedSha}`, issuedSha), true);
  assert.equal(evidenceNamesOnlySha(`Clean watch window after ${issuedSha} merged at ${mergedAt}`, issuedSha), true);
  assert.equal(evidenceNamesOnlySha(`Independent verifier passed every intent criterion at ${otherSha}`, issuedSha), false);
  assert.equal(evidenceNamesOnlySha(`Passed at ${issuedSha} and ${otherSha}`, issuedSha), false);
  assert.equal(evidenceNamesOnlySha('Forged', issuedSha), false);
  assert.equal(evidenceNamesOnlySha(undefined, issuedSha), false);
});
