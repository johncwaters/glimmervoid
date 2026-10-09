import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompactionTracking, observeCompaction, finishCompaction, isCompactionEndingSignal, suppressCompactionSignal, mapCompactionActivityEvent } from '../session/core/compaction-core.ts';
import { createNotifyGate, explainNotification } from '../session/core/notify-gate.ts';
import { TRANSITIONS } from '../session/core/state-machine.ts';
import { STATES } from '../shared/states.ts';

for (const state of [STATES.IDLE, STATES.COMPLETE, STATES.WAITING]) {
  test(`idle ${state} displaced by a title spinner restores through the table without notifying`, () => {
    let tracking = observeCompaction(createCompactionTracking(), { signal: 'working', source: 'title', state });
    tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.RUNNING });
    assert.equal(tracking.isCompacting, true);
    assert.equal(suppressCompactionSignal(tracking, 'working'), true);
    assert.equal(isCompactionEndingSignal(tracking, 'ready', 'title'), true);
    const finished = finishCompaction(tracking, STATES.RUNNING);
    assert.ok(finished.event);
    assert.equal(TRANSITIONS[STATES.RUNNING][finished.event], state);
    assert.equal(finished.tracking.isCompacting, false);
    const gate = createNotifyGate();
    assert.deepEqual(explainNotification(state, gate, finished.event), { category: null, reason: 'compaction-restored-silently' });
    assert.equal(gate.fire('complete'), true);
  });

  test(`PreCompact before a spinner preserves settled ${state}`, () => {
    const tracking = observeCompaction(createCompactionTracking(), { signal: 'compaction-start', state });
    assert.equal(tracking.returnState?.state, state);
    assert.equal(suppressCompactionSignal(tracking, 'working'), true);
    assert.equal(finishCompaction(tracking, state).event, null);
  });
}

test('a submitted turn remains running across auto compaction', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'resume', state: STATES.COMPLETE });
  tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.RUNNING });
  assert.equal(tracking.returnState, null);
  assert.equal(suppressCompactionSignal(tracking, 'working'), false);
  assert.equal(isCompactionEndingSignal(tracking, 'ready', 'title'), true);
  assert.equal(finishCompaction(tracking, STATES.RUNNING).event, null);
});

test('WAITING during a submitted turn is not an idle compaction', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'resume', state: STATES.IDLE });
  tracking = observeCompaction(tracking, { signal: 'working', source: 'title', state: STATES.WAITING });
  tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.RUNNING });
  assert.equal(tracking.returnState, null);
  assert.equal(mapCompactionActivityEvent(tracking, 'working', 'user_input'), 'user_input');
});

test('a new prompt during idle compaction cancels restoration', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'compaction-start', state: STATES.COMPLETE });
  tracking = observeCompaction(tracking, { signal: 'resume', state: STATES.COMPLETE });
  assert.equal(tracking.isCompacting, false);
  assert.equal(finishCompaction(tracking, STATES.RUNNING).event, null);
});

for (const signal of ['resume', 'stop', 'awaiting-input']) {
  test(`${signal} ends a compaction whose end hook never arrives`, () => {
    const started = observeCompaction(createCompactionTracking(), { signal: 'compaction-start', state: STATES.RUNNING });
    assert.equal(observeCompaction(started, { signal, state: STATES.RUNNING }).isCompacting, false);
  });
}

test('a hook Stop ready is never held by an in-progress compaction', () => {
  const tracking = observeCompaction(createCompactionTracking(), { signal: 'compaction-start', state: STATES.RUNNING });
  assert.equal(isCompactionEndingSignal(tracking, 'ready', 'hook'), false);
  assert.equal(suppressCompactionSignal(tracking, 'ready'), false);
});

test('a title ready ends a cancelled idle compaction and restores once', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'working', source: 'title', state: STATES.COMPLETE });
  tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.RUNNING });
  assert.equal(isCompactionEndingSignal(tracking, 'ready', 'title'), true);
  const endedByTitle = finishCompaction(tracking, STATES.RUNNING);
  assert.equal(endedByTitle.event, 'compaction_restore_complete');
  assert.equal(endedByTitle.tracking.isCompacting, false);
  assert.equal(isCompactionEndingSignal(endedByTitle.tracking, 'ready', 'title'), false);
  const lateEndHook = finishCompaction(endedByTitle.tracking, STATES.COMPLETE);
  assert.equal(lateEndHook.event, null);
  assert.equal(lateEndHook.shouldResetDetectionSources, false);
});

test('a title ready outside a compaction ends nothing', () => {
  assert.equal(isCompactionEndingSignal(createCompactionTracking(), 'ready', 'title'), false);
});

test('Stop settles the submitted turn before the next idle compaction', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'resume', state: STATES.IDLE });
  tracking = observeCompaction(tracking, { signal: 'stop', state: STATES.RUNNING });
  tracking = observeCompaction(tracking, { signal: 'settled', state: STATES.COMPLETE });
  tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.COMPLETE });
  assert.equal(tracking.returnState?.state, STATES.COMPLETE);
});

test('a duplicate PreCompact retains the original return state', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'compaction-start', state: STATES.COMPLETE });
  tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.RUNNING });
  assert.equal(tracking.returnState?.state, STATES.COMPLETE);
});

test('SessionStart compact can restore a displaced idle state without PreCompact', () => {
  const tracking = observeCompaction(createCompactionTracking(), { signal: 'working', source: 'title', state: STATES.COMPLETE });
  assert.equal(finishCompaction(tracking, STATES.RUNNING).event, 'compaction_restore_complete');
});

test('compaction never restores an exited session', () => {
  const tracking = observeCompaction(createCompactionTracking(), { signal: 'compaction-start', state: STATES.COMPLETE });
  assert.equal(finishCompaction(tracking, STATES.DONE).event, null);
  assert.equal(finishCompaction(tracking, STATES.FAILED).event, null);
});

test('idle WAITING spinner does not reset a spent notification cycle', () => {
  const tracking = observeCompaction(createCompactionTracking(), { signal: 'working', source: 'title', state: STATES.WAITING });
  const event = mapCompactionActivityEvent(tracking, 'working', 'user_input');
  assert.equal(event, 'new_output');
  const gate = createNotifyGate();
  gate.fire('complete');
  explainNotification(STATES.RUNNING, gate, event ?? undefined, { signal: 'working', hookSeen: true });
  assert.equal(gate.fire('complete'), false);
});

test('a duplicate end hook cannot reset detection after a new prompt or Stop', () => {
  const started = observeCompaction(createCompactionTracking(), { signal: 'compaction-start', state: STATES.RUNNING });
  const finished = finishCompaction(started, STATES.RUNNING);
  assert.equal(finished.shouldResetDetectionSources, true);
  const prompted = observeCompaction(finished.tracking, { signal: 'resume', state: STATES.RUNNING });
  const stopped = observeCompaction(prompted, { signal: 'stop', state: STATES.RUNNING });
  assert.equal(finishCompaction(stopped, STATES.RUNNING).shouldResetDetectionSources, false);
});

test('startup IDLE cannot erase a UserPromptSubmit that arrived before first output', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'resume', state: STATES.STARTING });
  tracking = observeCompaction(tracking, { signal: 'settled', state: STATES.IDLE });
  tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.IDLE });
  assert.equal(tracking.hasPromptInFlight, true);
  assert.equal(tracking.returnState, null);
});

test('a new permission prompt replaces an earlier idle title return candidate', () => {
  let tracking = observeCompaction(createCompactionTracking(), { signal: 'working', source: 'title', state: STATES.COMPLETE });
  tracking = observeCompaction(tracking, { signal: 'awaiting-input', state: STATES.RUNNING });
  tracking = observeCompaction(tracking, { signal: 'working', source: 'title', state: STATES.WAITING, pendingPromptKind: 'permission' });
  tracking = observeCompaction(tracking, { signal: 'compaction-start', state: STATES.RUNNING });
  assert.equal(tracking.returnState?.state, STATES.WAITING);
  assert.equal(tracking.returnState?.pendingPromptKind, 'permission');
});
