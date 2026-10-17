import test from 'node:test';
import assert from 'node:assert/strict';

import { isClipboardKey, isUploadKey, MOBILE_KEYS, mobileKeyBytes, UPLOAD_ACTION } from '../public/mobile-keys.ts';

test('mobileKeyBytes: sends the exact control bytes the keyboard paths send', () => {
  assert.equal(mobileKeyBytes('esc'), '\x1b');
  assert.equal(mobileKeyBytes('tab'), '\x09');
  assert.equal(mobileKeyBytes('up'), '\x1b[A');
  assert.equal(mobileKeyBytes('down'), '\x1b[B');
  assert.equal(mobileKeyBytes('left'), '\x1b[D');
  assert.equal(mobileKeyBytes('right'), '\x1b[C');
});

test('mobileKeyBytes: the action keys and unknown ids carry no bytes', () => {
  assert.equal(mobileKeyBytes('paste'), null);
  assert.equal(mobileKeyBytes('attach'), null, 'the upload travels over HTTP, not as key bytes');
  assert.equal(mobileKeyBytes('nope'), null);
});

test('isClipboardKey and isUploadKey: paste reads the clipboard and attach opens the file picker', () => {
  const byId = new Map(MOBILE_KEYS.map((k) => [k.id, k]));
  assert.equal(isClipboardKey(byId.get('paste')), true);
  assert.equal(isClipboardKey(byId.get('attach')), false);
  assert.equal(isUploadKey(byId.get('attach')), true);
  assert.equal(byId.get('attach')?.action, UPLOAD_ACTION);
  assert.equal(isUploadKey(byId.get('paste')), false);
  assert.equal(isUploadKey(byId.get('esc')), false);
  assert.equal(isClipboardKey(undefined), false);
  assert.equal(isUploadKey(undefined), false);
});
