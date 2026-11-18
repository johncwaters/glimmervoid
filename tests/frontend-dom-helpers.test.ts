import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { isRealInputOwningKey } from '../public/dom-helpers.ts';
import { stubGlobalForTest } from './helpers/frontend-global-stub.ts';

class FakeHTMLElement {
  readonly tagName: string;
  readonly isContentEditable = false;
  readonly dataset: Record<string, string> = {};
  readonly classList = { contains: () => false };

  constructor(tagName: string) {
    this.tagName = tagName;
  }
}

class FakeHTMLSelectElement extends FakeHTMLElement {}

class FakeHTMLTextAreaElement extends FakeHTMLElement {}

test('a focused select owns single-letter keys so panel shortcuts leave its type-ahead alone', (context) => {
  stubGlobalForTest(context, 'HTMLElement', FakeHTMLElement);
  stubGlobalForTest(context, 'HTMLSelectElement', FakeHTMLSelectElement);
  stubGlobalForTest(context, 'HTMLTextAreaElement', FakeHTMLTextAreaElement);
  stubGlobalForTest(context, 'document', { activeElement: new FakeHTMLSelectElement('SELECT') });
  const letterKey = new Event('keydown');
  Object.defineProperty(letterKey, 'key', { value: 'k' });
  assert.equal(isRealInputOwningKey(letterKey as KeyboardEvent), true);
});

test('a shortcut-allowing composer keeps Escape and undo while releasing the next-session chord', (context) => {
  const composer = new FakeHTMLTextAreaElement('TEXTAREA');
  composer.dataset.dashboardShortcuts = 'allowed';
  stubGlobalForTest(context, 'HTMLElement', FakeHTMLElement);
  stubGlobalForTest(context, 'HTMLSelectElement', FakeHTMLSelectElement);
  stubGlobalForTest(context, 'HTMLTextAreaElement', FakeHTMLTextAreaElement);
  stubGlobalForTest(context, 'document', { activeElement: composer });
  const keydownOf = (key: string, code: string) => {
    const keydown = new Event('keydown');
    Object.defineProperties(keydown, { key: { value: key }, code: { value: code }, metaKey: { value: true } });
    return keydown as KeyboardEvent;
  };
  assert.equal(isRealInputOwningKey(keydownOf('Escape', 'Escape')), true);
  assert.equal(isRealInputOwningKey(keydownOf('z', 'KeyZ')), true);
  assert.equal(isRealInputOwningKey(keydownOf('j', 'KeyJ')), false);
});
