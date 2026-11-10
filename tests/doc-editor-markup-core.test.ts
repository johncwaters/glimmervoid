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

function suggestOrFail(source: string, edit: Parameters<typeof suggestEdit>[1]) {
  const outcome = suggestEdit(source, edit, null);
  assert.equal(outcome.kind, 'applied');
  return outcome.kind === 'applied' ? outcome.source : source;
}

function acceptEveryMarkInTurn(source: string): string {
  const firstMark = parseCriticMarkup(source).find((segment) => segment.kind === 'mark');
  if (!firstMark || firstMark.kind !== 'mark') return source;
  return acceptEveryMarkInTurn(resolveMark(source, firstMark, 'accept'));
}

test('accepting a red pen Enter keeps its paragraph break and rejecting it joins the text back', () => {
  const entered = suggestOrFail('abcd efg', { kind: 'paragraph', selection: { start: 4, end: 4 } });
  const paragraphMark = parseCriticMarkup(entered).find((segment) => segment.kind === 'mark');
  assert.ok(paragraphMark && paragraphMark.kind === 'mark');
  assert.equal(resolveMark(entered, paragraphMark, 'accept'), 'abcd\n\n efg');
  assert.equal(resolveMark(entered, paragraphMark, 'reject'), 'abcd efg');
  const enteredTwice = suggestOrFail(entered, { kind: 'paragraph', selection: { start: entered.length - 4, end: entered.length - 4 } });
  assert.equal(acceptEveryMarkInTurn(enteredTwice), 'abcd\n\n\n efg');
  assert.equal(acceptEveryMarkInTurn(suggestOrFail('abcd\nefg', { kind: 'paragraph', selection: { start: 4, end: 4 } })), 'abcd\n\nefg');
});

test('red pen Backspace at a line start and Delete at a line end suggest joining the lines', () => {
  const backspaced = suggestOrFail('abcd\nefg', { kind: 'delete', selection: { start: 5, end: 5 }, direction: 'backward' });
  assert.equal(backspaced, 'abcd{--\n--}efg');
  assert.equal(suggestOrFail('abcd\nefg', { kind: 'delete', selection: { start: 4, end: 4 }, direction: 'forward' }), backspaced);
  assert.equal(acceptEveryMarkInTurn(backspaced), 'abcdefg');
  const entered = suggestOrFail('abcd efg', { kind: 'paragraph', selection: { start: 4, end: 4 } });
  assert.equal(suggestOrFail(entered, { kind: 'delete', selection: { start: 4, end: 4 }, direction: 'forward' }), 'abcd efg');
});

test('rejecting one line of a suggested numbered list closes the gap in the pending numbers after it', () => {
  const numberedSource = '{++1. ++}one\n{++2. ++}two\n{++3. ++}three\n{++4. ++}four\n\n{++9. ++}other';
  const secondMark = parseCriticMarkup(numberedSource).find((segment) => segment.kind === 'mark' && segment.newText === '2. ');
  assert.ok(secondMark && secondMark.kind === 'mark');
  assert.equal(resolveMark(numberedSource, secondMark, 'reject'), '{++1. ++}one\ntwo\n{++2. ++}three\n{++3. ++}four\n\n{++9. ++}other');
  assert.equal(resolveMark(numberedSource, secondMark, 'accept'), '{++1. ++}one\n2. two\n{++3. ++}three\n{++4. ++}four\n\n{++9. ++}other');
});
