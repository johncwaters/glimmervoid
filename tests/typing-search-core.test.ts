import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStep, EMPTY_LINE, rebuildLine, shrinkActions } from '../harness/browser/typing-search-core.ts';
import type { SearchAction, StepObservation } from '../harness/browser/typing-search-core.ts';

const THUMBS_UP_MEDIUM_SKIN = String.fromCodePoint(0x1f44d, 0x1f3fd);

function step(overrides: Partial<StepObservation>): StepObservation {
  return { action: { kind: 'keyboard-open' }, sentBytes: '', fieldBefore: 'hello', fieldAfter: 'hello', fieldWrites: [], ...overrides };
}

const lineHello = rebuildLine(EMPTY_LINE, 'hello');

test('the oracles flag each phone typing bug fixed in 457601fdb', () => {
  const tapResetsField = step({ action: { kind: 'tap-terminal', xFraction: 0.5, yFraction: 0.5 }, sentBytes: '\x1b[<0;5;5M\x1b[<0;5;5m', fieldAfter: '', fieldWrites: [{ value: '', isByOurCode: true }] });
  assert.equal(checkStep(lineHello, tapResetsField)?.oracle, 'field');

  const backspaceResetsField = step({ action: { kind: 'press', key: 'Backspace' }, sentBytes: '\x7f', fieldAfter: '', fieldWrites: [{ value: '', isByOurCode: true }] });
  assert.equal(checkStep(rebuildLine(lineHello, '\x7f'), backspaceResetsField)?.oracle, 'field');

  const emojiLine = rebuildLine(EMPTY_LINE, `a${THUMBS_UP_MEDIUM_SKIN}`);
  const doubleDelete = step({ action: { kind: 'press', key: 'Backspace' }, sentBytes: '\x7f\x7f', fieldBefore: `a${THUMBS_UP_MEDIUM_SKIN}`, fieldAfter: 'a' });
  assert.equal(checkStep(rebuildLine(emojiLine, '\x7f\x7f'), doubleDelete)?.oracle, 'mirror');
  const emojiAfterHistoryRecall = rebuildLine(EMPTY_LINE, `\x1b[Aa${THUMBS_UP_MEDIUM_SKIN}`);
  assert.equal(checkStep(rebuildLine(emojiAfterHistoryRecall, '\x7f\x7f'), doubleDelete)?.oracle, 'mirror');

  const scrollLeavesStaleField = step({ action: { kind: 'scroll', lines: 2 }, sentBytes: '\x1bOA\x1bOA', fieldBefore: 'teh', fieldAfter: 'teh' });
  assert.equal(checkStep(rebuildLine(EMPTY_LINE, 'teh\x1bOA\x1bOA'), scrollLeavesStaleField)?.oracle, 'field');
});

test('the oracles pass the fixed behavior of the same steps', () => {
  const tap = step({ action: { kind: 'tap-terminal', xFraction: 0.5, yFraction: 0.5 }, sentBytes: '\x1b[<0;5;5M\x1b[<0;5;5m' });
  assert.equal(checkStep(lineHello, tap), null);

  const emojiLine = rebuildLine(EMPTY_LINE, `a${THUMBS_UP_MEDIUM_SKIN}`);
  const singleDelete = step({ action: { kind: 'press', key: 'Backspace' }, sentBytes: '\x7f', fieldBefore: `a${THUMBS_UP_MEDIUM_SKIN}`, fieldAfter: 'a' });
  assert.equal(checkStep(rebuildLine(emojiLine, '\x7f'), singleDelete), null);

  const scroll = step({ action: { kind: 'scroll', lines: 2 }, sentBytes: '\x1bOA', fieldBefore: 'teh', fieldAfter: '', fieldWrites: [{ value: '', isByOurCode: true }] });
  assert.equal(checkStep(rebuildLine(EMPTY_LINE, 'teh\x1bOA'), scroll), null);

  const ctrlChord = step({ action: { kind: 'type', text: 'h' }, sentBytes: '\x08', fieldBefore: 'teh', fieldAfter: '', fieldWrites: [{ value: 'tehh', isByOurCode: false }, { value: '', isByOurCode: true }] });
  assert.equal(checkStep(rebuildLine(EMPTY_LINE, 'teh\x08'), ctrlChord), null);
});

test('a failing action list shrinks to the actions that still fail', async () => {
  const actions: SearchAction[] = [
    { kind: 'type', text: 'a' },
    { kind: 'keyboard-open' },
    { kind: 'agent', command: 'focus-on' },
    { kind: 'keyboard-open' },
    { kind: 'keyboard-close' },
    { kind: 'type', text: 'b' },
  ];
  const failsWhenFocusOnPrecedesClose = async (candidate: SearchAction[]) => {
    const focusIndex = candidate.findIndex((action) => action.kind === 'agent');
    const closeIndex = candidate.findIndex((action) => action.kind === 'keyboard-close');
    return focusIndex !== -1 && closeIndex > focusIndex;
  };
  const shortest = await shrinkActions(actions, 4, failsWhenFocusOnPrecedesClose, () => true);
  assert.deepEqual(shortest, [{ kind: 'agent', command: 'focus-on' }, { kind: 'keyboard-close' }]);
});
