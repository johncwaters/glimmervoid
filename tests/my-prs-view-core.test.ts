import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStateText, groupMyPrs, chooseSelectedKey, parseMyPrsStatus, queueNotices, readinessRows, stageLabel, stageTone } from '../public/my-prs-view-core.ts';
import { toMyPr } from '../server/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode } from '../shared/contracts/my-prs.ts';

const node: MyPrSearchNode = {
  __typename: 'PullRequest', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1', isDraft: false,
  state: 'OPEN', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', headRefOid: 'a'.repeat(40),
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app' },
  commits: { nodes: [] }, reviewThreads: { nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] },
};
const base = toMyPr(node, 0);
const pr = (stage: MyPr['stage'], number: number): MyPr => ({ ...base, stage, number, key: `Acme/app#${number}` });

test('groups every stage in fixed section order and preserves selection', () => {
  const sections = groupMyPrs([pr('merged', 5), pr('draft', 4), pr('ready', 3), pr('unknown', 2), pr('conflicts', 1)]);
  assert.deepEqual(sections.map((section) => [section.title, section.prs.map((item) => item.number)]), [
    ['Needs you', [1]], ['Waiting', [2]], ['Ready to merge', [3]], ['Drafts', [4]], ['Merged today', [5]],
  ]);
  assert.equal(chooseSelectedKey(sections, 'Acme/app#3'), 'Acme/app#3');
  assert.equal(chooseSelectedKey(sections, 'gone'), 'Acme/app#1');
});

test('labels, tones and empty messages reflect status', () => {
  assert.equal(stageLabel('conflicts'), 'Merge conflicts');
  assert.equal(stageTone('conflicts'), 'danger');
  const status = parseMyPrsStatus({ type: 'my-prs-status', ts: 1, configured: true, viewer: 'alice', prs: [] });
  assert.ok(status);
  assert.match(emptyStateText(status), /No open/);
  assert.match(emptyStateText({ ...status, configured: false }), /Team review/);
  assert.match(emptyStateText({ ...status, error: 'offline' }), /offline/);
  assert.equal(parseMyPrsStatus({ type: 'my-prs-status', ts: 1, configured: true, viewer: null, prs: [{}] }), null);
});

test('readiness rows cover merged and each checks outcome in order', () => {
  assert.deepEqual(readinessRows({ ...base, state: 'MERGED' }), []);
  const checks = (overrides: Partial<MyPr['checks']>) => readinessRows({ ...base, checks: { ...base.checks, ...overrides } })[0];
  assert.deepEqual(checks({ state: 'FAILURE', failing: ['a', 'b', 'c', 'd'], pendingCount: 2 }), { label: 'Checks', tone: 'danger', text: '4 failing: a, b, c and 1 more' });
  assert.deepEqual(checks({ state: 'PENDING', failing: [], pendingCount: 2 }), { label: 'Checks', tone: 'wait', text: '2 running' });
  assert.deepEqual(checks({ state: 'SUCCESS', failing: [], pendingCount: 0 }), { label: 'Checks', tone: 'ok', text: 'Passing' });
  assert.deepEqual(checks({ state: null, failing: [], pendingCount: 0 }), { label: 'Checks', tone: 'muted', text: 'No checks' });
  assert.deepEqual(checks({ state: 'ERROR', failing: [], pendingCount: 0 }), { label: 'Checks', tone: 'danger', text: 'Failing' });
  assert.deepEqual(checks({ state: 'FAILURE', failing: [], pendingCount: 3 }), { label: 'Checks', tone: 'danger', text: 'Failing' });
  assert.deepEqual(checks({ state: 'PENDING', failing: [], pendingCount: 0 }), { label: 'Checks', tone: 'wait', text: 'Running' });
  assert.deepEqual(checks({ state: 'EXPECTED', failing: [], pendingCount: 0 }), { label: 'Checks', tone: 'wait', text: 'Running' });
  assert.deepEqual(readinessRows(base).map((row) => row.label), ['Checks', 'Review', 'Threads', 'Conflicts', 'Base']);
});

test('readiness rows cover review, threads, conflicts and base outcomes', () => {
  const row = (label: string, overrides: Partial<MyPr>) => readinessRows({ ...base, ...overrides }).find((item) => item.label === label);
  assert.deepEqual(row('Review', { reviewDecision: 'CHANGES_REQUESTED', approvals: 2 }), { label: 'Review', tone: 'warn', text: 'Changes requested' });
  assert.deepEqual(row('Review', { reviewDecision: 'APPROVED', approvals: 2 }), { label: 'Review', tone: 'ok', text: '2 approvals' });
  assert.deepEqual(row('Review', { reviewDecision: 'APPROVED', approvals: 0 }), { label: 'Review', tone: 'ok', text: 'Approved' });
  assert.deepEqual(row('Review', { reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', approvals: 2 }), { label: 'Review', tone: 'wait', text: '2 approvals, merge blocked' });
  assert.deepEqual(row('Review', { reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', approvals: 0 }), { label: 'Review', tone: 'wait', text: 'Approved, merge blocked' });
  assert.deepEqual(row('Review', { reviewDecision: null, reviewRequests: ['Acme/docs', 'Acme/app'] }), { label: 'Review', tone: 'wait', text: 'Requested: Acme/docs, Acme/app' });
  assert.deepEqual(row('Review', { reviewDecision: null, reviewRequests: [] }), { label: 'Review', tone: 'muted', text: 'No review requested' });
  assert.deepEqual(row('Review', { reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], approvals: 0 }), { label: 'Review', tone: 'wait', text: 'Approval required' });
  assert.deepEqual(row('Review', { reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], approvals: 1 }), { label: 'Review', tone: 'wait', text: 'Approval required, 1 approval' });
  assert.deepEqual(row('Review', { reviewDecision: 'REVIEW_REQUIRED', reviewRequests: ['bob'], approvals: 2 }), { label: 'Review', tone: 'wait', text: 'Requested: bob, 2 approvals' });
  assert.deepEqual(row('Review', { reviewDecision: null, mergeStateStatus: 'BLOCKED', reviewRequests: [], approvals: 0 }), { label: 'Review', tone: 'wait', text: 'Approval required' });
  assert.deepEqual(row('Review', { reviewDecision: null, mergeStateStatus: 'BLOCKED', reviewRequests: ['bob'], approvals: 0 }), { label: 'Review', tone: 'wait', text: 'Requested: bob' });
  assert.deepEqual(row('Review', { reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }), { label: 'Review', tone: 'warn', text: 'Changes requested' });
  assert.deepEqual(row('Threads', { unresolvedThreads: 2 }), { label: 'Threads', tone: 'warn', text: '2 unresolved' });
  assert.deepEqual(row('Threads', { unresolvedThreads: 0 }), { label: 'Threads', tone: 'ok', text: 'None open' });
  assert.deepEqual(row('Conflicts', { mergeable: 'CONFLICTING' }), { label: 'Conflicts', tone: 'danger', text: 'Conflicts with main' });
  assert.deepEqual(row('Conflicts', { mergeable: 'MERGEABLE' }), { label: 'Conflicts', tone: 'ok', text: 'None' });
  assert.deepEqual(row('Conflicts', { mergeable: 'UNKNOWN' }), { label: 'Conflicts', tone: 'muted', text: 'Not computed yet' });
  assert.deepEqual(row('Conflicts', { mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }), { label: 'Conflicts', tone: 'danger', text: 'Conflicts with main' });
  assert.deepEqual(row('Base', { behindBy: 3 }), { label: 'Base', tone: 'muted', text: '3 behind main, update not required' });
  assert.deepEqual(row('Base', { behindBy: 3, mergeStateStatus: 'BEHIND' }), { label: 'Base', tone: 'warn', text: '3 behind main' });
  assert.deepEqual(row('Base', { behindBy: 0 }), { label: 'Base', tone: 'ok', text: 'Up to date with main' });
  assert.deepEqual(row('Base', { behindBy: null }), { label: 'Base', tone: 'muted', text: 'Unknown' });
  assert.deepEqual(row('Base', { behindBy: null, mergeStateStatus: 'BEHIND' }), { label: 'Base', tone: 'warn', text: 'Behind main' });
  assert.deepEqual(row('Base', { behindBy: 0, mergeStateStatus: 'BEHIND' }), { label: 'Base', tone: 'warn', text: 'Behind main' });
});

test('queue notices list the refresh error before the truncation note', () => {
  const status = parseMyPrsStatus({ type: 'my-prs-status', ts: 1, configured: true, viewer: 'alice', prs: [base] });
  assert.ok(status);
  const truncatedNote = 'Showing the 50 most recently updated of 73 pull requests.';
  assert.deepEqual(queueNotices(null), []);
  assert.deepEqual(queueNotices(status), []);
  assert.deepEqual(queueNotices({ ...status, truncatedNote }), [{ text: truncatedNote, tone: 'info' }]);
  assert.deepEqual(queueNotices({ ...status, error: 'offline', truncatedNote }), [{ text: 'Could not refresh your pull requests: offline', tone: 'error' }, { text: truncatedNote, tone: 'info' }]);
});
