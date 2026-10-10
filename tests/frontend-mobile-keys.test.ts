import test from 'node:test';
import assert from 'node:assert/strict';

import { isClipboardKey, isUploadKey, MOBILE_KEYS, mobileKeyBytes, UPLOAD_ACTION } from '../public/mobile-keys.ts';

test('mobileKeyBytes: sends the exact control bytes the keyboard paths send', () => {
  assert.equal(mobileKeyBytes('esc'), '\x1b');
  assert.equal(mobileKeyBytes('tab'), '\x09');
  assert.equal(mobileKeyBytes('up'), '\x1b[A');
  assert.equal(mobileKeyBytes('down'), '\x1b[B');
});

test('mobileKeyBytes: the action keys and unknown ids carry no bytes', () => {
  assert.equal(mobileKeyBytes('paste'), null);
  assert.equal(mobileKeyBytes('upload-image'), null, 'the image travels over HTTP, not as key bytes');
  assert.equal(mobileKeyBytes('upload-file'), null, 'so does any other file');
  assert.equal(mobileKeyBytes('nope'), null);
});

test('isClipboardKey: only the paste entry is a clipboard read', () => {
  const byId = new Map(MOBILE_KEYS.map((k) => [k.id, k]));
  assert.equal(isClipboardKey(byId.get('paste')), true);
  assert.equal(isClipboardKey(byId.get('esc')), false);
  assert.equal(isClipboardKey(byId.get('upload-image')), false);
  assert.equal(isClipboardKey(byId.get('upload-file')), false);
  assert.equal(isClipboardKey(undefined), false);
});

test('isUploadKey: both upload entries open the file picker and nothing else does', () => {
  const byId = new Map(MOBILE_KEYS.map((k) => [k.id, k]));
  assert.equal(isUploadKey(byId.get('upload-image')), true);
  assert.equal(byId.get('upload-image')?.action, UPLOAD_ACTION);
  assert.equal(isUploadKey(byId.get('upload-file')), true);
  assert.equal(byId.get('upload-file')?.action, UPLOAD_ACTION);
  assert.equal(isUploadKey(byId.get('paste')), false);
  assert.equal(isUploadKey(byId.get('esc')), false);
  assert.equal(isUploadKey(undefined), false);
});

test('accept: the image key narrows the picker and the file key carries no accept at all', () => {
  const byId = new Map(MOBILE_KEYS.map((k) => [k.id, k]));
  assert.equal(byId.get('upload-image')?.accept, 'image/*');
  assert.equal(byId.get('upload-file')?.accept, undefined, 'no accept attribute at all, not an empty one');
  assert.equal(byId.get('paste')?.accept, undefined);
});
