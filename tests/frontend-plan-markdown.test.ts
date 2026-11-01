import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlanMarkdown } from '../public/plan/plan-markdown-core.ts';

class FakeText {
  readonly textContent: string;

  constructor(textContent: string) {
    this.textContent = textContent;
  }
}

class FakeElement {
  readonly children: (FakeElement | FakeText)[] = [];
  className = '';
  href = '';
  id = '';
  rel = '';
  target = '';
  private ownText = '';

  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...children: (FakeElement | FakeText)[]) {
    this.children.push(...children);
  }

  querySelectorAll(selector: string) {
    return descendants(this).filter((node) => node.tagName === selector);
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(text: string) {
    this.ownText = text;
    this.children.length = 0;
  }
}

function descendants(root: FakeElement): FakeElement[] {
  const nested = root.children.filter((child): child is FakeElement => child instanceof FakeElement);
  return [root, ...nested.flatMap(descendants)];
}

test('plan rendering keeps safe links and leaves unsafe URLs and raw HTML as text', async () => {
  const fakeDocument = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  const { renderPlanBlocks } = await import('../public/plan/plan-render.ts');
  const markdown = [
    '[web](https://example.com/path) [plain](http://example.org)',
    '[script](javascript:alert(1)) [payload](data:text/html;base64,abc)',
    '<script>alert(1)</script>',
  ].join('\n\n');
  const root = renderPlanBlocks(parsePlanMarkdown(markdown));
  const links = Array.from(root.querySelectorAll('a'));
  assert.deepEqual(links.map((link) => link.href), ['https://example.com/path', 'http://example.org/']);
  assert.deepEqual(links.map((link) => [link.target, link.rel]), [
    ['_blank', 'noopener noreferrer'],
    ['_blank', 'noopener noreferrer'],
  ]);
  assert.match(root.textContent, /script payload/);
  assert.match(root.textContent, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(root.textContent, /javascript:|data:text/);
});

test('a fenced code info string renders at most one safe language class', async () => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => new FakeText(text),
    },
  });
  const { renderPlanBlocks } = await import('../public/plan/plan-render.ts');
  const markdown = [
    '```js dialog-overlay',
    'alert(1)',
    '```',
    '',
    '```plan face" onclick="x',
    'body',
    '```',
    '',
    '```<script>',
    'body',
    '```',
  ].join('\n');
  const blocks = parsePlanMarkdown(markdown);
  const codeBlocks = blocks.filter((block) => block.type === 'code');
  assert.deepEqual(codeBlocks.map((block) => block.type === 'code' && block.language), ['js', 'plan', '']);
  const root = renderPlanBlocks(blocks);
  const codeClasses = Array.from(root.querySelectorAll('code')).map((node) => node.className);
  assert.deepEqual(codeClasses, ['language-js', 'language-plan', '']);
});

test('GitHub issue text keeps intraword underscores, links bare URLs and shows img tags as a placeholder', () => {
  const [paragraph] = parsePlanMarkdown('?order_by=_created_by see https://github.com/a/b/pull/1. <img src="https://x.test/y.png"><br>');
  assert.deepEqual(paragraph, {
    type: 'paragraph',
    children: [
      { type: 'text', text: '?order_by=_created_by see ' },
      { type: 'link', href: 'https://github.com/a/b/pull/1', children: [{ type: 'text', text: 'https://github.com/a/b/pull/1' }] },
      { type: 'text', text: '. (image)' },
    ],
  });
});
