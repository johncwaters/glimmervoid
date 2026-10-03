import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aboutPrParagraphs, isReviewNeeded, actionLabel, actionOutcomeText, actionProgressText, attentionDetail, attentionStatusLabel, buildActionRequest, withReviewerNote, chooseSelectedReviewKey, commentLocation, shortCommentLocation, emptyStateText, githubReviewItems, githubReviewTitle, githubReviewTone, groupDrafts, hasAnyRow, inFlightElapsedText, inFlightProgressText, isInFlightProgressOnlyChange,
  parseInlineSegments, parseReviewComment, reviewCommentPreview, phaseLabel, pullRequestLabel, queueRowStateLabel, queueRowTitle, queueRowTone, readyAttentionSignature, readyRowSignature, detailHeadingSignature, reviewProgressSteps,
  commentSeverity, severityCounts, severityPresentation, tierLabel, verdictLabel, verdictSealKind, verdictTone, withoutComment, LEGACY_SUMMARY_HINT, hasRequeueFooter, detailActionLayout, isIncludedByDefault, detailMetaText, viewerApprovalContext, viewerApprovalNotice, reviewScopeTitle, coverageSummaryText, coverageDisclosureHeading, queuedDetailText,
} from '../public/team-review-view-core.ts';
import { InFlightReview, ReviewDraft, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type {
  InFlightReview as InFlightReviewType, ReviewDraft as ReviewDraftType, TeamReviewStatus as TeamReviewStatusType,
} from '../shared/contracts/team-review.ts';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

function githubReviewTexts(review: ReviewDraft, options: { isViewerShown?: boolean } = {}): string {
  return githubReviewItems(review, options).map((item) => item.text).join(', ');
}

test('queue row tones distinguish pending, settled and failed reviews', () => {
  assert.equal(queueRowTone('ready', 'ready'), 'warn');
  assert.equal(queueRowTone('settled', 'ready'), 'ok');
  assert.equal(queueRowTone('inReview', null), 'wait');
  assert.equal(queueRowTone('attention', 'error'), 'danger');
  assert.equal(queueRowTone('attention', 'stale'), 'warn');
  assert.equal(queueRowTone('posted', 'posted'), 'muted');
  assert.equal(queueRowTone('discarded', 'discarded'), 'muted');
});

test('queue row state labels name each kind and defer attention to its status', () => {
  assert.equal(queueRowStateLabel('ready', 'ready'), 'Ready');
  assert.equal(queueRowStateLabel('settled', 'ready'), 'No review needed');
  assert.equal(queueRowStateLabel('inReview', null), 'In review');
  assert.equal(queueRowStateLabel('attention', 'stale'), attentionStatusLabel('stale'));
  assert.equal(queueRowStateLabel('attention', 'error'), attentionStatusLabel('error'));
  assert.equal(queueRowStateLabel('attention', null), 'Needs attention');
  assert.equal(queueRowStateLabel('posted', 'posted'), 'Posted');
  assert.equal(queueRowStateLabel('discarded', 'discarded'), 'Discarded');
});

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
    'Acme/app#7: PR 7', 'Posted', 'Opened 5d ago', 'Reviewed 1d ago', 'Posted 3h ago', 'approved by sarah, 2d ago',
  ].join('\n'));
});

test('queue row title names an in-progress review and a queued pull request', () => {
  assert.equal(queueRowTitle(inFlightReview(8), 'inReview', { opened: '2d ago' }), 'Acme/app#8: PR 8\nIn review\nOpened 2d ago');
  const queuedReview = TeamReviewStatus.parse({
    type: 'team-review-status', ts: 1, configured: true, reason: null, drafts: [], inFlight: [],
    queued: [{ key: 'Acme/app#9', repo: 'Acme/app', number: 9, title: 'PR 9', url: 'https://github.com/Acme/app/pull/9', author: 'teammate' }],
  }).queued[0];
  assert.ok(queuedReview);
  assert.equal(queueRowTitle(queuedReview, 'queued', { opened: '4h ago' }), 'Acme/app#9: PR 9\nQueued\nOpened 4h ago');
});

test('queue row title retains the attention reason', () => {
  assert.equal(queueRowTitle(draft(10, { status: 'error', error: 'review timed out' }), 'attention', { opened: '5d ago' }),
    'Acme/app#10: PR 10\nerror\nOpened 5d ago\nreview timed out');
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

test('a stale draft the operator reviewed at the live head leaves Needs attention, an error draft stays', () => {
  const liveHead = 'c'.repeat(40);
  const reviewedAtLiveHead = [{ login: 'me', state: 'COMMENTED' as const, commit: liveHead, isViewer: true }];
  const sections = groupDrafts(status([
    draft(1, { status: 'stale', liveHead, githubReviews: reviewedAtLiveHead }),
    draft(2, { status: 'stale', liveHead, githubReviews: [{ login: 'me', state: 'APPROVED', commit: HEAD, isViewer: true }] }),
    draft(3, { status: 'error', error: 'timed out', liveHead, githubReviews: reviewedAtLiveHead }),
    draft(4, { liveHead, githubReviews: [{ login: 'sarah', state: 'APPROVED', commit: HEAD, isViewer: false }] }),
  ]));
  assert.deepEqual(sections.noReviewNeeded.map((row) => row.number), [1]);
  assert.deepEqual(sections.attention.map((row) => row.number), [2, 3]);
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

test('progress text never counts below zero once the deadline passes', () => {
  const overdue = inFlightReview(1, { phase: 'reviewing', startedAt: 0, deadlineAt: 1000, toolCalls: 0 });
  assert.equal(inFlightProgressText(overdue, 5000), '0:05 elapsed, times out in 0:00, 0 tool calls');
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

test('severity totals include folded body findings and every inline comment header', () => {
  const review = draft(1, {
    body: '**[body] HIGH**\n\nFirst.\n\n- **[folded] MEDIUM** `src/a.ts:3`: second.',
    comments: [
      { path: 'src/a.ts', line: 4, side: 'RIGHT', body: '> [!NOTE]\n> Automated review. Not written by a human.\n\n**[logic] HIGH**\n\nThird.' },
      { path: 'src/b.ts', line: 5, side: 'LEFT', body: '**[security] CRITICAL**\n\nFourth.' },
    ],
  });
  assert.deepEqual(severityCounts(review), [
    { severity: 'CRITICAL', count: 1 }, { severity: 'HIGH', count: 2 }, { severity: 'MEDIUM', count: 1 },
  ]);
  assert.deepEqual(severityCounts(draft(2)), []);
});

test('severity totals count finding headers when present and fall back to structured comment severity', () => {
  const review = draft(1, {
    body: '**[body] LOW**\n\nBody finding.',
    comments: [
      { path: 'src/a.ts', line: 4, side: 'RIGHT', severity: 'CRITICAL', body: '**[old] HIGH**\n\nHeader wins.' },
      { path: 'src/a.ts', line: 5, side: 'RIGHT', body: '**[legacy] MEDIUM**\n\nLegacy finding.' },
      { path: 'src/a.ts', line: 6, side: 'RIGHT', severity: 'CRITICAL', body: 'Bare posting plan comment.' },
    ],
  });
  assert.deepEqual(severityCounts(review), [
    { severity: 'CRITICAL', count: 1 }, { severity: 'HIGH', count: 1 }, { severity: 'MEDIUM', count: 1 }, { severity: 'LOW', count: 1 },
  ]);
});

test('severity totals count every finding header in a merged comment even when it carries a structured severity', () => {
  const review = draft(1, {
    body: '',
    comments: [{ path: 'src/a.ts', line: 4, side: 'RIGHT', severity: 'HIGH', body: '**[logic] HIGH**\n\nFirst.\n\n**[security] MEDIUM**\n\nSecond.' }],
  });
  assert.deepEqual(severityCounts(review), [{ severity: 'HIGH', count: 1 }, { severity: 'MEDIUM', count: 1 }]);
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
    queued: [{ key: 'Acme/app#7', repo: 'Acme/app', number: 7, title: 'PR 7', url: 'https://github.com/Acme/app/pull/7', author: 'teammate' }],
  });
  const sections = groupDrafts(status);
  assert.deepEqual(sections.queued.map((review) => review.key), ['Acme/app#7']);
  assert.equal(sections.attention.length, 0);
  assert.equal(hasAnyRow(sections), true);
  assert.equal(queueRowStateLabel('queued', null), 'Queued');
});

test('the queued detail says what the pull request is waiting for', () => {
  assert.match(queuedDetailText(0), /next poll/);
  assert.match(queuedDetailText(1), /as soon as the review in progress finishes/);
  assert.match(queuedDetailText(2), /one of the 2 reviews in progress/);
});

test('a change to the queued list is never treated as progress only', () => {
  const before = status([draft(1)], [inFlightReview(2)]);
  const queuedItem = { key: 'Acme/app#3', repo: 'Acme/app', number: 3, title: 'PR 3', url: 'https://github.com/Acme/app/pull/3', author: 'teammate' };
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
  assert.equal(queueRowTitle(draft(1, { assessment }), 'ready', { opened: '1d ago' }), 'Acme/app#1: PR 1\nAvoid stuck requests.\nReady\nOpened 1d ago');
  assert.equal(queueRowTitle(draft(1, { assessment: { ...assessment, goal: ' ' } }), 'ready', {}), 'Acme/app#1: PR 1\nReady');
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
