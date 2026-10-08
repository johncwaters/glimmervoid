import test from 'node:test';
import assert from 'node:assert/strict';

import { decideTerminalLinkState } from '../public/session-card/terminal-link-core.ts';

test('an open socket with no held input is live', () => {
  assert.equal(decideTerminalLinkState({ hasTerminal: true, isSocketOpen: true, isInputHeld: false }), 'live');
});

test('a socket that is not open shows connecting', () => {
  assert.equal(decideTerminalLinkState({ hasTerminal: true, isSocketOpen: false, isInputHeld: false }), 'connecting');
});

test('input held for a wake check shows connecting even on an open socket', () => {
  assert.equal(decideTerminalLinkState({ hasTerminal: true, isSocketOpen: true, isInputHeld: true }), 'connecting');
});

test('a card without a terminal carries no link state even while input is held', () => {
  assert.equal(decideTerminalLinkState({ hasTerminal: false, isSocketOpen: false, isInputHeld: true }), 'none');
});
