import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAppReveal, MAX_REVEAL_WAIT_MS } from '../public/app-reveal-core.ts';

test('the loading screen holds after the control socket connects until the session snapshot arrives', () => {
  assert.equal(decideAppReveal({ hasSnapshot: false, connectingTerminalCount: 0, msSinceConnected: 10 }), 'wait');
});

test('the loading screen holds while any terminal is still connecting, so the operator sees one load instead of two', () => {
  assert.equal(decideAppReveal({ hasSnapshot: true, connectingTerminalCount: 2, msSinceConnected: 10 }), 'wait');
});

test('the app reveals once the snapshot is in and every terminal is live', () => {
  assert.equal(decideAppReveal({ hasSnapshot: true, connectingTerminalCount: 0, msSinceConnected: 10 }), 'reveal');
});

test('a slow terminal or missing snapshot never holds the loading screen past the cap', () => {
  assert.equal(decideAppReveal({ hasSnapshot: true, connectingTerminalCount: 3, msSinceConnected: MAX_REVEAL_WAIT_MS }), 'reveal');
  assert.equal(decideAppReveal({ hasSnapshot: false, connectingTerminalCount: 0, msSinceConnected: MAX_REVEAL_WAIT_MS + 1 }), 'reveal');
  assert.equal(decideAppReveal({ hasSnapshot: false, connectingTerminalCount: 0, msSinceConnected: Number.NaN }), 'reveal');
});
