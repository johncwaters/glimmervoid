import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCriticMarkup, resolveMark, suggestEdit } from '../public/doc-editor/markup-core.ts';

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

test('accepting a red pen Enter keeps its paragraph break and rejecting it joins the text back', () => {
  const entered = suggestEdit('abcd efg', { kind: 'paragraph', selection: { start: 4, end: 4 } }, null);
  assert.ok(entered.kind === 'applied');
  const paragraphMark = parseCriticMarkup(entered.source).find((segment) => segment.kind === 'mark');
  assert.ok(paragraphMark && paragraphMark.kind === 'mark');
  assert.equal(resolveMark(entered.source, paragraphMark, 'accept'), 'abcd\n\n efg');
  assert.equal(resolveMark(entered.source, paragraphMark, 'reject'), 'abcd efg');
});

test('rejecting one line of a suggested numbered list closes the gap in the pending numbers after it', () => {
  const numberedSource = '{++1. ++}one\n{++2. ++}two\n{++3. ++}three\n{++4. ++}four\n\n{++9. ++}other';
  const secondMark = parseCriticMarkup(numberedSource).find((segment) => segment.kind === 'mark' && segment.newText === '2. ');
  assert.ok(secondMark && secondMark.kind === 'mark');
  assert.equal(resolveMark(numberedSource, secondMark, 'reject'), '{++1. ++}one\ntwo\n{++2. ++}three\n{++3. ++}four\n\n{++9. ++}other');
  assert.equal(resolveMark(numberedSource, secondMark, 'accept'), '{++1. ++}one\n2. two\n{++3. ++}three\n{++4. ++}four\n\n{++9. ++}other');
});
