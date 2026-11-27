import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';
import {
  PUBLIC_SOURCE_PATTERN,
  STATE_ACTIONS_DIR_PATTERN,
  STATE_COLLECTIONS_DIR_PATTERN,
  findMatchesWithLines,
} from '../../scripts/state-inventory.ts';
import type { TrackedSourceFile } from '../../scripts/state-inventory.ts';

const DEFINE_EXEMPT_FILES = new Set([
  'public/state/define-collection.ts',
  'public/state/define-action.ts',
]);

const FORBIDDEN_SOLID_PRIMITIVES = new Map<string, string>([
  ['createStore', 'public/state/define-collection.ts defineCollection'],
  ['createOptimisticStore', 'public/state/define-collection.ts defineCollection'],
  ['action', 'public/state/define-action.ts defineAction'],
]);

const SOLID_MODULE_SPECIFIER = "(?:solid-js|@solidjs\\/signals)";
const NAMED_SOLID_IMPORT_OR_EXPORT = new RegExp(`\\b(?:import|export)\\s*(?!type\\b)(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]+)\\}\\s*from\\s*['"]${SOLID_MODULE_SPECIFIER}['"]`, 'g');
const STAR_SOLID_EXPORT = new RegExp(`\\bexport\\s*\\*\\s*(?:as\\s+[A-Za-z_$][\\w$]*\\s+)?from\\s*['"]${SOLID_MODULE_SPECIFIER}['"]`, 'g');
const NAMESPACE_SOLID_IMPORT_PATTERN = new RegExp(`\\bimport\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]${SOLID_MODULE_SPECIFIER}['"]`, 'g');
const DYNAMIC_SOLID_IMPORT_PATTERN = new RegExp(`\\bimport\\s*\\(\\s*['"]${SOLID_MODULE_SPECIFIER}['"]\\s*\\)`, 'g');

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPreservingLines(sourceText: string, stripStrings: boolean): string {
  const chunks: string[] = [];
  let keptFrom = 0;
  let index = 0;
  while (index < sourceText.length) {
    const ch = sourceText[index];
    const next = sourceText[index + 1];
    if (ch === '/' && next === '/') {
      const lineEnd = sourceText.indexOf('\n', index + 2);
      const end = lineEnd < 0 ? sourceText.length : lineEnd;
      chunks.push(sourceText.slice(keptFrom, index), ' '.repeat(end - index));
      index = end;
      keptFrom = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const blockEnd = sourceText.indexOf('*/', index + 2);
      const end = blockEnd < 0 ? sourceText.length : blockEnd + 2;
      chunks.push(sourceText.slice(keptFrom, index), sourceText.slice(index, end).replace(/[^\n]/g, ' '));
      index = end;
      keptFrom = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = index;
      index += 1;
      while (index < sourceText.length) {
        if (sourceText[index] === '\\') {
          index += 2;
          continue;
        }
        if (sourceText[index] === ch) {
          index += 1;
          break;
        }
        index += 1;
      }
      if (stripStrings) {
        chunks.push(sourceText.slice(keptFrom, start), sourceText.slice(start, index).replace(/[^\n]/g, ' '));
        keptFrom = index;
      }
      continue;
    }
    index += 1;
  }
  chunks.push(sourceText.slice(keptFrom));
  return chunks.join('');
}

function lineAtOffset(sourceText: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (sourceText.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function skipWhitespace(source: string, startOffset: number): number {
  let index = startOffset;
  while (index < source.length && /\s/.test(source[index] ?? '')) index += 1;
  return index;
}

function offsetAfterBalancedAngles(source: string, openOffset: number): number {
  let depth = 0;
  let index = openOffset;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '=' && source[index + 1] === '>') {
      index += 2;
      continue;
    }
    if (ch === '<') depth += 1;
    if (ch === '>') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

function callParenOffsetAfterIdent(source: string, afterIdentOffset: number): number {
  let index = skipWhitespace(source, afterIdentOffset);
  if (source[index] === '<') {
    const afterAngles = offsetAfterBalancedAngles(source, index);
    if (afterAngles === -1) return -1;
    index = skipWhitespace(source, afterAngles);
  }
  return source[index] === '(' ? index : -1;
}

function findTopLevelAssignmentEquals(source: string, startOffset: number): number {
  let index = startOffset;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '=' && next === '>') {
      index += 2;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    if (ch === ')') parenDepth -= 1;
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth -= 1;
    if (ch === '[') bracketDepth += 1;
    if (ch === ']') bracketDepth -= 1;
    if (ch === '<') angleDepth += 1;
    if (ch === '>' && angleDepth > 0) angleDepth -= 1;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      if (ch === ';' || ch === '\n') return -1;
      if (ch === '=' && next !== '=' && source[index - 1] !== '!' && source[index - 1] !== '<' && source[index - 1] !== '>') {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

function hasFactoryCallAt(codeOnly: string, startOffset: number, factoryName: 'defineCollection' | 'defineAction'): boolean {
  const offset = skipWhitespace(codeOnly, startOffset);
  if (!codeOnly.startsWith(factoryName, offset)) return false;
  const afterIdent = offset + factoryName.length;
  if (/[\w$]/.test(codeOnly[afterIdent] ?? '')) return false;
  return callParenOffsetAfterIdent(codeOnly, afterIdent) !== -1;
}

function hasDefaultExportOfFactory(codeOnly: string, factoryName: 'defineCollection' | 'defineAction'): boolean {
  for (const match of codeOnly.matchAll(/\bexport\s+default\b/g)) {
    const afterDefault = (match.index ?? 0) + match[0].length;
    if (hasFactoryCallAt(codeOnly, afterDefault, factoryName)) return true;

    const identMatch = /^\s+([A-Za-z_$][\w$]*)\s*;?/.exec(codeOnly.slice(afterDefault));
    const bindingName = identMatch?.[1];
    if (!bindingName) continue;

    const declPattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(bindingName)}\\b`, 'g');
    for (const declMatch of codeOnly.matchAll(declPattern)) {
      const afterName = (declMatch.index ?? 0) + declMatch[0].length;
      const equalsOffset = findTopLevelAssignmentEquals(codeOnly, afterName);
      if (equalsOffset === -1) continue;
      if (hasFactoryCallAt(codeOnly, equalsOffset + 1, factoryName)) return true;
    }
  }
  return false;
}

function checkSolidSpecifierBlock(
  repoPath: string,
  sourceWithoutComments: string,
  blockStart: number,
  blockText: string,
  specifierBody: string,
  violations: string[],
): void {
  for (const rawSpecifier of specifierBody.split(',')) {
    const cleaned = rawSpecifier.trim().replace(/^type\s+/, '');
    if (!cleaned) continue;
    const importedName = cleaned.split(/\s+as\s+|:/)[0]?.trim() ?? '';
    const replacement = FORBIDDEN_SOLID_PRIMITIVES.get(importedName);
    if (!replacement) continue;
    const offsetInBlock = Math.max(0, blockText.indexOf(importedName));
    const line = lineAtOffset(sourceWithoutComments, blockStart + offsetInBlock);
    violations.push(
      `${repoPath}:${line}: forbidden Solid primitive "${importedName}" outside define-collection.ts / define-action.ts -> use ${replacement}`,
    );
  }
}

function checkNamespaceBindingUses(
  repoPath: string,
  withoutComments: string,
  codeOnly: string,
  bindingName: string,
  violations: string[],
): void {
  const escapedBinding = escapeRegExp(bindingName);
  for (const [symbol, replacement] of FORBIDDEN_SOLID_PRIMITIVES) {
    const dotAccessPattern = new RegExp(`(?<![.\\w$])${escapedBinding}\\.${symbol}(?![\\w$])`, 'g');
    for (const match of findMatchesWithLines(codeOnly, dotAccessPattern)) {
      violations.push(
        `${repoPath}:${match.line}: forbidden "${match.form}" outside define-collection.ts / define-action.ts -> use ${replacement}`,
      );
    }
    const bracketAccessPattern = new RegExp(`(?<![.\\w$])${escapedBinding}\\s*\\[\\s*['"]${symbol}['"]\\s*\\]`, 'g');
    for (const match of findMatchesWithLines(withoutComments, bracketAccessPattern)) {
      violations.push(
        `${repoPath}:${match.line}: forbidden "${match.form}" outside define-collection.ts / define-action.ts -> use ${replacement}`,
      );
    }
  }

  const destructurePattern = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${escapedBinding}(?![\\w$])`, 'g');
  for (const match of withoutComments.matchAll(destructurePattern)) {
    checkSolidSpecifierBlock(repoPath, withoutComments, match.index ?? 0, match[0], match[1] ?? '', violations);
  }
}

function checkDirectPrimitiveCalls(repoPath: string, codeOnly: string, violations: string[]): void {
  for (const symbol of ['createStore', 'createOptimisticStore'] as const) {
    const pattern = new RegExp(`(?<![.\\w$])${symbol}\\b`, 'g');
    for (const match of codeOnly.matchAll(pattern)) {
      const start = match.index ?? 0;
      const parenOffset = callParenOffsetAfterIdent(codeOnly, start + symbol.length);
      if (parenOffset === -1) continue;
      const line = lineAtOffset(codeOnly, start);
      violations.push(
        `${repoPath}:${line}: forbidden "${symbol}(" outside define-collection.ts / define-action.ts -> use public/state/define-collection.ts defineCollection`,
      );
    }
  }

  for (const match of codeOnly.matchAll(/(?<![.\w$])action\b/g)) {
    const start = match.index ?? 0;
    const parenOffset = callParenOffsetAfterIdent(codeOnly, start + 'action'.length);
    if (parenOffset === -1) continue;
    if (!/^\(\s*(?:async\s+)?function\s*\*/.test(codeOnly.slice(parenOffset))) continue;
    const line = lineAtOffset(codeOnly, start);
    violations.push(
      `${repoPath}:${line}: forbidden "action(function*" outside define-collection.ts / define-action.ts -> use public/state/define-action.ts defineAction`,
    );
  }
}

function defineOnlyViolationsIn(sourceFiles: readonly TrackedSourceFile[]): string[] {
  const violations: string[] = [];

  for (const sourceFile of sourceFiles) {
    const withoutComments = stripPreservingLines(sourceFile.content, false);
    const codeOnly = stripPreservingLines(sourceFile.content, true);

    if (STATE_COLLECTIONS_DIR_PATTERN.test(sourceFile.path)) {
      if (!hasDefaultExportOfFactory(codeOnly, 'defineCollection')) {
        violations.push(
          `${sourceFile.path}:1: collection module does not default-export defineCollection(...) -> export default defineCollection(...) from public/state/define-collection.ts defineCollection`,
        );
      }
    }

    if (STATE_ACTIONS_DIR_PATTERN.test(sourceFile.path)) {
      if (!hasDefaultExportOfFactory(codeOnly, 'defineAction')) {
        violations.push(
          `${sourceFile.path}:1: action module does not default-export defineAction(...) -> export default defineAction(...) from public/state/define-action.ts defineAction`,
        );
      }
    }

    if (DEFINE_EXEMPT_FILES.has(sourceFile.path)) continue;

    for (const match of withoutComments.matchAll(NAMED_SOLID_IMPORT_OR_EXPORT)) {
      checkSolidSpecifierBlock(sourceFile.path, withoutComments, match.index ?? 0, match[0], match[1] ?? '', violations);
    }

    for (const match of findMatchesWithLines(withoutComments, STAR_SOLID_EXPORT)) {
      violations.push(
        `${sourceFile.path}:${match.line}: forbidden "${match.form}" re-exporting Solid store/action primitives -> use public/state/define-collection.ts defineCollection or public/state/define-action.ts defineAction`,
      );
    }

    for (const match of findMatchesWithLines(withoutComments, DYNAMIC_SOLID_IMPORT_PATTERN)) {
      violations.push(
        `${sourceFile.path}:${match.line}: forbidden dynamic "${match.form}" outside define-collection.ts / define-action.ts -> use static imports or public/state/define-collection.ts defineCollection`,
      );
    }

    for (const match of withoutComments.matchAll(NAMESPACE_SOLID_IMPORT_PATTERN)) {
      if (match[1]) checkNamespaceBindingUses(sourceFile.path, withoutComments, codeOnly, match[1], violations);
    }

    checkDirectPrimitiveCalls(sourceFile.path, codeOnly, violations);
  }

  return violations;
}

test('collections/actions default-export defineCollection/defineAction and raw Solid store/action calls stay inside define-*', () => {
  const trackedPaths = trackedFiles(PUBLIC_SOURCE_PATTERN);
  assert.ok(trackedPaths.length > 0, 'expected tracked public/**/*.{ts,tsx} files');
  const sourceFiles = trackedPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  const violations = defineOnlyViolationsIn(sourceFiles);
  assert.deepEqual(
    violations,
    [],
    `State define-only boundary violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-define-only gate fails on planted violations and accepts nested generic / typed factory exports', () => {
  const validFiles: TrackedSourceFile[] = [
    {
      path: 'public/state/collections/sessions.ts',
      content: 'export default defineCollection<Record<string, Array<string>>>({ name: "sessions", initial: {} });\n',
    },
    {
      path: 'public/state/actions/rename-session.ts',
      content: 'const renameSession: (input: { id: string }) => Promise<void> = defineAction<{ id: string }>({ type: "rename-session", rollbackNotice: "Failed" });\nexport default renameSession;\n',
    },
  ];
  assert.deepEqual(defineOnlyViolationsIn(validFiles), []);

  const plantedFiles: TrackedSourceFile[] = [
    {
      path: 'public/state/collections/planted-bad.ts',
      content: 'const note = "export default defineCollection(";\nexport const items = [];\n',
    },
    {
      path: 'public/state/actions/planted-bad.ts',
      content: 'const note = "export default defineAction(";\nexport function runBad() {}\n',
    },
    {
      path: 'public/planted-raw-store.ts',
      content: [
        'const open = "/*";',
        "import { createStore, createOptimisticStore as makeOpt, action } from 'solid-js';",
        "import { createStore as sigStore } from '@solidjs/signals';",
        'const close = "*/";',
        "import * as Solid from 'solid-js';",
        "export * from 'solid-js';",
        'export async function bad() {',
        '  createStore<Record<string, number>>({});',
        '  action(function* () {});',
        '  const { createStore: destructured } = Solid;',
        "  void Solid['createOptimisticStore'];",
        "  void import('solid-js');",
        '  return [makeOpt, sigStore, destructured, open, close];',
        '}',
      ].join('\n'),
    },
  ];

  const violations = defineOnlyViolationsIn(plantedFiles);
  assert.ok(
    violations.some((entry) => entry.includes('public/state/collections/planted-bad.ts:1:') && entry.includes('defineCollection')),
    `expected spoofed-string collection violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/state/actions/planted-bad.ts:1:') && entry.includes('defineAction')),
    `expected spoofed-string action violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:2:') && entry.includes('"createOptimisticStore"')),
    `expected createOptimisticStore import past string /* violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:3:') && entry.includes('"createStore"')),
    `expected @solidjs/signals import violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:6:') && entry.includes("export * from 'solid-js'")),
    `expected star re-export violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:8:') && entry.includes('createStore(')),
    `expected nested-generic createStore<Record<string, number>>( violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:9:') && entry.includes('action(function*')),
    `expected action(function* violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:10:') && entry.includes('"createStore"')),
    `expected namespace destructure violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:11:') && entry.includes("Solid['createOptimisticStore']")),
    `expected bracket access violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-raw-store.ts:12:') && entry.includes("import('solid-js')")),
    `expected dynamic import violation, got: ${violations.join(' | ')}`,
  );
});
