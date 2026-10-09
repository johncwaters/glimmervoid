import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { COMPACTION_RESTORE_EVENTS, isCompactionRestoreEvent } from '../shared/compaction-restore-events.ts';
import { TRANSITIONS } from '../session/core/state-machine.ts';
import { STATES } from '../shared/states.ts';

test('every compaction restore event is a RUNNING transition the dashboard recognizes', () => {
  for (const [settledState, restoreEvent] of Object.entries(COMPACTION_RESTORE_EVENTS)) {
    assert.equal(TRANSITIONS[STATES.RUNNING][restoreEvent], settledState);
    assert.equal(isCompactionRestoreEvent(restoreEvent), true);
  }
  assert.equal(isCompactionRestoreEvent('task_complete'), false);
  assert.equal(isCompactionRestoreEvent('prompt_detected'), false);
  assert.equal(isCompactionRestoreEvent(''), false);
});

test('applyState gates the settled-state alert sound on the shared restore event predicate', () => {
  const lifecycleSource = fs.readFileSync(new URL('../public/session-card/lifecycle.ts', import.meta.url), 'utf8');
  assert.match(lifecycleSource, /import \{ isCompactionRestoreEvent \} from '#shared\/compaction-restore-events\.ts';/);
  assert.match(lifecycleSource, /export function applyState[\s\S]*?\(state === STATES\.COMPLETE && prevState !== STATES\.COMPLETE\)\) \{\n {4}if \(!isCompactionRestoreEvent\(event\) && isSoundEnabled\(\)\) playAlertSound\(getSoundId\(\)\);/);
  assert.equal(lifecycleSource.includes('compaction_restore_'), false);
});
