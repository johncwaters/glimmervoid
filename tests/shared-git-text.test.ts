import assert from 'node:assert';
import { test } from 'node:test';
import { FULL_SHA_RE, HEX_SHA_RE, SHORT_SHA_CHARS, shortSha } from '../shared/git-text.ts';

const FULL = '0123456789abcdef0123456789abcdef01234567';

test('shortSha slices the first seven characters of any non-empty string by default', () => {
  assert.equal(SHORT_SHA_CHARS, 7);
  assert.equal(shortSha(FULL), '0123456');
  assert.equal(shortSha('abc'), 'abc');
  assert.equal(shortSha('not a sha at all'), 'not a s');
  assert.equal(shortSha(''), '');
  assert.equal(shortSha(null), '');
  assert.equal(shortSha(42), '');
});

test('shortSha honours a custom width', () => {
  assert.equal(shortSha(FULL, { chars: 8 }), '01234567');
  assert.equal(shortSha(FULL, { chars: 40 }), FULL);
});

test('shortSha with validate trims, requires 7 to 40 hex characters and lowercases', () => {
  assert.equal(shortSha(`  ${FULL.toUpperCase()}  `, { validate: true }), '0123456');
  assert.equal(shortSha('ABCDEF0', { validate: true }), 'abcdef0');
  assert.equal(shortSha('abcdef', { validate: true }), '');
  assert.equal(shortSha('not a sha at all', { validate: true }), '');
  assert.equal(shortSha(`${FULL}0`, { validate: true }), '');
});

test('shortSha with validate returns empty for a missing or non-string sha', () => {
  assert.equal(shortSha(null, { validate: true }), '');
  assert.equal(shortSha(undefined, { validate: true }), '');
  assert.equal(shortSha('', { validate: true }), '');
  assert.equal(shortSha(42, { validate: true }), '');
});

test('the sha regexes agree on width and case', () => {
  assert.equal(HEX_SHA_RE.test('ABCDEF0'), true);
  assert.equal(HEX_SHA_RE.test('abcdef'), false);
  assert.equal(FULL_SHA_RE.test(FULL), true);
  assert.equal(FULL_SHA_RE.test(FULL.toUpperCase()), false);
  assert.equal(FULL_SHA_RE.test(FULL.slice(0, 39)), false);
});
