import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionOutcomeText, actionProgressText, attentionDetail, attentionStatusLabel, buildActionRequest, withReviewerNote, chooseSelectedReviewKey, commentLocation, emptyStateText, githubReviewItems, githubReviewTitle, githubReviewTone, groupDrafts, hasAnyRow, inFlightElapsedText, inFlightProgressText, isInFlightProgressOnlyChange,
  parseReviewComment, phaseLabel, pullRequestLabel, queueRowStateLabel, queueRowTone, readyAttentionSignature, readyRowSignature, detailHeadingSignature, reviewFooterText, reviewProgressSteps,
  severityCounts, severityPresentation, tierLabel, verdictLabel, verdictRecommendation, verdictSealKind, verdictSealText, verdictTone, withoutComment, LEGACY_SUMMARY_HINT, hasRequeueFooter, reviewScopeText, queuedDetailText,
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

test('an unposted verdict reads as the review suggestion, never as an action already taken', () => {
  assert.equal(verdictRecommendation('APPROVE'), 'suggests approve');
  assert.equal(verdictRecommendation('APPROVE WITH NITS'), 'suggests approve with nits');
  assert.equal(verdictRecommendation('REQUEST CHANGES'), 'suggests changes');
  assert.equal(verdictRecommendation('BLOCKED'), 'review blocked');
});

test('the verdict seal reads as a suggestion until the review is posted', () => {
  assert.equal(verdictSealText({ verdict: 'APPROVE', status: 'ready' }), 'suggests approve');
  assert.equal(verdictSealText({ verdict: 'REQUEST CHANGES', status: 'stale' }), 'suggests changes');
  assert.equal(verdictSealText({ verdict: 'APPROVE', status: 'posted' }), 'approve');
  assert.equal(verdictSealText({ verdict: 'REQUEST CHANGES', status: 'posted' }), 'request changes');
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

test('the reviewer note posts above the automated-review note, and a blank note leaves the body untouched', () => {
  const reviewBody = '> [!NOTE]\n> Automated review. Not written by a human.\n\nSummary.';
  assert.equal(withReviewerNote('  Code review focused. Trying it out later.\n', reviewBody), `Code review focused. Trying it out later.\n\n${reviewBody}`);
  assert.equal(withReviewerNote('First.\n\nSecond.', reviewBody), `First.\n\nSecond.\n\n${reviewBody}`);
  assert.equal(withReviewerNote(' \n ', reviewBody), reviewBody);
  assert.equal(withReviewerNote('Only mine.', '  '), 'Only mine.');
});

test('queue review sends an empty action payload and has stable progress and outcome text', () => {
  assert.deepEqual(buildActionRequest(draft(1, { status: 'error' }), 'requeue', '', []), {
    key: 'Acme/app#1', head: HEAD, action: 'requeue', body: '', comments: [],
  });
  assert.equal(actionProgressText('requeue'), 'Queueing the review');
  assert.equal(actionOutcomeText('requeue'), 'Queued. The next poll reviews it again.');
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

test('comment parsing removes the posted note and heading while keeping paragraphs and inline code', () => {
  const parsed = parseReviewComment('> [!NOTE]\n> Automated review. Not written by a human.\n\n**[code/logic] HIGH**\n\nFirst `value` stays.\n\nSuggested fix: update `count` here.\n\nOpen question. Does `mode` matter?');
  assert.equal(parsed.tag, 'code/logic');
  assert.equal(parsed.severity, 'HIGH');
  assert.deepEqual(parsed.paragraphs, [
    { lead: '', leadKind: null, segments: [{ text: 'First ', isCode: false }, { text: 'value', isCode: true }, { text: ' stays.', isCode: false }] },
    { lead: 'Suggested fix:', leadKind: 'fix', segments: [{ text: 'update ', isCode: false }, { text: 'count', isCode: true }, { text: ' here.', isCode: false }] },
    { lead: 'Open question.', leadKind: 'question', segments: [{ text: 'Does ', isCode: false }, { text: 'mode', isCode: true }, { text: ' matter?', isCode: false }] },
  ]);
});

test('comment parsing accepts fix and open question variants and plain comments', () => {
  assert.deepEqual(parseReviewComment('Fix: Use a guard.').paragraphs[0], { lead: 'Fix:', leadKind: 'fix', segments: [{ text: 'Use a guard.', isCode: false }] });
  assert.deepEqual(parseReviewComment('Open question, should this retry?').paragraphs[0], { lead: 'Open question,', leadKind: 'question', segments: [{ text: 'should this retry?', isCode: false }] });
  assert.deepEqual(parseReviewComment('Open question: is this intended?').paragraphs[0], { lead: 'Open question:', leadKind: 'question', segments: [{ text: 'is this intended?', isCode: false }] });
  assert.equal(parseReviewComment('Plain comment').severity, null);
});

test('footer names the reviewed head and current included comment count', () => {
  assert.equal(reviewFooterText(HEAD, 0), 'Posts 1 review on aaaaaaa: the body plus 0 inline comments');
  assert.equal(reviewFooterText(HEAD, 1), 'Posts 1 review on aaaaaaa: the body plus 1 inline comment');
  assert.equal(reviewFooterText(HEAD, 2), 'Posts 1 review on aaaaaaa: the body plus 2 inline comments');
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

test('the review scope names a re-review and the head it picks up from', () => {
  assert.equal(reviewScopeText({ tier: 'full', reasons: ['touches auth'] }), 'full review: touches auth');
  assert.equal(reviewScopeText({ tier: 'stamp', reasons: [], priorReviewedHead: 'abcdef0123456789abcdef0123456789abcdef01' }), 'light re-review of changes since abcdef0');
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
