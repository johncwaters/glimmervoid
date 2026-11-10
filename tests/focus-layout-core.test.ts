import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FOCUS_LAYOUT, moveBoard, parseFocusLayout } from '../public/focus-view/pane-layout-core.ts';

test('a stored focus layout in the tabbed shape migrates to a split and a corrupt one loads the default', () => {
  const tabbedBoardOnLeft = { kind: 'split', direction: 'row', firstShare: 0.3, children: [{ kind: 'group', tabs: ['board'], activeTab: 'board' }, { kind: 'group', tabs: ['terminal'], activeTab: 'terminal' }] };
  assert.deepEqual(parseFocusLayout(tabbedBoardOnLeft), { kind: 'split', direction: 'row', firstShare: 0.3, first: 'board', second: 'terminal' });
  const stackedTabs = { kind: 'group', tabs: ['terminal', 'board'], activeTab: 'board' };
  const duplicatedTerminal = { kind: 'split', direction: 'row', firstShare: 0.5, first: 'terminal', second: 'terminal' };
  for (const stored of [null, 'board', { kind: 'split' }, stackedTabs, duplicatedTerminal]) {
    assert.deepEqual(parseFocusLayout(stored), DEFAULT_FOCUS_LAYOUT);
  }
  const boardOnTop = moveBoard(DEFAULT_FOCUS_LAYOUT, 'top');
  assert.deepEqual(parseFocusLayout(JSON.parse(JSON.stringify(boardOnTop))), boardOnTop);
});
