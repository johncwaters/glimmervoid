import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';
import { CALL_IMPORT, EXPORT_FROM, STATIC_IMPORT, relativeImportBasePath } from '../../server/core/import-graph-core.ts';
import { findMatchesWithLines, readCommittedStateRatchets } from '../../scripts/state-inventory.ts';
import type { TrackedSourceFile } from '../../scripts/state-inventory.ts';

const PUBLIC_TSX_PATTERN = /^public\/.*\.tsx$/;
const IMPORT_PATTERNS = [STATIC_IMPORT, EXPORT_FROM, CALL_IMPORT];
const NAMED_SOLID_IMPORT_OR_EXPORT = /\b(?:import|export)\s*(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*['"]solid-js['"]/g;
const DYNAMIC_SOLID_DESTRUCTURE = /\{([^{}]+)\}\s*=\s*(?:await\s+)?import\s*\(\s*['"]solid-js['"]\s*\)/g;
const DYNAMIC_SOLID_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\s*\(\s*['"]solid-js['"]\s*\)/g;
const NAMESPACE_SOLID_IMPORT = /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]solid-js['"]/g;
const FETCH_CALL_PATTERN = /(?:(?<![.\w$])|\b(?:window|globalThis|self)\.)fetch(?:\?\.)?\s*\(/g;

const JS_TO_TS_EXTENSION: Readonly<Record<string, string>> = {
  '.js': '.ts',
  '.jsx': '.tsx',
  '.mjs': '.mts',
  '.cjs': '.cts',
};

const FORBIDDEN_SOLID_PRIMITIVES = new Map<string, string>([
  ['createStore', 'public/state/define-collection.ts defineCollection'],
  ['createOptimisticStore', 'public/state/define-action.ts defineAction'],
  ['action', 'public/state/define-action.ts defineAction'],
]);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCommentsPreservingLines(sourceText: string): string {
  const chunks: string[] = [];
  let keptFrom = 0;
  let index = 0;
  while (index < sourceText.length) {
    const ch = sourceText[index];
    const next = sourceText[index + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
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
      continue;
    }
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
    index += 1;
  }
  chunks.push(sourceText.slice(keptFrom));
  return chunks.join('');
}

function lineNumberCursor(sourceText: string): (offset: number) => number {
  let currentLine = 1;
  let scannedOffset = 0;
  return (targetOffset: number): number => {
    for (let index = scannedOffset; index < targetOffset; index += 1) {
      if (sourceText.charCodeAt(index) === 10) currentLine += 1;
    }
    scannedOffset = targetOffset;
    return currentLine;
  };
}

function normalizeTsExtension(normalizedPath: string): string {
  const extension = path.posix.extname(normalizedPath);
  if (extension === '.ts' || extension === '.tsx') return normalizedPath;
  const mappedExtension = JS_TO_TS_EXTENSION[extension];
  if (mappedExtension) return `${normalizedPath.slice(0, -extension.length)}${mappedExtension}`;
  return `${normalizedPath}.ts`;
}

function resolvePublicImport(fromPath: string, specifier: string): string | null {
  const cleanSpecifier = specifier.split('?')[0] ?? specifier;
  if (cleanSpecifier.startsWith('./') || cleanSpecifier.startsWith('../')) {
    return normalizeTsExtension(relativeImportBasePath(fromPath, cleanSpecifier));
  }
  if (cleanSpecifier.startsWith('/') && !cleanSpecifier.startsWith('//')) {
    return normalizeTsExtension(path.posix.normalize(`public${cleanSpecifier}`));
  }
  return null;
}

function checkSolidSpecifierBlock(
  repoPath: string,
  lineForOffset: (offset: number) => number,
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
    const line = lineForOffset(blockStart + offsetInBlock);
    violations.push(
      `${repoPath}:${line}: forbidden Solid state primitive "${importedName}" from "solid-js" -> use ${replacement}`,
    );
  }
}

function checkSolidBindingUses(repoPath: string, source: string, bindingName: string, violations: string[]): void {
  const escapedBinding = escapeRegExp(bindingName);
  const accessPattern = new RegExp(`(?<![.\\w$])${escapedBinding}\\.([A-Za-z_$][\\w$]*)`, 'g');
  const lineForAccess = lineNumberCursor(source);
  for (const accessMatch of source.matchAll(accessPattern)) {
    const primitiveName = accessMatch[1] ?? '';
    const replacement = FORBIDDEN_SOLID_PRIMITIVES.get(primitiveName);
    if (!replacement) continue;
    const line = lineForAccess(accessMatch.index ?? 0);
    violations.push(
      `${repoPath}:${line}: forbidden Solid state primitive "${primitiveName}" from "solid-js" -> use ${replacement}`,
    );
  }

  const destructurePattern = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${escapedBinding}(?![\\w$])`, 'g');
  const lineForDestructure = lineNumberCursor(source);
  for (const destructureMatch of source.matchAll(destructurePattern)) {
    checkSolidSpecifierBlock(
      repoPath,
      lineForDestructure,
      destructureMatch.index ?? 0,
      destructureMatch[0],
      destructureMatch[1] ?? '',
      violations,
    );
  }
}

function tsxImportViolationsIn(
  sourceFiles: readonly TrackedSourceFile[],
  recordedLegacyStoreModules: readonly string[],
): string[] {
  const violations: string[] = [];
  const legacyStoreSet = new Set(recordedLegacyStoreModules);

  for (const sourceFile of sourceFiles) {
    const source = stripCommentsPreservingLines(sourceFile.content);

    const rawImportMatches: { offset: number; specifier: string }[] = [];
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        rawImportMatches.push({ offset: match.index ?? 0, specifier: match[2] ?? '' });
      }
    }
    rawImportMatches.sort((left, right) => left.offset - right.offset);

    const lineForImport = lineNumberCursor(source);
    for (const { offset, specifier } of rawImportMatches) {
      const resolvedPath = resolvePublicImport(sourceFile.path, specifier);
      if (!resolvedPath) continue;
      const line = lineForImport(offset);
      if (resolvedPath === 'public/control-ws.ts') {
        violations.push(
          `${sourceFile.path}:${line}: forbidden import "${specifier}" -> use public/state/define-action.ts defineAction`,
        );
        continue;
      }
      if (resolvedPath === 'public/local-store.ts') {
        violations.push(
          `${sourceFile.path}:${line}: forbidden import "${specifier}" -> use public/ui/store-signal.ts localJsonSignal or public/state/persist.ts definePersisted`,
        );
        continue;
      }
      if (legacyStoreSet.has(resolvedPath)) {
        violations.push(
          `${sourceFile.path}:${line}: forbidden legacy store import "${specifier}" -> use public/ui/store-signal.ts or public/state/define-collection.ts defineCollection`,
        );
      }
    }

    const lineForNamedSolid = lineNumberCursor(source);
    for (const match of source.matchAll(NAMED_SOLID_IMPORT_OR_EXPORT)) {
      checkSolidSpecifierBlock(sourceFile.path, lineForNamedSolid, match.index ?? 0, match[0], match[1] ?? '', violations);
    }

    const lineForDynamicSolid = lineNumberCursor(source);
    for (const match of source.matchAll(DYNAMIC_SOLID_DESTRUCTURE)) {
      checkSolidSpecifierBlock(sourceFile.path, lineForDynamicSolid, match.index ?? 0, match[0], match[1] ?? '', violations);
    }

    const solidBindings = new Set<string>();
    for (const match of source.matchAll(NAMESPACE_SOLID_IMPORT)) {
      if (match[1]) solidBindings.add(match[1]);
    }
    for (const match of source.matchAll(DYNAMIC_SOLID_BINDING)) {
      if (match[1]) solidBindings.add(match[1]);
    }
    for (const bindingName of solidBindings) {
      checkSolidBindingUses(sourceFile.path, source, bindingName, violations);
    }

    for (const fetchMatch of findMatchesWithLines(source, FETCH_CALL_PATTERN)) {
      violations.push(
        `${sourceFile.path}:${fetchMatch.line}: forbidden direct "${fetchMatch.form}" call -> use public/state/define-action.ts defineAction`,
      );
    }
  }

  return violations;
}

test('public/**/*.tsx files import no control-ws, local-store, legacy store, Solid store/action primitive, or fetch(', () => {
  const tsxPaths = trackedFiles(PUBLIC_TSX_PATTERN);
  assert.ok(tsxPaths.length > 0, 'expected at least one tracked public/**/*.tsx file');
  const sourceFiles = tsxPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  const committedRatchets = readCommittedStateRatchets();
  const violations = tsxImportViolationsIn(sourceFiles, committedRatchets.subscribeModules);
  assert.deepEqual(
    violations,
    [],
    `Solid .tsx state boundary violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-tsx-imports gate fails on planted violations with file, line, form, and replacement', () => {
  const plantedFiles: TrackedSourceFile[] = [
    {
      path: 'public/ui/planted-bad-view.tsx',
      content: [
        "import { sendControlMsg } from '../control-ws.ts';",
        "import { getString } from '../local-store.js';",
        "import { subscribeHooks } from '/hooks-store.ts';",
        "import { action, createOptimisticStore, createStore } from 'solid-js';",
        "import * as $Solid from 'solid-js';",
        'export async function PlantedBadView() {',
        "  const url = 'https://example.com/api'; void fetch(url);",
        '  const { createStore: nsStore } = $Solid;',
        "  const solidMod = await import('solid-js'); solidMod.action(() => {});",
        "  void self.fetch('/api/self'); void fetch?.('/api/opt');",
        '  return <div>{String(Boolean(sendControlMsg && getString && subscribeHooks && action && createOptimisticStore && createStore && nsStore))}</div>;',
        '}',
      ].join('\n'),
    },
  ];
  const recordedStores = ['public/hooks-store.ts'];

  const violations = tsxImportViolationsIn(plantedFiles, recordedStores);
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:1:') && entry.includes('../control-ws.ts') && entry.includes('public/state/define-action.ts defineAction')),
    `expected control-ws violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:2:') && entry.includes('../local-store.js') && entry.includes('public/ui/store-signal.ts localJsonSignal')),
    `expected local-store.js violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:3:') && entry.includes('/hooks-store.ts') && entry.includes('public/ui/store-signal.ts')),
    `expected root-relative legacy store violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:4:') && entry.includes('"action"') && entry.includes('public/state/define-action.ts defineAction')),
    `expected action violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:4:') && entry.includes('"createOptimisticStore"') && entry.includes('public/state/define-action.ts defineAction')),
    `expected createOptimisticStore violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:4:') && entry.includes('"createStore"') && entry.includes('public/state/define-collection.ts defineCollection')),
    `expected createStore violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:7:') && entry.includes('fetch(') && entry.includes('public/state/define-action.ts defineAction')),
    `expected fetch( after URL string violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:8:') && entry.includes('"createStore"') && entry.includes('public/state/define-collection.ts defineCollection')),
    `expected namespace destructure violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:9:') && entry.includes('"action"') && entry.includes('public/state/define-action.ts defineAction')),
    `expected dynamic import binding violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:10:') && entry.includes('self.fetch(')),
    `expected self.fetch( violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/ui/planted-bad-view.tsx:10:') && entry.includes('fetch?.(')),
    `expected fetch?.( violation, got: ${violations.join(' | ')}`,
  );
});
