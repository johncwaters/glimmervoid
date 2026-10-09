import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeMouseEncoding, updateMouseEncoding } from '../session/core/mouse-encoding-core.ts';

for (const encoding of [1006, 1016] as const) {
  test(`DECSET ${encoding} replaces the active mouse encoding`, () => {
    assert.equal(updateMouseEncoding(null, [encoding], true), encoding);
    assert.equal(updateMouseEncoding(1006, [encoding], true), encoding);
    assert.equal(updateMouseEncoding(1016, [encoding], true), encoding);
  });

  test(`DECRST ${encoding} returns any active encoding to default`, () => {
    assert.equal(updateMouseEncoding(1006, [encoding], false), null);
    assert.equal(updateMouseEncoding(1016, [encoding], false), null);
    assert.equal(updateMouseEncoding(null, [encoding], false), null);
  });

  test(`the snapshot restores encoding ${encoding}`, () => {
    assert.equal(serializeMouseEncoding(encoding), `\x1b[?${encoding}h`);
  });
}

test('modes 1005 and 1015 are ignored the way xterm.js ignores them', () => {
  assert.equal(updateMouseEncoding(null, [1005], true), null);
  assert.equal(updateMouseEncoding(null, [1015], true), null);
  assert.equal(updateMouseEncoding(1006, [1005, 1015], true), 1006);
  assert.equal(updateMouseEncoding(1006, [1005, 1015], false), 1006);
  assert.equal(updateMouseEncoding(1016, [1005, 1015], false), 1016);
});

test('the last honored encoding in a combined DECSET wins in parameter order', () => {
  assert.equal(updateMouseEncoding(null, [1000, 1006, 1015], true), 1006);
  assert.equal(updateMouseEncoding(null, [1006, 1016], true), 1016);
  assert.equal(updateMouseEncoding(null, [1016, 1006, 1005], true), 1006);
});

test('unrelated modes leave encoding unchanged in combined sequences', () => {
  assert.equal(updateMouseEncoding(1006, [9, 1000, 1002, 1003, 1004, 1049, 2004], true), 1006);
  assert.equal(updateMouseEncoding(1006, [9, 1000, 1002, 1003, 1004, 1049, 2004], false), 1006);
  assert.equal(updateMouseEncoding(null, [], true), null);
});

test('parameters with subparameters use the primary mode number', () => {
  assert.equal(updateMouseEncoding(null, [[1006, 1]], true), 1006);
  assert.equal(updateMouseEncoding(1006, [[1016, 1]], false), null);
  assert.equal(updateMouseEncoding(1006, [[1000, 1016], []], true), 1006);
});

test('default mouse encoding needs no snapshot suffix', () => {
  assert.equal(serializeMouseEncoding(null), '');
});
