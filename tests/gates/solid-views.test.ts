import '../helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { relativeImportBasePath } from '../../server/core/import-graph-core.ts';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const RECORDED_VIEWS_RELATIVE_PATH = 'tests/gates/imperative-views.json';
const PUBLIC_TS_PATTERN = /^public\/.+\.ts$/;
const PUBLIC_TSX_PATTERN = /^public\/.+\.tsx$/;

const NON_VIEW_INFRASTRUCTURE_PATHS = new Set([
  'public/dom-helpers.ts',
  'public/svg-dom.ts',
  'public/favicon.ts',
  'public/perf-harness.ts',
]);

const NON_PRIMITIVE_UI_PATHS = new Set([
  'public/ui/island.ts',
  'public/ui/store-signal.ts',
  'public/ui/modal-state.ts',
]);

const DOM_HELPER_BUILDER_EXPORTS = new Set([
  'el',
  'elWithMarkup',
  'createAuthorOrgTag',
  'createAvatar',
  'createReviewerStack',
  'externalLink',
  'buildPanelSection',
  'buildStatChip',
]);

const SVG_DOM_BUILDER_EXPORTS = new Set([
  'createSvgShape',
  'createSvgIcon',
  'createLineIcon',
]);

const NEVER_CONVERTED_FROZEN_DIRS = new Set([
  'wargames',
  'arena',
  'radar',
  'community',
  'usage',
  'animals',
  'merge-celebration',
  'flying-animals',
  'nyan',
]);

const JS_TO_TS_EXTENSION: Readonly<Record<string, string>> = {
  '.js': '.ts',
  '.jsx': '.tsx',
  '.mjs': '.mts',
  '.cjs': '.cts',
};

const STATIC_VALUE_IMPORT_PATTERN = /(?:^|[;\n])\s*import(?:\s+(?!type\b)|(?=\{|\*))([^'"`;]+?)\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CREATE_ELEMENT_PATTERN = /\.createElement(?:NS)?\s*\(/;
const RAW_HTML_WRITE_PATTERN = /\.(?:innerHTML|outerHTML)\s*[+=]|\binsertAdjacentHTML\s*\(|\bparseFromString\s*\(|\bcreateContextualFragment\s*\(/;

interface TrackedSourceFile {
  path: string;
  content: string;
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

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/\.tsx?$/, '').replace(/-/g, '');
}

function normalizedStemOf(repoPath: string): string {
  return normalizeToken(path.posix.basename(repoPath));
}

function normalizedSubpathTokens(repoPath: string, prefixSegmentCount: number): string[] {
  const segments = repoPath.toLowerCase().split('/').slice(prefixSegmentCount);
  return segments.map((segment) => normalizeToken(segment));
}

function matchesAnyPrefix(tokens: readonly string[], prefixes: readonly string[]): boolean {
  return tokens.some((token) => prefixes.some((prefix) => token.startsWith(prefix)));
}

function neverConvertedAreaOf(repoPath: string): string | null {
  const lowerPath = repoPath.toLowerCase();
  if (!lowerPath.startsWith('public/')) return null;

  const segments = lowerPath.split('/');
  const topSegment = segments[1] ?? '';
  if (segments.length >= 3 && NEVER_CONVERTED_FROZEN_DIRS.has(topSegment)) {
    return `frozen feature (${topSegment})`;
  }

  const rootTokens = normalizedSubpathTokens(lowerPath, 1);
  if (matchesAnyPrefix(rootTokens.slice(0, 1), ['flyinganimal', 'nyan', 'mergecelebration'])) {
    return 'frozen feature (celebration extras)';
  }
  if (segments.length === 2 && (rootTokens[0] === 'renderscheduler' || rootTokens[0] === 'terminalcolorreport')) {
    return 'xterm terminal';
  }

  if (topSegment === 'github') {
    const tokens = normalizedSubpathTokens(lowerPath, 2);
    if (matchesAnyPrefix(tokens, ['teamreview', 'review']) || tokens.includes('prqueuecolumns')) {
      return 'frozen feature (team review)';
    }
    return null;
  }

  if (topSegment === 'whiteboard') {
    const tokens = normalizedSubpathTokens(lowerPath, 2);
    if (
      matchesAnyPrefix(tokens, [
        'boardgl',
        'boardcanvaspainter',
        'boardpaintworker',
        'boardpaintprotocol',
        'boardflowlayer',
        'renderer',
        'paintworker',
      ])
    ) {
      return 'board renderer and paint worker';
    }
    return null;
  }

  if (topSegment === 'session-card') {
    const tokens = normalizedSubpathTokens(lowerPath, 2);
    if (matchesAnyPrefix(tokens, ['terminal', 'xterm', 'touchscroll', 'touchselect', 'selectionmirror', 'webgl'])) {
      return 'xterm terminal';
    }
    return null;
  }

  if (topSegment === 'chat') {
    const tokens = normalizedSubpathTokens(lowerPath, 2);
    if (matchesAnyPrefix(tokens, ['chatfeed', 'sticktobottom'])) {
      return 'chat feed';
    }
    return null;
  }

  return null;
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

function isImperativeUiPrimitivePath(resolvedPath: string): boolean {
  return (
    resolvedPath.startsWith('public/ui/') &&
    resolvedPath.endsWith('.ts') &&
    !resolvedPath.endsWith('-core.ts') &&
    !NON_PRIMITIVE_UI_PATHS.has(resolvedPath)
  );
}

function valueImportedNames(importClause: string): { hasNamespaceOrDefault: boolean; names: string[] } {
  const trimmed = importClause.trim();
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  const beforeBrace = braceStart >= 0 ? trimmed.slice(0, braceStart).replace(/,\s*$/, '').trim() : trimmed;
  const hasNamespaceOrDefault = beforeBrace.length > 0;
  if (braceStart < 0 || braceEnd <= braceStart) {
    return { hasNamespaceOrDefault, names: [] };
  }

  const specifierBody = trimmed.slice(braceStart + 1, braceEnd);
  const names: string[] = [];
  for (const rawEntry of specifierBody.split(',')) {
    const entry = rawEntry.trim();
    if (!entry || /^type\s+/.test(entry)) continue;
    const importedName = entry.split(/\s+as\s+/)[0]?.trim() ?? '';
    if (importedName) names.push(importedName);
  }
  return { hasNamespaceOrDefault, names };
}

function importsImperativeDomBuilder(repoPath: string, strippedSource: string): boolean {
  for (const match of strippedSource.matchAll(STATIC_VALUE_IMPORT_PATTERN)) {
    const importClause = match[1] ?? '';
    const specifier = match[2] ?? '';
    const resolvedPath = resolvePublicImport(repoPath, specifier);
    if (!resolvedPath) continue;

    const { hasNamespaceOrDefault, names } = valueImportedNames(importClause);
    if (!hasNamespaceOrDefault && names.length === 0) continue;

    if (resolvedPath === 'public/dom-helpers.ts') {
      if (hasNamespaceOrDefault || names.some((name) => DOM_HELPER_BUILDER_EXPORTS.has(name))) return true;
      continue;
    }
    if (resolvedPath === 'public/svg-dom.ts') {
      if (hasNamespaceOrDefault || names.some((name) => SVG_DOM_BUILDER_EXPORTS.has(name))) return true;
      continue;
    }
    if (isImperativeUiPrimitivePath(resolvedPath)) return true;
  }

  for (const match of strippedSource.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    const specifier = match[1] ?? '';
    const resolvedPath = resolvePublicImport(repoPath, specifier);
    if (!resolvedPath) continue;
    if (
      resolvedPath === 'public/dom-helpers.ts' ||
      resolvedPath === 'public/svg-dom.ts' ||
      isImperativeUiPrimitivePath(resolvedPath)
    ) {
      return true;
    }
  }

  return false;
}

function isImperativeViewFile(repoPath: string, rawSource: string): boolean {
  if (!PUBLIC_TS_PATTERN.test(repoPath)) return false;
  if (NON_VIEW_INFRASTRUCTURE_PATHS.has(repoPath)) return false;
  if (neverConvertedAreaOf(repoPath) !== null) return false;

  const strippedSource = stripCommentsPreservingLines(rawSource);
  if (importsImperativeDomBuilder(repoPath, strippedSource)) return true;
  if (CREATE_ELEMENT_PATTERN.test(strippedSource)) return true;
  if (RAW_HTML_WRITE_PATTERN.test(strippedSource)) return true;
  return false;
}

function readRecordedImperativeViews(): string[] {
  const raw = fs.readFileSync(path.join(REPO_ROOT, RECORDED_VIEWS_RELATIVE_PATH), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  assert.ok(
    Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'),
    `${RECORDED_VIEWS_RELATIVE_PATH} must be a JSON array of repo-relative paths`,
  );
  return parsed;
}

function findNewImperativeViewViolations(
  sourceFiles: readonly TrackedSourceFile[],
  recordedViews: readonly string[],
): string[] {
  const recordedSet = new Set(recordedViews);
  const violations: string[] = [];

  for (const sourceFile of sourceFiles) {
    if (!isImperativeViewFile(sourceFile.path, sourceFile.content)) continue;
    if (recordedSet.has(sourceFile.path)) continue;
    const scopeHint = sourceFile.path.startsWith('public/board-session/')
      ? 'U3.1/U3.3 violation: new imperative view under public/board-session/ -> write it as a Solid 2 .tsx island on the U1.3 conventions (do not add entries to tests/gates/imperative-views.json)'
      : 'U3.3 violation: new imperative view under public/ -> write it as a Solid 2 .tsx component following public/AGENTS.md Solid 2 Components (do not add entries to tests/gates/imperative-views.json)';
    violations.push(`${sourceFile.path}: ${scopeHint}`);
  }

  return violations;
}

function findConversionLedgerViolations(
  sourceFiles: readonly TrackedSourceFile[],
  tsxPaths: readonly string[],
  recordedViews: readonly string[],
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < recordedViews.length; index += 1) {
    const entry = recordedViews[index] ?? '';
    if (seen.has(entry)) {
      violations.push(`${entry}: duplicate entry in ${RECORDED_VIEWS_RELATIVE_PATH} -> remove the duplicate`);
    }
    seen.add(entry);

    if (index > 0 && entry < (recordedViews[index - 1] ?? '')) {
      violations.push(`${entry}: ${RECORDED_VIEWS_RELATIVE_PATH} is not sorted -> keep entries in lexicographical order`);
    }
    if (NON_VIEW_INFRASTRUCTURE_PATHS.has(entry)) {
      violations.push(`${entry}: non-view DOM infrastructure does not belong in ${RECORDED_VIEWS_RELATIVE_PATH} -> remove it`);
    }
    const neverArea = neverConvertedAreaOf(entry);
    if (neverArea !== null) {
      violations.push(`${entry}: Decision 6 never-converted area (${neverArea}) does not belong in ${RECORDED_VIEWS_RELATIVE_PATH} -> remove it`);
    }
  }

  const liveImperativeViews = new Set(
    sourceFiles
      .filter((sourceFile) => isImperativeViewFile(sourceFile.path, sourceFile.content))
      .map((sourceFile) => sourceFile.path),
  );

  for (const recordedPath of recordedViews) {
    if (liveImperativeViews.has(recordedPath)) continue;
    violations.push(
      `${recordedPath}: recorded imperative view was deleted or converted -> remove it from ${RECORDED_VIEWS_RELATIVE_PATH} in the same change so the conversion ledger only shrinks`,
    );
  }

  const tsxByDirectoryAndStem = new Map<string, string>();
  for (const tsxPath of tsxPaths) {
    if (tsxPath.startsWith('public/ui/')) continue;
    const key = `${path.posix.dirname(tsxPath)}/${normalizedStemOf(tsxPath)}`;
    tsxByDirectoryAndStem.set(key, tsxPath);
  }

  for (const recordedPath of recordedViews) {
    if (recordedPath.startsWith('public/ui/')) continue;
    const key = `${path.posix.dirname(recordedPath)}/${normalizedStemOf(recordedPath)}`;
    const twinTsxPath = tsxByDirectoryAndStem.get(key);
    if (!twinTsxPath) continue;
    violations.push(
      `${recordedPath}: imperative view has Solid twin ${twinTsxPath} -> delete the imperative .ts file and remove it from ${RECORDED_VIEWS_RELATIVE_PATH} in the same U3.2 conversion task (no view lives in both forms)`,
    );
  }

  return violations;
}

function findNeverConvertedTsxViolations(tsxPaths: readonly string[]): string[] {
  const violations: string[] = [];

  for (const tsxPath of tsxPaths) {
    const area = neverConvertedAreaOf(tsxPath);
    if (area === null) continue;
    violations.push(
      `${tsxPath}: Decision 6 violation: Solid .tsx file in never-converted area (${area}) -> keep this surface imperative and remove ${tsxPath}`,
    );
  }

  return violations;
}

function loadTrackedPublicTs(): TrackedSourceFile[] {
  const trackedPaths = trackedFiles(PUBLIC_TS_PATTERN);
  assert.ok(trackedPaths.length > 0, 'expected tracked public/**/*.ts files so this gate cannot pass vacuously');
  return trackedPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
}

test('new view files under public/ and public/board-session/ are Solid .tsx, not imperative .ts', () => {
  const sourceFiles = loadTrackedPublicTs();
  const recordedViews = readRecordedImperativeViews();

  const violations = findNewImperativeViewViolations(sourceFiles, recordedViews);
  assert.deepEqual(
    violations,
    [],
    `New imperative view files found under public/:\n  ${violations.join('\n  ')}`,
  );
});

test('recorded imperative view ledger shrinks on conversion and keeps no dual .ts/.tsx view outside public/ui/', () => {
  const sourceFiles = loadTrackedPublicTs();
  const tsxPaths = trackedFiles(PUBLIC_TSX_PATTERN);
  const recordedViews = readRecordedImperativeViews();

  const violations = findConversionLedgerViolations(sourceFiles, tsxPaths, recordedViews);
  assert.deepEqual(
    violations,
    [],
    `Imperative view conversion ledger violations:\n  ${violations.join('\n  ')}`,
  );
});

test('no Solid .tsx component lives inside a Decision 6 never-converted area', () => {
  const tsxPaths = trackedFiles(PUBLIC_TSX_PATTERN);
  assert.ok(tsxPaths.length > 0, 'expected tracked public/**/*.tsx files so this gate cannot pass vacuously');

  const violations = findNeverConvertedTsxViolations(tsxPaths);
  assert.deepEqual(
    violations,
    [],
    `Solid .tsx files found in Decision 6 never-converted areas:\n  ${violations.join('\n  ')}`,
  );
});

test('solid-views gates fail on planted violations for all three U3.3 rules and U3.1', () => {
  const plantedSourceFiles: TrackedSourceFile[] = [
    {
      path: 'public/board-session/planted-panel.ts',
      content: "import { el as createNode } from '../dom-helpers';\nexport function renderPlanted() { return createNode<'div'>('div', 'planted'); }\n",
    },
    {
      path: 'public/board-session/planted-svg.ts',
      content: "import{createSvgIcon}from'/svg-dom.ts';\nexport function icon() { return createSvgIcon('M0 0'); }\n",
    },
    {
      path: 'public/board-session/planted-ownerdoc.ts',
      content: 'const docs = "https://example.com"; export function mount(host: HTMLElement) { return host.ownerDocument.createElement("div"); }\n',
    },
    {
      path: 'public/board-session/planted-parser.ts',
      content: 'const open = "/*"; export function parse() { return new DOMParser().parseFromString("<div>hi</div>", "text/html"); } const close = "*/";\n',
    },
    {
      path: 'public/planted-dynamic.ts',
      content: "export async function load() { const ui = await import('./ui/button'); return ui; }\n",
    },
    {
      path: 'public/planted-type-only.ts',
      content: "import './panel.css';\nimport type { OutlineIconButton } from './ui/button.ts';\nimport { type ButtonOptions } from './ui/button.ts';\nexport type Pair = [OutlineIconButton<'off'> | null, ButtonOptions | null];\n",
    },
    {
      path: 'public/board-session/existing-view.ts',
      content: "import { button } from '../ui/button.ts';\nexport function renderExisting() { return button({ label: 'Save', variant: 'primary' }); }\n",
    },
  ];
  const recorded = ['public/board-session/existing-view.ts', 'public/planted-converted-view.ts'];

  const newViewViolations = findNewImperativeViewViolations(plantedSourceFiles, recorded);
  assert.ok(
    newViewViolations.some((entry) => entry.includes('public/board-session/planted-panel.ts') && entry.includes('U3.1/U3.3')),
    `expected U3.1/U3.3 violation for aliased extensionless dom-helpers import, got: ${newViewViolations.join(' | ')}`,
  );
  assert.ok(
    newViewViolations.some((entry) => entry.includes('public/board-session/planted-svg.ts') && entry.includes('U3.1/U3.3')),
    `expected U3.1/U3.3 violation for compact root-relative svg-dom import, got: ${newViewViolations.join(' | ')}`,
  );
  assert.ok(
    newViewViolations.some((entry) => entry.includes('public/board-session/planted-ownerdoc.ts')),
    `expected violation for ownerDocument.createElement after URL string, got: ${newViewViolations.join(' | ')}`,
  );
  assert.ok(
    newViewViolations.some((entry) => entry.includes('public/board-session/planted-parser.ts')),
    `expected violation for DOMParser.parseFromString between string comment tokens, got: ${newViewViolations.join(' | ')}`,
  );
  assert.ok(
    newViewViolations.some((entry) => entry.includes('public/planted-dynamic.ts') && entry.includes('U3.3')),
    `expected U3.3 violation for dynamic ui primitive import, got: ${newViewViolations.join(' | ')}`,
  );
  assert.equal(
    newViewViolations.filter((entry) => entry.includes('public/planted-type-only.ts')).length,
    0,
  );

  const ledgerViolations = findConversionLedgerViolations(
    plantedSourceFiles,
    ['public/board-session/ExistingView.tsx', 'public/ui/Button.tsx'],
    recorded,
  );
  assert.ok(
    ledgerViolations.some((entry) => entry.includes('public/planted-converted-view.ts') && entry.includes('remove it from tests/gates/imperative-views.json')),
    `expected stale ledger violation, got: ${ledgerViolations.join(' | ')}`,
  );
  assert.ok(
    ledgerViolations.some((entry) => entry.includes('public/board-session/existing-view.ts') && entry.includes('ExistingView.tsx')),
    `expected dual .ts/.tsx twin violation, got: ${ledgerViolations.join(' | ')}`,
  );

  const neverConvertedViolations = findNeverConvertedTsxViolations([
    'public/wargames/WargamesPanel.tsx',
    'public/arena/ArenaPanel.tsx',
    'public/radar/RadarPanel.tsx',
    'public/community/CommunityPanel.tsx',
    'public/github/TeamReviewPanel.tsx',
    'public/github/team-review/SubPanel.tsx',
    'public/github/review-queue/QueueRow.tsx',
    'public/github/PrQueueColumns.tsx',
    'public/usage/UsagePanel.tsx',
    'public/animals/SpritePicker.tsx',
    'public/flying-animals/Preview.tsx',
    'public/FlyingAnimalPreview.tsx',
    'public/NyanCat.tsx',
    'public/merge-celebration/CelebrationPlayer.tsx',
    'public/whiteboard/BoardGlRenderer.tsx',
    'public/whiteboard/renderer/CanvasPass.tsx',
    'public/whiteboard/BoardPaintWorker.tsx',
    'public/session-card/TerminalNotices.tsx',
    'public/session-card/terminal/Overlay.tsx',
    'public/chat/ChatFeed.tsx',
    'public/chat/chat-feed/Row.tsx',
    'public/chat/StickToBottom.tsx',
    'public/board-session/StudioCard.tsx',
    'public/github/MyPrsPanel.tsx',
    'public/whiteboard/BoardsView.tsx',
    'public/chat/Composer.tsx',
  ]);
  assert.equal(neverConvertedViolations.length, 22, `expected 22 Decision 6 violations, got ${neverConvertedViolations.length}: ${neverConvertedViolations.join(' | ')}`);
  assert.equal(
    neverConvertedViolations.filter((entry) => entry.includes('StudioCard.tsx') || entry.includes('MyPrsPanel.tsx') || entry.includes('BoardsView.tsx') || entry.includes('Composer.tsx')).length,
    0,
  );
});
