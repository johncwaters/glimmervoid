import test from 'node:test';
import assert from 'node:assert/strict';

import { findUrls, trimTrailingPunctuation } from '../public/session-card/link-detect-core.ts';

test('findUrls: bare URL in prose, offsets cover exactly the URL', () => {
  const text = 'see https://example.com/docs for details';
  assert.deepEqual(findUrls(text), [
    { start: 4, end: 28, url: 'https://example.com/docs' },
  ]);
  assert.equal(text.slice(4, 28), 'https://example.com/docs');
});

test('findUrls: http and https both match, other schemes do not', () => {
  assert.equal(findUrls('http://example.com').length, 1);
  assert.equal(findUrls('ftp://example.com file:///etc/passwd').length, 0);
});

test('findUrls: multiple URLs on one line', () => {
  const urls = findUrls('a https://one.dev b https://two.dev c').map((f) => f.url);
  assert.deepEqual(urls, ['https://one.dev', 'https://two.dev']);
});

test('findUrls: trailing sentence punctuation is not part of the URL', () => {
  assert.equal(findUrls('go to https://example.com/a.')[0].url, 'https://example.com/a');
  assert.equal(findUrls('really? https://example.com/a?!')[0].url, 'https://example.com/a');
  assert.equal(findUrls('"https://example.com/a"')[0].url, 'https://example.com/a');
});

test('findUrls: wrapping parens stripped, balanced parens kept', () => {
  assert.equal(findUrls('(https://example.com/a)')[0].url, 'https://example.com/a');
  assert.equal(
    findUrls('https://en.wikipedia.org/wiki/Foo_(bar)')[0].url,
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  );
});

test('findUrls: query strings and fragments survive', () => {
  const url = 'https://github.com/owner/repo/pull/12#issuecomment-9?x=1&y=2';
  assert.equal(findUrls(`PR: ${url}`)[0].url, url);
});

test('findUrls: a bare scheme is not a link', () => {
  assert.deepEqual(findUrls('the https:// prefix means TLS'), []);
});

test('findUrls: no URLs means empty result', () => {
  assert.deepEqual(findUrls(''), []);
  assert.deepEqual(findUrls('plain text only'), []);
});

test('trimTrailingPunctuation: strips stacked punctuation', () => {
  assert.equal(trimTrailingPunctuation('https://x.dev/a).,'), 'https://x.dev/a');
  assert.equal(trimTrailingPunctuation('https://x.dev/(a)'), 'https://x.dev/(a)');
});
