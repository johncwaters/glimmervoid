import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { overCapPage, signInPage, wakeLimitedPage, wakingPage } from '../../cloud/doorman/host-page.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const OFFLINE_PAGE_SOURCE = 'public/service-worker.ts';
const SCREEN_SOURCES = [OFFLINE_PAGE_SOURCE, 'cloud/doorman/host-page.ts'];
const PAGE_BODY_CONSTANT = /const (\w+_PAGE_BODY) = `([\s\S]*?)`;/g;
const OFFLINE_PAGE_KIND_COUNT = 3;
const ONE_MESSAGE = /^\s*<h1>[^<]+<\/h1>\s*<p[^>]*>[^<]+<\/p>\s*(?:<a [^>]*>[^<]+<\/a>\s*)?$/;
const MARKUP_WRITING_CALL = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/;
const DOORMAN_PAGE_SHAPE = /^<!doctype html><html[^>]*><head>[\s\S]*<\/head><body><main[^>]*>([\s\S]*)<\/main><script>[\s\S]*<\/script><\/body><\/html>$/;
const BRAND_MARK = /^<svg class="mark"[^>]*>(?:<path [^>]*\/>)+<\/svg>/;
const PROGRESS_BAR = /<div class="bar" aria-hidden="true"><div class="bar-fill"><\/div><\/div>$/;

const DOORMAN_PAGES: Record<string, string> = {
  waking: wakingPage({ phase: 'waking', elapsedMs: 4000, didLastWakeFail: false, isColdStart: false }, 5),
  wakingAfterFailedTry: wakingPage({ phase: 'waking', elapsedMs: 40000, didLastWakeFail: true, isColdStart: false }, 5),
  coldStart: wakingPage({ phase: 'waking', elapsedMs: 4000, didLastWakeFail: false, isColdStart: true }, 5),
  holding: wakingPage({ phase: 'holding', retryInMs: 30000 }, 5),
  wakeLimited: wakeLimitedPage(12),
  overCap: overCapPage('2026-12-01T00:00:00.000Z'),
  signIn: signInPage('https://accounts.example/'),
};

test('every offline page is one heading, one line of body text and at most one action, per the one message per screen principle', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, OFFLINE_PAGE_SOURCE), 'utf8');
  const pageBodies = [...source.matchAll(PAGE_BODY_CONSTANT)];
  assert.equal(pageBodies.length, OFFLINE_PAGE_KIND_COUNT, `expected ${OFFLINE_PAGE_KIND_COUNT} *_PAGE_BODY constants in ${OFFLINE_PAGE_SOURCE}`);
  assert.deepEqual(pageBodies.filter(([, , markup]) => !ONE_MESSAGE.test(markup)).map(([, constantName]) => constantName), []);
});

test('every Cloud doorman page is one heading, one line of body text and at most one action beside the brand mark and progress bar', () => {
  const offending = Object.entries(DOORMAN_PAGES).filter(([, html]) => {
    const mainContent = DOORMAN_PAGE_SHAPE.exec(html)?.[1];
    if (mainContent === undefined || !BRAND_MARK.test(mainContent)) return true;
    return !ONE_MESSAGE.test(mainContent.replace(BRAND_MARK, '').replace(PROGRESS_BAR, ''));
  });
  assert.deepEqual(offending.map(([pageName]) => pageName), []);
});

test('no screen script writes markup, so the markup the gate reads is the whole screen', () => {
  const writingSources = SCREEN_SOURCES.filter((relativePath) => MARKUP_WRITING_CALL.test(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')));
  assert.deepEqual(writingSources, []);
});
