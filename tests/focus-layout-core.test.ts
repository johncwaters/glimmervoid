import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FOCUS_LAYOUT, movePane, parseFocusLayout, resizeSplit, visibleLayout } from '../public/focus-view/pane-layout-core.ts';
import type { VisibleSplit } from '../public/focus-view/pane-layout-core.ts';

test('a stored two-pane focus layout keeps its arrangement and gains the shell below, and a corrupt one loads the default', () => {
  const flatBoardOnLeft = { kind: 'split', direction: 'row', firstShare: 0.3, first: 'board', second: 'terminal' };
  const migrated = parseFocusLayout(flatBoardOnLeft);
  assert.deepEqual(visibleLayout(migrated, new Set(['terminal', 'board'])), { direction: 'row', children: ['board', 'terminal'], shares: [0.3, 0.7], sourcePath: [0], sourceIndexes: [0, 1] });
  const duplicatedTerminal = { kind: 'split', direction: 'row', children: ['terminal', 'terminal'], shares: [0.5, 0.5] };
  for (const stored of [null, 'tabs', { kind: 'split' }, duplicatedTerminal]) {
    assert.deepEqual(parseFocusLayout(stored), DEFAULT_FOCUS_LAYOUT);
  }
});

test('dragging the shell under the terminal and board row, then resizing it while the board is hidden, keeps every pane once and the round trip stable', () => {
  const shellOnLeft = movePane(DEFAULT_FOCUS_LAYOUT, 'shell', 'terminal', 'left');
  assert.deepEqual(visibleLayout(shellOnLeft, new Set(['terminal', 'board', 'shell'])), { direction: 'row', children: ['shell', 'terminal', 'board'], shares: [0.25, 0.25, 0.5], sourcePath: [], sourceIndexes: [0, 1, 2] });
  const shellUnderneath = movePane(shellOnLeft, 'shell', 'board', 'bottom');
  const withoutBoard = visibleLayout(shellUnderneath, new Set(['terminal', 'shell']));
  assert.ok(withoutBoard && typeof withoutBoard !== 'string');
  const resized = resizeSplit(shellUnderneath, withoutBoard satisfies VisibleSplit, [0.4, 0.6]);
  assert.deepEqual(visibleLayout(resized, new Set(['terminal', 'shell'])), { ...withoutBoard, shares: [0.4, 0.6] });
  assert.deepEqual(parseFocusLayout(JSON.parse(JSON.stringify(resized))), resized);
});
