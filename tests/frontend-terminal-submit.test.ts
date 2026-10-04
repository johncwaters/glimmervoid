import test from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalSubmitKeystroke } from '../public/session-card/terminal-submit-core.ts';

test('a lone Enter keystroke counts as a submit', () => {
  assert.equal(isTerminalSubmitKeystroke('\r'), true);
});

test('a bracketed multi-line paste never counts as a submit', () => {
  assert.equal(isTerminalSubmitKeystroke('\x1b[200~first line\rsecond line\x1b[201~'), false);
});

test('backslash-Enter and Alt+Enter newlines keep the operator composing', () => {
  assert.equal(isTerminalSubmitKeystroke('\\\r'), false);
  assert.equal(isTerminalSubmitKeystroke('\x1b\r'), false);
});

test('typed text arriving in the same chunk as Enter is not a submit', () => {
  assert.equal(isTerminalSubmitKeystroke('abc\r'), false);
});
