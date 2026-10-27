import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewQueue, decideTurnAttention, nextTurnKey, turnActivityEntries } from '../public/github/review-queue-core.ts';
import type { QueueGroup } from '../public/github/review-queue-core.ts';
import { groupDrafts } from '../public/github/github-store-core.ts';
import { toMyPr } from '../server/github/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode } from '../shared/contracts/my-prs.ts';
import { InFlightReview, ReviewDraft, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { ReviewDraft as ReviewDraftType } from '../shared/contracts/team-review.ts';

const HEAD = 'a'.repeat(40);

const myPrNode: MyPrSearchNode = {
  __typename: 'PullRequest', id: 'PR_node', number: 1, title: 'Fix', url: 'https://github.com/Acme/mine/pull/1', isDraft: false,
  state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', isCrossRepository: false, headRefOid: HEAD, isInMergeQueue: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/mine', viewerDefaultMergeMethod: 'SQUASH' },
  commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
};

function myPr(number: number, stage: MyPr['stage']): MyPr {
  return { ...toMyPr(myPrNode, 0), number, stage, key: `Acme/mine#${number}`, headRefName: `feature-${number}` };
}

function draft(number: number, overrides: Partial<ReviewDraftType> = {}): ReviewDraftType {
  return ReviewDraft.parse({
    key: `Acme/app#${number}`, repo: 'Acme/app', number, title: `PR ${number}`, url: `https://github.com/Acme/app/pull/${number}`,
    author: 'teammate', tier: 'stamp', reasons: [], reviewedHead: HEAD, verdict: 'APPROVE', summary: 'Fine', body: 'LGTM', comments: [], status: 'ready', ...overrides,
  });
}

function teamSections(drafts: ReviewDraftType[], extra: Partial<TeamReviewStatus> = {}) {
  return groupDrafts(TeamReviewStatus.parse({ type: 'team-review-status', ts: 1000, configured: true, reason: null, drafts, inFlight: [], ...extra }));
}

function keysByGroup(groups: readonly QueueGroup[]): Record<string, string[]> {
  return Object.fromEntries(groups.map((group) => [group.id, group.items.map((item) => item.key)]));
}

test('team reviews and own pull requests merge into one queue grouped by who acts next', () => {
  const inReview = InFlightReview.parse({
    key: 'Acme/app#9', repo: 'Acme/app', number: 9, title: 'PR 9', url: 'https://github.com/Acme/app/pull/9', author: 'teammate',
    tier: 'stamp', reasons: [], head: HEAD, phase: 'reviewing', startedAt: 1000, deadlineAt: null, toolCalls: 0, recentSteps: [],
  });
  const sections = teamSections([
    draft(1),
    draft(2, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }),
    draft(3, { status: 'error', error: 'Review timed out' }),
    draft(4, { status: 'posted' }),
    draft(5, { status: 'discarded' }),
  ], { inFlight: [inReview] });
  const prs = [myPr(11, 'ready'), myPr(12, 'checks-failing'), myPr(13, 'checks-failing'), myPr(14, 'needs-approval'), myPr(15, 'draft')];
  const groups = buildReviewQueue(sections, prs, new Set(['acme/mine#13']));
  assert.deepEqual(keysByGroup(groups), {
    turn: ['team:Acme/app#2', 'mine:Acme/mine#12', 'team:Acme/app#1', 'mine:Acme/mine#11', 'team:Acme/app#3'],
    working: ['team:Acme/app#9', 'mine:Acme/mine#13'],
    waiting: ['team:Acme/app#4', 'mine:Acme/mine#14'],
    aside: ['team:Acme/app#5', 'mine:Acme/mine#15'],
  });
});

test('acting on a review advances to the next Your turn item in the order captured before the action', () => {
  const groups = buildReviewQueue(teamSections([draft(1), draft(3)]), [myPr(11, 'conflicts')], new Set());
  const capturedOrder = ['team:Acme/app#2', 'mine:Acme/mine#11', 'team:Acme/app#1', 'team:Acme/app#3'];
  assert.equal(nextTurnKey({ capturedOrder, actedKey: 'team:Acme/app#2', groups }), 'mine:Acme/mine#11');
  assert.equal(nextTurnKey({ capturedOrder, actedKey: 'team:Acme/app#3', groups }), 'mine:Acme/mine#11');
  assert.equal(nextTurnKey({ capturedOrder: [], actedKey: 'team:Acme/app#1', groups: buildReviewQueue(teamSections([draft(1)]), [], new Set()) }), null);
});

test('the Reviews tab dot lights for a new Your turn item from either lane and stays dark when one leaves', () => {
  const before = turnActivityEntries(buildReviewQueue(teamSections([draft(1)]), [myPr(11, 'needs-approval')], new Set()));
  const settled = decideTurnAttention({ turnEntries: before, acknowledged: before.join('|'), unseen: '', isLooking: false });
  assert.equal(settled.isShown, false);
  const ownPrNeedsYou = turnActivityEntries(buildReviewQueue(teamSections([draft(1)]), [myPr(11, 'checks-failing')], new Set()));
  assert.equal(decideTurnAttention({ turnEntries: ownPrNeedsYou, acknowledged: settled.acknowledged, unseen: settled.unseen, isLooking: false }).isShown, true);
  const reviewPosted = turnActivityEntries(buildReviewQueue(teamSections([draft(1, { status: 'posted' })]), [myPr(11, 'needs-approval')], new Set()));
  assert.equal(decideTurnAttention({ turnEntries: reviewPosted, acknowledged: settled.acknowledged, unseen: settled.unseen, isLooking: false }).isShown, false);
});
