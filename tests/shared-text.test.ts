import assert from 'node:assert';
import { test } from 'node:test';
import { errorCode, errorLabel, errorMessage, errorText, isMissingFileError } from '../shared/text.ts';

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

test('isMissingFileError reads ENOENT always and ENOTDIR only by default', () => {
  assert.equal(isMissingFileError(errno('ENOENT')), true);
  assert.equal(isMissingFileError(errno('ENOTDIR')), true);
  assert.equal(isMissingFileError(errno('ENOTDIR'), { includeNotDir: false }), false);
  assert.equal(isMissingFileError(errno('ENOENT'), { includeNotDir: false }), true);
  assert.equal(isMissingFileError(errno('EACCES')), false);
  assert.equal(isMissingFileError({ code: 'ENOENT' }), true);
  assert.equal(isMissingFileError(new Error('ENOENT')), false);
  assert.equal(isMissingFileError(null), false);
});

test('errorMessage reads an Error message and stringifies everything else', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage(new Error('')), '');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage({ message: 'shaped' }), '[object Object]');
});

test('errorText prefers a non-empty message on any object and falls back to String', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText({ message: 'shaped' }), 'shaped');
  assert.equal(errorText(new Error('')), 'Error');
  assert.equal(errorText('plain'), 'plain');
  assert.equal(errorText(undefined), 'undefined');
});

test('errorCode returns only a string code and undefined otherwise', () => {
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(errorCode({ code: 'EXDEV' }), 'EXDEV');
  assert.equal(errorCode({ code: 13 }), undefined);
  assert.equal(errorCode(new Error('x')), undefined);
  assert.equal(errorCode(null), undefined);
  assert.equal(errorCode('ENOENT'), undefined);
});

test('errorLabel prefers the code and falls back to the text', () => {
  assert.equal(errorLabel(Object.assign(new Error('denied'), { code: 'EACCES' })), 'EACCES');
  assert.equal(errorLabel(new Error('denied')), 'denied');
  assert.equal(errorLabel({ code: '', message: 'empty code' }), 'empty code');
  assert.equal(errorLabel('raw'), 'raw');
});
