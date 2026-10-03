import test from 'node:test';
import assert from 'node:assert/strict';
import { MyPr, MyPrKeepMergeableRequest, MyPrSearchNode, MyPrSearchResponse, MyPrsState, MyPrsStatus } from '../shared/contracts/my-prs.ts';
import { ClientMessage, ServerMessage, SERVER_MESSAGE_TYPES } from '../shared/contracts/control-messages.ts';

test('keep mergeable state and control boundaries reject malformed flags and head attempts', () => {
  const state = { keepMergeableKeys: ['Acme/app#7'], keepMergeableAttemptKeys: [`Acme/app#7@${'a'.repeat(40)}`] };
  assert.deepEqual(MyPrsState.parse(state), state);
  for (const raw of [{}, { ...state, extra: true }, { ...state, keepMergeableKeys: ['app#7'] }, { ...state, keepMergeableKeys: ['Acme/app#0'] }, { ...state, keepMergeableAttemptKeys: ['Acme/app#7@bad'] }, { ...state, keepMergeableAttemptKeys: [`Acme/app#7@${'A'.repeat(40)}`] }, { ...state, keepMergeableAttemptKeys: [`Acme/app#0@${'a'.repeat(40)}`] }, { ...state, keepMergeableAttemptKeys: [`app#7@${'a'.repeat(40)}`] }, { ...state, keepMergeableKeys: 'Acme/app#7' }]) {
    assert.equal(MyPrsState.safeParse(raw).success, false);
  }
  const request = { type: 'my-pr-keep-mergeable', requestId: 'toggle-1', repo: 'Acme/app', number: 7, keepMergeable: true };
  assert.equal(ClientMessage.safeParse(request).success, true);
  assert.equal(MyPrKeepMergeableRequest.safeParse({ ...request, keepMergeable: 'true' }).success, false);
  assert.equal(ClientMessage.safeParse({ ...request, keepMergeable: undefined }).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'my-pr-keep-mergeable-result', requestId: 'toggle-1', key: 'Acme/app#7', ok: true }).success, true);
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
    baseRefName: 'main', headRefName: 'feature', isCrossRepository: false, headRefOid: 'a'.repeat(40), isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    checks: { state: null, failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], behindBy: 0,
    reviewRequests: [{ name: 'Acme/docs', isTeam: true, avatarUrl: 'https://github.com/Acme.png' }, { name: 'ana', isTeam: false, avatarUrl: null }],
    approvals: 0, reviews: [], stage: 'ready',
  };
  assert.equal(MyPr.parse(pr).headRefName, 'feature');
  assert.equal(MyPr.safeParse({ ...pr, headRefName: undefined }).success, false);
  assert.equal(MyPr.safeParse({ ...pr, headRefName: '' }).success, false);
  assert.deepEqual(MyPr.parse(pr).reviewRequests, pr.reviewRequests);
  assert.equal(MyPr.safeParse({ ...pr, reviewRequests: ['Acme/docs'] }).success, false);
  assert.equal(MyPr.safeParse({ ...pr, reviewRequests: [{ name: 'ana', isTeam: false }] }).success, false);
});
