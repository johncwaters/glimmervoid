import test from 'node:test';
import assert from 'node:assert/strict';

import { clampColumnWidth, keyboardWidthDelta } from '../public/column-width-core.ts';
const bounds = { minPx: 200, maxPx: 600 };

test('a width inside the bounds is kept and rounded', () => {
  assert.equal(clampColumnWidth(321.6, bounds), 322);
});

test('a width outside the bounds is pinned to the nearest bound', () => {
  assert.equal(clampColumnWidth(12, bounds), 200);
  assert.equal(clampColumnWidth(9000, bounds), 600);
});

test('a non-finite width is rejected rather than clamped', () => {
  assert.equal(clampColumnWidth(Number.NaN, bounds), null);
  assert.equal(clampColumnWidth(Number.POSITIVE_INFINITY, bounds), null);
});

test('only the horizontal arrow keys move the column edge', () => {
  assert.equal(keyboardWidthDelta('ArrowRight', 16), 16);
  assert.equal(keyboardWidthDelta('ArrowLeft', 16), -16);
  assert.equal(keyboardWidthDelta('ArrowUp', 16), null);
  assert.equal(keyboardWidthDelta('Enter', 16), null);
});
