import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attentionOrder, nextAttentionKey, caughtUpSelectionView, planActionReply, viewerThreadsText, detailThreadItems, caughtUpDetail, postedOutcome, queueRowGlyph, queueRowExceptionReason, commentCountText, classifyReviewPriority, aboutPrParagraphs, isReviewNeeded, actionLabel, actionOutcomeText, actionProgressText, attentionDetail, attentionStatusLabel, buildActionRequest, withReviewerNote, chooseSelectedReviewKey, commentLocation, shortCommentLocation, emptyStateText, laneNotice, githubReviewItems, githubReviewTitle, githubReviewTone, groupDrafts, hasAnyRow, inFlightElapsedText, inFlightProgressText, isInFlightProgressOnlyChange,
  parseInlineSegments, parseReviewComment, reviewCommentPreview, phaseLabel, pullRequestLabel, queueRowTitle, queueRowVerdictLabel, queueRowRefLabel, hasMultipleQueueRepos, readyAttentionSignature, readyRowSignature, detailHeadingSignature, reviewProgressSteps,
  commentSeverity, severityPresentation, tierLabel, verdictHeading, verdictLabel, verdictSealKind, verdictTone, withoutComment, LEGACY_SUMMARY_HINT, hasRequeueFooter, detailActionLayout, isIncludedByDefault, detailMetaText, viewerApprovalContext, viewerApprovalNotice, reviewScopeTitle, coverageSummaryText, coverageDisclosureHeading, queuedDetailText,
} from '../public/team-review-view-core.ts';
import { answeredViewerThreads, THREAD_PLACEHOLDER_ERROR } from '../server/core/team-review-threads-core.ts';
import { threadNode } from './helpers/team-review-thread-fixture.ts';
import { InFlightReview, ReviewDraft, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type {
  InFlightReview as InFlightReviewType, ReviewDraft as ReviewDraftType, TeamReviewStatus as TeamReviewStatusType,
} from '../shared/contracts/team-review.ts';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

function githubReviewTexts(review: ReviewDraft, options: { isViewerShown?: boolean } = {}): string {
  return githubReviewItems(review, options).map((item) => item.text).join(', ');
}

function draft(number: number, overrides: Partial<ReviewDraftType> = {}): ReviewDraftType {
  return ReviewDraft.parse({
    key: `Acme/app#${number}`, repo: 'Acme/app', number, title: `PR ${number}`, url: `https://github.com/Acme/app/pull/${number}`,
    author: 'teammate', tier: 'stamp', reasons: ['12 counted lines in 1 files'], reviewedHead: HEAD,
    verdict: 'APPROVE', summary: 'Fine', body: 'LGTM', comments: [], status: 'ready', ...overrides,
  });
}

function inFlightReview(number: number, overrides: Partial<InFlightReviewType> = {}): InFlightReviewType {
  return InFlightReview.parse({
    key: `Acme/app#${number}`, repo: 'Acme/app', number, title: `PR ${number}`, url: `https://github.com/Acme/app/pull/${number}`,
    author: 'teammate', tier: 'stamp', reasons: ['12 counted lines in 1 files'], head: HEAD,
    phase: 'preparing', startedAt: 1000, deadlineAt: null, toolCalls: 0, recentSteps: [], ...overrides,
  });
}

function status(drafts: ReviewDraftType[], inFlight: InFlightReviewType[] = [], configured = true): TeamReviewStatusType {
  return TeamReviewStatus.parse({ type: 'team-review-status', ts: 1000, configured, reason: null, drafts, inFlight });
}

test('queue row title keeps draft ages and GitHub review sentences', () => {
  const review = draft(7, {
    status: 'posted',
    githubReviews: [
      { login: 'me', state: 'COMMENTED', commit: HEAD, isViewer: true, submittedAt: '2026-09-27T12:00:00Z' },
      { login: 'sarah', state: 'APPROVED', commit: HEAD, isViewer: false, submittedAt: '2026-09-28T12:00:00Z' },
    ],
  });
  assert.equal(queueRowTitle(review, 'posted', { opened: '5d ago', reviewed: '1d ago', posted: '3h ago', githubReviews: ['2d ago'] }), [
    'Acme/app#7: PR 7', 'You commented', 'Opened 5d ago', 'Reviewed 1d ago', 'Posted 3h ago', 'Automated review: Approve, 0 comments', 'approved by sarah, 2d ago',
  ].join('\n'));
});

test('queue row title names an in-progress review and a queued pull request', () => {
  assert.equal(queueRowTitle(inFlightReview(8), 'inReview', { opened: '2d ago' }), 'Acme/app#8: PR 8\nIn review\nOpened 2d ago');
  const queuedReview = TeamReviewStatus.parse({
    type: 'team-review-status', ts: 1, configured: true, reason: null, drafts: [], inFlight: [],
    queued: [{ key: 'Acme/app#9', repo: 'Acme/app', number: 9, title: 'PR 9', url: 'https://github.com/Acme/app/pull/9', author: 'teammate', requestSource: 'team' }],
  }).queued[0];
  assert.ok(queuedReview);
  assert.equal(queueRowTitle(queuedReview, 'queued', { opened: '4h ago' }), 'Acme/app#9: PR 9\nQueued\nOpened 4h ago');
});

test('queue row title retains the attention reason and names no verdict for a review that never ran', () => {
  assert.equal(queueRowTitle(draft(10, { status: 'error', error: 'review timed out', verdict: 'BLOCKED', comments: [] }), 'attention', { opened: '5d ago' }),
    'Acme/app#10: PR 10\nReview failed\nOpened 5d ago\nreview timed out');
});

test('queue verdict words distinguish approvals, nits, changes and blocked reviews', () => {
  assert.equal(queueRowVerdictLabel('APPROVE'), 'Approve');
  assert.equal(queueRowVerdictLabel('APPROVE WITH NITS'), 'Nits');
  assert.equal(queueRowVerdictLabel('REQUEST CHANGES'), 'Changes');
  assert.equal(queueRowVerdictLabel('BLOCKED'), 'Blocked');
});

test('queue refs omit the repo for empty and single-repo rendered groups', () => {
  assert.equal(hasMultipleQueueRepos(groupDrafts(null)), false);
  const sections = groupDrafts(status([draft(1), draft(2, { status: 'posted' })], [inFlightReview(3)]));
  assert.equal(hasMultipleQueueRepos(sections), false);
  assert.equal(queueRowRefLabel('Acme/app', 1, hasMultipleQueueRepos(sections)), '#1');
});

test('queue refs keep the repo when any rendered group contains another repo', () => {
  const otherRepoDraft = draft(1, { key: 'Acme/docs#1', repo: 'Acme/docs' });
  for (const draftStatus of ['ready', 'stale', 'error', 'posted', 'discarded'] as const) {
    const sections = groupDrafts(status([draft(2), { ...otherRepoDraft, status: draftStatus }]));
    assert.equal(hasMultipleQueueRepos(sections), true);
    assert.equal(queueRowRefLabel('Acme/app', 2, hasMultipleQueueRepos(sections)), 'Acme/app#2');
  }
  const settled = draft(1, { ...otherRepoDraft, githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true }] });
  assert.equal(hasMultipleQueueRepos(groupDrafts(status([draft(2), settled]))), true);
  assert.equal(hasMultipleQueueRepos(groupDrafts(status([draft(2)], [inFlightReview(1, { repo: 'Acme/docs', key: 'Acme/docs#1' })]))), true);
  const queued = { key: 'Acme/docs#1', repo: 'Acme/docs', number: 1, title: 'PR 1', url: 'https://github.com/Acme/docs/pull/1', author: 'teammate', requestSource: 'team' as const };
  assert.equal(hasMultipleQueueRepos(groupDrafts({ ...status([draft(2)]), queued: [queued] })), true);
});

test('queue repo prefixes depend on rendered rows after older drafts are hidden', () => {
  const sections = groupDrafts(status([draft(1, { repo: 'Acme/old' })], [inFlightReview(1)]));
  assert.equal(sections.ready.length, 0);
  assert.equal(hasMultipleQueueRepos(sections), false);
});

test('queue row titles retain the full repo ref, verdict and the inline comment count the detail shows', () => {
  const inlineComment = { path: 'src/a.ts', line: 1, side: 'RIGHT' as const, body: 'A finding.' };
  const review = draft(1, { verdict: 'APPROVE WITH NITS', body: '**[logic] HIGH**\n\nA body finding.', comments: [inlineComment] });
  assert.equal(queueRowTitle(review, 'ready', {}), 'Acme/app#1: PR 1\nWaits on you\nAutomated review: Nits, 1 comment');
  assert.match(queueRowTitle({ ...review, comments: [inlineComment, { ...inlineComment, line: 2 }] }, 'ready', {}), /Nits, 2 comments/);
  assert.match(queueRowTitle({ ...review, comments: [] }, 'ready', {}), /Nits, 0 comments/);
});

test('drafts group into ready, in review, needs attention, recently posted and discarded', () => {
  const sections = groupDrafts(status([
    draft(1),
    draft(2, { status: 'stale' }),
    draft(3, { status: 'error', error: 'review timed out after 900s' }),
    draft(4, { status: 'posted' }),
    draft(5, { status: 'discarded' }),
  ], [inFlightReview(9)]));
  assert.deepEqual(sections.ready.map((row) => row.number), [1]);
  assert.deepEqual(sections.inReview.map((row) => row.key), ['Acme/app#9']);
  assert.deepEqual(sections.attention.map((row) => row.number), [2, 3]);
  assert.deepEqual(sections.posted.map((row) => row.number), [4]);
  assert.deepEqual(sections.discarded.map((row) => row.number), [5]);
  assert.equal(hasAnyRow(sections), true);
});

test('a ready draft leaves Ready once a review at its head settles it', () => {
  const reviewedHead = draft(1).reviewedHead;
  const sections = groupDrafts(status([
    draft(1, { githubReviews: [{ login: 'me', state: 'COMMENTED', commit: reviewedHead, isViewer: true }] }),
    draft(2, { githubReviews: [{ login: 'me', state: 'APPROVED', commit: null, isViewer: true }] }),
    draft(3, { githubReviews: [{ login: 'sarah', state: 'APPROVED', commit: reviewedHead, isViewer: false }] }),
    draft(4, { githubReviews: [{ login: 'gil', state: 'CHANGES_REQUESTED', commit: reviewedHead, isViewer: false }] }),
    draft(5, { githubReviews: [{ login: 'sarah', state: 'APPROVED', commit: null, isViewer: false }] }),
    draft(6),
  ]));
  assert.deepEqual(sections.noReviewNeeded.map((row) => row.number), [1, 3, 4]);
  assert.deepEqual(sections.ready.map((row) => row.number), [2, 5, 6]);
  assert.equal(chooseSelectedReviewKey(sections, 'Acme/app#1'), 'Acme/app#1');
});

test('the GitHub summary names the operator first and flags a review of an older commit', () => {
  const reviewedHead = draft(1).reviewedHead;
  assert.equal(githubReviewTexts(draft(1)), '');
  assert.equal(githubReviewTexts(draft(1, { githubReviews: [
    { login: 'sarah', state: 'CHANGES_REQUESTED', commit: reviewedHead, isViewer: false },
    { login: 'me', state: 'APPROVED', commit: reviewedHead, isViewer: true },
  ] })), 'you approved, requested changes by sarah');
  assert.equal(githubReviewTexts(draft(1, { githubReviews: [{ login: 'me', state: 'COMMENTED', commit: null, isViewer: true }] })), 'you commented (older commit)');
  assert.equal(githubReviewTexts(draft(1, { githubReviews: [
    { login: 'me', state: 'COMMENTED', commit: reviewedHead, isViewer: true },
    { login: 'sarah', state: 'APPROVED', commit: reviewedHead, isViewer: false },
  ] }), { isViewerShown: false }), 'approved by sarah');
});

test('stale and error drafts reviewed by the operator at the live head leave Needs attention', () => {
  const liveHead = 'c'.repeat(40);
  const reviewedAtLiveHead = [{ login: 'me', state: 'COMMENTED' as const, commit: liveHead, isViewer: true }];
  const sections = groupDrafts(status([
    draft(1, { status: 'stale', liveHead, githubReviews: reviewedAtLiveHead }),
    draft(2, { status: 'stale', liveHead, githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true }] }),
    draft(3, { status: 'error', error: 'timed out', liveHead, githubReviews: reviewedAtLiveHead }),
    draft(4, { liveHead, githubReviews: [{ login: 'sarah', state: 'APPROVED', commit: HEAD, isViewer: false }] }),
  ]));
  assert.deepEqual(sections.noReviewNeeded.map((row) => row.number), [1, 3]);
  assert.deepEqual(sections.attention.map((row) => row.number), [2]);
  assert.deepEqual(sections.ready.map((row) => row.number), [4]);
});

test('the GitHub summary judges the operator review against the live head, not the reviewed head', () => {
  const liveHead = 'c'.repeat(40);
  assert.equal(githubReviewTexts(draft(1, { status: 'stale', liveHead, githubReviews: [{ login: 'me', state: 'APPROVED', commit: liveHead, isViewer: true }] })), 'you approved');
  assert.equal(githubReviewTexts(draft(1, { status: 'stale', liveHead, githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true }] })), 'you approved (older commit)');
});

test('GitHub review items preserve submission times for the DOM shell', () => {
  const submittedAt = '2026-09-28T12:00:00Z';
  assert.deepEqual(githubReviewItems(draft(1, { githubReviews: [
    { login: 'sarah', state: 'APPROVED', commit: HEAD, isViewer: false, submittedAt },
    { login: 'me', state: 'COMMENTED', commit: HEAD, isViewer: true, submittedAt: null },
  ] })), [
    { login: 'me', tone: 'muted', text: 'you commented', submittedAt: null },
    { login: 'sarah', tone: 'ok', text: 'approved by sarah', submittedAt },
  ]);
});

test('GitHub review tones and hover titles preserve state and older-commit wording', () => {
  assert.equal(githubReviewTone('APPROVED'), 'ok');
  assert.equal(githubReviewTone('CHANGES_REQUESTED'), 'warn');
  assert.equal(githubReviewTone('COMMENTED'), 'muted');
  assert.equal(githubReviewTitle('you approved (older commit)', '3h ago'), 'you approved (older commit), 3h ago');
  assert.equal(githubReviewTitle('commented by alice', null), 'commented by alice');
});

test('a PR under review shows only under In review, even when an older draft exists', () => {
  const sections = groupDrafts(status([draft(1, { status: 'stale' })], [inFlightReview(1)]));
  assert.equal(sections.inReview.length, 1);
  assert.equal(sections.inReview[0]?.number, 1);
  assert.deepEqual(sections.attention, []);
});

test('each section keeps the server order, which is newest first', () => {
  const sections = groupDrafts(status([draft(7), draft(3), draft(12)]));
  assert.deepEqual(sections.ready.map((row) => row.number), [7, 3, 12]);
});

test('an absent or empty status has no rows', () => {
  assert.equal(hasAnyRow(groupDrafts(null)), false);
  assert.equal(hasAnyRow(groupDrafts(status([], [], true))), false);
  assert.equal(hasAnyRow(groupDrafts(status([draft(1, { status: 'discarded' })]))), true);
});

test('tier and verdict labels are short and lower case, with a tone per verdict', () => {
  assert.equal(tierLabel('stamp'), 'light');
  assert.equal(tierLabel('full'), 'full');
  assert.equal(verdictLabel('APPROVE'), 'approve');
  assert.equal(verdictLabel('APPROVE WITH NITS'), 'approve with nits');
  assert.equal(verdictLabel('REQUEST CHANGES'), 'request changes');
  assert.equal(verdictLabel('BLOCKED'), 'blocked');
  assert.equal(verdictHeading('APPROVE WITH NITS'), 'Approve with nits');
  assert.equal(verdictTone('APPROVE'), 'ok');
  assert.equal(verdictTone('REQUEST CHANGES'), 'warn');
  assert.equal(verdictTone('BLOCKED'), 'crit');
  assert.equal(pullRequestLabel('Acme/app', 7), 'Acme/app#7');
});

test('the legacy summary hint offers a requeue', () => {
  assert.match(LEGACY_SUMMARY_HINT, /Queue review to get a plain summary\.$/);
});

test('a posted, failed, stale or discarded review offers a requeue footer, a ready one uses its action row', () => {
  for (const status of ['posted', 'error', 'stale', 'discarded'] as const) assert.equal(hasRequeueFooter(status), true, status);
  assert.equal(hasRequeueFooter('ready'), false);
});

test('the empty state says whether the lane is off or simply has nothing yet', () => {
  assert.equal(emptyStateText(status([], [], false)), 'Team review is off.');
  assert.equal(
    emptyStateText({ ...status([], [], false), reason: 'teamReview needs both org and team' }),
    'Team review is not running: teamReview needs both org and team.',
  );
  assert.match(emptyStateText(status([])), /No review drafts yet/);
  assert.equal(emptyStateText({ ...status([]), error: 'GitHub unreachable' }), 'Review drafts will show here once GitHub answers.');
});

test('a running lane surfaces its reason as a notice and an unconfigured lane keeps the empty state', () => {
  assert.equal(laneNotice({ ...status([]), reason: 'sandbox dependencies missing' }), 'sandbox dependencies missing');
  assert.equal(laneNotice(status([])), null);
  assert.equal(laneNotice({ ...status([]), reason: '' }), null);
  assert.equal(laneNotice({ ...status([], [], false), reason: 'teamReview needs both org and team' }), null);
  assert.equal(laneNotice(null), null);
  assert.equal(emptyStateText({ ...status([]), reason: 'sandbox dependencies missing' }), 'No review drafts yet. New teammate pull requests show up here after the next poll.');
});

test('the badge signature tracks ready drafts by key and head only', () => {
  const readyAtHead = status([draft(1), draft(2, { status: 'posted' }), draft(3, { status: 'error' })]);
  assert.equal(readyAttentionSignature(readyAtHead), `Acme/app#1@${HEAD}`);
  const reReviewed = status([draft(1, { reviewedHead: NEXT_HEAD })]);
  assert.notEqual(readyAttentionSignature(reReviewed), readyAttentionSignature(readyAtHead));
  assert.equal(readyAttentionSignature(status([draft(1, { status: 'posted' })])), '');
  assert.equal(readyAttentionSignature(status([draft(1, { status: 'discarded' })])), '');
  assert.equal(readyAttentionSignature(null), '');
});

test('a ready row is rebuilt when its head or status changes', () => {
  assert.equal(readyRowSignature(draft(1)), readyRowSignature(draft(1, { body: 'edited upstream' })));
  assert.notEqual(readyRowSignature(draft(1)), readyRowSignature(draft(1, { reviewedHead: NEXT_HEAD })));
  assert.notEqual(readyRowSignature(draft(1)), readyRowSignature(draft(1, { status: 'stale' })));
  assert.notEqual(readyRowSignature(draft(1)), readyRowSignature(draft(1, { githubReviews: [{ login: 'sarah', state: 'APPROVED', commit: HEAD, isViewer: false, submittedAt: '2026-09-28T12:00:00Z' }] })));
});

test('a ready row editor survives timestamp-only changes but not a new GitHub verdict', () => {
  const approvedBySarah = (submittedAt: string) => draft(1, { githubReviews: [{ login: 'sarah', state: 'APPROVED', commit: HEAD, isViewer: false, submittedAt }] });
  const changesRequestedBySarah = draft(1, { githubReviews: [{ login: 'sarah', state: 'CHANGES_REQUESTED', commit: HEAD, isViewer: false, submittedAt: '2026-09-28T12:00:00Z' }] });
  assert.equal(readyRowSignature(draft(1)), readyRowSignature(draft(1, { reviewedAt: 1000 })));
  assert.equal(readyRowSignature(draft(1)), readyRowSignature(draft(1, { prCreatedAt: '2026-09-26T12:00:00Z' })));
  assert.equal(readyRowSignature(approvedBySarah('2026-09-28T12:00:00Z')), readyRowSignature(approvedBySarah('2026-09-28T13:00:00Z')));
  assert.notEqual(readyRowSignature(approvedBySarah('2026-09-28T12:00:00Z')), readyRowSignature(changesRequestedBySarah));
});

test('the detail heading is refreshed when its ages or GitHub reviews change', () => {
  assert.equal(detailHeadingSignature(draft(1)), detailHeadingSignature(draft(1, { body: 'edited upstream' })));
  assert.notEqual(detailHeadingSignature(draft(1)), detailHeadingSignature(draft(1, { reviewedAt: 1000 })));
  assert.notEqual(detailHeadingSignature(draft(1)), detailHeadingSignature(draft(1, { prCreatedAt: '2026-09-26T12:00:00Z' })));
  assert.notEqual(detailHeadingSignature(draft(1)), detailHeadingSignature(draft(1, { githubReviews: [{ login: 'sarah', state: 'APPROVED', commit: HEAD, isViewer: false, submittedAt: '2026-09-28T12:00:00Z' }] })));
});

test('the action request pins the reviewed head and carries only the remaining comments', () => {
  const comments = [
    { path: 'src/a.ts', line: 3, side: 'RIGHT' as const, body: 'first', severity: 'HIGH' as const },
    { path: 'src/a.ts', line: 9, side: 'LEFT' as const, body: 'second', severity: 'LOW' as const },
  ];
  const remaining = withoutComment(comments, 0);
  assert.deepEqual(remaining, [comments[1]]);
  assert.equal(comments.length, 2);
  assert.deepEqual(buildActionRequest(draft(1, { comments }), 'approve', 'edited body', remaining), {
    key: 'Acme/app#1', head: HEAD, action: 'approve', body: 'edited body', comments: [{ path: 'src/a.ts', line: 9, side: 'LEFT', body: 'second' }],
  });
  assert.equal(commentLocation(comments[0]), 'src/a.ts:3');
  assert.equal(commentLocation(comments[1]), 'src/a.ts:9 (old)');
});

test('the short comment location keeps only the file name and line, with the old-side marker', () => {
  assert.equal(shortCommentLocation({ path: 'src/programs/detection/__tests__/agentic-progress.test.ts', line: 1, side: 'RIGHT' }), 'agentic-progress.test.ts:1');
  assert.equal(shortCommentLocation({ path: 'README.md', line: 12, side: 'RIGHT' }), 'README.md:12');
  assert.equal(shortCommentLocation({ path: 'src/a.ts', line: 9, side: 'LEFT' }), 'a.ts:9 (old)');
  assert.equal(commentLocation({ path: 'src/a.ts', line: 9, side: 'LEFT' }), 'src/a.ts:9 (old)');
});

test('the reviewer note posts above the automated-review note, and a blank note leaves the body untouched', () => {
  const reviewBody = '> [!NOTE]\n> Automated review. Not written by a human.\n\nSummary.';
  assert.equal(withReviewerNote('  Code review focused. Trying it out later.\n', reviewBody), `Code review focused. Trying it out later.\n\n${reviewBody}`);
  assert.equal(withReviewerNote('First.\n\nSecond.', reviewBody), `First.\n\nSecond.\n\n${reviewBody}`);
  assert.equal(withReviewerNote(' \n ', reviewBody), reviewBody);
  assert.equal(withReviewerNote('Only mine.', '  '), 'Only mine.');
});

test('approve-only drops the edited body and selected comments and has stable action text', () => {
  const review = draft(1, { comments: [{ path: 'src/a.ts', line: 9, side: 'RIGHT', body: 'Fix it' }] });
  assert.deepEqual(buildActionRequest(review, 'approve-only', 'Edited body', review.comments), {
    key: 'Acme/app#1', head: HEAD, action: 'approve-only', body: '', comments: [],
  });
  assert.equal(actionLabel('approve-only'), 'Approve');
  assert.equal(actionLabel('approve'), 'Approve and comment');
  assert.equal(actionProgressText('approve-only'), 'Posting the approval');
  assert.equal(actionOutcomeText('approve-only'), 'Approved on GitHub');
});

test('queue review sends an empty action payload and has stable progress and outcome text', () => {
  assert.deepEqual(buildActionRequest(draft(1, { status: 'error' }), 'requeue', '', []), {
    key: 'Acme/app#1', head: HEAD, action: 'requeue', body: '', comments: [],
  });
  assert.equal(actionProgressText('requeue'), 'Queueing the review');
  assert.equal(actionOutcomeText('requeue'), 'Queued. The next poll reviews it again.');
});

test('a ready review offers Comment, Approve and Approve and comment, and keeps Queue review and Discard in the More menu', () => {
  const ready = draft(1);
  assert.deepEqual(detailActionLayout(ready), { footer: ['comment', 'approve-only', 'approve'], more: ['requeue', 'discard'] });
  assert.deepEqual(detailActionLayout(ready).footer.map((action) => actionLabel(action)), ['Comment', 'Approve', 'Approve and comment']);
  assert.deepEqual(detailActionLayout(ready).more.map((action) => actionLabel(action)), ['Queue review', 'Discard']);
});

test('a posted comment review offers a plain Approve with Queue review in the More menu', () => {
  const commented = draft(1, { status: 'posted', postedEvent: 'COMMENT' });
  assert.deepEqual(detailActionLayout(commented), { footer: ['approve-only'], more: ['requeue'] });
  assert.equal(actionLabel('approve-only'), 'Approve');
});

test('a review with nothing to post keeps Queue review as its only footer action', () => {
  for (const settled of [draft(1, { status: 'posted', postedEvent: 'APPROVE' }), draft(1, { status: 'error', error: 'boom' }), draft(1, { status: 'stale' }), draft(1, { status: 'discarded' })]) {
    assert.deepEqual(detailActionLayout(settled), { footer: ['requeue'], more: [] });
  }
});

test('low-severity inline comments start excluded and every other comment starts included', () => {
  const comment = (body: string, severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW') => ({ body, ...(severity ? { severity } : {}) });
  assert.equal(isIncludedByDefault(comment('**[style] LOW**\n\nRename it.')), false);
  assert.equal(isIncludedByDefault(comment('Rename it.', 'LOW')), false);
  assert.equal(isIncludedByDefault(comment('**[logic] MEDIUM**\n\nOff by one.')), true);
  assert.equal(isIncludedByDefault(comment('**[style] LOW**\n\nNit.\n\n**[logic] HIGH**\n\nBug.')), true);
  assert.equal(isIncludedByDefault(comment('No header at all.')), true);
});

test('attention rows explain a stale draft and surface the error of a failed one', () => {
  assert.equal(attentionDetail(draft(1, { status: 'stale' })), 'Out of date. Automatic review runs at the next poll after the configured wait. Queue review bypasses the wait.');
  assert.equal(attentionDetail(draft(1, { status: 'error', error: 'no result file' })), 'no result file');
  assert.equal(attentionStatusLabel('discarded'), 'discarded');
  assert.equal(attentionDetail(draft(1, { status: 'discarded' })), 'Not reviewed again until queued.');
});

test('a review in progress names its phase in plain words', () => {
  assert.equal(phaseLabel('preparing'), 'fetching the diff');
  assert.equal(phaseLabel('checkout'), 'checking out the head');
  assert.equal(phaseLabel('reviewing'), 'agent reviewing');
});

test('progress text shows elapsed time before the agent starts, then the timeout budget and tool calls', () => {
  assert.equal(inFlightProgressText(inFlightReview(1, { startedAt: 0 }), 42000), '0:42 elapsed');
  const reviewing = inFlightReview(1, { phase: 'reviewing', startedAt: 0, deadlineAt: 900000, toolCalls: 1 });
  assert.equal(inFlightProgressText(reviewing, 125000), '2:05 elapsed, times out in 12:55, 1 tool call');
  assert.equal(inFlightProgressText({ ...reviewing, toolCalls: 14 }, 125000), '2:05 elapsed, times out in 12:55, 14 tool calls');
});

test('elapsed text is the leading part of the progress text on its own', () => {
  const reviewing = inFlightReview(1, { phase: 'reviewing', startedAt: 0, deadlineAt: 900000, toolCalls: 3 });
  assert.equal(inFlightElapsedText(reviewing, 125000), '2:05 elapsed');
  assert.ok(inFlightProgressText(reviewing, 125000).startsWith(inFlightElapsedText(reviewing, 125000)));
});

test('progress text drops the countdown once the wall-clock deadline passes', () => {
  const overdue = inFlightReview(1, { phase: 'reviewing', startedAt: 0, deadlineAt: 1000, toolCalls: 0 });
  assert.equal(inFlightProgressText(overdue, 5000), '0:05 elapsed, 0 tool calls');
});

test('a status that only advances in-flight progress is a progress-only change', () => {
  const previous = status([draft(1)], [inFlightReview(2)]);
  assert.equal(isInFlightProgressOnlyChange(previous, status([draft(1)], [inFlightReview(2, { phase: 'reviewing', toolCalls: 3 })])), true);
});

test('a changed draft, in-flight set, configuration or missing previous status needs a full render', () => {
  const previous = status([draft(1)], [inFlightReview(2)]);
  assert.equal(isInFlightProgressOnlyChange(null, previous), false);
  assert.equal(isInFlightProgressOnlyChange(previous, status([draft(1, { body: 'edited' })], [inFlightReview(2)])), false);
  assert.equal(isInFlightProgressOnlyChange(previous, status([draft(1)], [inFlightReview(2), inFlightReview(3)])), false);
  assert.equal(isInFlightProgressOnlyChange(previous, status([draft(1)], [])), false);
  assert.equal(isInFlightProgressOnlyChange(previous, status([draft(1)], [inFlightReview(2)], false)), false);
});

test('selection favors ready, then in review, attention, posted and discarded, while keeping an available key', () => {
  const sections = groupDrafts(status([draft(5, { status: 'discarded' }), draft(1), draft(2, { status: 'stale' }), draft(3, { status: 'posted' })], [inFlightReview(4)]));
  assert.equal(chooseSelectedReviewKey(sections, null), 'Acme/app#1');
  assert.equal(chooseSelectedReviewKey(sections, 'Acme/app#4'), 'Acme/app#4');
  assert.equal(chooseSelectedReviewKey(sections, 'Acme/app#5'), 'Acme/app#5');
  assert.equal(chooseSelectedReviewKey(sections, 'missing'), 'Acme/app#1');
  assert.equal(chooseSelectedReviewKey(groupDrafts(status([draft(2, { status: 'error' })], [inFlightReview(4)])), null), 'Acme/app#4');
  assert.equal(chooseSelectedReviewKey(groupDrafts(status([draft(2, { status: 'error' })])), null), 'Acme/app#2');
  assert.equal(chooseSelectedReviewKey(groupDrafts(status([draft(5, { status: 'discarded' }), draft(3, { status: 'posted' })])), null), 'Acme/app#3');
  assert.equal(chooseSelectedReviewKey(groupDrafts(status([draft(5, { status: 'discarded' })])), null), 'Acme/app#5');
  assert.equal(chooseSelectedReviewKey(groupDrafts(status([])), null), null);
});

test('severity glyph data uses three shards and distinct critical halo level', () => {
  assert.deepEqual(severityPresentation('LOW'), { filledCount: 1, colorToken: '--text-dim' });
  assert.deepEqual(severityPresentation('MEDIUM'), { filledCount: 2, colorToken: '--accent' });
  assert.deepEqual(severityPresentation('HIGH'), { filledCount: 3, colorToken: '--state-waiting' });
  assert.deepEqual(severityPresentation('CRITICAL'), { filledCount: 3, colorToken: '--state-failed' });
});

test('each verdict selects its one seal mark', () => {
  assert.equal(verdictSealKind('APPROVE'), 'check');
  assert.equal(verdictSealKind('APPROVE WITH NITS'), 'dot');
  assert.equal(verdictSealKind('REQUEST CHANGES'), 'bar');
  assert.equal(verdictSealKind('BLOCKED'), 'cross');
});

test('comment severity takes the highest finding header and falls back to structured severity', () => {
  assert.equal(commentSeverity({ severity: 'LOW', body: '**[logic] MEDIUM**\n\nFirst.\n\n**[security] HIGH**\n\nSecond.' }), 'HIGH');
  assert.equal(commentSeverity({ severity: 'CRITICAL', body: 'Bare comment.' }), 'CRITICAL');
  assert.equal(commentSeverity({ body: 'Bare comment.' }), null);
});

test('comment parsing removes the posted note and heading while keeping paragraphs and inline code', () => {
  const parsed = parseReviewComment('> [!NOTE]\n> Automated review. Not written by a human.\n\n**[code/logic] HIGH**\n\nFirst `value` stays.\n\nSuggested fix: update `count` here.\n\nOpen question. Does `mode` matter?');
  assert.equal(parsed.tag, 'code/logic');
  assert.equal(parsed.severity, 'HIGH');
  assert.deepEqual(parsed.paragraphs, [
    { kind: 'prose', lead: '', leadKind: null, segments: [{ text: 'First ', kind: 'text' }, { text: 'value', kind: 'code' }, { text: ' stays.', kind: 'text' }] },
    { kind: 'prose', lead: 'Suggested fix:', leadKind: 'fix', segments: [{ text: 'update ', kind: 'text' }, { text: 'count', kind: 'code' }, { text: ' here.', kind: 'text' }] },
    { kind: 'prose', lead: 'Open question.', leadKind: 'question', segments: [{ text: 'Does ', kind: 'text' }, { text: 'mode', kind: 'code' }, { text: ' matter?', kind: 'text' }] },
  ]);
});

test('comment parsing accepts fix and open question variants and plain comments', () => {
  assert.deepEqual(parseReviewComment('Fix: Use a guard.').paragraphs[0], { kind: 'prose', lead: 'Fix:', leadKind: 'fix', segments: [{ text: 'Use a guard.', kind: 'text' }] });
  assert.deepEqual(parseReviewComment('Open question, should this retry?').paragraphs[0], { kind: 'prose', lead: 'Open question,', leadKind: 'question', segments: [{ text: 'should this retry?', kind: 'text' }] });
  assert.deepEqual(parseReviewComment('Open question: is this intended?').paragraphs[0], { kind: 'prose', lead: 'Open question:', leadKind: 'question', segments: [{ text: 'is this intended?', kind: 'text' }] });
  assert.equal(parseReviewComment('Plain comment').severity, null);
});

test('inline segments distinguish prose, code and file citations', () => {
  assert.deepEqual(parseInlineSegments('plain text'), [{ text: 'plain text', kind: 'text' }]);
  assert.deepEqual(parseInlineSegments('`foo()`'), [{ text: 'foo()', kind: 'code' }]);
  assert.deepEqual(parseInlineSegments('`a.ts:1`'), [{ text: 'a.ts:1', kind: 'citation' }]);
  assert.deepEqual(parseInlineSegments('See `src/x/y.tsx:10-14` and `count`.'), [
    { text: 'See ', kind: 'text' },
    { text: 'src/x/y.tsx:10-14', kind: 'citation' },
    { text: ' and ', kind: 'text' },
    { text: 'count', kind: 'code' },
    { text: '.', kind: 'text' },
  ]);
});

test('only file paths followed by line numbers become citations', () => {
  for (const citation of ['a.ts:1', 'src/x/y.tsx:10-14', '.github/workflows/ci.yml:12', 'package.json:26', 'SRC/App.TSX:4']) {
    assert.equal(parseInlineSegments(`\`${citation}\``)[0]?.kind, 'citation', citation);
  }
  const nonCitations = [
    'foo()', 'a:b', 'http://x:80', 'key: value', '0.1.3', 'Makefile:3', 'docs/Makefile:3', 'localhost:8080', '0.0.0.0:3000',
    'postgres:16', 'node:22', 'example.com:443', 'api.github.com:443', 'redis.local:6379', 'bitnami/redis:7', 'ghcr.io/org/app:1',
  ];
  for (const code of nonCitations) {
    assert.equal(parseInlineSegments(`\`${code}\``)[0]?.kind, 'code', code);
  }
});

test('fenced code stays together across blank lines and preserves prose around it', () => {
  assert.deepEqual(parseReviewComment('Before.\n\n```ts\nconst first = 1;\n\nconst second = 2;\n```\n\nAfter.').paragraphs, [
    { kind: 'prose', lead: '', leadKind: null, segments: [{ text: 'Before.', kind: 'text' }] },
    { kind: 'code', language: 'ts', code: 'const first = 1;\n\nconst second = 2;' },
    { kind: 'prose', lead: '', leadKind: null, segments: [{ text: 'After.', kind: 'text' }] },
  ]);
  assert.deepEqual(parseReviewComment('```\nconst value = 1;\n```').paragraphs, [
    { kind: 'code', language: null, code: 'const value = 1;' },
  ]);
});

test('fences with any info string open a code block and name the first word as language', () => {
  assert.deepEqual(parseReviewComment('```c++\nint x;\n```\n\nThis prose.\n\n```ts\nconst y=1;\n```').paragraphs, [
    { kind: 'code', language: 'c++', code: 'int x;' },
    { kind: 'prose', lead: '', leadKind: null, segments: [{ text: 'This prose.', kind: 'text' }] },
    { kind: 'code', language: 'ts', code: 'const y=1;' },
  ]);
  assert.deepEqual(parseReviewComment('```ts title="x"\nconst value = 1;\n```').paragraphs, [
    { kind: 'code', language: 'ts', code: 'const value = 1;' },
  ]);
});

test('an unclosed fence remains prose without dropping its lines', () => {
  const paragraphs = parseReviewComment('Before.\n\n```ts\nconst value = 1;\n\nAfter.').paragraphs;
  assert.deepEqual(paragraphs, [
    { kind: 'prose', lead: '', leadKind: null, segments: [{ text: 'Before.', kind: 'text' }] },
    { kind: 'prose', lead: '', leadKind: null, segments: [{ text: '```ts\nconst value = 1;', kind: 'text' }] },
    { kind: 'prose', lead: '', leadKind: null, segments: [{ text: 'After.', kind: 'text' }] },
  ]);
});

test('comment preview uses the first prose paragraph after code', () => {
  const paragraphs = parseReviewComment('```ts\ncall();\n```\n\nSuggested fix: Use a guard. More detail.').paragraphs;
  assert.equal(reviewCommentPreview(paragraphs), 'Suggested fix: Use a guard.');
  assert.equal(reviewCommentPreview(parseReviewComment('```\ncall();\n```').paragraphs), 'Open comment');
  assert.equal(reviewCommentPreview([]), 'Open comment');
});

test('progress tracker advances one active stage and leaves Draft ready pending', () => {
  assert.deepEqual(reviewProgressSteps('preparing').map((step) => step.state), ['active', 'todo', 'todo', 'todo']);
  assert.deepEqual(reviewProgressSteps('checkout').map((step) => step.state), ['done', 'active', 'todo', 'todo']);
  assert.deepEqual(reviewProgressSteps('reviewing'), [
    { label: 'Fetch the diff', state: 'done' },
    { label: 'Check out the head', state: 'done' },
    { label: 'Review', state: 'active' },
    { label: 'Draft ready', state: 'todo' },
  ]);
});

test('detail metadata names the scope and keeps raw reasons in the title', () => {
  assert.equal(detailMetaText({ tier: 'full' }), 'full review');
  assert.equal(detailMetaText({ tier: 'stamp' }), 'light review');
  assert.equal(detailMetaText({ tier: 'full', priorReviewedHead: 'abcdef0123456789abcdef0123456789abcdef01' }), 'full review of changes since abcdef0');
  assert.equal(reviewScopeTitle({ reasons: ['touches auth', 'many files'] }), 'touches auth, many files');
  assert.equal(reviewScopeTitle({ reasons: [] }), '');
});

test('coverage summaries omit empty counts and use singular checks', () => {
  assert.equal(coverageSummaryText({ goal: '', change: 'Updated flow', checked: Array(6).fill('check'), gaps: Array(3).fill('gap') }), '6 checks, 3 not covered');
  assert.equal(coverageSummaryText({ goal: '', change: '', checked: ['check'], gaps: [] }), '1 check');
  assert.equal(coverageSummaryText({ goal: '', change: '', checked: [], gaps: ['gap'] }), '1 not covered');
  assert.equal(coverageSummaryText({ goal: '', change: '', checked: [], gaps: [] }), 'No coverage notes');
  assert.equal(coverageSummaryText(undefined), 'No coverage notes');
});

test('a legacy draft without an assessment labels its disclosure as the review audit with no preview', () => {
  assert.deepEqual(coverageDisclosureHeading(undefined), { label: 'Review audit', preview: '' });
  assert.deepEqual(coverageDisclosureHeading(null), { label: 'Review audit', preview: '' });
  assert.match(LEGACY_SUMMARY_HINT, /audit log/);
});

test('a draft with an assessment labels its disclosure as coverage with the count preview', () => {
  assert.deepEqual(coverageDisclosureHeading({ goal: '', change: '', checked: ['check'], gaps: ['gap'] }), { label: 'Coverage', preview: '1 check, 1 not covered' });
  assert.deepEqual(coverageDisclosureHeading({ goal: '', change: '', checked: [], gaps: [] }), { label: 'Coverage', preview: 'No coverage notes' });
});

test('a queued pull request gets its own section and hides its older draft', () => {
  const status = TeamReviewStatus.parse({
    type: 'team-review-status', ts: 1, configured: true, reason: null, inFlight: [],
    drafts: [draft(7, { status: 'stale' })],
    queued: [{ key: 'Acme/app#7', repo: 'Acme/app', number: 7, title: 'PR 7', url: 'https://github.com/Acme/app/pull/7', author: 'teammate', requestSource: 'team' }],
  });
  const sections = groupDrafts(status);
  assert.deepEqual(sections.queued.map((review) => review.key), ['Acme/app#7']);
  assert.equal(sections.attention.length, 0);
  assert.equal(hasAnyRow(sections), true);
});

test('the queued detail says what the pull request is waiting for', () => {
  assert.match(queuedDetailText(0), /next poll/);
  assert.match(queuedDetailText(1), /as soon as the review in progress finishes/);
  assert.match(queuedDetailText(2), /one of the 2 reviews in progress/);
});

test('a change to the queued list is never treated as progress only', () => {
  const before = status([draft(1)], [inFlightReview(2)]);
  const queuedItem = { key: 'Acme/app#3', repo: 'Acme/app', number: 3, title: 'PR 3', url: 'https://github.com/Acme/app/pull/3', author: 'teammate', requestSource: 'team' as const };
  assert.equal(isInFlightProgressOnlyChange(before, { ...before, queued: [queuedItem] }), false);
  assert.equal(isInFlightProgressOnlyChange(before, { ...before }), true);
});

test('About this PR paragraphs omit absent and blank assessments and preserve goal then change', () => {
  assert.deepEqual(aboutPrParagraphs(undefined), []);
  assert.deepEqual(aboutPrParagraphs(null), []);
  assert.deepEqual(aboutPrParagraphs({ goal: '  ', change: '\n', checked: [], gaps: [] }), []);
  assert.deepEqual(aboutPrParagraphs({ goal: ' Avoid stuck `requests`. ', change: ' Re-arm the timer. ', checked: [], gaps: [] }), [
    { kind: 'goal', text: 'Avoid stuck `requests`.' }, { kind: 'change', text: 'Re-arm the timer.' },
  ]);
  assert.deepEqual(aboutPrParagraphs({ goal: '', change: 'Re-arm the timer.', checked: [], gaps: [] }), [{ kind: 'change', text: 'Re-arm the timer.' }]);
  assert.deepEqual(aboutPrParagraphs({ goal: 'Avoid stuck requests.', change: '', checked: [], gaps: [] }), [{ kind: 'goal', text: 'Avoid stuck requests.' }]);
});

test('queue row title puts a draft goal immediately after the PR title and omits blank goals', () => {
  const assessment = { goal: ' Avoid stuck requests. ', change: 'Re-arm the timer.', checked: [], gaps: [] };
  assert.equal(queueRowTitle(draft(1, { assessment }), 'ready', { opened: '1d ago' }), 'Acme/app#1: PR 1\nAvoid stuck requests.\nWaits on you\nOpened 1d ago\nAutomated review: Approve, 0 comments');
  assert.equal(queueRowTitle(draft(1, { assessment: { ...assessment, goal: ' ' } }), 'ready', {}), 'Acme/app#1: PR 1\nWaits on you\nAutomated review: Approve, 0 comments');
});

test('poll errors, retry schedules and refresh progress always render even when the drafts stay the same', () => {
  const previous = status([]);
  for (const patch of [{ error: 'offline' }, { nextAttemptAt: 11_000 }, { retry: { attempt: 1, limit: 3 } }, { isRefreshing: true }, { refreshNotice: 'A refresh is already running.' }]) {
    assert.equal(isInFlightProgressOnlyChange(previous, { ...previous, ...patch }), false);
  }
});


test('viewer approval context identifies an approval on an older commit', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: NEXT_HEAD, isViewer: true, submittedAt: '2026-09-28T12:00:00Z' } as const;
  assert.deepEqual(viewerApprovalContext(draft(1, { githubReviews: [approval] })), { approvedCommit: NEXT_HEAD, submittedAt: approval.submittedAt, state: 'APPROVED', isReviewScopeSinceDecision: false });
});

test('an older approval GitHub still counts needs no review and carries no re-review context', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: NEXT_HEAD, isViewer: true, submittedAt: '2026-09-28T12:00:00Z' } as const;
  const standing = draft(1, { githubReviews: [approval], reviewDecision: 'APPROVED' });
  assert.equal(isReviewNeeded(standing), false);
  assert.equal(viewerApprovalContext(standing), null);
  assert.deepEqual(groupDrafts(status([standing])).noReviewNeeded.map((row) => row.key), [standing.key]);
  const required = draft(2, { githubReviews: [approval], reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(isReviewNeeded(required), true);
  assert.notEqual(viewerApprovalContext(required), null);
  assert.equal(isReviewNeeded(draft(3, { githubReviews: [{ ...approval, isViewer: false, login: 'sarah' }], reviewDecision: 'APPROVED' })), true);
});

test('a review the operator queued at its head stays ready with its re-review context despite an approval that still counts', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: NEXT_HEAD, isViewer: true, submittedAt: '2026-09-28T12:00:00Z' } as const;
  const requeued = draft(1, { githubReviews: [approval], reviewDecision: 'APPROVED', requeuedHead: HEAD, priorReviewedHead: NEXT_HEAD });
  assert.equal(isReviewNeeded(requeued), true);
  assert.deepEqual(groupDrafts(status([requeued])).ready.map((row) => row.key), [requeued.key]);
  assert.equal(viewerApprovalContext(requeued)?.isReviewScopeSinceDecision, true);
  const requeuedElsewhere = draft(2, { githubReviews: [approval], reviewDecision: 'APPROVED', requeuedHead: NEXT_HEAD });
  assert.deepEqual(groupDrafts(status([requeuedElsewhere])).noReviewNeeded.map((row) => row.key), [requeuedElsewhere.key]);
});

test('a review queued at an earlier head needs no review once the approval still counts after new commits', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true, submittedAt: '2026-09-28T12:00:00Z' } as const;
  const movedOn = draft(1, { githubReviews: [approval], reviewDecision: 'APPROVED', requeuedHead: HEAD, liveHead: NEXT_HEAD });
  assert.equal(isReviewNeeded(movedOn), false);
  assert.deepEqual(groupDrafts(status([movedOn])).noReviewNeeded.map((row) => row.key), [movedOn.key]);
  const stillAtRequeuedHead = draft(2, { githubReviews: [approval], reviewDecision: 'APPROVED', requeuedHead: NEXT_HEAD, liveHead: NEXT_HEAD });
  assert.equal(isReviewNeeded(stillAtRequeuedHead), true);
});

test('viewer approval context omits current-head approvals, unknown commits and absent viewer decisions', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true } as const;
  assert.equal(viewerApprovalContext(draft(1, { githubReviews: [approval] })), null);
  assert.equal(viewerApprovalContext(draft(1, { githubReviews: [{ ...approval, commit: null }] })), null);
  assert.equal(viewerApprovalContext(draft(1, { githubReviews: [{ ...approval, isViewer: false, commit: NEXT_HEAD }] })), null);
  assert.equal(viewerApprovalContext(draft(1, { githubReviews: [{ ...approval, state: 'COMMENTED', commit: NEXT_HEAD }] })), null);
  assert.equal(viewerApprovalContext(draft(1)), null);
});

test('the latest viewer decision supersedes older approvals regardless of array order and ignores comments', () => {
  const olderApproval = { login: 'me', state: 'APPROVED', commit: NEXT_HEAD, isViewer: true, submittedAt: '2026-09-27T12:00:00Z' } as const;
  const currentApproval = { ...olderApproval, commit: HEAD, submittedAt: '2026-09-28T12:00:00Z' };
  for (const githubReviews of [[olderApproval, currentApproval], [currentApproval, olderApproval]]) {
    assert.equal(viewerApprovalContext(draft(1, { githubReviews })), null);
  }
  const requestedChanges = { ...olderApproval, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-28T12:00:00Z' } as const;
  const comment = { ...olderApproval, state: 'COMMENTED', submittedAt: '2026-09-29T12:00:00Z' } as const;
  assert.deepEqual(viewerApprovalContext(draft(1, { githubReviews: [olderApproval, comment, requestedChanges] })), { approvedCommit: NEXT_HEAD, submittedAt: requestedChanges.submittedAt, state: 'CHANGES_REQUESTED', isReviewScopeSinceDecision: false });
});

test('re-review tooltips name the earlier viewer decision, commit, age and new commits', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: NEXT_HEAD, isViewer: true } as const;
  assert.ok(queueRowTitle(draft(1, { githubReviews: [approval] }), 'ready', { viewerApproval: '2d ago' }).split('\n').includes('You approved at bbbbbbb 2d ago; new commits since.'));
  assert.ok(queueRowTitle(draft(1, { githubReviews: [{ ...approval, state: 'CHANGES_REQUESTED' }] }), 'ready', {}).split('\n').includes('You requested changes at bbbbbbb; new commits since.'));
});

test('re-review notices explain the previous decision and the scope with optional age', () => {
  const context = { approvedCommit: NEXT_HEAD, submittedAt: null, state: 'APPROVED', isReviewScopeSinceDecision: true } as const;
  assert.equal(viewerApprovalNotice(context, '2d ago'), 'You approved this at bbbbbbb 2d ago. It has new commits since, so this review covers what changed after your approval.');
  assert.equal(viewerApprovalNotice({ ...context, state: 'CHANGES_REQUESTED' }, null), 'You requested changes at bbbbbbb. It has new commits since, so this review covers what changed after your request for changes.');
});

test('re-review notices drop the scope clause when the review scope is not the changes since the decision', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: NEXT_HEAD, isViewer: true } as const;
  const unrelatedScope = viewerApprovalContext(draft(1, { githubReviews: [approval] }));
  assert.ok(unrelatedScope);
  assert.equal(unrelatedScope.isReviewScopeSinceDecision, false);
  assert.equal(viewerApprovalNotice(unrelatedScope, '2d ago'), 'You approved this at bbbbbbb 2d ago. It has new commits since.');
  assert.equal(viewerApprovalNotice({ ...unrelatedScope, state: 'CHANGES_REQUESTED' }, null), 'You requested changes at bbbbbbb. It has new commits since.');
  const matchingScope = viewerApprovalContext(draft(1, { githubReviews: [approval], priorReviewedHead: NEXT_HEAD }));
  assert.equal(matchingScope?.isReviewScopeSinceDecision, true);
});

test('viewer approval context is null when the viewer decided on the live head or after the review ran', () => {
  const approval = { login: 'me', state: 'APPROVED', commit: NEXT_HEAD, isViewer: true, submittedAt: '2026-09-28T12:00:00Z' } as const;
  assert.equal(viewerApprovalContext(draft(1, { githubReviews: [approval], liveHead: NEXT_HEAD })), null);
  const decidedAtMs = Date.parse(approval.submittedAt);
  assert.equal(viewerApprovalContext(draft(1, { githubReviews: [approval], reviewedAt: decidedAtMs - 1000 })), null);
  assert.ok(viewerApprovalContext(draft(1, { githubReviews: [approval], reviewedAt: decidedAtMs + 1000 })));
});

test('review priority classifies author blockers and readiness before request urgency', () => {
  const directReview = draft(1, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED', checksState: 'SUCCESS' });
  assert.deepEqual(classifyReviewPriority(directReview), { band: 'blocking-others', reason: 'direct-request' });
  assert.deepEqual(classifyReviewPriority(draft(2)), { band: 'actionable', reason: 'team-request' });
  assert.deepEqual(classifyReviewPriority({ ...directReview, isDraft: true }), { band: 'not-ready', reason: 'draft' });
  assert.deepEqual(classifyReviewPriority({ ...directReview, reviewDecision: 'CHANGES_REQUESTED' }), { band: 'waiting-on-author', reason: 'changes-requested' });
  for (const checksState of ['FAILURE', 'ERROR'] as const) assert.deepEqual(classifyReviewPriority({ ...directReview, checksState }), { band: 'waiting-on-author', reason: 'checks-failing' });
  for (const checksState of ['PENDING', 'EXPECTED'] as const) assert.deepEqual(classifyReviewPriority({ ...directReview, checksState }), { band: 'not-ready', reason: 'checks-pending' });
  assert.equal(classifyReviewPriority({ ...directReview, checksState: null }).band, 'blocking-others');
  assert.equal(classifyReviewPriority({ ...directReview, reviewDecision: 'APPROVED' }).band, 'actionable');
});

test('ready and queued rows preserve incoming order within priority bands', () => {
  const drafts = [draft(1, { checksState: 'PENDING' }), draft(2), draft(3, { checksState: 'FAILURE' }), draft(4, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }), draft(5), draft(6, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }), draft(7, { isDraft: true })];
  const sections = groupDrafts(status(drafts));
  assert.deepEqual(sections.ready.map((review) => review.number), [4, 6, 2, 5, 3, 1, 7]);
  const queued = drafts.map(({ key, repo, number, title, url, author, requestSource, reviewDecision, checksState, isDraft }) => ({ key, repo, number, title, url, author, requestSource, reviewDecision, checksState, isDraft }));
  assert.deepEqual(groupDrafts({ ...status([]), queued }).queued.map((review) => review.number), [4, 6, 2, 5, 3, 1, 7]);
});

test('a ready row editor survives request source, CI and approval changes', () => {
  const review = draft(1);
  assert.equal(readyRowSignature(review), readyRowSignature({ ...review, requestSource: 'direct' }));
  assert.equal(readyRowSignature(review), readyRowSignature({ ...review, checksState: 'FAILURE' }));
  assert.equal(readyRowSignature(review), readyRowSignature({ ...review, checksState: 'PENDING' }));
  assert.equal(readyRowSignature(review), readyRowSignature({ ...review, reviewDecision: 'CHANGES_REQUESTED' }));
});


test('answered non-nit threads take Ready precedence over standing approval, posted and discarded drafts', () => {
  for (const draftStatus of ['ready', 'posted', 'stale', 'discarded'] as const) {
    const review = draft(1, { status: draftStatus, reviewDecision: 'APPROVED', githubReviews: [{ login: 'viewer', state: 'APPROVED', commit: HEAD, isViewer: true }], threads: answeredViewerThreads([threadNode()], [], HEAD) });
    const grouped = groupDrafts(status([review]));
    assert.deepEqual(grouped.ready, [review]);
    assert.equal(grouped.noReviewNeeded.length + grouped.posted.length + grouped.attention.length + grouped.discarded.length, 0);
    assert.equal(isReviewNeeded(review), true);
  }
  assert.equal(groupDrafts(status([draft(1, { status: 'posted', threads: answeredViewerThreads([threadNode('LOW')], [], HEAD) })])).ready.length, 0);
});

test('detail threads expose location, judge status and current judgement, and resolve regardless of judgement', () => {
  const review = draft(1, { threads: answeredViewerThreads([threadNode()], [], HEAD) });
  assert.equal(detailThreadItems(review)[0].location, 'src/app.ts:2');
  assert.equal(detailThreadItems(review)[0].judgementText, 'Judging');
  assert.equal(detailThreadItems(review)[0].canResolve, true);
  const thread = review.threads?.[0];
  assert.ok(thread);
  thread.judgement = { addressed: false, reason: 'Guard missing', head: HEAD, lastReplyAt: thread.lastReplyAt, judgedAt: 1 };
  assert.equal(detailThreadItems(review)[0].judgementText, 'Not addressed: Guard missing');
  assert.equal(detailThreadItems(review)[0].canResolve, true);
  const signature = readyRowSignature(review);
  review.liveHead = NEXT_HEAD;
  assert.equal(detailThreadItems(review)[0].judgementText, 'Judging');
  assert.equal(detailThreadItems(review)[0].canResolve, true);
  assert.equal(readyRowSignature(review), signature);
  thread.unjudgeable = { head: NEXT_HEAD, lastReplyAt: thread.lastReplyAt, reason: 'Thread or diff too large to judge' };
  assert.equal(detailThreadItems(review)[0].judgementText, 'Not judged: Thread or diff too large to judge');
  assert.equal(detailThreadItems(review)[0].canResolve, true);
  thread.viewerCanResolve = false;
  assert.equal(detailThreadItems(review)[0].canResolve, false);
  thread.isResolved = true;
  assert.equal(detailThreadItems(review).length, 0);
});

test('a nit whose automatic resolve failed is listed with an operator Resolve while a pending nit stays hidden', () => {
  const review = draft(1, { threads: answeredViewerThreads([threadNode('LOW')], [], HEAD) });
  const thread = review.threads?.[0];
  assert.ok(thread);
  assert.equal(detailThreadItems(review).length, 0);
  thread.resolveError = 'denied';
  assert.equal(detailThreadItems(review)[0].judgementText, 'Automatic resolution failed');
  assert.equal(detailThreadItems(review)[0].canResolve, true);
  thread.viewerCanResolve = false;
  assert.equal(detailThreadItems(review)[0].canResolve, false);
});

test('an in-flight or queued review keeps precedence over the answered threads of its own draft', () => {
  const review = draft(1, { status: 'stale', threads: answeredViewerThreads([threadNode()], [], HEAD) });
  const grouped = groupDrafts(status([review], [inFlightReview(1)]));
  assert.equal(grouped.inReview.length, 1);
  assert.equal(grouped.ready.length, 0);
});

test('an error with standing approval settles without attention', () => {
  const review = draft(1388, {
    status: 'error', reviewDecision: 'APPROVED', liveHead: NEXT_HEAD,
    githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true }],
  });
  const sections = groupDrafts(status([review]));
  assert.deepEqual(sections.noReviewNeeded, [review]);
  assert.deepEqual(sections.attention, []);
});

test('posted outcome comes from the viewer GitHub review or the posted event, and is null without either', () => {
  const review = draft(1337, { status: 'posted', verdict: 'REQUEST CHANGES', postedEvent: 'APPROVE' });
  assert.deepEqual(postedOutcome(review), { label: 'You approved', tone: 'ok' });
  assert.match(queueRowTitle(review, 'posted', {}), /^Acme\/app#1337: PR 1337\nYou approved\n/);
  assert.deepEqual(postedOutcome({ ...review, postedEvent: 'COMMENT' }), { label: 'You commented', tone: 'muted' });
  const legacy = { ...review, postedEvent: undefined };
  assert.equal(postedOutcome(legacy), null);
  assert.match(queueRowTitle(legacy, 'posted', {}), /\nPosted\nAutomated review: Changes, 0 comments/);
  const approvedOnGithub = { ...legacy, githubReviews: [
    { login: 'me', state: 'COMMENTED' as const, commit: HEAD, isViewer: true, submittedAt: '2026-10-01T10:00:00Z' },
    { login: 'me', state: 'APPROVED' as const, commit: HEAD, isViewer: true, submittedAt: '2026-10-02T10:00:00Z' },
    { login: 'other', state: 'CHANGES_REQUESTED' as const, commit: HEAD, isViewer: false, submittedAt: '2026-10-03T10:00:00Z' },
  ] };
  assert.deepEqual(postedOutcome(approvedOnGithub), { label: 'You approved', tone: 'ok' });
  assert.match(queueRowTitle(approvedOnGithub, 'posted', {}), /\nYou approved\n/);
});

test('posted outcome prefers a comment posted after an older viewer approval snapshot', () => {
  const review = draft(1338, {
    status: 'posted', postedEvent: 'COMMENT', postedAt: Date.parse('2026-10-03T10:00:00Z'),
    githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true, submittedAt: '2026-10-02T10:00:00Z' }],
  });
  assert.deepEqual(postedOutcome(review), { label: 'You commented', tone: 'muted' });
});

test('posted outcome prefers a viewer approval submitted after the posted comment', () => {
  const review = draft(1339, {
    status: 'posted', postedEvent: 'COMMENT', postedAt: Date.parse('2026-10-02T10:00:00Z'),
    githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true, submittedAt: '2026-10-03T10:00:00Z' }],
  });
  assert.deepEqual(postedOutcome(review), { label: 'You approved', tone: 'ok' });
});

test('posted outcome prefers the posted event when the viewer review has no submitted time', () => {
  const review = draft(1340, {
    status: 'posted', postedEvent: 'COMMENT', postedAt: Date.parse('2026-10-02T10:00:00Z'),
    githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true, submittedAt: null }],
  });
  assert.deepEqual(postedOutcome(review), { label: 'You commented', tone: 'muted' });
});

test('hand review rows populate their section and keep a hand-only list visible', () => {
  const review = draft(19911, { repo: 'Acme/fork', key: 'Acme/fork#19911' });
  const snapshot = TeamReviewStatus.parse({ ...status([]), handReview: [review] });
  const sections = groupDrafts(snapshot);
  assert.deepEqual(sections.handReview, snapshot.handReview);
  assert.equal(hasAnyRow(sections), true);
  assert.equal(hasMultipleQueueRepos(groupDrafts({ ...snapshot, drafts: [draft(1)] })), true);
  assert.equal(isInFlightProgressOnlyChange(status([]), snapshot), false);
});

test('a fork placeholder draft with an answered thread lands in Ready instead of its hand review row', () => {
  const placeholder = draft(19911, { repo: 'Acme/fork', key: 'Acme/fork#19911', status: 'error', error: THREAD_PLACEHOLDER_ERROR, threads: answeredViewerThreads([threadNode()], [], HEAD) });
  const handReviewRow = draft(19911, { repo: 'Acme/fork', key: 'Acme/fork#19911' });
  const sections = groupDrafts(TeamReviewStatus.parse({ ...status([placeholder]), handReview: [handReviewRow] }));
  assert.deepEqual(sections.ready.map((review) => review.key), [placeholder.key]);
  assert.deepEqual(sections.handReview, []);
});

test('hand review rows replace older drafts and queued rows while active reviews take precedence', () => {
  const review = draft(5, { status: 'stale' });
  const snapshot = TeamReviewStatus.parse({ ...status([review]), queued: [review], handReview: [review] });
  const sections = groupDrafts(snapshot);
  assert.equal(sections.handReview.length, 1);
  assert.deepEqual(sections.queued, []);
  assert.deepEqual(sections.attention, []);
  assert.equal(chooseSelectedReviewKey(sections, review.key), null);
  const activeSections = groupDrafts({ ...snapshot, inFlight: [inFlightReview(5)] });
  assert.deepEqual(activeSections.handReview, []);
  assert.equal(activeSections.inReview.length, 1);
});

test('queue row glyphs name the operator outcome on posted rows and the next step elsewhere', () => {
  const posted = draft(1, { status: 'posted', postedEvent: 'APPROVE', postedAt: 1 });
  assert.deepEqual(queueRowGlyph(posted, 'posted'), { tone: 'ok', meaning: 'You approved' });
  assert.deepEqual(queueRowGlyph({ ...posted, postedEvent: 'COMMENT' }, 'posted'), { tone: 'muted', meaning: 'You commented' });
  const viewerRequestedChanges = { login: 'me', state: 'CHANGES_REQUESTED', commit: HEAD, isViewer: true, submittedAt: '2026-10-03T10:00:00Z' } as const;
  assert.deepEqual(queueRowGlyph({ ...posted, githubReviews: [viewerRequestedChanges] }, 'posted'), { tone: 'wait', meaning: 'You requested changes' });
  assert.deepEqual(queueRowGlyph({ ...posted, postedEvent: undefined }, 'posted'), { tone: 'muted', meaning: 'Posted' });
  assert.deepEqual(queueRowGlyph(draft(2), 'ready'), { tone: 'warn', meaning: 'Waits on you' });
  assert.deepEqual(queueRowGlyph(draft(3, { checksState: 'FAILURE' }), 'ready'), { tone: 'wait', meaning: 'Checks failing' });
  assert.deepEqual(queueRowGlyph(draft(4), 'settled'), { tone: 'ok', meaning: 'Others reviewed' });
  assert.deepEqual(queueRowGlyph(draft(4, { postedEvent: 'APPROVE', postedAt: 1 }), 'settled'), { tone: 'ok', meaning: 'You approved' });
  assert.deepEqual(queueRowGlyph(draft(4, { githubReviews: [{ ...viewerRequestedChanges, commit: 'b'.repeat(40) }, { login: 'teammate', state: 'APPROVED', commit: HEAD, isViewer: false, submittedAt: '2026-10-04T10:00:00Z' }] }), 'settled'), { tone: 'ok', meaning: 'Others reviewed' });
  const teammateApprovalAtHead = { login: 'teammate', state: 'APPROVED', commit: HEAD, isViewer: false, submittedAt: '2026-10-04T10:00:00Z' } as const;
  assert.deepEqual(queueRowGlyph(draft(4, { reviewDecision: 'APPROVED', githubReviews: [{ login: 'me', state: 'APPROVED', commit: 'b'.repeat(40), isViewer: true, submittedAt: '2026-10-03T10:00:00Z' }, teammateApprovalAtHead] }), 'settled'), { tone: 'ok', meaning: 'You approved' });
  assert.deepEqual(queueRowGlyph(draft(4, { githubReviews: [{ login: 'me', state: 'COMMENTED', commit: HEAD, isViewer: true, submittedAt: '2026-10-03T10:00:00Z' }, teammateApprovalAtHead] }), 'settled'), { tone: 'muted', meaning: 'You commented' });
  assert.equal(queueRowGlyph(draft(8, { isDraft: true }), 'queued').meaning, 'Queued, Draft');
  assert.equal(queueRowGlyph(draft(9, { checksState: 'FAILURE' }), 'inReview').meaning, 'In review, Checks failing');
  assert.deepEqual(queueRowGlyph(draft(5, { status: 'error' }), 'attention'), { tone: 'danger', meaning: 'Review failed' });
  assert.deepEqual(queueRowGlyph(draft(6, { status: 'stale' }), 'attention'), { tone: 'warn', meaning: 'Out of date' });
  assert.deepEqual(queueRowGlyph(draft(7), 'handReview'), { tone: 'warn', meaning: 'From a fork' });
});

test('only exceptional priority reasons earn row text, so plain team and ready requests stay silent', () => {
  assert.equal(queueRowExceptionReason({ requestSource: 'team' }), null);
  assert.equal(queueRowExceptionReason({ requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }), null);
  assert.equal(queueRowExceptionReason({ requestSource: 'team', reviewDecision: 'APPROVED' }), null);
  assert.equal(queueRowExceptionReason({ requestSource: 'team', isDraft: true }), 'Draft');
  assert.equal(queueRowExceptionReason({ requestSource: 'team', reviewDecision: 'CHANGES_REQUESTED' }), 'Author to fix');
  assert.equal(queueRowExceptionReason({ requestSource: 'team', checksState: 'PENDING' }), 'Checks running');
});

test('comment counts read as words', () => {
  assert.equal(commentCountText(1), '1 comment');
  assert.equal(commentCountText(3), '3 comments');
});

test('the caught-up banner shows only when nothing is ready, failed or waiting on a hand review', () => {
  assert.equal(caughtUpDetail(groupDrafts(status([draft(1, { status: 'posted' })]))), 'Nothing needs you right now.');
  assert.equal(caughtUpDetail(groupDrafts(status([draft(1, { status: 'posted' })], [inFlightReview(2)]))), 'Nothing needs you right now. 1 review is still running.');
  assert.equal(caughtUpDetail(groupDrafts(status([draft(1)]))), null);
  assert.equal(caughtUpDetail(groupDrafts(status([draft(1, { status: 'error' })]))), null);
  assert.equal(caughtUpDetail(groupDrafts(TeamReviewStatus.parse({ ...status([]), handReview: [draft(3)] }))), null);
});


test('viewer thread sentences distinguish zero, partial, complete and singular tallies', () => {
  assert.equal(viewerThreadsText(undefined), null);
  assert.equal(viewerThreadsText({ total: 0, resolved: 0 }), null);
  assert.equal(viewerThreadsText({ total: 5, resolved: 2 }), '2 of 5 of your comments resolved');
  assert.equal(viewerThreadsText({ total: 5, resolved: 5 }), 'All 5 of your comments resolved');
  assert.equal(viewerThreadsText({ total: 1, resolved: 0 }), 'Your 1 comment unresolved');
  assert.equal(viewerThreadsText({ total: 1, resolved: 1 }), 'Your 1 comment resolved');
});

test('all viewer threads resolved needs review despite a current comment or teammate approval', () => {
  const reviewed = draft(1, { githubReviews: [
    { login: 'me', state: 'COMMENTED', commit: HEAD, isViewer: true },
    { login: 'teammate', state: 'APPROVED', commit: HEAD, isViewer: false },
  ] });
  for (const viewerThreads of [undefined, { total: 0, resolved: 0 }, { total: 5, resolved: 2 }]) {
    const sections = groupDrafts(status([{ ...reviewed, viewerThreads }]));
    assert.equal(sections.noReviewNeeded.length, 1);
    assert.equal(sections.ready.length, 0);
  }
  for (const draftStatus of ['ready', 'stale', 'error'] as const) {
    const review = { ...reviewed, status: draftStatus, viewerThreads: { total: 5, resolved: 5 } };
    const sections = groupDrafts(status([review]));
    assert.equal(isReviewNeeded(review), true);
    assert.equal(sections.noReviewNeeded.length, 0);
    assert.equal(sections.ready.length, draftStatus === 'ready' ? 1 : 0);
    assert.equal(sections.attention.length, draftStatus === 'ready' ? 0 : 1);
  }
});

test('standing approval settles resolved threads while answered threads still need review first', () => {
  const review = draft(1, { viewerThreads: { total: 5, resolved: 5 }, reviewDecision: 'APPROVED', githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true }] });
  assert.equal(isReviewNeeded(review), false);
  assert.equal(groupDrafts(status([review])).noReviewNeeded.length, 1);
  review.threads = answeredViewerThreads([threadNode()], [], HEAD);
  assert.equal(isReviewNeeded(review), true);
  assert.equal(groupDrafts(status([review])).ready.length, 1);
});

test('resolved thread glyph respects exceptions and hover and heading reflect counts', () => {
  const review = draft(1, { viewerThreads: { total: 5, resolved: 5 } });
  assert.deepEqual(queueRowGlyph(review, 'ready'), { meaning: 'Comments resolved', tone: 'warn' });
  assert.deepEqual(queueRowGlyph({ ...review, checksState: 'FAILURE' }, 'ready'), { meaning: 'Checks failing', tone: 'wait' });
  assert.deepEqual(queueRowGlyph({ ...review, isDraft: true }, 'ready'), { meaning: 'Draft', tone: 'wait' });
  assert.deepEqual(queueRowGlyph({ ...review, viewerThreads: { total: 5, resolved: 2 } }, 'ready'), { meaning: 'Waits on you', tone: 'warn' });
  assert.match(queueRowTitle(review, 'ready', {}), /All 5 of your comments resolved/);
  assert.notEqual(detailHeadingSignature(review), detailHeadingSignature({ ...review, viewerThreads: { total: 5, resolved: 2 } }));
});

test('a posted review whose comments are all resolved moves to Ready unless your approval stands', () => {
  const posted = draft(1, { status: 'posted', postedEvent: 'COMMENT', viewerThreads: { total: 3, resolved: 3 } });
  const sections = groupDrafts(status([posted]));
  assert.equal(sections.posted.length, 0);
  assert.deepEqual(sections.ready.map((review) => review.key), [posted.key]);
  assert.deepEqual(queueRowGlyph(posted, 'ready'), { meaning: 'Comments resolved', tone: 'warn' });
  assert.equal(groupDrafts(status([{ ...posted, viewerThreads: { total: 3, resolved: 1 } }])).posted.length, 1);
  const approved = { ...posted, reviewDecision: 'APPROVED' as const, githubReviews: [{ login: 'me', state: 'APPROVED' as const, commit: HEAD, isViewer: true }] };
  assert.equal(groupDrafts(status([approved])).posted.length, 1);
});

test('your approval at the current head settles resolved comments without a standing review decision', () => {
  const viewerApproval = { login: 'me', state: 'APPROVED' as const, commit: HEAD, isViewer: true };
  for (const reviewDecision of [null, 'REVIEW_REQUIRED'] as const) {
    const review = draft(1, { viewerThreads: { total: 5, resolved: 5 }, reviewDecision, githubReviews: [viewerApproval] });
    assert.equal(isReviewNeeded(review), false);
    assert.equal(groupDrafts(status([review])).noReviewNeeded.length, 1);
    assert.notDeepEqual(queueRowGlyph(review, 'ready'), { meaning: 'Comments resolved', tone: 'warn' });
    const posted = { ...review, status: 'posted' as const, postedEvent: 'APPROVE' as const };
    assert.equal(groupDrafts(status([posted])).posted.length, 1);
  }
});

test('your approval at an older commit leaves resolved comments waiting on you', () => {
  const review = draft(1, { viewerThreads: { total: 5, resolved: 5 }, reviewDecision: null, liveHead: NEXT_HEAD, githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true }] });
  assert.equal(isReviewNeeded(review), true);
  assert.equal(groupDrafts(status([review])).ready.length, 1);
  assert.deepEqual(queueRowGlyph(review, 'ready'), { meaning: 'Comments resolved', tone: 'warn' });
});


test('attention order contains selectable ready rows by priority followed by attention rows', () => {
  const sections = groupDrafts({ ...status([
    draft(1), draft(2, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }),
    draft(3, { status: 'error' }), draft(4, { status: 'posted' }), draft(5, { status: 'discarded' }),
  ], [inFlightReview(6)]), handReview: [draft(7)] });
  assert.deepEqual(attentionOrder(sections), ['Acme/app#2', 'Acme/app#1', 'Acme/app#3']);
});

test('next attention key follows the captured order despite current priority changes', () => {
  const capturedOrder = attentionOrder(groupDrafts(status([draft(1), draft(2), draft(3)])));
  const groups = groupDrafts(status([draft(3, { requestSource: 'direct', reviewDecision: 'REVIEW_REQUIRED' }), draft(2), draft(1)]));
  assert.equal(nextAttentionKey({ capturedOrder, actedKey: 'Acme/app#1', groups }), 'Acme/app#2');
});

test('next attention key skips reviews that are no longer actionable', () => {
  const capturedOrder = attentionOrder(groupDrafts(status([draft(1), draft(2), draft(3), draft(4), draft(5)])));
  const groups = groupDrafts(status([draft(1), draft(2, { status: 'posted' }), draft(3, { status: 'discarded' }), draft(5, { status: 'stale' })], [inFlightReview(4)]));
  assert.equal(nextAttentionKey({ capturedOrder, actedKey: 'Acme/app#1', groups }), 'Acme/app#5');
});

test('next attention key falls back to the first remaining captured key after the last review', () => {
  const capturedOrder = attentionOrder(groupDrafts(status([draft(1), draft(2), draft(3)])));
  const groups = groupDrafts(status([draft(2), draft(1), draft(3, { status: 'discarded' })]));
  assert.equal(nextAttentionKey({ capturedOrder, actedKey: 'Acme/app#3', groups }), 'Acme/app#1');
});

test('next attention key includes newly arrived attention when no captured key remains', () => {
  const groups = groupDrafts(status([draft(1, { status: 'posted' }), draft(2, { status: 'error' })]));
  assert.equal(nextAttentionKey({ capturedOrder: ['Acme/app#1'], actedKey: 'Acme/app#1', groups }), 'Acme/app#2');
});

test('next attention key excludes the acted review even before the status broadcast', () => {
  const groups = groupDrafts(status([draft(1)]));
  assert.equal(nextAttentionKey({ capturedOrder: ['Acme/app#1'], actedKey: 'Acme/app#1', groups }), null);
  assert.equal(nextAttentionKey({ capturedOrder: ['Acme/app#1'], actedKey: 'Acme/app#1', groups: groupDrafts(status([draft(1, { status: 'posted' })], [inFlightReview(2)])) }), null);
});

test('caught-up selection survives posted rows and background arrivals until a row is selected', () => {
  const groups = groupDrafts(status([draft(1, { status: 'posted' })]));
  assert.equal(chooseSelectedReviewKey(groups, null, true), null);
  assert.equal(chooseSelectedReviewKey(groups, null), 'Acme/app#1');
  const withArrival = groupDrafts(status([draft(2), draft(1, { status: 'posted' })]));
  assert.equal(chooseSelectedReviewKey(withArrival, null, true), null);
  assert.equal(chooseSelectedReviewKey(withArrival, 'Acme/app#2'), 'Acme/app#2');
});

test('caught-up selection prompts a pick when new attention arrives but ignores the acted review', () => {
  const pickPrompt = { title: 'New pull requests need you', detail: 'Pick one from the queue.' };
  assert.deepEqual(caughtUpSelectionView(groupDrafts(status([draft(1, { status: 'posted' }), draft(2)])), null), pickPrompt);
  assert.deepEqual(caughtUpSelectionView(groupDrafts(status([draft(2, { status: 'error' })])), null), pickPrompt);
  assert.deepEqual(caughtUpSelectionView(groupDrafts(status([draft(1)])), 'Acme/app#1'), { title: 'All caught up', detail: 'Nothing needs you right now.' });
});

test('caught-up selection names the pull requests left to review by hand', () => {
  const oneByHand = groupDrafts(TeamReviewStatus.parse({ ...status([draft(1, { status: 'posted' })]), handReview: [draft(3)] }));
  assert.deepEqual(caughtUpSelectionView(oneByHand, null), { title: 'Drafts all handled', detail: '1 pull request needs review by hand.' });
  const twoByHand = groupDrafts(TeamReviewStatus.parse({ ...status([]), handReview: [draft(3), draft(4)] }));
  assert.equal(caughtUpSelectionView(twoByHand, null).detail, '2 pull requests need review by hand.');
});

test('caught-up selection counts reviews still running when nothing needs the operator', () => {
  assert.deepEqual(caughtUpSelectionView(groupDrafts(status([], [inFlightReview(2)])), null), { title: 'All caught up', detail: 'Nothing needs you right now. 1 review is still running.' });
});

test('an ok action reply advances the selected review and names the outcome', () => {
  assert.deepEqual(planActionReply({ action: 'approve', pullRequest: 'Acme/app#1', warning: '', isActedSelected: true }), {
    statusText: 'Approved on GitHub', shouldAdvance: true, notice: { text: 'Acme/app#1: Approved on GitHub.', tone: 'ok' },
  });
  assert.equal(planActionReply({ action: 'requeue', pullRequest: 'Acme/app#1', warning: '', isActedSelected: true }).notice?.text, 'Acme/app#1: Queued. The next poll reviews it again.');
});

test('an ok action reply carrying a warning stays on the acted review and keeps the warning', () => {
  assert.deepEqual(planActionReply({ action: 'approve', pullRequest: 'Acme/app#1', warning: 'Check the approval on GitHub', isActedSelected: true }), {
    statusText: 'Approved on GitHub', shouldAdvance: false, notice: { text: 'Acme/app#1: Approved on GitHub. Check the approval on GitHub.', tone: 'error' },
  });
  assert.equal(planActionReply({ action: 'approve', pullRequest: 'Acme/app#1', warning: 'Check the approval on GitHub', isActedSelected: false }).notice?.tone, 'error');
});

test('an ok action reply for a review no longer selected neither advances nor raises a notice', () => {
  assert.deepEqual(planActionReply({ action: 'comment', pullRequest: 'Acme/app#1', warning: '  ', isActedSelected: false }), { statusText: 'Comment posted on GitHub', shouldAdvance: false, notice: null });
});
