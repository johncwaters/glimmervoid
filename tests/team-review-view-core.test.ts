import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attentionDetail, buildActionRequest, commentLocation, emptyStateText, groupDrafts, hasAnyRow, pullRequestLabel,
  readyAttentionSignature, readyRowSignature, tierLabel, verdictLabel, verdictTone, withoutComment,
} from '../public/team-review-view-core.ts';
import { ReviewDraft, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { ReviewDraft as ReviewDraftType, TeamReviewStatus as TeamReviewStatusType } from '../shared/contracts/team-review.ts';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

function draft(number: number, overrides: Partial<ReviewDraftType> = {}): ReviewDraftType {
  return ReviewDraft.parse({
    key: `Acme/app#${number}`, repo: 'Acme/app', number, title: `PR ${number}`, url: `https://github.com/Acme/app/pull/${number}`,
    author: 'teammate', tier: 'stamp', reasons: ['12 counted lines in 1 files'], reviewedHead: HEAD,
    verdict: 'STAMP', summary: 'Fine', body: 'LGTM', comments: [], status: 'ready', ...overrides,
  });
}

function status(drafts: ReviewDraftType[], inFlight: string[] = [], configured = true): TeamReviewStatusType {
  return TeamReviewStatus.parse({ type: 'team-review-status', ts: 1000, configured, reason: null, drafts, inFlight });
}

test('drafts group into ready, in review, needs attention and recently posted, with discarded hidden', () => {
  const sections = groupDrafts(status([
    draft(1),
    draft(2, { status: 'stale' }),
    draft(3, { status: 'error', error: 'review timed out after 900s' }),
    draft(4, { status: 'posted' }),
    draft(5, { status: 'discarded' }),
  ], ['Acme/app#9']));
  assert.deepEqual(sections.ready.map((row) => row.number), [1]);
  assert.deepEqual(sections.inReview, [{ key: 'Acme/app#9', draft: null }]);
  assert.deepEqual(sections.attention.map((row) => row.number), [2, 3]);
  assert.deepEqual(sections.posted.map((row) => row.number), [4]);
  assert.equal(hasAnyRow(sections), true);
});

test('a PR under review shows only under In review, even when an older draft exists', () => {
  const sections = groupDrafts(status([draft(1, { status: 'stale' })], ['Acme/app#1']));
  assert.equal(sections.inReview.length, 1);
  assert.equal(sections.inReview[0]?.draft?.number, 1);
  assert.deepEqual(sections.attention, []);
});

test('each section keeps the server order, which is newest first', () => {
  const sections = groupDrafts(status([draft(7), draft(3), draft(12)]));
  assert.deepEqual(sections.ready.map((row) => row.number), [7, 3, 12]);
});

test('an absent or empty status has no rows', () => {
  assert.equal(hasAnyRow(groupDrafts(null)), false);
  assert.equal(hasAnyRow(groupDrafts(status([], [], true))), false);
  assert.equal(hasAnyRow(groupDrafts(status([draft(1, { status: 'discarded' })]))), false);
});

test('tier and verdict labels are short and lower case, with a tone per verdict', () => {
  assert.equal(tierLabel('stamp'), 'stamp');
  assert.equal(tierLabel('full'), 'full');
  assert.equal(verdictLabel('STAMP'), 'stamp');
  assert.equal(verdictLabel('COMMENT'), 'comment');
  assert.equal(verdictLabel('NEEDS_YOU'), 'needs you');
  assert.equal(verdictTone('STAMP'), 'ok');
  assert.equal(verdictTone('NEEDS_YOU'), 'warn');
  assert.equal(pullRequestLabel('Acme/app', 7), 'Acme/app#7');
});

test('the empty state says whether the lane is off or simply has nothing yet', () => {
  assert.equal(emptyStateText(status([], [], false)), 'Team review is off.');
  assert.equal(
    emptyStateText({ ...status([], [], false), reason: 'teamReview needs both org and team' }),
    'Team review is not running: teamReview needs both org and team.',
  );
  assert.match(emptyStateText(status([])), /No review drafts yet/);
});

test('the badge signature tracks ready drafts by key and head only', () => {
  const readyAtHead = status([draft(1), draft(2, { status: 'posted' }), draft(3, { status: 'error' })]);
  assert.equal(readyAttentionSignature(readyAtHead), `Acme/app#1@${HEAD}`);
  const reReviewed = status([draft(1, { reviewedHead: NEXT_HEAD })]);
  assert.notEqual(readyAttentionSignature(reReviewed), readyAttentionSignature(readyAtHead));
  assert.equal(readyAttentionSignature(status([draft(1, { status: 'posted' })])), '');
  assert.equal(readyAttentionSignature(null), '');
});

test('a ready row is rebuilt when its head or status changes', () => {
  assert.equal(readyRowSignature(draft(1)), readyRowSignature(draft(1, { body: 'edited upstream' })));
  assert.notEqual(readyRowSignature(draft(1)), readyRowSignature(draft(1, { reviewedHead: NEXT_HEAD })));
  assert.notEqual(readyRowSignature(draft(1)), readyRowSignature(draft(1, { status: 'stale' })));
});

test('the action request pins the reviewed head and carries only the remaining comments', () => {
  const comments = [
    { path: 'src/a.ts', line: 3, side: 'RIGHT' as const, body: 'first' },
    { path: 'src/a.ts', line: 9, side: 'LEFT' as const, body: 'second' },
  ];
  const remaining = withoutComment(comments, 0);
  assert.deepEqual(remaining, [comments[1]]);
  assert.equal(comments.length, 2);
  assert.deepEqual(buildActionRequest(draft(1, { comments }), 'approve', 'edited body', remaining), {
    key: 'Acme/app#1', head: HEAD, action: 'approve', body: 'edited body', comments: [comments[1]],
  });
  assert.equal(commentLocation(comments[0]), 'src/a.ts:3');
  assert.equal(commentLocation(comments[1]), 'src/a.ts:9 (old)');
});

test('attention rows explain a stale draft and surface the error of a failed one', () => {
  assert.match(attentionDetail(draft(1, { status: 'stale' })), /moved after this review/);
  assert.equal(attentionDetail(draft(1, { status: 'error', error: 'no result file' })), 'no result file');
});
