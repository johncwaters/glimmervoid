import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStateText, groupMyPrs, groupStackedMyPrs, chooseSelectedKey, mergeConfirmMessage, mergeControlState, parseMyPrMergeResult, parseMyPrsStatus, queueNotices, readinessRows, reviewRows, sectionStackedMyPrs, stageLabel, stageTone, threadRows } from '../public/my-prs-view-core.ts';
import { toMyPr } from '../server/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode, MyPrThread } from '../shared/contracts/my-prs.ts';

const node: MyPrSearchNode = {
  __typename: 'PullRequest', id: 'PR_node', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1', isDraft: false,
  state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', headRefName: 'feature', isCrossRepository: false, headRefOid: 'a'.repeat(40), isInMergeQueue: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
  commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
};
const base = toMyPr(node, 0);
const pr = (stage: MyPr['stage'], number: number): MyPr => ({ ...base, stage, number, key: `Acme/app#${number}` });
const teamRequest = { name: 'Acme/docs', isTeam: true, avatarUrl: 'https://github.com/Acme.png' };
const appRequest = { name: 'Acme/app', isTeam: true, avatarUrl: null };
const userRequest = { name: 'bob', isTeam: false, avatarUrl: null };

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
  assert.equal(emptyStateText({ ...status, error: 'connection refused' }), 'Pull requests will show here once GitHub answers.');
  assert.match(emptyStateText({ ...status, error: 'connection refused', prs: [base] }), /No open/);
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
  assert.deepEqual(row('Review', { reviewDecision: null, reviewRequests: [teamRequest, appRequest] }), { label: 'Review', tone: 'wait', text: 'Requested: Acme/docs, Acme/app' });
  assert.deepEqual(row('Review', { reviewDecision: null, reviewRequests: [] }), { label: 'Review', tone: 'muted', text: 'No review requested' });
  assert.deepEqual(row('Review', { reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], approvals: 0 }), { label: 'Review', tone: 'wait', text: 'Approval required' });
  assert.deepEqual(row('Review', { reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], approvals: 1 }), { label: 'Review', tone: 'wait', text: 'Approval required, 1 approval' });
  assert.deepEqual(row('Review', { reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [userRequest], approvals: 2 }), { label: 'Review', tone: 'wait', text: 'Requested: bob, 2 approvals' });
  assert.deepEqual(row('Review', { reviewDecision: null, mergeStateStatus: 'BLOCKED', reviewRequests: [], approvals: 0 }), { label: 'Review', tone: 'wait', text: 'Approval required' });
  assert.deepEqual(row('Review', { reviewDecision: null, mergeStateStatus: 'BLOCKED', reviewRequests: [userRequest], approvals: 0 }), { label: 'Review', tone: 'wait', text: 'Requested: bob' });
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
  assert.deepEqual(queueNotices({ ...status, error: 'offline', truncatedNote }), [{ text: 'Could not reach GitHub: offline.', tone: 'error' }, { text: truncatedNote, tone: 'info' }]);
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

test('an auto-rebase outcome adds its own readiness row', () => {
  const rebased = { ...toMyPr(node, 0), autoRebase: { outcome: 'rebased' as const, at: 1, message: 'Rebased onto main' } };
  assert.deepEqual(readinessRows(rebased).at(-1), { label: 'Auto-rebase', tone: 'ok', text: 'Rebased onto main' });
  const failed = { ...toMyPr(node, 0), autoRebase: { outcome: 'failed' as const, at: 1, message: 'Protected branch' } };
  assert.deepEqual(readinessRows(failed).at(-1), { label: 'Auto-rebase', tone: 'danger', text: 'Protected branch' });
  assert.equal(readinessRows(toMyPr(node, 0)).some((row) => row.label === 'Auto-rebase'), false);
});

test('the merge control is hidden once merged and disabled with the blocking reason beside it', () => {
  assert.equal(mergeControlState({ ...pr('merged', 1), state: 'MERGED' }, undefined).isVisible, false);
  const ready = pr('ready', 1);
  assert.deepEqual(mergeControlState(ready, undefined), { isVisible: true, isDisabled: false, statusText: 'Merges into main with squash and merge', tone: null });
  assert.deepEqual(mergeControlState({ ...ready, isDraft: true, stage: 'draft' }, undefined), { isVisible: true, isDisabled: true, statusText: 'Drafts cannot be merged', tone: null });
  assert.deepEqual(mergeControlState(pr('checks-pending', 1), undefined), { isVisible: true, isDisabled: true, statusText: 'Not ready to merge yet', tone: null });
});

test('the merge control tracks an attempt only for the head it was made at', () => {
  const ready = pr('ready', 1);
  const head = ready.headRefOid;
  assert.deepEqual(mergeControlState(ready, { head, phase: 'pending', text: '' }), { isVisible: true, isDisabled: true, statusText: 'Merging on GitHub', tone: 'busy' });
  assert.deepEqual(mergeControlState(ready, { head, phase: 'merged', text: '' }), { isVisible: true, isDisabled: true, statusText: 'Merged on GitHub. Refreshing the list.', tone: 'ok' });
  assert.deepEqual(mergeControlState(ready, { head, phase: 'failed', text: 'Head branch was modified' }), { isVisible: true, isDisabled: false, statusText: 'Head branch was modified', tone: 'error' });
  assert.equal(mergeControlState(ready, { head: 'b'.repeat(40), phase: 'merged', text: '' }).isDisabled, false);
});

test('a queued, auto-merge or unconfirmed attempt never claims a merge, even once the pull request shows in the queue', () => {
  const ready = pr('ready', 1);
  const head = ready.headRefOid;
  const queuedPr = { ...ready, isInMergeQueue: true };
  assert.deepEqual(mergeControlState(queuedPr, { head, phase: 'queued', text: '' }), { isVisible: true, isDisabled: true, statusText: 'Added to the merge queue. Refreshing the list.', tone: 'ok' });
  assert.deepEqual(mergeControlState(ready, { head, phase: 'auto-merge', text: '' }), { isVisible: true, isDisabled: true, statusText: 'Auto-merge enabled. GitHub merges it once its requirements pass.', tone: 'ok' });
  assert.deepEqual(mergeControlState(ready, { head, phase: 'unconfirmed', text: '' }), { isVisible: true, isDisabled: true, statusText: 'GitHub accepted the request but did not confirm a merge. Check GitHub.', tone: null });
});

test('the merge confirmation names the pull request, base branch and method', () => {
  assert.equal(mergeConfirmMessage(pr('ready', 1)), 'Merge Acme/app#1 "Fix" into main with squash and merge, your default for this repository. Glimmervoid does not delete the branch.');
});

test('merge results parse only with a request id and a typed outcome', () => {
  assert.deepEqual(parseMyPrMergeResult({ type: 'my-pr-merge-result', requestId: 'r1', key: 'Acme/app#1', ok: false, error: 'nope' }), { key: 'Acme/app#1', ok: false, error: 'nope', requestId: 'r1' });
  assert.equal(parseMyPrMergeResult({ type: 'my-pr-merge-result', key: 'Acme/app#1', ok: true }), null);
  assert.equal(parseMyPrMergeResult({ type: 'my-pr-merge-result', requestId: 'r1', key: 'Acme/app#1', ok: 'yes' }), null);
  assert.deepEqual(parseMyPrMergeResult({ type: 'my-pr-merge-result', requestId: 'r1', key: 'Acme/app#1', ok: true, kind: 'queued' }), { key: 'Acme/app#1', ok: true, kind: 'queued', requestId: 'r1' });
  assert.equal(parseMyPrMergeResult({ type: 'my-pr-merge-result', requestId: 'r1', key: 'Acme/app#1', ok: true, kind: 'pending' }), null);
});

test('stacks group children beneath parents across readiness states and retain sibling order', () => {
  const root = { ...pr('needs-approval', 1), headRefName: 'foundation', baseRefName: 'main' };
  const child = { ...pr('conflicts', 2), headRefName: 'followup', baseRefName: 'foundation' };
  const grandchild = { ...pr('ready', 3), headRefName: 'finish', baseRefName: 'followup' };
  const sibling = { ...pr('checks-failing', 4), headRefName: 'other-followup', baseRefName: 'foundation' };
  const independent = { ...pr('ready', 5), headRefName: 'independent', baseRefName: 'main' };
  const stacks = groupStackedMyPrs([child, grandchild, root, sibling, independent]);
  assert.deepEqual(stacks.map((stack) => [stack.root.number, stack.rows.map(({ pr, parentKey, depth }) => [pr.number, parentKey, depth])]), [
    [1, [[1, null, 0], [2, root.key, 1], [3, child.key, 2], [4, root.key, 1]]],
    [5, [[5, null, 0]]],
  ]);
});

test('stack lookup isolates repositories and matches their case without changing branch case', () => {
  const parent = { ...pr('ready', 1), headRefName: 'feature', baseRefName: 'main' };
  const otherRepo = { ...pr('ready', 2), repo: 'Acme/other', key: 'Acme/other#2', headRefName: 'followup', baseRefName: 'feature' };
  const differentCase = { ...pr('ready', 3), repo: 'acme/APP', key: 'acme/APP#3', headRefName: 'followup', baseRefName: 'feature' };
  const otherBranch = { ...pr('ready', 4), headRefName: 'other', baseRefName: 'FEATURE' };
  const stacks = groupStackedMyPrs([parent, otherRepo, differentCase, otherBranch]);
  assert.deepEqual(stacks.map((stack) => stack.rows.map(({ pr }) => pr.key)), [[parent.key, differentCase.key], [otherRepo.key], [otherBranch.key]]);
});

test('a fork PR from a branch named like the shared base never becomes a stack parent', () => {
  const forkFromMain = { ...pr('ready', 1), headRefName: 'main', baseRefName: 'main', isCrossRepository: true };
  const firstAgainstMain = { ...pr('needs-approval', 2), headRefName: 'fix-a', baseRefName: 'main' };
  const secondAgainstMain = { ...pr('conflicts', 3), headRefName: 'fix-b', baseRefName: 'main' };
  const stacks = groupStackedMyPrs([forkFromMain, firstAgainstMain, secondAgainstMain]);
  assert.deepEqual(stacks.map((stack) => stack.rows.map(({ pr }) => pr.number)), [[1], [2], [3]]);
});

test('an open PR based on a merged parent branch stays its own root in its own section', () => {
  const mergedParent = { ...pr('merged', 1), state: 'MERGED' as const, headRefName: 'foundation', baseRefName: 'main' };
  const openChild = { ...pr('conflicts', 2), headRefName: 'followup', baseRefName: 'foundation' };
  const stacks = groupStackedMyPrs([mergedParent, openChild]);
  assert.deepEqual(stacks.map((stack) => stack.rows.map(({ pr }) => pr.number)), [[1], [2]]);
  const sectionsByRoot = groupMyPrs(stacks.map((stack) => stack.root));
  assert.deepEqual(sectionsByRoot.find((section) => section.title === 'Needs you')?.prs.map((item) => item.number), [2]);
  assert.deepEqual(sectionsByRoot.find((section) => section.title === 'Merged today')?.prs.map((item) => item.number), [1]);
});

test('a merged PR based on an open parent branch stays its own root in Merged today', () => {
  const openParent = { ...pr('conflicts', 1), headRefName: 'foundation', baseRefName: 'main' };
  const mergedChild = { ...pr('merged', 2), state: 'MERGED' as const, headRefName: 'followup', baseRefName: 'foundation' };
  const stacks = groupStackedMyPrs([openParent, mergedChild]);
  assert.deepEqual(stacks.map((stack) => stack.rows.map(({ pr, parentKey, depth }) => [pr.number, parentKey, depth])), [[[1, null, 0]], [[2, null, 0]]]);
  const sectionsByRoot = groupMyPrs(stacks.map((stack) => stack.root));
  assert.deepEqual(sectionsByRoot.find((section) => section.title === 'Needs you')?.prs.map((item) => item.number), [1]);
  assert.deepEqual(sectionsByRoot.find((section) => section.title === 'Merged today')?.prs.map((item) => item.number), [2]);
});

test('a conflicts child stacked on a needs-approval parent puts the whole stack under Needs you', () => {
  const parent = { ...pr('needs-approval', 1), headRefName: 'foundation', baseRefName: 'main' };
  const conflictsChild = { ...pr('conflicts', 2), headRefName: 'followup', baseRefName: 'foundation' };
  const waitingAlone = { ...pr('checks-pending', 3), headRefName: 'unrelated', baseRefName: 'main' };
  const sections = sectionStackedMyPrs([waitingAlone, conflictsChild, parent]);
  assert.deepEqual(sections.map((section) => [section.title, section.rows.map(({ pr }) => pr.number)]), [
    ['Needs you', [1, 2]], ['Waiting', [3]], ['Ready to merge', []], ['Drafts', []], ['Merged today', []],
  ]);
});

test('the default selection is the first visible row of the stacked sections', () => {
  const readyParent = { ...pr('ready', 1), headRefName: 'foundation', baseRefName: 'main' };
  const failingChild = { ...pr('checks-failing', 2), headRefName: 'followup', baseRefName: 'foundation' };
  const sections = sectionStackedMyPrs([failingChild, readyParent]);
  const firstVisibleRow = sections.find((section) => section.rows.length > 0)?.rows[0];
  assert.equal(firstVisibleRow?.pr.number, 1);
  assert.equal(chooseSelectedKey(sections, null), readyParent.key);
  assert.equal(chooseSelectedKey(sections, 'gone'), readyParent.key);
  assert.equal(chooseSelectedKey(sections, failingChild.key), failingChild.key);
});

test('missing parents, self references and cycles retain each PR once', () => {
  const missingParent = { ...pr('ready', 1), headRefName: 'orphan', baseRefName: 'missing' };
  const selfReference = { ...pr('ready', 2), headRefName: 'self', baseRefName: 'self' };
  const cycleStart = { ...pr('ready', 3), headRefName: 'cycle-start', baseRefName: 'cycle-end' };
  const cycleEnd = { ...pr('ready', 4), headRefName: 'cycle-end', baseRefName: 'cycle-start' };
  const stacks = groupStackedMyPrs([missingParent, selfReference, cycleStart, cycleEnd]);
  assert.deepEqual(stacks.map((stack) => stack.rows.map(({ pr }) => pr.number)), [[1], [2], [3, 4]]);
  assert.deepEqual(groupStackedMyPrs([]), []);
});

test('a long stack is walked without recursive rendering or losing rows', () => {
  const prs = Array.from({ length: 10000 }, (_unused, index) => ({ ...pr('ready', index + 1), headRefName: `branch-${index}`, baseRefName: index === 0 ? 'main' : `branch-${index - 1}` }));
  const stacks = groupStackedMyPrs(prs);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0]?.rows.length, 10000);
  assert.equal(stacks[0]?.rows.at(-1)?.depth, 9999);
});
