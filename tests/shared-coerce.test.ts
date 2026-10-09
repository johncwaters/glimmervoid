import assert from 'node:assert';
import { test } from 'node:test';
import {
  coercedNumberOr,
  isRecord,
  nonNegativeIntOr,
  numberOr,
  positiveIntOr,
  positiveNumberOr,
  rawTextOr,
  textOr,
} from '../shared/coerce.ts';

test('isRecord admits plain objects only', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord('text'), false);
  assert.equal(isRecord(() => {}), false);
});

test('textOr trims and rejects blank strings', () => {
  assert.equal(textOr('  padded  ', null), 'padded');
  assert.equal(textOr('   ', null), null);
  assert.equal(textOr('', 'fallback'), 'fallback');
  assert.equal(textOr(42, null), null);
  assert.equal(textOr(undefined, null), null);
});

test('rawTextOr keeps whitespace and rejects only the empty string', () => {
  assert.equal(rawTextOr('  padded  ', null), '  padded  ');
  assert.equal(rawTextOr('   ', null), '   ');
  assert.equal(rawTextOr('', null), null);
  assert.equal(rawTextOr(42, null), null);
});

test('numberOr accepts finite numbers and never coerces', () => {
  assert.equal(numberOr(3.5, 0), 3.5);
  assert.equal(numberOr(0, null), 0);
  assert.equal(numberOr(-1, null), -1);
  assert.equal(numberOr(Number.NaN, 0), 0);
  assert.equal(numberOr(Number.POSITIVE_INFINITY, null), null);
  assert.equal(numberOr('7', null), null);
  assert.equal(numberOr(null, 0), 0);
});

test('positiveNumberOr rejects zero and negatives without coercing', () => {
  assert.equal(positiveNumberOr(2, 9), 2);
  assert.equal(positiveNumberOr(0.5, null), 0.5);
  assert.equal(positiveNumberOr(0, 9), 9);
  assert.equal(positiveNumberOr(-3, null), null);
  assert.equal(positiveNumberOr('2', 9), 9);
});

test('nonNegativeIntOr floors finite numbers at or above zero and never coerces', () => {
  assert.equal(nonNegativeIntOr(2.9, 7), 2);
  assert.equal(nonNegativeIntOr(0, 7), 0);
  assert.equal(nonNegativeIntOr(-0.1, 7), 7);
  assert.equal(nonNegativeIntOr('3', 7), 7);
  assert.equal(nonNegativeIntOr(Number.NaN, 7), 7);
});

test('coercedNumberOr applies Number() and keeps any finite result', () => {
  assert.equal(coercedNumberOr('12', 0), 12);
  assert.equal(coercedNumberOr('', 5), 0);
  assert.equal(coercedNumberOr(null, 5), 0);
  assert.equal(coercedNumberOr(true, 5), 1);
  assert.equal(coercedNumberOr('abc', 5), 5);
  assert.equal(coercedNumberOr(undefined, 5), 5);
  assert.equal(coercedNumberOr(-4.5, 5), -4.5);
});

test('positiveIntOr applies Number(), floors, and rejects zero and negatives', () => {
  assert.equal(positiveIntOr('12.9', 1), 12);
  assert.equal(positiveIntOr(3.2, 1), 3);
  assert.equal(positiveIntOr(0, 1), 1);
  assert.equal(positiveIntOr('0', 1), 1);
  assert.equal(positiveIntOr(-2, 1), 1);
  assert.equal(positiveIntOr('abc', 1), 1);
  assert.equal(positiveIntOr(null, 1), 1);
  assert.equal(positiveIntOr(0.5, 1), 0);
});
