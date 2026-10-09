import assert from 'node:assert';
import { test } from 'node:test';
import { escapeMarkup } from '../shared/escape-markup.ts';

test('escapeMarkup escapes the five markup-significant characters and nothing else', () => {
  assert.equal(escapeMarkup(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(escapeMarkup('plain text 123'), 'plain text 123');
  assert.equal(escapeMarkup('&amp;'), '&amp;amp;');
});

test('escapeMarkup stringifies non-string input', () => {
  assert.equal(escapeMarkup(42), '42');
  assert.equal(escapeMarkup(null), 'null');
  assert.equal(escapeMarkup(undefined), 'undefined');
});
