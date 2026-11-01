import test from 'node:test';
import assert from 'node:assert/strict';

import { escapesFocusedTerminal, resolveDashboardShortcut } from '../public/shortcuts-core.ts';

test('next-attention escapes a terminal docked beside a board', () => {
  const altJ = { code: 'KeyJ', key: 'j', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  const nextAttention = resolveDashboardShortcut(altJ, 'other', { isTerminalFocused: true });
  assert.ok(nextAttention);
  assert.equal(escapesFocusedTerminal(nextAttention, 'boards'), true);
  assert.equal(escapesFocusedTerminal(nextAttention, 'prs'), false);
});
