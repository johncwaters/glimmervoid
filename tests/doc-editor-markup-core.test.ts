import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestEdit } from '../public/doc-editor/markup-core.ts';

function pressEnterThenBackspace(source: string, caret: number) {
  const entered = suggestEdit(source, { kind: 'paragraph', selection: { start: caret, end: caret } }, null);
  assert.equal(entered.kind, 'applied');
  if (entered.kind !== 'applied') return source;
  const deleted = suggestEdit(entered.source, { kind: 'delete', selection: { start: entered.caret, end: entered.caret }, direction: 'backward' }, null);
  assert.equal(deleted.kind, 'applied');
  return deleted.kind === 'applied' ? deleted.source : entered.source;
}

test('Backspace right after a red pen Enter removes the paragraph mark it made', () => {
  assert.equal(pressEnterThenBackspace('abcd efg', 4), 'abcd efg');
  const markedSource = 'ab{~~c~>d~~}ef';
  assert.equal(pressEnterThenBackspace(markedSource, markedSource.indexOf('ef')), markedSource);
});
