import test from 'node:test';
import assert from 'node:assert/strict';

import { attentionSignature, createAttentionAck, decideAttention } from '../public/attention-ack-core.ts';

test('attentionSignature: sorts and dedupes, so the same facts in any order are one signature', () => {
  assert.equal(attentionSignature(['b', 'a']), 'a|b');
  assert.equal(attentionSignature(['a', 'b']), attentionSignature(['b', 'a']));
  assert.equal(attentionSignature(['a', 'a']), 'a');
});

test('attentionSignature: nothing to say is the empty signature, never a throw', () => {
  assert.equal(attentionSignature([]), '');
  assert.equal(attentionSignature(null), '');
  assert.equal(attentionSignature(undefined), '');
  assert.equal(attentionSignature(['', null, 3, {}, 'a']), 'a');
});

test('decideAttention: a fresh fact shows the dot and looking at it clears it', () => {
  const first = decideAttention('a', '');
  assert.deepEqual(first, { shown: true, acknowledged: '' });
  assert.deepEqual(decideAttention('a', 'a'), { shown: false, acknowledged: 'a' });
});

test('decideAttention: a changed signature re-lights an acknowledged dot', () => {
  assert.equal(decideAttention('a|b', 'a').shown, true);
  assert.equal(decideAttention('b', 'a').shown, true);
});

test('decideAttention: the condition clearing drops the dot AND the acknowledgement, so a recurrence re-arms', () => {
  const cleared = decideAttention('', 'a');
  assert.deepEqual(cleared, { shown: false, acknowledged: '' });
  assert.equal(decideAttention('a', cleared.acknowledged).shown, true);
});

test('decideAttention: a missing or corrupt stored acknowledgement still shows a live fact', () => {
  assert.equal(decideAttention('a', null).shown, true);
  assert.equal(decideAttention('a', undefined).shown, true);
  assert.equal(decideAttention('a', 42).shown, true);
  assert.deepEqual(decideAttention(null, 'a'), { shown: false, acknowledged: '' });
});

function fakeSurface(stored = '') {
  const state = { stored, signature: '', looking: false, writes: 0 };
  return { state, deps: {
    getAck: () => state.stored,
    setAck: (value: string) => { state.stored = value; state.writes += 1; },
    signature: () => state.signature,
    isLooking: () => state.looking,
  } };
}

test('createAttentionAck: an unseen fact shows the dot, and looking at the surface clears it', () => {
  const surface = fakeSurface();
  const attention = createAttentionAck(surface.deps);
  surface.state.signature = 'a';
  assert.equal(attention.refresh(), true);
  attention.acknowledge();
  assert.equal(surface.state.stored, 'a');
  assert.equal(attention.refresh(), false);
});

test('createAttentionAck: a fact arriving while the surface is on screen acknowledges itself', () => {
  const surface = fakeSurface();
  const attention = createAttentionAck(surface.deps);
  surface.state.looking = true;
  surface.state.signature = 'a';
  assert.equal(attention.refresh(), false);
  assert.equal(surface.state.stored, 'a');
});

test('createAttentionAck: the condition clearing drops the stored acknowledgement, so a recurrence re-arms', () => {
  const surface = fakeSurface('a');
  const attention = createAttentionAck(surface.deps);
  assert.equal(attention.refresh(), false);
  assert.equal(surface.state.stored, '');
  surface.state.signature = 'a';
  assert.equal(attention.refresh(), true);
});

test('createAttentionAck: an unchanged signature never rewrites the stored acknowledgement', () => {
  const surface = fakeSurface('a');
  const attention = createAttentionAck(surface.deps);
  surface.state.signature = 'a';
  attention.acknowledge();
  attention.refresh();
  assert.equal(surface.state.writes, 0);
});
