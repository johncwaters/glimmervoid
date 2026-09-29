import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStateText, groupMyPrs, chooseSelectedKey, parseMyPrsStatus, queueNotices, readinessRows, reviewRows, stageLabel, stageTone, threadRows } from '../public/my-prs-view-core.ts';
import { toMyPr } from '../server/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode, MyPrThread } from '../shared/contracts/my-prs.ts';

const node: MyPrSearchNode = {
  __typename: 'PullRequest', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1', isDraft: false,
  state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', headRefOid: 'a'.repeat(40),
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app' },
  commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
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

function thread(overrides: Partial<MyPrThread>): MyPrThread {
  return {
    path: 'src/app.ts', line: 4, isOutdated: false, url: 'https://github.com/Acme/app/pull/1#discussion_r1', author: 'bob',
    excerpt: 'Rename this', commentCount: 1, lastAuthor: 'bob', lastActivityAt: '2026-09-28T10:00:00Z', ...overrides,
  };
}

test('thread rows list threads waiting on the viewer first, newest activity next', () => {
  const threads = [
    thread({ path: 'a.ts', lastAuthor: 'alice', commentCount: 2, lastActivityAt: '2026-09-28T12:00:00Z' }),
    thread({ path: 'b.ts', lastActivityAt: '2026-09-28T09:00:00Z' }),
    thread({ path: 'c.ts', line: null, isOutdated: true, commentCount: 4, lastAuthor: 'carol', lastActivityAt: '2026-09-28T11:00:00Z' }),
  ];
  const rows = threadRows({ ...base, unresolvedThreads: 3, threads }, 'alice');
  assert.deepEqual(rows.map((row) => [row.location, row.waiting?.text, row.replySummary]), [
    ['c.ts (outdated)', 'Waiting on you', '3 replies, last by carol'],
    ['b.ts:4', 'Waiting on you', 'No replies'],
    ['a.ts:4', 'Waiting on reviewer', '1 reply, last by alice'],
  ]);
  assert.equal(threadRows({ ...base, threads }, null)[0].waiting, null);
});

test('threads readiness says how many threads wait on the viewer', () => {
  const row = (overrides: Partial<MyPr>, viewer: string | null) => readinessRows({ ...base, ...overrides }, viewer).find((item) => item.label === 'Threads');
  const threads = [thread({}), thread({ lastAuthor: 'alice' })];
  assert.deepEqual(row({ unresolvedThreads: 2, threads }, 'alice'), { label: 'Threads', tone: 'warn', text: '2 unresolved, 1 waiting on you' });
  assert.deepEqual(row({ unresolvedThreads: 1, threads: [thread({ lastAuthor: 'alice' })] }, 'alice'), { label: 'Threads', tone: 'wait', text: '1 unresolved, all waiting on reviewers' });
  assert.deepEqual(row({ unresolvedThreads: 2, threads }, null), { label: 'Threads', tone: 'warn', text: '2 unresolved' });
});

test('review rows list the newest review first with a readable verdict', () => {
  const rows = reviewRows({ ...base, reviews: [
    { reviewer: 'bob', state: 'APPROVED', submittedAt: '2026-09-27T10:00:00Z' },
    { reviewer: null, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-28T10:00:00Z' },
    { reviewer: 'carol', state: 'COMMENTED', submittedAt: null },
  ] });
  assert.deepEqual(rows, [
    { reviewer: 'a deleted account', text: 'Requested changes', tone: 'warn', submittedAt: '2026-09-28T10:00:00Z' },
    { reviewer: 'bob', text: 'Approved', tone: 'ok', submittedAt: '2026-09-27T10:00:00Z' },
    { reviewer: 'carol', text: 'Commented', tone: 'muted', submittedAt: null },
  ]);
});
