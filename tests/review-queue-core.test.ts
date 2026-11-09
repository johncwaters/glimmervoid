import test from 'node:test';
import assert from 'node:assert/strict';

import { MyPr } from '../shared/contracts/my-prs.ts';
import type { MyPrStage } from '../shared/contracts/my-prs.ts';
import { TeamReviewStatus, ReviewDraft } from '../shared/contracts/team-review.ts';
import { groupDrafts, stackBadgeOf } from '../public/github/github-store-core.ts';
import { settledLineText } from '../public/github/team-review-view-core.ts';
import { ageToneOf, attentionTilesOf, buildReviewQueue, chooseQueueSelection, queueItemWaitStartMs, splitReviewingNow, togglePulledKey, turnItems, turnPositionText } from '../public/github/review-queue-core.ts';

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

test('Reviewing now holds the pulled Your turn reviews in turn order, up to the limit, and drops a pulled key that left Your turn', () => {
  const sections = groupDrafts({ ...TeamReviewStatus.parse({ type: 'team-review-status', ts: 1, configured: true, reason: null, drafts: [], inFlight: [], queued: [] }), drafts: [
    readyDraft(1, '2026-10-01T00:00:00Z', { reviewedAt: Date.parse('2026-10-01T00:00:00Z') }),
    readyDraft(2, '2026-10-02T00:00:00Z', { reviewedAt: Date.parse('2026-10-02T00:00:00Z') }),
    readyDraft(3, '2026-10-03T00:00:00Z', { status: 'posted' }),
  ] });
  const groups = buildReviewQueue(sections, [], new Set(), true);
  const turnKeys = turnItems(groups).map((item) => item.key);
  const pulledKeys = togglePulledKey({ pulledKeys: ['team:acme/app#3'], key: 'team:acme/app#2', turnKeys, limit: 2 });
  assert.deepEqual(togglePulledKey({ pulledKeys, key: 'team:acme/app#1', turnKeys, limit: 2 }), pulledKeys);
  const split = splitReviewingNow(groups, pulledKeys);
  assert.deepEqual(split.pulledKeys, ['team:acme/app#2']);
  assert.deepEqual(split.groups.slice(0, 2).map((group) => [group.id, group.title, group.items.map((item) => item.key)]), [
    ['now', 'Reviewing now', ['team:acme/app#2']],
    ['turn', 'Ready', ['team:acme/app#1']],
  ]);
  assert.equal(turnPositionText(split.groups, 'team:acme/app#2'), '1 of 1 in Reviewing now');
});

test('queued reviews sit in Queued, merged pull requests in Merged, settled reviews leave the queue but stay open when held and name who settled them, drafts and discarded reviews in Parked, and posted reviews keep waiting on others', () => {
  const prs = [
    myPr(1, 'merged', '2026-10-01T00:00:00Z', { state: 'MERGED', mergedAt: '2026-10-02T00:00:00Z' }),
    myPr(2, 'draft', '2026-10-01T00:00:00Z', { isDraft: true }),
  ];
  const sections = groupDrafts(TeamReviewStatus.parse({
    type: 'team-review-status', ts: 1, configured: true, reason: null, inFlight: [],
    queued: [{ key: 'acme/app#3', repo: 'acme/app', number: 3, title: 'PR 3', url: 'https://github.com/acme/app/pull/3', author: 'teammate' }],
    drafts: [
      readyDraft(4, '2026-10-01T00:00:00Z', { githubReviews: [{ login: 'lead', state: 'APPROVED', commit: 'c'.repeat(40), isViewer: false }] }),
      readyDraft(5, '2026-10-01T00:00:00Z', { status: 'discarded' }),
      readyDraft(6, '2026-10-01T00:00:00Z', { status: 'posted' }),
    ],
  }));
  const groups = buildReviewQueue(sections, prs, new Set(), true);
  assert.deepEqual(groups.map((group) => [group.id, group.items.map((item) => item.key)]), [
    ['turn', []],
    ['working', []],
    ['queued', ['team:acme/app#3']],
    ['waiting', ['team:acme/app#6']],
    ['merged', ['mine:acme/app#1']],
    ['parked', ['team:acme/app#5', 'mine:acme/app#2']],
  ]);
  const settledKeys = new Set(sections.noReviewNeeded.map((draft) => `team:${draft.key}`));
  assert.equal(chooseQueueSelection(groups, 'team:acme/app#4', settledKeys), 'team:acme/app#4');
  assert.equal(chooseQueueSelection(groups, 'team:acme/app#4'), 'team:acme/app#3');
  assert.equal(settledLineText(sections.noReviewNeeded[0]), `Approved by lead at ${'c'.repeat(7)}. Your review is optional.`);
  const keptApproval = readyDraft(7, '2026-10-01T00:00:00Z', { reviewDecision: 'APPROVED', githubReviews: [{ login: 'me', state: 'APPROVED', commit: 'a'.repeat(40), isViewer: true }] });
  assert.equal(settledLineText(keptApproval), `You approved (older commit) at ${'a'.repeat(7)}. Your review is optional.`);
});

test('a posted review waits on others from when it was posted, not from when the agent reviewed it', () => {
  const nowMs = Date.parse('2026-10-10T00:00:00Z');
  const postedAtMs = nowMs - 50 * 60 * 60 * 1000;
  const sections = groupDrafts(TeamReviewStatus.parse({
    type: 'team-review-status', ts: 1, configured: true, reason: null, inFlight: [], queued: [],
    drafts: [readyDraft(1, '2026-09-01T00:00:00Z', { status: 'posted', reviewedAt: nowMs - 10 * 24 * 60 * 60 * 1000, postedAt: postedAtMs })],
  }));
  const waiting = buildReviewQueue(sections, [], new Set(), true).find((group) => group.id === 'waiting');
  const postedItem = waiting?.items[0];
  assert.ok(postedItem);
  assert.equal(queueItemWaitStartMs(postedItem), postedAtMs);
  assert.equal(ageToneOf('waiting', queueItemWaitStartMs(postedItem), nowMs), 'aging');
});
