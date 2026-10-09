import assert from 'node:assert';
import { test } from 'node:test';
import { parseJsonOrNull, parseJsonRecord } from '../server/core/json-core.ts';

test('parseJsonOrNull returns any JSON value and null for malformed or non-text input', () => {
  assert.deepEqual(parseJsonOrNull('[1,2]'), [1, 2]);
  assert.equal(parseJsonOrNull('7'), 7);
  assert.equal(parseJsonOrNull('null'), null);
  assert.equal(parseJsonOrNull('{ invalid'), null);
  assert.equal(parseJsonOrNull(''), null);
  assert.equal(parseJsonOrNull(42), null);
  assert.equal(parseJsonOrNull(undefined), null);
  assert.deepEqual(parseJsonOrNull(Buffer.from('{"a":1}')), { a: 1 });
});

test('parseJsonRecord admits plain objects only by default', () => {
  assert.deepEqual(parseJsonRecord('{"a":1}'), { a: 1 });
  assert.equal(parseJsonRecord('[1]'), null);
  assert.equal(parseJsonRecord('"text"'), null);
  assert.equal(parseJsonRecord('null'), null);
  assert.equal(parseJsonRecord('{ invalid'), null);
  assert.equal(parseJsonRecord(''), null);
  assert.equal(parseJsonRecord({ a: 1 }), null);
});

test('parseJsonRecord admits arrays only when asked', () => {
  assert.deepEqual(parseJsonRecord('[1]', { admitArrays: true }), [1]);
  assert.equal(parseJsonRecord('7', { admitArrays: true }), null);
  assert.equal(parseJsonRecord('null', { admitArrays: true }), null);
  assert.equal(parseJsonRecord('[1]', { admitArrays: false }), null);
});
