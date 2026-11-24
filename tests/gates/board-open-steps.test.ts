import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';
import { BOARD_OPEN_STEPS } from '../../shared/contracts/telemetry.ts';

const WHITEBOARD_SOURCE = /^server\/whiteboard\/(?!.*\.test\.ts$).*\.ts$/;
const MARKED_STEP = /(?:markStep\??\.?|openSteps\??\.mark)\('([^']+)'/g;

test('board_opened names every step a board open marks, so none reports as other', () => {
  const knownSteps: readonly string[] = BOARD_OPEN_STEPS;
  const markedSteps = new Set<string>();
  for (const filePath of trackedFiles(WHITEBOARD_SOURCE)) {
    for (const match of readTracked(filePath).matchAll(MARKED_STEP)) markedSteps.add(match[1] ?? '');
  }
  assert.ok(markedSteps.size > 0);
  assert.deepEqual([...markedSteps].filter((step) => !knownSteps.includes(step)), []);
});
