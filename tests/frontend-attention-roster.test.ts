import test from 'node:test';
import assert from 'node:assert/strict';

import { attentionRank, attentionSummaryText, countAttentionByKind, needsAttention, orderAttentionQueue, orderRoster, pickAdjacent, pickNextAttention, pickStagedSession, pickStrongestAttention, stageNeedWords, titleAlertCount } from '../public/focus-view/attention-core.ts';

test('orderRoster: non-dormant before dormant, add order within each group', () => {
  const out = orderRoster([
    { id: '1', name: 'zebra', isDormant: false },
    { id: '2', name: 'alpha', isDormant: true },
    { id: '3', name: 'mike', isDormant: false },
    { id: '4', name: 'bravo', isDormant: true },
  ]).map((s) => s.id);

  assert.deepEqual(out, ['1', '3', '2', '4']);
});

test('orderRoster: an owned session sits directly after its owner, and one whose owner is gone keeps its place', () => {
  const out = orderRoster([
    { id: 'child-a', isDormant: false, ownerId: 'parent' },
    { id: 'other', isDormant: false },
    { id: 'parent', isDormant: false },
    { id: 'orphan', isDormant: false, ownerId: 'removed' },
    { id: 'child-b', isDormant: false, ownerId: 'parent' },
  ]).map((s) => s.id);

  assert.deepEqual(out, ['other', 'parent', 'child-a', 'child-b', 'orphan']);
});

test('orderRoster: does not mutate its input', () => {
  const input = [
    { id: '1', name: 'zebra', isDormant: false },
    { id: '2', name: 'alpha', isDormant: false },
  ];
  orderRoster(input);
  assert.deepEqual(input.map((s) => s.id), ['1', '2']);
});

test('pickNextAttention: empty queue returns null', () => {
  assert.equal(pickNextAttention([], 'x'), null);
});

test('pickNextAttention: advances and wraps around', () => {
  assert.equal(pickNextAttention(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(pickNextAttention(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(pickNextAttention(['a', 'b', 'c'], 'c'), 'a');
});

test('pickNextAttention: currentId absent starts at the front', () => {
  assert.equal(pickNextAttention(['a', 'b'], 'zzz'), 'a');
  assert.equal(pickNextAttention(['a', 'b'], null), 'a');
});

test('pickNextAttention: single-element queue stays put', () => {
  assert.equal(pickNextAttention(['only'], 'only'), 'only');
});

test('pickAdjacent: empty list returns null', () => {
  assert.equal(pickAdjacent([], 'x', 1), null);
  assert.equal(pickAdjacent([], 'x', -1), null);
});

test('pickAdjacent: steps forward and backward', () => {
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'a', 1), 'b');
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'c', -1), 'b');
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'b', -1), 'a');
});

test('pickAdjacent: wraps around both ends', () => {
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'c', 1), 'a');
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'a', -1), 'c');
});

test('pickAdjacent: absent cursor starts at the correct end per direction', () => {
  assert.equal(pickAdjacent(['a', 'b'], 'gone', 1), 'a');
  assert.equal(pickAdjacent(['a', 'b'], null, 1), 'a');
  assert.equal(pickAdjacent(['a', 'b'], 'gone', -1), 'b');
  assert.equal(pickAdjacent(['a', 'b'], null, -1), 'b');
});

test('pickAdjacent: single-element list stays put either direction', () => {
  assert.equal(pickAdjacent(['only'], 'only', 1), 'only');
  assert.equal(pickAdjacent(['only'], 'only', -1), 'only');
});

interface AttentionRow {
  id: string;
  state: string;
}

const attentionRow = (id: string, state: string): AttentionRow => ({ id, state });

test('needsAttention: WAITING and COMPLETE qualify until the operator sees them', () => {
  assert.equal(needsAttention({ state: 'WAITING' }), true);
  assert.equal(needsAttention({ state: 'COMPLETE' }), true);
});

test('needsAttention: no other state qualifies', () => {
  for (const state of ['RUNNING', 'FAILED', 'IDLE', 'DONE', 'DORMANT', 'STARTING', 'INITIALIZING']) {
    assert.equal(needsAttention({ state }), false, `${state} must not qualify`);
  }
  assert.equal(needsAttention({}), false);
  assert.equal(needsAttention(), false);
});

test('countAttentionByKind: counts the rows needsAttention accepts, plus failed sessions', () => {
  assert.deepEqual(countAttentionByKind([
    attentionRow('a', 'WAITING'),
    attentionRow('b', 'FAILED'),
    attentionRow('c', 'COMPLETE'),
    attentionRow('e', 'RUNNING'),
    attentionRow('f', 'IDLE'),
  ]), { waitingCount: 1, finishedCount: 1, failedCount: 1 });
  const noAttention = { waitingCount: 0, finishedCount: 0, failedCount: 0 };
  assert.deepEqual(countAttentionByKind([attentionRow('a', 'RUNNING'), attentionRow('b', 'DORMANT')]), noAttention);
  assert.deepEqual(countAttentionByKind([]), noAttention);
  assert.deepEqual(countAttentionByKind(undefined), noAttention);
  assert.deepEqual(countAttentionByKind([null, undefined]), noAttention);
  assert.equal(titleAlertCount(noAttention), 0);
  assert.equal(titleAlertCount({ waitingCount: 2, finishedCount: 5, failedCount: 3 }), 5);
});

test('attentionSummaryText: resting reads as a sentence, never an empty slot', () => {
  assert.equal(attentionSummaryText({ waitingCount: 0, finishedCount: 0, failedCount: 0 }), 'ALL CLEAR');
  assert.equal(attentionSummaryText({ waitingCount: 1, finishedCount: 0, failedCount: 0 }), '1 NEEDS YOU');
  assert.equal(attentionSummaryText({ waitingCount: 4, finishedCount: 0, failedCount: 0 }), '4 NEED YOU');
  assert.equal(attentionSummaryText({ waitingCount: 1, finishedCount: 2, failedCount: 1 }), '1 NEEDS YOU, 1 FAILED, 2 FINISHED');
});

test('orderAttentionQueue: the jump queue puts waiting, then failed, then finished sessions, keeping roster order within each', () => {
  const rosterOrderedRows = [attentionRow('alpha', 'COMPLETE'), attentionRow('bravo', 'RUNNING'), attentionRow('charlie', 'WAITING'), attentionRow('delta', 'FAILED'), attentionRow('echo', 'WAITING'), attentionRow('foxtrot', 'IDLE')];
  assert.deepEqual(orderAttentionQueue(rosterOrderedRows), ['charlie', 'echo', 'delta', 'alpha']);
});

test('pickStagedSession: a staged session keeps the stage while it stays queued, even when a higher-ranked one arrives', () => {
  assert.equal(pickStagedSession(['charlie', 'echo', 'alpha'], 'alpha'), 'alpha');
  assert.equal(pickStagedSession(['charlie', 'echo'], 'alpha'), 'charlie');
  assert.equal(pickStagedSession([], 'alpha'), null);
  assert.equal(stageNeedWords('COMPLETE', 'permission'), 'Finished');
});

test('attentionSummaryText: a finished session never reads as a session waiting on you', () => {
  const counts = countAttentionByKind([attentionRow('a', 'COMPLETE'), attentionRow('b', 'WAITING'), attentionRow('c', 'COMPLETE')]);
  assert.deepEqual(counts, { waitingCount: 1, finishedCount: 2, failedCount: 0 });
  assert.equal(attentionSummaryText(counts), '1 NEEDS YOU, 2 FINISHED');
  assert.equal(attentionSummaryText({ waitingCount: 0, finishedCount: 1, failedCount: 0 }), '1 FINISHED');
});

test('pickStrongestAttention: a raised hand outranks an arrival dot whatever the order', () => {
  assert.equal(pickStrongestAttention(['unseen', 'hand']), 'hand');
  assert.equal(pickStrongestAttention(['hand', 'unseen']), 'hand');
  assert.equal(pickStrongestAttention([false, true, 'hand', false]), 'hand');
  assert.equal(pickStrongestAttention(['hand', true]), 'hand');
});

test('pickStrongestAttention: equal-rank levels resolve to the first one asking', () => {
  assert.equal(pickStrongestAttention([false, 'unseen', true]), 'unseen');
  assert.equal(pickStrongestAttention([true, 'unseen']), true);
  assert.equal(pickStrongestAttention([false, true]), true);
});

test('pickStrongestAttention: nothing asking is false, never a stray truthy level', () => {
  assert.equal(pickStrongestAttention([]), false);
  assert.equal(pickStrongestAttention([false, false]), false);
  assert.equal(pickStrongestAttention([null, undefined, '']), false);
  assert.equal(pickStrongestAttention(), false);
});

test('attentionRank: an unknown level still counts as asking, below a raised hand', () => {
  assert.equal(attentionRank('hand'), 2);
  assert.equal(attentionRank('unseen'), 1);
  assert.equal(attentionRank('something-new'), 1);
  assert.equal(attentionRank(true), 1);
  assert.equal(attentionRank(false), 0);
  assert.equal(attentionRank(undefined), 0);
});
