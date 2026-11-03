import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FOCUS_LAYOUT, groupsOf, moveTab, parseFocusLayout, trailGroupIndex } from '../public/focus-view/pane-layout-core.ts';

test('a stored focus layout that is corrupt or loses a tab loads the default layout', () => {
  const missingBoard = { kind: 'group', tabs: ['terminal'], activeTab: 'terminal' };
  const duplicatedTerminal = { kind: 'split', direction: 'row', firstShare: 0.5, children: [missingBoard, missingBoard] };
  for (const stored of [null, 'board', { kind: 'split' }, missingBoard, duplicatedTerminal]) {
    assert.deepEqual(parseFocusLayout(stored), DEFAULT_FOCUS_LAYOUT);
  }
  const joined = moveTab(DEFAULT_FOCUS_LAYOUT, 'board', 1, 'join');
  assert.deepEqual(parseFocusLayout(JSON.parse(JSON.stringify(joined))), joined);
});

test('the review bar rides the strip of the group holding the terminal in any split', () => {
  assert.equal(trailGroupIndex(groupsOf(DEFAULT_FOCUS_LAYOUT)), 1);
  const terminalOnLeft = moveTab(DEFAULT_FOCUS_LAYOUT, 'terminal', 0, 'left');
  assert.equal(trailGroupIndex(groupsOf(terminalOnLeft)), 0);
  const terminalOnRight = moveTab(DEFAULT_FOCUS_LAYOUT, 'terminal', 0, 'right');
  assert.equal(trailGroupIndex(groupsOf(terminalOnRight)), 1);
  const joined = moveTab(DEFAULT_FOCUS_LAYOUT, 'board', 1, 'join');
  assert.equal(trailGroupIndex(groupsOf(joined)), 0);
  assert.equal(trailGroupIndex([{ kind: 'group', tabs: ['board'], activeTab: 'board' }]), 0);
});
