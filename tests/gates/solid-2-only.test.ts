import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const PUBLIC_TS_AND_TSX_PATTERN = /^public\/.*\.tsx?$/;
const PUBLIC_TSX_PATTERN = /^public\/.*\.tsx$/;

const REMOVED_SUBPATH_REPLACEMENTS: Readonly<Record<string, string>> = {
  'solid-js/web': '@solidjs/web',
  'solid-js/store': 'solid-js',
  'solid-js/h': '@solidjs/h',
  'solid-js/html': '@solidjs/html',
  'solid-js/universal': '@solidjs/universal',
  'solid-js/jsx-runtime': '@solidjs/web',
};

const REMOVED_IMPORT_REPLACEMENTS: Readonly<Record<string, string>> = {
  Suspense: 'Loading',
  SuspenseList: 'Reveal',
  ErrorBoundary: 'Errored',
  mergeProps: 'merge',
  splitProps: 'omit',
  unwrap: 'snapshot',
  onMount: 'onSettled',
  createSelector: 'createProjection (or createStore(fn))',
  equalFn: 'isEqual',
  getListener: 'getObserver',
  batch: 'default microtask batching or flush()',
  createComputed: 'createMemo, split createEffect, or createSignal(fn)',
  createResource: 'async createMemo under <Loading>',
  startTransition: 'built-in transitions (action, isPending, optimistic APIs)',
  useTransition: 'built-in transitions (action, isPending, optimistic APIs)',
  on: 'split createEffect(compute, apply)',
  onError: '<Errored> or createEffect error option',
  catchError: '<Errored> or createEffect error option',
  produce: 'draft-first createStore setter',
  createMutable: 'createStore with draft setters',
  modifyMutable: 'createStore with draft setters',
  observable: 'createEffect to push out or createMemo(() => from(source))',
  Index: '<For keyed={false}>',
  indexArray: 'mapArray',
  resetErrorBoundaries: '<Errored> boundaries heal automatically',
};

const SUBPATH_SPECIFIER_PATTERN = /(?:(?:from|import)\s*['"]|import\s*\(\s*['"])(solid-js\/(?:web|store|h|html|universal|jsx-runtime))['"]/g;
const NAMED_SOLID_IMPORT_OR_EXPORT_PATTERN = /\b(?:import|export)\s*(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*['"](?:solid-js|@solidjs\/web)['"]/g;
const NAMESPACE_SOLID_IMPORT_PATTERN = /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"](?:solid-js|@solidjs\/web)['"]/g;
const DYNAMIC_SOLID_DESTRUCTURE_PATTERN = /\{([^}]+)\}\s*=\s*(?:await\s+)?import\s*\(\s*['"](?:solid-js|@solidjs\/web)['"]\s*\)/g;
const CLASS_DEF_OR_EXPR_PATTERN = /(?:^|[;{}()=,:\s])(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[^{]+)?\s*\{/gm;

const JSX_SOLID_1X_TAG_RULES: ReadonlyArray<{
  pattern: RegExp;
  describeMatch: (match: RegExpMatchArray) => string;
  replacement: string;
}> = [
  {
    pattern: /\bclassList\s*=/g,
    describeMatch: () => 'classList= attribute',
    replacement: 'class={{ ... }} or class={[...]}',
  },
  {
    pattern: /\buse:[A-Za-z_$][\w$]*/g,
    describeMatch: (match) => `${match[0]} directive`,
    replacement: 'ref={directive(arg)}',
  },
  {
    pattern: /\battr:[A-Za-z_$][\w$-]*/g,
    describeMatch: (match) => `${match[0]} namespace`,
    replacement: 'standard lowercase HTML attribute',
  },
  {
    pattern: /\bbool:[A-Za-z_$][\w$-]*/g,
    describeMatch: (match) => `${match[0]} namespace`,
    replacement: 'standard boolean attribute',
  },
  {
    pattern: /\bon:[A-Za-z_$][\w$-]*/g,
    describeMatch: (match) => `${match[0]} namespace`,
    replacement: 'camelCase event prop (onClick) or ref addEventListener',
  },
  {
    pattern: /\boncapture:[A-Za-z_$][\w$-]*/g,
    describeMatch: (match) => `${match[0]} namespace`,
    replacement: 'ref callback calling addEventListener(..., { capture: true })',
  },
  {
    pattern: /\btabIndex\s*=/g,
    describeMatch: () => 'tabIndex= attribute',
    replacement: 'lowercase tabindex=',
  },
];

interface JsxTagSpan {
  text: string;
  start: number;
}

function stripCommentsPreservingLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function jsxOpeningTagsIn(source: string): JsxTagSpan[] {
  const tags: JsxTagSpan[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '<' || !/[A-Za-z]/.test(source[index + 1] ?? '')) continue;
    const prev = index > 0 ? source[index - 1] : '';
    if (/[A-Za-z0-9_$)]/.test(prev)) continue;
    let braceDepth = 0;
    let quote: string | null = null;
    let end = index + 1;
    while (end < source.length) {
      const ch = source[end];
      if (quote) {
        if (ch === '\\' && end + 1 < source.length) {
          end += 2;
          continue;
        }
        if (ch === quote) quote = null;
        end += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        end += 1;
        continue;
      }
      if (ch === '{') {
        braceDepth += 1;
        end += 1;
        continue;
      }
      if (ch === '}' && braceDepth > 0) {
        braceDepth -= 1;
        end += 1;
        continue;
      }
      if (ch === '>' && braceDepth === 0) break;
      end += 1;
    }
    if (source[end] === '>') {
      tags.push({ text: source.slice(index, end + 1), start: index });
      index = end;
    }
  }
  return tags;
}

function checkSpecifierList(
  repoPath: string,
  source: string,
  blockStart: number,
  blockText: string,
  specifierBody: string,
  violations: string[],
): void {
  for (const rawSpecifier of specifierBody.split(',')) {
    const cleaned = rawSpecifier.trim().replace(/^type\s+/, '');
    if (!cleaned) continue;
    const importedName = cleaned.split(/\s+as\s+|:/)[0]?.trim() ?? '';
    const replacement = REMOVED_IMPORT_REPLACEMENTS[importedName];
    if (!replacement) continue;
    const offset = blockText.indexOf(importedName);
    const line = lineNumberAt(source, blockStart + Math.max(0, offset));
    violations.push(`${repoPath}:${line}: 1.x API "${importedName}" -> use ${replacement}`);
  }
}

function solid1xViolationsIn(repoPath: string, rawSource: string): string[] {
  const source = stripCommentsPreservingLines(rawSource);
  const violations: string[] = [];

  for (const match of source.matchAll(SUBPATH_SPECIFIER_PATTERN)) {
    const subpath = match[1] ?? '';
    const replacement = REMOVED_SUBPATH_REPLACEMENTS[subpath];
    if (!replacement) continue;
    const line = lineNumberAt(source, match.index ?? 0);
    violations.push(`${repoPath}:${line}: 1.x subpath "${subpath}" -> use "${replacement}"`);
  }

  for (const match of source.matchAll(NAMED_SOLID_IMPORT_OR_EXPORT_PATTERN)) {
    checkSpecifierList(repoPath, source, match.index ?? 0, match[0], match[1] ?? '', violations);
  }

  for (const match of source.matchAll(DYNAMIC_SOLID_DESTRUCTURE_PATTERN)) {
    checkSpecifierList(repoPath, source, match.index ?? 0, match[0], match[1] ?? '', violations);
  }

  for (const match of source.matchAll(NAMESPACE_SOLID_IMPORT_PATTERN)) {
    const namespaceName = match[1] ?? '';
    if (!namespaceName) continue;
    const accessPattern = new RegExp(`\\b${namespaceName}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const accessMatch of source.matchAll(accessPattern)) {
      const apiName = accessMatch[1] ?? '';
      const replacement = REMOVED_IMPORT_REPLACEMENTS[apiName];
      if (!replacement) continue;
      const line = lineNumberAt(source, accessMatch.index ?? 0);
      violations.push(`${repoPath}:${line}: 1.x API "${apiName}" -> use ${replacement}`);
    }
  }

  if (!repoPath.endsWith('.tsx')) return violations;

  for (const tag of jsxOpeningTagsIn(source)) {
    const providerMatch = /^<([A-Za-z_$][\w$.]*\.Provider)\b/.exec(tag.text);
    if (providerMatch) {
      const line = lineNumberAt(source, tag.start);
      violations.push(`${repoPath}:${line}: 1.x <${providerMatch[1]}> -> use <Context value={...}> (context itself is the provider)`);
    }
    for (const rule of JSX_SOLID_1X_TAG_RULES) {
      for (const match of tag.text.matchAll(rule.pattern)) {
        const line = lineNumberAt(source, tag.start + (match.index ?? 0));
        violations.push(`${repoPath}:${line}: 1.x ${rule.describeMatch(match)} -> use ${rule.replacement}`);
      }
    }
  }

  return violations;
}

function tsxConventionViolationsIn(repoPath: string, rawSource: string): string[] {
  const source = stripCommentsPreservingLines(rawSource);
  const violations: string[] = [];

  for (const tag of jsxOpeningTagsIn(source)) {
    for (const match of tag.text.matchAll(/\bstyle\s*=\s*(?:\{|['"])/g)) {
      const line = lineNumberAt(source, tag.start + (match.index ?? 0));
      violations.push(`${repoPath}:${line}: forbidden inline style= attribute -> use existing semantic classes and [data-state] attributes`);
    }
    for (const match of tag.text.matchAll(/\.\.\.\s*\{[^}]*\bstyle\s*:/g)) {
      const line = lineNumberAt(source, tag.start + (match.index ?? 0));
      violations.push(`${repoPath}:${line}: forbidden inline style= attribute -> use existing semantic classes and [data-state] attributes`);
    }
  }

  for (const match of source.matchAll(CLASS_DEF_OR_EXPR_PATTERN)) {
    const classOffset = match[0].indexOf('class');
    const line = lineNumberAt(source, (match.index ?? 0) + Math.max(0, classOffset));
    violations.push(`${repoPath}:${line}: forbidden class declaration -> use a plain function component (one function per .tsx file, no classes)`);
  }

  return violations;
}

test('public/**/*.{ts,tsx} files contain no Solid 1.x-only imports, APIs, directives, or attributes', () => {
  const sourceFiles = trackedFiles(PUBLIC_TS_AND_TSX_PATTERN);
  assert.ok(sourceFiles.length > 0, 'expected tracked public/**/*.{ts,tsx} files');

  const violations = sourceFiles.flatMap((repoPath) => solid1xViolationsIn(repoPath, readTracked(repoPath)));
  assert.deepEqual(
    violations,
    [],
    `Found Solid 1.x forms in public/ (read node_modules/solid-js/CHEATSHEET.md):\n  ${violations.join('\n  ')}`,
  );
});

test('public/**/*.tsx files avoid inline style= attributes and class declarations', () => {
  const tsxFiles = trackedFiles(PUBLIC_TSX_PATTERN);
  assert.ok(tsxFiles.length > 0, 'expected at least one tracked public/**/*.tsx file');

  const violations = tsxFiles.flatMap((repoPath) => tsxConventionViolationsIn(repoPath, readTracked(repoPath)));
  assert.deepEqual(
    violations,
    [],
    `Found .tsx convention violations (see public/AGENTS.md Solid 2 Components):\n  ${violations.join('\n  ')}`,
  );
});

test('solid-2-only gate fails on planted 1.x forms and .tsx convention violations with file, line, form, and replacement', () => {
  const plantedTsx = [
    "import { render } from 'solid-js/web';",
    "import * as Solid from 'solid-js';",
    "import{onMount,createResource,Suspense}from'solid-js';",
    "export { batch } from 'solid-js';",
    'export function BadComponent() {',
    '  Solid.onMount(() => {});',
    '  const style = "compact";',
    '  return <div classList={{ active: true }} use:tooltip={1} tabIndex={0} style={{ color: "red" }} {...{ style: { margin: 0 } }}><Contexts.Theme.Provider value={style}>First class Support</Contexts.Theme.Provider></div>;',
    '}',
    'class helperClass {}',
    'const Widget = class {};',
  ].join('\n');

  const solid1xViolations = solid1xViolationsIn('public/planted-example.tsx', plantedTsx);
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:1:') && line.includes('solid-js/web') && line.includes('@solidjs/web')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:3:') && line.includes('onMount') && line.includes('onSettled')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:3:') && line.includes('createResource') && line.includes('createMemo')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:3:') && line.includes('Suspense') && line.includes('Loading')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:4:') && line.includes('batch') && line.includes('flush()')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:6:') && line.includes('onMount') && line.includes('onSettled')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:8:') && line.includes('classList=') && line.includes('class=')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:8:') && line.includes('use:tooltip') && line.includes('ref=')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:8:') && line.includes('tabIndex=') && line.includes('tabindex=')));
  assert.ok(solid1xViolations.some((line) => line.includes('public/planted-example.tsx:8:') && line.includes('<Contexts.Theme.Provider>') && line.includes('<Context value={...}>')));

  const conventionViolations = tsxConventionViolationsIn('public/planted-example.tsx', plantedTsx);
  assert.equal(conventionViolations.filter((line) => line.includes(':7:')).length, 0);
  assert.equal(conventionViolations.filter((line) => line.includes(':8:') && line.includes('class declaration')).length, 0);
  assert.equal(conventionViolations.filter((line) => line.includes(':8:') && line.includes('style=')).length, 2);
  assert.ok(conventionViolations.some((line) => line.includes('public/planted-example.tsx:10:') && line.includes('class declaration')));
  assert.ok(conventionViolations.some((line) => line.includes('public/planted-example.tsx:11:') && line.includes('class declaration')));

  const plantedTs = "import 'solid-js/store';\nconst { createResource } = await import('solid-js');\n";
  const tsViolations = solid1xViolationsIn('public/ui/planted-helper.ts', plantedTs);
  assert.ok(tsViolations.some((line) => line.includes('public/ui/planted-helper.ts:1:') && line.includes('solid-js/store') && line.includes('solid-js')));
  assert.ok(tsViolations.some((line) => line.includes('public/ui/planted-helper.ts:2:') && line.includes('createResource') && line.includes('createMemo')));
});
