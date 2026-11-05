import test from 'node:test';
import assert from 'node:assert/strict';

import { MyPr } from '../shared/contracts/my-prs.ts';
import type { MyPrStage } from '../shared/contracts/my-prs.ts';
import { TeamReviewStatus, ReviewDraft } from '../shared/contracts/team-review.ts';
import { groupDrafts, stackBadgeOf } from '../public/github/github-store-core.ts';
import { attentionTilesOf, buildReviewQueue, turnItems } from '../public/github/review-queue-core.ts';

const NO_TEAM_REVIEWS = { ready: [], noReviewNeeded: [], inReview: [], queued: [], attention: [], posted: [], discarded: [] };

function myPr(number: number, stage: MyPrStage, createdAt: string, extra: Partial<MyPr> = {}): MyPr {
  return MyPr.parse({
    key: `acme/app#${number}`, repo: 'acme/app', number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false, state: 'OPEN', createdAt, mergedAt: null, updatedAt: createdAt,
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: `feature-${number}`, isCrossRepository: false, headRefOid: 'b'.repeat(40),
    isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    checks: { state: null, failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], reviewItems: [], behindBy: null,
    reviewRequests: [], approvals: 0, reviews: [], stage, ...extra,
  });
}

test('your turn puts a failed repair first, then a direct ask, then whatever has waited longest in its stage across your and team pull requests', () => {
  const prs = [
    myPr(1, 'ready', '2026-10-01T00:00:00Z', { stageSinceMs: Date.parse('2026-10-09T00:00:00Z') }),
    myPr(2, 'checks-failing', '2026-10-03T00:00:00Z', { stageSinceMs: Date.parse('2026-10-06T00:00:00Z') }),
    myPr(3, 'conflicts', '2026-10-02T00:00:00Z'),
    myPr(4, 'changes-requested', '2026-10-04T00:00:00Z', { stageSinceMs: Date.parse('2026-10-07T00:00:00Z') }),
    myPr(5, 'checks-failing', '2026-10-05T00:00:00Z', { stageSinceMs: Date.parse('2026-10-10T00:00:00Z'), keepMergeable: true, keepMergeableAttempt: { outcome: 'failed', reason: 'rebase conflict', at: 1 } }),
  ];
  const sections = groupDrafts({ ...TeamReviewStatus.parse({ type: 'team-review-status', ts: 1, configured: true, reason: null, drafts: [], inFlight: [], queued: [] }), drafts: [
    readyDraft(6, '2026-09-01T00:00:00Z', { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED', reviewedAt: Date.parse('2026-10-11T00:00:00Z') }),
    readyDraft(7, '2026-09-01T00:00:00Z', { reviewedAt: Date.parse('2026-10-05T00:00:00Z') }),
  ] });
  const groups = buildReviewQueue(sections, prs, new Set(), true);
  assert.deepEqual(turnItems(groups).map((item) => [item.key, item.action]), [
    ['mine:acme/app#5', 'fix'],
    ['team:acme/app#6', 'review'],
    ['mine:acme/app#3', 'update'],
    ['team:acme/app#7', 'review'],
    ['mine:acme/app#2', 'update'],
    ['mine:acme/app#4', 'reply'],
    ['mine:acme/app#1', 'merge'],
  ]);
  assert.deepEqual(attentionTilesOf(groups).map((tile) => tile.kind), ['failed', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'finished']);
});

test('stack badge gives siblings one level and counts height by the tallest branch', () => {
  const prs = [
    myPr(1, 'ready', '2026-10-01T00:00:00Z'),
    myPr(2, 'ready', '2026-10-02T00:00:00Z', { baseRefName: 'feature-1' }),
    myPr(3, 'ready', '2026-10-03T00:00:00Z', { baseRefName: 'feature-1' }),
    myPr(4, 'ready', '2026-10-04T00:00:00Z', { baseRefName: 'feature-2' }),
    myPr(5, 'ready', '2026-10-05T00:00:00Z'),
  ];
  const badges = turnItems(buildReviewQueue(NO_TEAM_REVIEWS, prs, new Set(), true)).map((item) => [item.key, item.source === 'mine' ? stackBadgeOf(item.stackRow) : null]);
  assert.deepEqual(badges, [
    ['mine:acme/app#1', 'Stack 1/3'],
    ['mine:acme/app#2', 'Stack 2/3'],
    ['mine:acme/app#3', 'Stack 2/3'],
    ['mine:acme/app#4', 'Stack 3/3'],
    ['mine:acme/app#5', null],
  ]);
});

function readyDraft(number: number, prCreatedAt: string, extra: Partial<ReviewDraft> = {}): ReviewDraft {
  return ReviewDraft.parse({
    key: `acme/app#${number}`, repo: 'acme/app', number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`,
    author: 'teammate', tier: 'full', reasons: [], reviewedHead: 'c'.repeat(40), verdict: 'APPROVE', summary: 'Fine', body: 'Fine',
    comments: [], status: 'ready', reviewedAt: 1, prCreatedAt, requestSource: 'team', checksState: 'SUCCESS', ...extra,
  });
}

test('a team review still waiting on checks or a draft, fresh or stale, ranks below a review ready to act on, however old', () => {
  const sections = groupDrafts({ ...TeamReviewStatus.parse({ type: 'team-review-status', ts: 1, configured: true, reason: null, drafts: [], inFlight: [], queued: [] }), drafts: [
    readyDraft(1, '2026-10-01T00:00:00Z', { checksState: 'PENDING', reviewedAt: Date.parse('2026-10-01T00:00:00Z') }),
    readyDraft(2, '2026-10-02T00:00:00Z', { isDraft: true, reviewedAt: Date.parse('2026-10-02T00:00:00Z') }),
    readyDraft(3, '2026-10-03T00:00:00Z', { reviewedAt: Date.parse('2026-10-03T00:00:00Z') }),
    readyDraft(4, '2026-09-30T00:00:00Z', { status: 'stale', checksState: 'PENDING', reviewedAt: Date.parse('2026-09-30T00:00:00Z') }),
  ] });
  const turnKeys = turnItems(buildReviewQueue(sections, [], new Set(), true)).map((item) => item.key);
  assert.deepEqual(turnKeys, ['team:acme/app#3', 'team:acme/app#4', 'team:acme/app#1', 'team:acme/app#2']);
});
