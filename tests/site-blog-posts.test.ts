import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { formatDate } from '../site/src/lib/format-date.ts';

const SITE_ROOT = path.join(import.meta.dirname, '..', 'site');
const BLOG_CONTENT_DIRECTORY = path.join(SITE_ROOT, 'src', 'content', 'blog');
const SITE_PUBLIC_DIRECTORY = path.join(SITE_ROOT, 'public');

const postFileNames = fs.readdirSync(BLOG_CONTENT_DIRECTORY).filter((fileName) => fileName.endsWith('.md'));

const postSlugs = postFileNames.map((fileName) => fileName.replace(/\.md$/, ''));

function readPost(slug: string): string {
  return fs.readFileSync(path.join(BLOG_CONTENT_DIRECTORY, `${slug}.md`), 'utf8');
}

function isDraft(postSource: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(postSource)?.[1] ?? '';
  return /^draft:\s*true\s*$/m.test(frontmatter);
}

const publishedPostSlugs = postSlugs.filter((slug) => !isDraft(readPost(slug)));

function relativeTargets(postSource: string): string[] {
  const markdownTargets = [...postSource.matchAll(/\]\((\.\.\/[^)\s]+)\)/g)].map((match) => match[1] ?? '');
  const attributeTargets = [...postSource.matchAll(/(?:src|poster|href)="(\.\.\/[^"]+)"/g)].map((match) => match[1] ?? '');
  return [...markdownTargets, ...attributeTargets];
}

test('the blog has posts to check', () => {
  assert.ok(postSlugs.length > 0);
});

test('every blog post file name is already the slug its route is built under', () => {
  for (const fileName of postFileNames) {
    assert.match(fileName, /^[a-z0-9]+(-[a-z0-9]+)*\.md$/, `${fileName} is not a lowercase kebab-case slug`);
  }
});

test('every published blog post has its social preview image', () => {
  for (const slug of publishedPostSlugs) {
    assert.ok(fs.existsSync(path.join(SITE_PUBLIC_DIRECTORY, 'blog', `${slug}.png`)), `missing site/public/blog/${slug}.png`);
  }
});

test('every blog post has a calendar publish date', () => {
  for (const slug of postSlugs) assert.match(readPost(slug), /^pubDate: \d{4}-\d{2}-\d{2}$/m, `bad pubDate in ${slug}`);
});

test('every relative link in a post resolves to a published post or a shipped asset', () => {
  for (const slug of postSlugs) {
    for (const target of relativeTargets(readPost(slug))) {
      const crossPostLink = /^\.\.\/([a-z0-9-]+)\/$/.exec(target);
      if (crossPostLink) {
        assert.ok(publishedPostSlugs.includes(crossPostLink[1] ?? ''), `${slug} links to missing or draft post ${target}`);
        continue;
      }
      const assetPath = target.replace(/^\.\.\/\.\.\//, '');
      assert.notEqual(assetPath, target, `${slug} has a relative link that is neither a post nor a site asset: ${target}`);
      assert.ok(fs.existsSync(path.join(SITE_PUBLIC_DIRECTORY, assetPath)), `${slug} references missing asset ${target}`);
    }
  }
});

test('a publish date renders as the same calendar day in every timezone', () => {
  assert.equal(formatDate(new Date('2026-09-14')), 'September 14, 2026');
});
