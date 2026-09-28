import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStage, mergedSinceDate, myPrsShouldStart, sortedMyPrs, toMyPr } from '../server/core/my-prs-core.ts';
import { MyPrSearchNode } from '../shared/contracts/my-prs.ts';
import type { MyPr, MyPrSearchNode as MyPrSearchNodeType } from '../shared/contracts/my-prs.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const SHA = 'a'.repeat(40);
function searchNode(): MyPrSearchNodeType {
  return {
    __typename: 'PullRequest', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7', isDraft: false,
    state: 'OPEN', mergedAt: null, updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', headRefOid: SHA,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }] },
    reviewThreads: { nodes: [{ isResolved: true }] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [{ state: 'APPROVED' }] },
  };
}
function readyPr(): MyPr { return toMyPr(searchNode(), 0); }

test('normalizes failing checks, pending checks, requests, approvals, and unresolved threads', () => {
  const node = searchNode();
  node.commits.nodes[0].commit.statusCheckRollup = { state: 'FAILURE', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'lint', conclusion: 'TIMED_OUT', status: 'COMPLETED' },
    { __typename: 'CheckRun', name: 'build', conclusion: null, status: 'IN_PROGRESS' },
    { __typename: 'StatusContext', context: 'test', state: 'ERROR' },
  ] } };
  node.reviewThreads.nodes.push({ isResolved: false });
  node.reviewRequests.nodes.push({ requestedReviewer: { __typename: 'Team', slug: 'docs', organization: { login: 'Acme' } } });
  const pr = toMyPr(node, 3);
  assert.deepEqual(pr.checks, { state: 'FAILURE', failing: ['lint', 'test'], pendingCount: 1 });
  assert.equal(pr.unresolvedThreads, 1);
  assert.deepEqual(pr.reviewRequests, ['Acme/docs']);
  assert.equal(pr.approvals, 1);
  assert.equal(pr.behindBy, 3);
  assert.equal(pr.stage, 'checks-failing');
});

test('derives every stage in precedence order', () => {
  const base = readyPr();
  const cases: [Partial<MyPr>, MyPr['stage']][] = [
    [{ state: 'MERGED', isDraft: true }, 'merged'],
    [{ isDraft: true, mergeable: 'CONFLICTING' }, 'draft'],
    [{ mergeable: 'CONFLICTING', mergeStateStatus: 'BEHIND' }, 'conflicts'],
    [{ mergeStateStatus: 'DIRTY' }, 'conflicts'],
    [{ mergeStateStatus: 'BEHIND', checks: { state: 'FAILURE', failing: [], pendingCount: 0 } }, 'behind'],
    [{ checks: { state: 'ERROR', failing: [], pendingCount: 0 }, reviewDecision: 'CHANGES_REQUESTED' }, 'checks-failing'],
    [{ reviewDecision: 'CHANGES_REQUESTED', unresolvedThreads: 1 }, 'changes-requested'],
    [{ unresolvedThreads: 1, checks: { state: 'PENDING', failing: [], pendingCount: 1 } }, 'unresolved-threads'],
    [{ checks: { state: 'EXPECTED', failing: [], pendingCount: 1 }, reviewDecision: 'REVIEW_REQUIRED' }, 'checks-pending'],
    [{ reviewDecision: 'REVIEW_REQUIRED' }, 'needs-approval'],
    [{ mergeStateStatus: 'BLOCKED' }, 'needs-approval'],
    [{}, 'ready'],
    [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'unknown'],
  ];
  for (const [changes, expected] of cases) assert.equal(deriveStage({ ...base, ...changes }), expected);
});

test('retains merged PRs for 24 hours and sorts work before waiting, ready, drafts, merged', () => {
  assert.equal(mergedSinceDate(NOW), '2026-09-27');
  const base = readyPr();
  const make = (stage: MyPr['stage'], number: number): MyPr => ({ ...base, key: `Acme/app#${number}`, number, stage });
  const merged = { ...make('merged', 4), state: 'MERGED' as const, mergedAt: new Date(NOW - 86400000).toISOString() };
  const olderMerged = { ...merged, number: 5, mergedAt: new Date(NOW - 86400001).toISOString() };
  const closed = { ...make('unknown', 6), state: 'CLOSED' as const };
  const prs = sortedMyPrs([merged, olderMerged, closed, make('draft', 3), make('ready', 2), make('needs-approval', 1), make('conflicts', 9)], NOW);
  assert.deepEqual(prs.map((pr) => pr.number), [9, 1, 2, 3, 4]);
});

test('a bot review request keeps the pull request and lists no reviewer for it', () => {
  const node = { ...searchNode(), reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Bot' } }, { requestedReviewer: { __typename: 'User', login: 'ana' } }] } };
  const parsed = MyPrSearchNode.safeParse(node);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success ? toMyPr(parsed.data, 0).reviewRequests : null, ['ana']);
});

test('myPrsShouldStart refuses when team review is disabled', () => {
  assert.deepEqual(myPrsShouldStart({ enabled: false, org: 'Acme' }), { start: false, reason: 'Team review is disabled' });
});

test('myPrsShouldStart refuses without an organization', () => {
  assert.deepEqual(myPrsShouldStart({ enabled: true, org: '' }), { start: false, reason: 'Team review needs an organization' });
});

test('myPrsShouldStart starts with an organization and no team', () => {
  assert.deepEqual(myPrsShouldStart({ enabled: true, org: 'Acme' }), { start: true });
});
