import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeMethodLabel, myPrMergeBlocker, myPrMergeRefusal } from '../shared/my-pr-merge.ts';
import { toMyPr } from '../server/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode } from '../shared/contracts/my-prs.ts';

const HEAD = 'a'.repeat(40);

function readyPr(overrides: Partial<MyPr> = {}): MyPr {
  const node: MyPrSearchNode = {
    __typename: 'PullRequest', id: 'PR_node', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7', isDraft: false,
    state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', headRefName: 'feature', isCrossRepository: false, headRefOid: HEAD, isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'MERGE' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  };
  return { ...toMyPr(node, 0), ...overrides };
}

test('maps a GitHub merge method to a readable label', () => {
  assert.equal(mergeMethodLabel('SQUASH'), 'squash and merge');
});

test('a ready open pull request carries the head, queue flag and default method from the search node', () => {
  const pr = readyPr();
  assert.equal(pr.stage, 'ready');
  assert.equal(pr.headRefOid, HEAD);
  assert.equal(pr.isInMergeQueue, false);
  assert.equal(pr.mergeMethod, 'MERGE');
  assert.equal(myPrMergeBlocker(pr), null);
  assert.equal(myPrMergeRefusal(pr, HEAD), null);
});

test('drafts, queued, conflicting, failing, merged and not-ready pull requests are never mergeable', () => {
  const blocked: [Partial<MyPr>, string][] = [
    [{ state: 'MERGED', stage: 'merged' }, 'Already merged'],
    [{ state: 'CLOSED' }, 'Closed'],
    [{ isDraft: true }, 'Drafts cannot be merged'],
    [{ isInMergeQueue: true }, 'Already in the merge queue'],
    [{ mergeable: 'CONFLICTING' }, 'Resolve the merge conflicts first'],
    [{ mergeStateStatus: 'DIRTY' }, 'Resolve the merge conflicts first'],
    [{ checks: { state: 'FAILURE', failing: [], pendingCount: 0 } }, 'Checks are failing'],
    [{ checks: { state: 'ERROR', failing: [], pendingCount: 0 } }, 'Checks are failing'],
    [{ checks: { state: 'SUCCESS', failing: ['lint'], pendingCount: 0 } }, 'Checks are failing'],
    [{ stage: 'needs-approval' }, 'Not ready to merge yet'],
    [{ stage: 'checks-pending' }, 'Not ready to merge yet'],
  ];
  for (const [overrides, reason] of blocked) {
    assert.equal(myPrMergeBlocker(readyPr(overrides)), reason, JSON.stringify(overrides));
    assert.equal(myPrMergeRefusal(readyPr(overrides), HEAD), reason, JSON.stringify(overrides));
  }
});

test('a merge is refused for an untracked pull request or a head other than the one seen', () => {
  assert.match(String(myPrMergeRefusal(undefined, HEAD)), /not one of your tracked/);
  assert.match(String(myPrMergeRefusal(readyPr(), 'b'.repeat(40))), /new commits/);
});
