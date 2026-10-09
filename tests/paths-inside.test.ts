import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { isPathInside } from '../shared/paths.ts';

const ROOT = path.resolve(path.sep, 'srv', 'glimmervoid', 'a', 'b');

test('isPathInside admits a descendant and refuses a sibling that shares a spelling prefix', () => {
  assert.equal(isPathInside(ROOT, path.join(ROOT, 'c')), true);
  assert.equal(isPathInside(ROOT, path.join(ROOT, 'c', 'd.txt')), true);
  assert.equal(isPathInside(ROOT, `${ROOT}c`), false, '/a/bc is not under /a/b');
  assert.equal(isPathInside(ROOT, `${ROOT}-other`), false);
});

test('isPathInside refuses the parent, an ancestor and a dot-dot escape', () => {
  assert.equal(isPathInside(ROOT, path.dirname(ROOT)), false, 'the parent is not inside');
  assert.equal(isPathInside(ROOT, path.resolve(path.sep)), false);
  assert.equal(isPathInside(ROOT, path.join(ROOT, '..', 'other')), false);
  assert.equal(isPathInside(ROOT, path.join(ROOT, 'c', '..', '..', 'x')), false);
});

test('isPathInside keeps a child whose name merely starts with two dots', () => {
  assert.equal(isPathInside(ROOT, path.join(ROOT, '..hidden')), true);
  assert.equal(isPathInside(ROOT, path.join(ROOT, '...')), true);
});

test('isPathInside equality is an explicit option', () => {
  assert.equal(isPathInside(ROOT, ROOT), true, 'equality admitted by default');
  assert.equal(isPathInside(ROOT, `${ROOT}${path.sep}`), true);
  assert.equal(isPathInside(ROOT, ROOT, { allowEqual: true }), true);
  assert.equal(isPathInside(ROOT, ROOT, { allowEqual: false }), false, 'a strict root refuses itself');
  assert.equal(isPathInside(ROOT, path.join(ROOT, 'c'), { allowEqual: false }), true);
});

test('isPathInside folds case only when asked', () => {
  const upper = path.join(ROOT, 'Src');
  const lower = path.join(ROOT, 'src', 'app.ts');
  assert.equal(isPathInside(upper, lower, { foldCase: true }), true);
  assert.equal(isPathInside(upper, lower, { foldCase: false }), process.platform === 'win32');
});

test('isPathInside refuses blank inputs and another absolute root', () => {
  assert.equal(isPathInside('', ROOT), false);
  assert.equal(isPathInside(ROOT, ''), false);
  assert.equal(isPathInside(ROOT, path.resolve(path.sep, 'elsewhere')), false);
});
