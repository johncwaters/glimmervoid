import test from 'node:test';
import assert from 'node:assert/strict';
import { stateChip } from '../public/dom-helpers.ts';
import { STATES } from '../shared/states.ts';

test('state chip shows Monitoring only for a running session awaiting background tasks', () => {
  assert.equal(stateChip(STATES.RUNNING, true).label, 'MONITORING');
  assert.equal(stateChip(STATES.RUNNING, false).label, 'WORKING');
  assert.equal(stateChip(STATES.COMPLETE, true).label, 'COMPLETE');
  assert.equal(stateChip(STATES.RUNNING, true).glyph, stateChip(STATES.RUNNING).glyph);
});
