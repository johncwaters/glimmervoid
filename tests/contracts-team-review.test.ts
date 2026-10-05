import test from 'node:test';
import assert from 'node:assert/strict';

import { DraftComment, PrDetail, ReviewAssessment, ReviewComment, ReviewDraft, ReviewResult, SearchedPr, TeamReviewActionRequest, TeamReviewStateEntry, TeamReviewStatus } from '../shared/contracts/team-review.ts';

const HEAD = 'a'.repeat(40);

test('team review status accepts an optional team profile', () => {
  const status = { type: 'team-review-status', ts: 1000, configured: true, drafts: [], inFlight: [] };
  assert.equal(TeamReviewStatus.parse(status).team, undefined);
  const team = { org: 'Acme', slug: 'core', name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' };
  assert.deepEqual(TeamReviewStatus.parse({ ...status, team }).team, team);
  assert.equal(TeamReviewStatus.parse({ ...status, team: null }).team, null);
  assert.equal(TeamReviewStatus.safeParse({ ...status, team: { ...team, name: 12 } }).success, false);
});

test('saved review entries accept both legacy state and a resumable session', () => {
  const oldEntry = { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1000 };
  const resumable = { sessionId: 'claude-1', workDir: '/work/review', worktreePath: '/work/tree', head: HEAD, deadlineAt: 9000, savedAt: 1000 };
  assert.deepEqual(TeamReviewStateEntry.parse(oldEntry), oldEntry);
  assert.deepEqual(TeamReviewStateEntry.parse({ ...oldEntry, resumable }), { ...oldEntry, resumable });
  assert.deepEqual(TeamReviewStateEntry.parse({ ...oldEntry, reviewedAt: 2000 }).reviewedAt, 2000);
  assert.equal(TeamReviewStateEntry.safeParse({ ...oldEntry, resumable: { ...resumable, sessionId: '' } }).success, false);
  assert.equal(TeamReviewStateEntry.safeParse({ ...oldEntry, resumable: { ...resumable, head: 'bad' } }).success, false);
});

test('saved review records parse with and without a remaining awake budget', () => {
  const oldEntry = { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1000 };
  const legacyResumable = { sessionId: 'claude-1', workDir: '/work/review', worktreePath: '/work/tree', head: HEAD, deadlineAt: 9000, savedAt: 1000 };
  const budgetedResumable = { ...legacyResumable, remainingAwakeMs: 120000 };
  assert.equal(TeamReviewStateEntry.parse({ ...oldEntry, resumable: legacyResumable }).resumable?.remainingAwakeMs, undefined);
  assert.equal(TeamReviewStateEntry.parse({ ...oldEntry, resumable: budgetedResumable }).resumable?.remainingAwakeMs, 120000);
  assert.equal(TeamReviewStateEntry.safeParse({ ...oldEntry, resumable: { ...legacyResumable, remainingAwakeMs: -1 } }).success, false);
});

test('search items require the fields needed to identify a PR while retaining GitHub fields', () => {
  const item = {
    number: 1350,
    title: 'Improve agent detection',
    html_url: 'https://github.com/PostHog/wizard/pull/1350',
    repository_url: 'https://api.github.com/repos/PostHog/wizard',
    user: { login: 'teammate', type: 'User', id: 7 },
    pull_request: { url: 'https://api.github.com/repos/PostHog/wizard/pulls/1350' },
    state: 'open',
    updated_at: '2026-09-25T00:00:00Z',
  };
  assert.deepEqual(SearchedPr.parse(item), item);
  for (const invalid of [
    { ...item, pull_request: undefined },
    { ...item, user: { login: 'teammate' } },
    { ...item, number: 0 },
    { ...item, draft: 'false' },
    { ...item, updated_at: 123 },
  ]) assert.equal(SearchedPr.safeParse(invalid).success, false);
});

test('PR detail requires the selected GitHub CLI fields', () => {
  const detail = {
    number: 1350, title: 'Improve agent detection', body: 'Description',
    url: 'https://github.com/PostHog/wizard/pull/1350',
    author: { login: 'teammate', is_bot: false }, isDraft: false, isCrossRepository: false,
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefOid: HEAD,
    additions: 2, deletions: 1, files: [{ path: 'src/agent/index.ts', additions: 2, deletions: 1 }],
  };
  assert.deepEqual(PrDetail.parse(detail), detail);
  assert.equal(PrDetail.safeParse({ ...detail, files: [{ path: 'src/agent/index.ts', additions: -1, deletions: 1 }] }).success, false);
});

test('review comments default to the new side and require a positive line', () => {
  assert.deepEqual(ReviewComment.parse({ path: 'src/agent/index.ts', line: 4, body: 'Check this' }), {
    path: 'src/agent/index.ts', line: 4, side: 'RIGHT', body: 'Check this',
  });
  for (const line of [0, -1, 1.5]) {
    assert.equal(ReviewComment.safeParse({ path: 'src/agent/index.ts', line, body: 'Check this' }).success, false);
  }
  assert.equal(ReviewComment.safeParse({ path: 'src/agent/index.ts', line: 4, side: 'CENTER', body: 'Check this' }).success, false);
});

test('draft comments accept optional severity while action comments omit it', () => {
  const comment = { path: 'src/a.ts', line: 4, side: 'RIGHT', body: 'Check this' };
  assert.deepEqual(DraftComment.parse(comment), comment);
  assert.deepEqual(DraftComment.parse({ ...comment, severity: 'HIGH' }), { ...comment, severity: 'HIGH' });
  assert.equal(DraftComment.safeParse({ ...comment, severity: 'UNKNOWN' }).success, false);
  const action = TeamReviewActionRequest.parse({ key: 'Acme/app#1', head: HEAD, action: 'comment', body: '', comments: [{ ...comment, severity: 'HIGH' }] });
  assert.deepEqual(action.comments, [comment]);
});

test('approve-only is accepted by the action request contract', () => {
  const request = { key: 'Acme/app#1', head: HEAD, action: 'approve-only', body: '', comments: [] };
  assert.deepEqual(TeamReviewActionRequest.parse(request), request);
});

test('review result accepts code-review verdicts, typed findings and an exact lowercase commit SHA', () => {
  const finding = { path: 'src/a.ts', line: 4, side: 'RIGHT', severity: 'HIGH', reviewer: 'code/logic', disposition: 'ACTIONABLE', body: 'Off by one' };
  const result = { verdict: 'APPROVE WITH NITS', head: HEAD, summary: 'Spot checked', assessment: null, findings: [finding, { ...finding, line: null, disposition: null }] };
  assert.deepEqual(ReviewResult.parse(result), result);
  for (const invalid of [
    { ...result, head: 'abc123' },
    { ...result, head: HEAD.toUpperCase() },
    { ...result, verdict: 'STAMP' },
    { ...result, verdict: 'FAILED' },
    { ...result, findings: [{ ...finding, severity: 'NIT' }] },
    { ...result, findings: [{ ...finding, line: 0 }] },
  ]) assert.equal(ReviewResult.safeParse(invalid).success, false);
});

test('editable review draft requires a repository, tier, status, and reviewed head', () => {
  const draft = {
    key: 'PostHog/wizard#1350', repo: 'PostHog/wizard', number: 1350,
    title: 'Improve agent detection', url: 'https://github.com/PostHog/wizard/pull/1350',
    author: 'teammate', tier: 'full', reasons: ['252 counted lines over 200'],
    reviewedHead: HEAD, verdict: 'APPROVE WITH NITS', summary: 'Check branch', body: 'A draft review',
    comments: [{ path: 'src/agent/index.ts', line: 4, side: 'RIGHT', body: 'Check this' }],
    status: 'ready',
  };
  assert.deepEqual(ReviewDraft.parse(draft), { ...draft, requestSource: 'team' });
  assert.deepEqual(ReviewDraft.parse({ ...draft, comments: [{ ...draft.comments[0], severity: 'CRITICAL' }] }).comments, [{ ...draft.comments[0], severity: 'CRITICAL' }]);
  const storedEntry = { draft, reviewedHead: HEAD, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: 1000 };
  assert.deepEqual(TeamReviewStateEntry.parse(storedEntry).draft?.comments, draft.comments);
  for (const invalid of [
    { ...draft, repo: 'wizard' },
    { ...draft, tier: 'skip' },
    { ...draft, reviewedHead: 'abc123' },
    { ...draft, status: 'pending' },
  ]) assert.equal(ReviewDraft.safeParse(invalid).success, false);
});

test('an old assessment without a goal parses with an empty goal', () => {
  const oldAssessment = { change: 'Re-arm the timer.', checked: ['Old timer cleared.'], gaps: [] };
  assert.deepEqual(ReviewAssessment.parse(oldAssessment), { goal: '', ...oldAssessment });
});

test('request source and priority fields round trip through the review wire and fail closed', () => {
  const review = {
    key: 'Acme/app#1', repo: 'Acme/app', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1', author: 'teammate',
    requestSource: 'direct', isDraft: false, checksState: 'FAILURE', reviewDecision: 'REVIEW_REQUIRED',
  };
  const report = { type: 'team-review-status', ts: 1, configured: true, drafts: [], inFlight: [], queued: [review] };
  assert.deepEqual(TeamReviewStatus.parse(report).queued[0], review);
  assert.equal(TeamReviewStatus.safeParse({ ...report, queued: [{ ...review, requestSource: 'unknown' }] }).success, false);
  assert.equal(TeamReviewStatus.safeParse({ ...report, queued: [{ ...review, checksState: 'unknown' }] }).success, false);
  assert.equal(TeamReviewStatus.safeParse({ ...report, queued: [{ ...review, isDraft: 'true' }] }).success, false);
});


test('hand review contracts parse new fields and default legacy status to no hand reviews', () => {
  const handReview = { key: 'Acme/app#1', repo: 'Acme/app', number: 1, title: 'Fork change', url: 'https://github.com/Acme/app/pull/1', author: 'contributor', requestSource: 'team' };
  const entry = { draft: null, reviewedHead: HEAD, inFlight: false, skipReason: 'fork', reviewAttempts: 0, updatedAt: 1000 };
  assert.deepEqual(TeamReviewStateEntry.parse({ ...entry, handReview }).handReview, handReview);
  assert.equal(TeamReviewStateEntry.parse(entry).handReview, undefined);
  const snapshot = { type: 'team-review-status', ts: 1000, configured: true, drafts: [], inFlight: [] };
  assert.deepEqual(TeamReviewStatus.parse({ ...snapshot, handReview: [handReview] }).handReview, [handReview]);
  assert.deepEqual(TeamReviewStatus.parse(snapshot).handReview, []);
});
