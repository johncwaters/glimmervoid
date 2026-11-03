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
    ['mine:acme/app#1', { text: '1/3', title: 'Base of a stack of 4' }],
    ['mine:acme/app#2', { text: '2/3', title: 'Stacked on acme/app#1' }],
    ['mine:acme/app#3', { text: '2/3', title: 'Stacked on acme/app#1' }],
    ['mine:acme/app#4', { text: '3/3', title: 'Stacked on acme/app#2' }],
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

test('a team review still waiting on checks or a draft ranks below a same-state review ready to act on, however old', () => {
  const sections = groupDrafts({ ...TeamReviewStatus.parse({ type: 'team-review-status', ts: 1, configured: true, reason: null, drafts: [], inFlight: [], queued: [] }), drafts: [
    readyDraft(1, '2026-10-01T00:00:00Z', { checksState: 'PENDING' }),
    readyDraft(2, '2026-10-02T00:00:00Z', { isDraft: true }),
    readyDraft(3, '2026-10-03T00:00:00Z'),
  ] });
  const turnKeys = turnItems(buildReviewQueue(sections, [], new Set(), true)).map((item) => item.key);
  assert.deepEqual(turnKeys, ['team:acme/app#3', 'team:acme/app#1', 'team:acme/app#2']);
});
