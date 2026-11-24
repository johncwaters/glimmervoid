import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const OFFLINE_PAGE_SOURCE = 'public/service-worker.ts';
const PAGE_BODY_CONSTANT = /const (\w+_PAGE_BODY) = `([\s\S]*?)`;/g;
const OPENING_TAG = /<([a-z][a-z0-9]*)\b/gi;
const ANY_OPENING_TAG = /<[a-z]/i;
const PAGE_SCRIPT_CONSTANT = /const (\w+_SCRIPT) = `([\s\S]*?)`;/g;
const OFFLINE_PAGE_KIND_COUNT = 3;
const MOST_TAGS_PER_SCREEN: Record<string, number> = { h1: 1, p: 1, a: 1 };

function countTags(markup: string): Map<string, number> {
  const countByTag = new Map<string, number>();
  for (const match of markup.matchAll(OPENING_TAG)) countByTag.set(match[1].toLowerCase(), (countByTag.get(match[1].toLowerCase()) ?? 0) + 1);
  return countByTag;
}

test('every offline page shows one heading, at most one line of body text and at most one action, per the one message per screen principle', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, OFFLINE_PAGE_SOURCE), 'utf8');
  const pageBodies = [...source.matchAll(PAGE_BODY_CONSTANT)];
  assert.equal(pageBodies.length, OFFLINE_PAGE_KIND_COUNT, `expected ${OFFLINE_PAGE_KIND_COUNT} *_PAGE_BODY constants in ${OFFLINE_PAGE_SOURCE}`);
  const overflowing = pageBodies.flatMap(([, constantName, markup]) => {
    const countByTag = countTags(markup);
    return [...countByTag].filter(([tag, count]) => count > (MOST_TAGS_PER_SCREEN[tag] ?? 0)).map(([tag, count]) => `${constantName}: ${count} <${tag}>`);
  });
  assert.deepEqual(overflowing, []);
  for (const [, constantName, markup] of pageBodies) assert.equal(countTags(markup).get('h1'), 1, `${constantName} needs exactly one <h1>`);
});

test('no offline page script writes markup, so the page bodies the gate counts are the whole screen', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, OFFLINE_PAGE_SOURCE), 'utf8');
  const scriptsWritingMarkup = [...source.matchAll(PAGE_SCRIPT_CONSTANT)].filter(([, , script]) => ANY_OPENING_TAG.test(script)).map(([, constantName]) => constantName);
  assert.deepEqual(scriptsWritingMarkup, []);
});
