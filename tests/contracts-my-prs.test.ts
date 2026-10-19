import test from 'node:test';
import assert from 'node:assert/strict';
import { MyPr, MyPrKeepMergeableRequest, MyPrMergeabilityFixResult, MyPrMergeWhenReadyRequest, MyPrSearchNode, MyPrSearchResponse, MyPrsState, MyPrsStatus } from '../shared/contracts/my-prs.ts';
import { ClientMessage, ServerMessage, SERVER_MESSAGE_TYPES } from '../shared/contracts/control-messages.ts';
import { GithubPr, GithubPrsFrame } from '../shared/contracts/github-prs.ts';

test('keep mergeable state and control boundaries reject malformed flags and head attempts', () => {
  const state = { keepMergeableKeys: ['Acme/app#7'], keepMergeableAttemptKeys: [`Acme/app#7@${'a'.repeat(40)}`], mergeQueueKeys: [], keepMergeablePushedHeadKeys: [], keepMergeableAttempts: [] };
  assert.deepEqual(MyPrsState.parse(state), state);
  assert.deepEqual(MyPrsState.parse({ keepMergeableKeys: [], keepMergeableAttemptKeys: [] }), { keepMergeableKeys: [], keepMergeableAttemptKeys: [], mergeQueueKeys: [], keepMergeablePushedHeadKeys: [], keepMergeableAttempts: [] });
  for (const raw of [{}, { ...state, extra: true }, { ...state, keepMergeableKeys: ['app#7'] }, { ...state, keepMergeableKeys: ['Acme/app#0'] }, { ...state, keepMergeableAttemptKeys: ['Acme/app#7@bad'] }, { ...state, keepMergeableAttemptKeys: [`Acme/app#7@${'A'.repeat(40)}`] }, { ...state, keepMergeableAttemptKeys: [`Acme/app#0@${'a'.repeat(40)}`] }, { ...state, keepMergeableAttemptKeys: [`app#7@${'a'.repeat(40)}`] }, { ...state, keepMergeableKeys: 'Acme/app#7' }, { ...state, mergeQueueKeys: ['app#7'] }, { ...state, mergeQueueKeys: 'Acme/app#7' }, { ...state, keepMergeablePushedHeadKeys: ['Acme/app#7@bad'] }]) {
    assert.equal(MyPrsState.safeParse(raw).success, false);
  }
  const request = { type: 'my-pr-keep-mergeable', requestId: 'toggle-1', repo: 'Acme/app', number: 7, keepMergeable: true };
  assert.equal(ClientMessage.safeParse(request).success, true);
  assert.equal(MyPrKeepMergeableRequest.safeParse({ ...request, keepMergeable: 'true' }).success, false);
  assert.equal(ClientMessage.safeParse({ ...request, keepMergeable: undefined }).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'my-pr-keep-mergeable-result', requestId: 'toggle-1', key: 'Acme/app#7', ok: true }).success, true);
});

test('merge when ready control boundaries accept a boolean toggle and its result only', () => {
  const request = { type: 'my-pr-merge-when-ready', requestId: 'queue-1', repo: 'Acme/app', number: 7, mergeWhenReady: true };
  assert.equal(ClientMessage.safeParse(request).success, true);
  assert.equal(MyPrMergeWhenReadyRequest.safeParse({ ...request, mergeWhenReady: 'true' }).success, false);
  assert.equal(ClientMessage.safeParse({ ...request, mergeWhenReady: undefined }).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'my-pr-merge-when-ready-result', requestId: 'queue-1', key: 'Acme/app#7', ok: false, error: 'nope' }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'my-pr-merge-when-ready-result', requestId: 'queue-1', key: 'Acme/app#7', ok: 'yes' }).success, false);
});

test('my PR contracts reject malformed reports and register the control message', () => {
  const status = { type: 'my-prs-status', ts: 1, configured: false, viewer: null, prs: [], error: null };
  assert.deepEqual(MyPrsStatus.parse(status), status);
  assert.equal(ServerMessage.safeParse(status).success, true);
  assert.equal(SERVER_MESSAGE_TYPES.includes('my-prs-status'), true);
  assert.equal(MyPrsStatus.safeParse({ ...status, prs: [{}] }).success, false);
  assert.equal(MyPrSearchResponse.safeParse({ data: { open: { issueCount: 0, nodes: [] }, merged: { issueCount: 0, nodes: [] } } }).success, true);
  assert.equal(MyPrSearchResponse.safeParse({ data: { open: { nodes: [] }, merged: { nodes: [] } } }).success, false);
  assert.equal(MyPrsStatus.safeParse({ ...status, truncatedNote: 'Showing the 50 most recently updated of 73 pull requests.' }).success, true);
  assert.equal(MyPrSearchNode.safeParse({ number: 1 }).success, false);
  assert.equal(MyPr.safeParse({ key: 'wrong' }).success, false);
});

test('my PR contract parses requested reviewers with avatar metadata', () => {
  const pr = {
    key: 'Acme/app#1', repo: 'Acme/app', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1',
    isDraft: false, state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z',
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', isCrossRepository: false, headRefOid: 'a'.repeat(40), isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    checks: { state: null, failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], behindBy: 0,
    reviewRequests: [{ name: 'Acme/docs', isTeam: true, avatarUrl: 'https://github.com/Acme.png' }, { name: 'ana', isTeam: false, avatarUrl: null }],
    approvals: 0, reviews: [], stage: 'ready',
  };
  const entry = {
    key: pr.key, autoRebase: { outcome: 'failed', at: 1, message: 'Could not rebase' }, keepMergeable: true,
    keepMergeableAttempt: { outcome: 'pushed', at: 2 }, isKeepMergeableFixInFlight: false,
    mergeQueuePosition: 1, isMergeQueueHeldForRepairPush: false, mergeQueueFailure: { at: 3, message: 'Merge refused' },
  };
  const status = { type: 'my-prs-status', ts: 1, configured: true, viewer: 'alice', prs: [entry] };
  assert.deepEqual(MyPrsStatus.parse(status), status);
  assert.deepEqual(MyPrsStatus.parse({ ...status, prs: [{ key: pr.key }] }).prs, [{ key: pr.key }]);
  for (const invalidEntry of [pr, {}, { ...entry, key: 'app#1' }, { ...entry, key: 'Acme/app#0' }, { ...entry, extra: true }, { ...entry, stage: 'ready' }, { ...entry, keepMergeable: 'true' }, { ...entry, mergeQueuePosition: 0 }, { ...entry, keepMergeableAttempt: { outcome: 'invalid', at: 2 } }]) {
    assert.equal(MyPrsStatus.safeParse({ ...status, prs: [invalidEntry] }).success, false);
    assert.equal(ServerMessage.safeParse({ ...status, prs: [invalidEntry] }).success, false);
  }
  assert.equal(MyPr.parse(pr).baseRefOid, 'b'.repeat(40));
  assert.equal(MyPr.safeParse({ ...pr, baseRefOid: undefined }).success, false);
  assert.equal(MyPr.safeParse({ ...pr, baseRefOid: 'bad' }).success, false);
  assert.equal(MyPr.parse(pr).headRefName, 'feature');
  assert.equal(MyPr.safeParse({ ...pr, headRefName: undefined }).success, false);
  assert.equal(MyPr.safeParse({ ...pr, headRefName: '' }).success, false);
  assert.deepEqual(MyPr.parse(pr).reviewRequests, pr.reviewRequests);
  assert.equal(MyPr.safeParse({ ...pr, reviewRequests: ['Acme/docs'] }).success, false);
  assert.equal(MyPr.safeParse({ ...pr, reviewRequests: [{ name: 'ana', isTeam: false }] }).success, false);
});

test('keep mergeable attempts migrate old state and reject malformed persisted outcomes and commit shas', () => {
  const legacyState = { keepMergeableKeys: ['Acme/app#7'], keepMergeableAttemptKeys: [`Acme/app#7@${'a'.repeat(40)}`] };
  const attempt = { key: 'Acme/app#7', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), outcome: 'failed', reason: 'Could not fetch the base', at: 1234 };
  const migrated = MyPrsState.parse(legacyState);
  assert.deepEqual(migrated.keepMergeableAttempts, []);
  const state = { ...migrated, keepMergeableAttempts: [attempt] };
  assert.deepEqual(MyPrsState.parse(state), state);
  for (const overrides of [{ key: 'bad' }, { headRefOid: 'bad' }, { baseRefOid: undefined }, { baseRefOid: 'bad' }, { outcome: 'finished' }, { at: Infinity }, { at: '1234' }, { reason: '' }, { extra: true }]) {
    assert.equal(MyPrsState.safeParse({ ...state, keepMergeableAttempts: [{ ...attempt, ...overrides }] }).success, false);
  }
  assert.equal(MyPrMergeabilityFixResult.safeParse({ outcome: 'pushed' }).success, true);
  for (const outcome of ['failed', 'no-change', 'stopped', 'timed-out']) {
    assert.equal(MyPrMergeabilityFixResult.safeParse({ outcome, reason: 'Repair did not finish' }).success, true);
    assert.equal(MyPrMergeabilityFixResult.safeParse({ outcome }).success, false);
  }
});

test('canonical GitHub PR frames fail closed on malformed snapshots and PR fields', () => {
  const pr = {
    key: 'acme/app#7', id: 'PR_node', repo: 'Acme/app', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7',
    author: 'alice', labels: ['bug'], commentCount: 3,
    isDraft: false, state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z',
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', headRefOid: 'a'.repeat(40),
    isCrossRepository: false, isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: null, checks: { state: 'SUCCESS', failing: [], pendingCount: 0 }, rollupState: 'SUCCESS',
    unresolvedThreads: 0, threads: [], behindBy: null,
    reviewRequests: [{ name: 'Acme/docs', isTeam: true, avatarUrl: null }], approvals: 0, reviews: [],
  };
  const frame = { type: 'github-prs', ts: 1234, prs: { [pr.key]: pr }, freshness: { lastRefreshedAt: 1234, error: null } };
  assert.deepEqual(GithubPr.parse(pr), pr);
  assert.deepEqual(GithubPrsFrame.parse(frame), frame);
  assert.equal(GithubPrsFrame.safeParse({ ...frame, prs: {}, freshness: { lastRefreshedAt: null, error: 'Refresh failed' } }).success, true);
  for (const overrides of [
    { key: 'Acme/app#7' }, { key: 'acme/app#8' }, { repo: 'app' }, { number: 0 }, { headRefOid: 'bad' },
    { id: undefined }, { author: undefined }, { labels: [7] }, { commentCount: -1 }, { state: 'UNKNOWN' },
    { reviewDecision: 'READY' }, { checks: { state: 'UNKNOWN', failing: [], pendingCount: 0 } },
    { checks: { state: null, failing: [], pendingCount: -1 } }, { checks: { ...pr.checks, extra: true } },
    { reviewRequests: [{ name: 'Acme/docs', isTeam: true }] }, { reviewRequests: [{ ...pr.reviewRequests[0], extra: true }] },
    { keepMergeable: true }, { extra: true },
  ]) {
    const malformedPr = { ...pr, ...overrides };
    assert.equal(GithubPr.safeParse(malformedPr).success, false);
    assert.equal(GithubPrsFrame.safeParse({ ...frame, prs: { [pr.key]: malformedPr } }).success, false);
  }
  for (const overrides of [
    { type: 'my-prs-status' }, { ts: Infinity }, { ts: '1234' }, { prs: [] }, { prs: { 'acme/app#8': pr } },
    { prs: { 'Acme/app#7': pr } }, { freshness: undefined }, { freshness: { lastRefreshedAt: 1234 } },
    { freshness: { lastRefreshedAt: -1, error: null } }, { freshness: { lastRefreshedAt: Infinity, error: null } },
    { freshness: { lastRefreshedAt: null, error: 7 } }, { freshness: { ...frame.freshness, extra: true } },
  ]) {
    assert.equal(GithubPrsFrame.safeParse({ ...frame, ...overrides }).success, false);
  }
});
