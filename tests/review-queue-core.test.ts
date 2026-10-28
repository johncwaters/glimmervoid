import test from 'node:test';
import assert from 'node:assert/strict';

import { MyPr } from '../shared/contracts/my-prs.ts';
import type { MyPrStage } from '../shared/contracts/my-prs.ts';
import { attentionTilesOf, buildReviewQueue, turnItems } from '../public/github/review-queue-core.ts';

const NO_TEAM_REVIEWS = { ready: [], noReviewNeeded: [], inReview: [], queued: [], attention: [], posted: [], discarded: [] };

function myPr(number: number, stage: MyPrStage, createdAt: string, extra: Partial<MyPr> = {}): MyPr {
  return MyPr.parse({
    key: `acme/app#${number}`, repo: 'acme/app', number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false, state: 'OPEN', createdAt, mergedAt: null, updatedAt: createdAt,
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: `feature-${number}`, isCrossRepository: false, headRefOid: 'b'.repeat(40),
    isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    checks: { state: null, failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], behindBy: null,
    reviewRequests: [], approvals: 0, reviews: [], stage, ...extra,
  });
}

test('your turn puts a failed keep-mergeable repair first and clusters the rest by action, oldest first', () => {
  const prs = [
    myPr(1, 'ready', '2026-10-01T00:00:00Z'),
    myPr(2, 'checks-failing', '2026-10-03T00:00:00Z'),
    myPr(3, 'conflicts', '2026-10-02T00:00:00Z'),
    myPr(4, 'changes-requested', '2026-10-04T00:00:00Z'),
    myPr(5, 'checks-failing', '2026-10-05T00:00:00Z', { keepMergeable: true, keepMergeableAttempt: { outcome: 'failed', reason: 'rebase conflict', at: 1 } }),
  ];
  const groups = buildReviewQueue(NO_TEAM_REVIEWS, prs, new Set(), true);
  assert.deepEqual(turnItems(groups).map((item) => [item.key, item.action]), [
    ['mine:acme/app#5', 'fix'],
    ['mine:acme/app#4', 'reply'],
    ['mine:acme/app#2', 'update'],
    ['mine:acme/app#3', 'update'],
    ['mine:acme/app#1', 'merge'],
  ]);
  assert.deepEqual(attentionTilesOf(groups).map((tile) => tile.kind), ['failed', 'waiting', 'waiting', 'waiting', 'finished']);
});
