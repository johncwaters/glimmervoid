import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptsAttentionSignal, mapSignalToEvent, shouldDeferAttention } from '../session/core/status-mapper.ts';
import { STATES } from '../shared/states.ts';

const ALL_STATES = Object.values(STATES);

test('working and resume wake an IDLE or COMPLETE session as new output and answer a WAITING prompt as user input', () => {
  for (const signal of ['working', 'resume']) {
    assert.equal(mapSignalToEvent(signal, STATES.IDLE, 'high', 0), 'new_output');
    assert.equal(mapSignalToEvent(signal, STATES.COMPLETE, 'high', 0), 'new_output');
    assert.equal(mapSignalToEvent(signal, STATES.WAITING, 'high', 0), 'user_input');
    assert.equal(mapSignalToEvent(signal, STATES.RUNNING, 'high', 0), null);
  }
});

test('high-confidence ready completes a RUNNING, WAITING or IDLE session', () => {
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'high', 0), 'task_complete');
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'high', 0), 'task_complete');
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'high', 0), 'task_complete');
});

test('awaiting-input raises a prompt from RUNNING, IDLE or COMPLETE', () => {
  assert.equal(mapSignalToEvent('awaiting-input', STATES.RUNNING, 'high', 0), 'prompt_detected');
  assert.equal(mapSignalToEvent('awaiting-input', STATES.IDLE, 'low', 0), 'prompt_detected');
  assert.equal(mapSignalToEvent('awaiting-input', STATES.COMPLETE, 'high', 1), 'prompt_detected');
});

test('session lifecycle and unknown signals never map to a lifecycle event in any state', () => {
  for (const signal of ['session-start', 'session-end', 'totally-unknown-signal']) {
    for (const state of ALL_STATES) assert.equal(mapSignalToEvent(signal, state, 'high', 0), null);
  }
});

test('low-confidence ready only ever confirms quiescence from RUNNING, never from WAITING or IDLE', () => {
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'low', 0), 'task_complete');
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'low', 0), null);
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'low', 0), null);
});

test('activeAgents > 0 suppresses ready to task_complete even from RUNNING with high confidence', () => {
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'high', 1), null);
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'high', 1), null);
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'high', 1), null);
});

test('idle_prompt demotion: a low-confidence ready cannot complete a fresh IDLE session or a WAITING prompt', () => {
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'low', 0), null);
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'low', 0), null);
});

test('awaiting-input never fires from WAITING (already awaiting input) or DONE/FAILED/DORMANT/INITIALIZING/STARTING', () => {
  assert.equal(mapSignalToEvent('awaiting-input', STATES.WAITING, 'high', 0), null);
  assert.equal(mapSignalToEvent('awaiting-input', STATES.DONE, 'high', 0), null);
  assert.equal(mapSignalToEvent('awaiting-input', STATES.FAILED, 'high', 0), null);
  assert.equal(mapSignalToEvent('awaiting-input', STATES.DORMANT, 'high', 0), null);
});

test('activeAgents default parameter behaves as 0 when omitted', () => {
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'high'), 'task_complete');
});

test('an attention signal is accepted only from the states the machine table lets it move', () => {
  const accepting = ALL_STATES.filter((state) => acceptsAttentionSignal(state));
  assert.deepEqual(accepting.sort(), [STATES.COMPLETE, STATES.IDLE, STATES.RUNNING].sort());
});

test('an attention note is held only while the session is still starting up', () => {
  const deferring = ALL_STATES.filter((state) => shouldDeferAttention(state));
  assert.deepEqual(deferring.sort(), [STATES.DORMANT, STATES.INITIALIZING, STATES.STARTING].sort());
});
