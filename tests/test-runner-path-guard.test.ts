import test from 'node:test';
import assert from 'node:assert/strict';

import { isUnder, underTestRunner } from '../server/core/test-runner-path-guard.ts';

test('the node test runner is recognised by its context marker alone', () => {
  assert.equal(underTestRunner(process.env), true, 'this suite runs under node --test');
  assert.equal(underTestRunner({}), false);
  assert.equal(underTestRunner({ NODE_TEST_CONTEXT: '' }), false);
});

test('isUnder accepts the parent itself and its descendants, never a sibling', () => {
  assert.equal(isUnder('/a/b', '/a/b'), true);
  assert.equal(isUnder('/a/b/c', '/a/b'), true);
  assert.equal(isUnder('/a/bc', '/a/b'), false);
  assert.equal(isUnder('/a', '/a/b'), false);
  assert.equal(isUnder('', '/a'), false);
});
