import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FOCUS_LAYOUT, moveTab, parseFocusLayout } from '../public/focus-view/pane-layout-core.ts';

test('a stored focus layout that is corrupt or loses a tab loads the default layout', () => {
  const missingBoard = { kind: 'group', tabs: ['terminal'], activeTab: 'terminal' };
  const duplicatedTerminal = { kind: 'split', direction: 'row', firstShare: 0.5, children: [missingBoard, missingBoard] };
  for (const stored of [null, 'board', { kind: 'split' }, missingBoard, duplicatedTerminal]) {
    assert.deepEqual(parseFocusLayout(stored), DEFAULT_FOCUS_LAYOUT);
  }
  const joined = moveTab(DEFAULT_FOCUS_LAYOUT, 'board', 1, 'join');
  assert.deepEqual(parseFocusLayout(JSON.parse(JSON.stringify(joined))), joined);
});
