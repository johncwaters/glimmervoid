import path from 'node:path';
import { matchPathPatterns } from './tsconfig-paths-core.ts';
import { importLanguageOf } from './import-language-core.ts';
import type { EmbeddedScriptHost } from './import-language-core.ts';
import { manifestPackageIndexOf, packagePrefixMatches, packagesOfManifest } from './import-resolvers/manifest-prefix.ts';
import type { ManifestPackageIndex } from './import-resolvers/manifest-prefix.ts';
import { fileCandidatesOf } from './import-resolvers/file-candidates.ts';
import {
  CHANGE_MAP_LIST_CAP,
  changeMapFactId,
  type BlastRadiusFact,
} from '../../shared/contracts/change-map.ts';

export const CALL_IMPORT = /\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
export const STATIC_IMPORT = /\bimport\b(?:(?:(?!\b(?:import|export)\b)[^'";])*?\bfrom)?\s*(['"])([^'"]+)\1/g;
export const EXPORT_FROM =/\bexport\b(?:(?!\b(?:import|export)\b)[^'";])*?\bfrom\s*(['"])([^'"]+)\1/g;
const TYPE_ONLY_IMPORT = /\b(?:import|export)\s+type(?=\s*[{*]|\s+(?!from\b)[A-Za-z_$])(?:(?!\b(?:import|export)\b)[^'";])*?\bfrom\s*(['"])([^'"]+)\1/dg;
const SPECIFIER_PATTERNS = [CALL_IMPORT, STATIC_IMPORT, EXPORT_FROM].map((pattern) => new RegExp(pattern.source, 'dg'));
const MASKING_START = /[/'"`{}]/g;
const WORD_BEFORE = /[\w$]+$/;
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of']);

interface ImportGraph {
  dependentsByPath: Map<string, Set<string>>;
  dependentsByPackage: Map<string, Set<string>>;
  packageKeysByPath: Map<string, string[]>;
}

function blankedRange(sourceText: string, start: number, end: number): string {
  const range = sourceText.slice(start, end);
  return range.includes('\n') ? range.replace(/[^\n]/g, ' ') : ' '.repeat(range.length);
}

function quotedStringEnd(sourceText: string, start: number): number {
  const quote = sourceText[start];
  for (let index = start + 1; index < sourceText.length; index++) {
    const character = sourceText[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === '\n') return index;
  }
  return sourceText.length;
}

const UNKNOWN_REGEX_OUTCOME = 0;
const UNCLOSED_REGEX_OUTCOME = -1;

function regexLiteralEnd(sourceText: string, start: number, outcomesByScanState: Int32Array): number | null {
  const visitedScanStates: number[] = [];
  let isInClass = false;
  let outcome = UNCLOSED_REGEX_OUTCOME;
  for (let index = start + 1; index < sourceText.length; index++) {
    const character = sourceText[index];
    if (character === '\n') break;
    const scanState = index * 2 + (isInClass ? 1 : 0);
    const knownOutcome = outcomesByScanState[scanState];
    if (knownOutcome !== UNKNOWN_REGEX_OUTCOME) {
      outcome = knownOutcome;
      break;
    }
    visitedScanStates.push(scanState);
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '[') isInClass = true;
    if (character === ']') isInClass = false;
    if (character === '/' && !isInClass) {
      outcome = index + 1;
      break;
    }
  }
  for (const scanState of visitedScanStates) outcomesByScanState[scanState] = outcome;
  return outcome === UNCLOSED_REGEX_OUTCOME ? null : outcome;
}

function templateTextEnd(sourceText: string, start: number): { end: number; opensExpression: boolean } | null {
  for (let index = start; index < sourceText.length; index++) {
    const character = sourceText[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '`') return { end: index + 1, opensExpression: false };
    if (character === '$' && sourceText[index + 1] === '{') return { end: index + 2, opensExpression: true };
  }
  return null;
}

function slashStartsRegexLiteral(sourceText: string, slashIndex: number): boolean {
  let previousIndex = slashIndex - 1;
  while (previousIndex >= 0 && /\s/.test(sourceText[previousIndex])) previousIndex--;
  if (previousIndex < 0) return true;
  const previousCharacter = sourceText[previousIndex];
  if (/[\w$]/.test(previousCharacter)) return KEYWORDS_BEFORE_REGEX.has(WORD_BEFORE.exec(sourceText.slice(Math.max(0, previousIndex - 16), previousIndex + 1))?.[0] ?? '');
  return !')]}\'"`'.includes(previousCharacter);
}

function maskedSourceOf(sourceText: string): string {
  const maskedParts: string[] = [];
  const braceDepthsOutsideTemplates: number[] = [];
  let braceDepth = 0;
  let keptFrom = 0;
  let index = 0;
  let unclosedTemplateFrom = Number.POSITIVE_INFINITY;
  let commentCloseMissingFrom = Number.POSITIVE_INFINITY;
  let regexOutcomesByScanState: Int32Array | null = null;
  function blank(start: number, end: number): void {
    maskedParts.push(sourceText.slice(keptFrom, start), blankedRange(sourceText, start, end));
    index = end;
    keptFrom = end;
  }
  function continueTemplate(): void {
    const templateText = index < unclosedTemplateFrom ? templateTextEnd(sourceText, index) : null;
    if (!templateText) {
      unclosedTemplateFrom = Math.min(unclosedTemplateFrom, index);
      return;
    }
    const { end, opensExpression } = templateText;
    blank(index, end);
    if (!opensExpression) return;
    braceDepthsOutsideTemplates.push(braceDepth);
    braceDepth = 0;
  }
  while (index < sourceText.length) {
    MASKING_START.lastIndex = index;
    const found = MASKING_START.exec(sourceText);
    if (!found) break;
    const startIndex = found.index;
    const character = found[0];
    const nextCharacter = sourceText[startIndex + 1];
    index = startIndex + 1;
    if (character === '/' && nextCharacter === '/') {
      const lineEnd = sourceText.indexOf('\n', startIndex);
      blank(startIndex, lineEnd < 0 ? sourceText.length : lineEnd);
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      const commentClose = startIndex < commentCloseMissingFrom ? sourceText.indexOf('*/', startIndex + 2) : -1;
      if (commentClose < 0) commentCloseMissingFrom = Math.min(commentCloseMissingFrom, startIndex);
      if (commentClose >= 0) blank(startIndex, commentClose + 2);
      continue;
    }
    if (character === '"' || character === "'") {
      const stringEnd = quotedStringEnd(sourceText, startIndex);
      const hasClosingQuote = sourceText[stringEnd - 1] === character && stringEnd - 1 > startIndex;
      blank(startIndex + 1, hasClosingQuote ? stringEnd - 1 : stringEnd);
      index = stringEnd;
      continue;
    }
    if (character === '`') {
      blank(startIndex, startIndex + 1);
      continueTemplate();
      continue;
    }
    if (character === '/' && slashStartsRegexLiteral(sourceText, startIndex)) {
      regexOutcomesByScanState ??= new Int32Array(sourceText.length * 2 + 2);
      const literalEnd = regexLiteralEnd(sourceText, startIndex, regexOutcomesByScanState);
      if (literalEnd !== null) blank(startIndex, literalEnd);
      continue;
    }
    if (character === '}' && braceDepth === 0 && braceDepthsOutsideTemplates.length > 0) {
      braceDepth = braceDepthsOutsideTemplates.pop() ?? 0;
      blank(startIndex, startIndex + 1);
      continueTemplate();
      continue;
    }
    if (character === '{') braceDepth++;
    if (character === '}') braceDepth--;
  }
  maskedParts.push(sourceText.slice(keptFrom));
  return maskedParts.join('');
}

function specifierSlicedFrom(sourceText: string, match: RegExpExecArray): string {
  const [specifierStart, specifierEnd] = match.indices?.[2] ?? [0, 0];
  return sourceText.slice(specifierStart, specifierEnd);
}

function specifiersMatchedIn(sourceText: string, maskedText: string): string[] {
  const matches: { index: number; specifier: string }[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of maskedText.matchAll(pattern)) matches.push({ index: match.index, specifier: specifierSlicedFrom(sourceText, match) });
  }
  matches.sort((left, right) => left.index - right.index);
  return [...new Set(matches.map((match) => match.specifier))];
}

export function extractImportSpecifiers(sourceText: string): string[] {
  return specifiersMatchedIn(sourceText, maskedSourceOf(sourceText));
}

export function extractTypeOnlySpecifiers(sourceText: string): string[] {
  const maskedText = maskedSourceOf(sourceText);
  const typeOnlySpecifiers = [...maskedText.matchAll(TYPE_ONLY_IMPORT)].map((match) => specifierSlicedFrom(sourceText, match));
  if (typeOnlySpecifiers.length === 0) return [];
  const maskedWithoutTypeOnly = maskedText.replace(TYPE_ONLY_IMPORT, (typeOnlyStatement) => ' '.repeat(typeOnlyStatement.length));
  const valueSpecifiers = new Set(specifiersMatchedIn(sourceText, maskedWithoutTypeOnly));
  return [...new Set(typeOnlySpecifiers)].filter((specifier) => !valueSpecifiers.has(specifier));
}

const SCRIPT_TAG_START = /<script\b/gi;
const SCRIPT_CLOSING_TAG = /<\/script\s*>/gi;
const SCRIPT_TYPE_ATTRIBUTE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
const SCRIPT_SOURCE_ATTRIBUTE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const SCRIPT_TYPES = new Set(['module', 'text/javascript', 'application/javascript', 'text/typescript', 'application/typescript', 'ts', 'text/babel', 'text/jsx']);
const ASTRO_FRONTMATTER = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MDX_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MDX_MODULE_LINE = /^(?:import|export)(?=[\s{*])/;
const MDX_SINGLE_LINE_BLOCK = /^(?:\s*(?:-{3,}|\+{3,}|\*{3,}|_{3,})\s*$| {0,3}#{1,6}(?:\s|$))/;

interface TextRange {
  start: number;
  end: number;
}

function isScriptType(openingAttributes: string): boolean {
  const scriptType = SCRIPT_TYPE_ATTRIBUTE.exec(openingAttributes)?.[1]?.toLowerCase();
  return scriptType === undefined || SCRIPT_TYPES.has(scriptType);
}

interface ScriptTag {
  attributes: string;
  content: TextRange;
}

function scriptTagsOf(sourceText: string): ScriptTag[] {
  const tags: ScriptTag[] = [];
  SCRIPT_TAG_START.lastIndex = 0;
  for (let opening = SCRIPT_TAG_START.exec(sourceText); opening; opening = SCRIPT_TAG_START.exec(sourceText)) {
    const openingEnd = sourceText.indexOf('>', opening.index);
    if (openingEnd < 0) break;
    const attributes = sourceText.slice(opening.index + opening[0].length, openingEnd);
    const contentStart = openingEnd + 1;
    if (attributes.trimEnd().endsWith('/')) {
      tags.push({ attributes, content: { start: contentStart, end: contentStart } });
      SCRIPT_TAG_START.lastIndex = contentStart;
      continue;
    }
    SCRIPT_CLOSING_TAG.lastIndex = contentStart;
    const closing = SCRIPT_CLOSING_TAG.exec(sourceText);
    tags.push({ attributes, content: { start: contentStart, end: closing ? closing.index : sourceText.length } });
    SCRIPT_TAG_START.lastIndex = closing ? closing.index + closing[0].length : sourceText.length;
  }
  return tags;
}

function scriptTagRanges(sourceText: string): TextRange[] {
  return scriptTagsOf(sourceText).filter((tag) => isScriptType(tag.attributes) && tag.content.end > tag.content.start).map((tag) => tag.content);
}

function closesFence(line: string, openFence: string): boolean {
  const closing = MDX_FENCE.exec(line)?.[1] ?? '';
  return closing[0] === openFence[0] && closing.length >= openFence.length && line.trim() === closing;
}

function mdxModuleRanges(sourceText: string): TextRange[] {
  const ranges: TextRange[] = [];
  let openFence = '';
  let moduleBlockStart = -1;
  let lastBlockEndLineIndex = -1;
  let lineStart = 0;
  for (const [lineIndex, line] of sourceText.split('\n').entries()) {
    const currentLineStart = lineStart;
    const isBlank = line.trim() === '';
    const startsBlock = lastBlockEndLineIndex === lineIndex - 1;
    lineStart += line.length + 1;
    if (isBlank || MDX_SINGLE_LINE_BLOCK.test(line)) lastBlockEndLineIndex = lineIndex;
    if (openFence) {
      lastBlockEndLineIndex = lineIndex;
      if (closesFence(line, openFence)) openFence = '';
      continue;
    }
    if (moduleBlockStart >= 0) {
      if (!isBlank) continue;
      ranges.push({ start: moduleBlockStart, end: currentLineStart });
      moduleBlockStart = -1;
      continue;
    }
    openFence = MDX_FENCE.exec(line)?.[1] ?? '';
    if (!openFence && startsBlock && MDX_MODULE_LINE.test(line)) moduleBlockStart = currentLineStart;
  }
  if (moduleBlockStart >= 0) ranges.push({ start: moduleBlockStart, end: sourceText.length });
  return ranges;
}

function scriptRangesOf(sourceText: string, host: EmbeddedScriptHost): TextRange[] {
  if (host === 'mdx') return mdxModuleRanges(sourceText);
  const frontmatter = host === 'astro' ? ASTRO_FRONTMATTER.exec(sourceText) : null;
  const frontmatterBody = frontmatter?.[1] ?? '';
  const frontmatterStart = frontmatter ? frontmatter[0].indexOf(frontmatterBody) : 0;
  const frontmatterRanges = frontmatter ? [{ start: frontmatterStart, end: frontmatterStart + frontmatterBody.length }] : [];
  return [...frontmatterRanges, ...scriptTagRanges(sourceText)];
}

export function blankOutsideScriptRegions(sourceText: string, host: EmbeddedScriptHost): string {
  const keptParts: string[] = [];
  let blankFrom = 0;
  for (const range of scriptRangesOf(sourceText, host).sort((left, right) => left.start - right.start)) {
    if (range.start < blankFrom) continue;
    keptParts.push(blankedRange(sourceText, blankFrom, range.start), sourceText.slice(range.start, range.end));
    blankFrom = range.end;
  }
  keptParts.push(blankedRange(sourceText, blankFrom, sourceText.length));
  return keptParts.join('');
}

export function scriptSourceSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  for (const { attributes } of scriptTagsOf(sourceText)) {
    const source = SCRIPT_SOURCE_ATTRIBUTE.exec(attributes)?.[1];
    if (!source || !isScriptType(attributes) || source.startsWith('//') || source.includes(':')) continue;
    const isRelative = source.startsWith('./') || source.startsWith('../');
    specifiers.push(isRelative ? source : source.startsWith('/') ? `.${source}` : `./${source}`);
  }
  return [...new Set(specifiers)];
}

interface OutsideGraphImport {
  specifier: string;
  targetPath: string | null;
}

function relativeImportCandidates(candidatePath: string): string[] {
  const declarationAndIndexForms = ['.d.ts', '/index.d.ts', '/index.mjs', '/index.mts', '/index.cjs', '/index.cts', '/index.jsx'].map((suffix) => `${candidatePath}${suffix}`);
  return [...sourceCandidates(candidatePath), ...declarationAndIndexForms];
}

export function outsideGraphImportsOf(fromPath: string, specifiers: readonly string[], graphPaths: ReadonlySet<string>, trackedPaths: ReadonlySet<string>): OutsideGraphImport[] {
  const language = importLanguageOf(fromPath);
  if (!language || language.id === 'python' || language.resolver.kind !== 'file') return [];
  return specifiers.flatMap((specifier) => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
    const candidatePath = relativeImportBasePath(fromPath, specifier);
    if (sourceCandidates(candidatePath).some((candidate) => graphPaths.has(candidate))) return [];
    return [{ specifier, targetPath: relativeImportCandidates(candidatePath).find((candidate) => trackedPaths.has(candidate)) ?? null }];
  });
}

export function relativeImportBasePath(fromPath: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier.split('?')[0] ?? specifier));
}

const EXPORTED_DECLARATION = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORTED_LIST_OPENING = /\bexport\s+(?:type\s+)?\{/g;

export function extractExportedNames(sourceText: string): string[] {
  const names = new Set<string>();
  EXPORTED_DECLARATION.lastIndex = 0;
  for (const match of sourceText.matchAll(EXPORTED_DECLARATION)) names.add(match[1]);
  EXPORTED_LIST_OPENING.lastIndex = 0;
  let closingBraceIndex = -1;
  for (const match of sourceText.matchAll(EXPORTED_LIST_OPENING)) {
    const listStart = match.index + match[0].length;
    if (closingBraceIndex < listStart) closingBraceIndex = sourceText.indexOf('}', listStart);
    if (closingBraceIndex < 0) break;
    for (const entry of sourceText.slice(listStart, closingBraceIndex).split(',')) {
      const exportedName = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)?.trim();
      if (exportedName && /^[A-Za-z_$][\w$]*$/.test(exportedName)) names.add(exportedName);
    }
  }
  return [...names].sort();
}

export function extractPythonImportSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  let pendingFrom = '';
  let pendingNames = '';
  let stringQuote = '';
  let isTripleString = false;
  for (const originalLine of sourceText.split('\n')) {
    let line = '';
    for (let index = 0; index < originalLine.length; index++) {
      const character = originalLine[index];
      if (stringQuote) {
        if (character === '\\') { index++; continue; }
        if (isTripleString && originalLine.slice(index, index + 3) === stringQuote.repeat(3)) {
          index += 2;
          stringQuote = '';
          isTripleString = false;
          continue;
        }
        if (!isTripleString && character === stringQuote) stringQuote = '';
        continue;
      }
      if (character === '#') break;
      if (character === '"' || character === "'") {
        stringQuote = character;
        isTripleString = originalLine.slice(index, index + 3) === character.repeat(3);
        if (isTripleString) index += 2;
        continue;
      }
      line += character;
    }
    const trimmed = line.trim();
    if (pendingFrom) {
      pendingNames += trimmed;
      if (!trimmed.includes(')')) continue;
      specifiers.push(...fromImportSpecifiers(pendingFrom, pendingNames));
      pendingFrom = '';
      pendingNames = '';
      continue;
    }
    if (trimmed.startsWith('import ')) {
      for (const name of trimmed.slice(7).split(',')) {
        const importedName = name.trim().split(/\s+/)[0];
        if (importedName) specifiers.push(importedName);
      }
      continue;
    }
    if (!trimmed.startsWith('from ')) continue;
    const importIndex = trimmed.indexOf(' import ');
    if (importIndex < 0) continue;
    const moduleName = trimmed.slice(5, importIndex).trim();
    if (!moduleName) continue;
    const names = trimmed.slice(importIndex + 8);
    if (names.includes('(') && !names.includes(')')) {
      pendingFrom = moduleName;
      pendingNames = names;
      continue;
    }
    specifiers.push(...fromImportSpecifiers(moduleName, names));
  }
  return [...new Set(specifiers)];
}

function fromImportSpecifiers(moduleName: string, importedNames: string): string[] {
  const separator = moduleName.endsWith('.') ? '' : '.';
  const submodules = importedNames.replace(/[()]/g, '').split(',')
    .map((name) => name.trim().split(/\s+/)[0])
    .filter((importedName) => importedName && importedName !== '*')
    .map((importedName) => `${moduleName}${separator}${importedName}`);
  return [moduleName, ...submodules];
}

function resolvePythonSpecifier(fromPath: string, specifier: string, knownPaths: Set<string>): string | null {
  let moduleName = specifier;
  let directory = '';
  if (specifier.startsWith('.')) {
    directory = path.posix.dirname(fromPath);
    let dotCount = 0;
    while (specifier[dotCount] === '.') dotCount++;
    for (let index = 1; index < dotCount; index++) {
      if (directory === '.') return null;
      directory = path.posix.dirname(directory);
    }
    moduleName = specifier.slice(dotCount);
  }
  const modulePath = path.posix.normalize(path.posix.join(directory, moduleName.replaceAll('.', '/')));
  if (modulePath === '..' || modulePath.startsWith('../') || path.posix.isAbsolute(modulePath)) return null;
  const candidates = moduleName ? [`${modulePath}.py`, `${modulePath}/__init__.py`] : [path.posix.join(directory, '__init__.py')];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function sourceCandidates(candidatePath: string): string[] {
  const mappedExtension: Record<string, string> = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' };
  const extension = path.posix.extname(candidatePath);
  const mapped = mappedExtension[extension];
  return [
    candidatePath,
    ...(mapped ? [`${candidatePath.slice(0, -extension.length)}${mapped}`] : []),
    `${candidatePath}.ts`, `${candidatePath}.js`, `${candidatePath}.mjs`, `${candidatePath}.cjs`,
    `${candidatePath}.tsx`, `${candidatePath}.jsx`, `${candidatePath}.mts`, `${candidatePath}.cts`,
    `${candidatePath}/index.ts`, `${candidatePath}/index.js`, `${candidatePath}/index.tsx`,
  ];
}

interface RepoResolution {
  knownPaths: Set<string>;
  sourcePaths: Set<string>;
  filesByDirectory: Map<string, string[]>;
  importsMap: Record<string, string>;
  tsconfigTargets: (fromPath: string, specifier: string) => string[];
  packages: ManifestPackageIndex;
  packageFilesByKey: Map<string, string[]>;
  packageKeyBySpecifier: Map<string, string | null>;
  targetFilesByLanguage: Map<string, Map<string, string[]>>;
  pathsByBasename: Map<string, string[]>;
  suffixMatchBySuffix: Map<string, string[]>;
}

function pathsByBasenameOf(knownPaths: Iterable<string>): Map<string, string[]> {
  const pathsByBasename = new Map<string, string[]>();
  for (const knownPath of knownPaths) {
    const basename = path.posix.basename(knownPath);
    const sameBasename = pathsByBasename.get(basename) ?? [];
    sameBasename.push(knownPath);
    pathsByBasename.set(basename, sameBasename);
  }
  return pathsByBasename;
}

function filesByDirectoryOf(knownPaths: Iterable<string>): Map<string, string[]> {
  const filesByDirectory = new Map<string, string[]>();
  for (const knownPath of knownPaths) {
    const directory = path.posix.dirname(knownPath);
    const directoryFiles = filesByDirectory.get(directory) ?? [];
    directoryFiles.push(knownPath);
    filesByDirectory.set(directory, directoryFiles);
  }
  return filesByDirectory;
}

function nearestTargetFinder(targetDirectories: ReadonlySet<string>): (directory: string) => string | null {
  const nearestTargetByDirectory = new Map<string, string | null>();
  return (directory) => {
    const unresolvedDirectories: string[] = [];
    let nearestTarget: string | null = null;
    for (let current = directory; ; current = path.posix.dirname(current)) {
      if (nearestTargetByDirectory.has(current)) {
        nearestTarget = nearestTargetByDirectory.get(current) ?? null;
        break;
      }
      unresolvedDirectories.push(current);
      if (targetDirectories.has(current)) {
        nearestTarget = current;
        break;
      }
      if (path.posix.dirname(current) === current) break;
    }
    for (const unresolvedDirectory of unresolvedDirectories) nearestTargetByDirectory.set(unresolvedDirectory, nearestTarget);
    return nearestTarget;
  };
}

function targetFilesOf(language: NonNullable<ReturnType<typeof importLanguageOf>>, manifestName: string, repo: RepoResolution): Map<string, string[]> {
  const cached = repo.targetFilesByLanguage.get(language.id);
  if (cached) return cached;
  const nearestTargetOf = nearestTargetFinder(new Set(packagesOfManifest(repo.packages, manifestName).map((manifestPackage) => manifestPackage.sourceDirectory)));
  const filesByTarget = new Map<string, string[]>();
  for (const knownPath of repo.knownPaths) {
    if (importLanguageOf(knownPath) !== language) continue;
    const nearestTarget = nearestTargetOf(path.posix.dirname(knownPath));
    if (nearestTarget === null) continue;
    const targetFiles = filesByTarget.get(nearestTarget) ?? [];
    targetFiles.push(knownPath);
    filesByTarget.set(nearestTarget, targetFiles);
  }
  repo.targetFilesByLanguage.set(language.id, filesByTarget);
  return filesByTarget;
}

function uniqueSuffixMatch(suffix: string, repo: RepoResolution): string[] {
  const cached = repo.suffixMatchBySuffix.get(suffix);
  if (cached) return cached;
  const matches = (repo.pathsByBasename.get(path.posix.basename(suffix)) ?? []).filter((candidate) => candidate === suffix || candidate.endsWith(`/${suffix}`));
  const uniqueMatch = matches.length === 1 ? matches : [];
  repo.suffixMatchBySuffix.set(suffix, uniqueMatch);
  return uniqueMatch;
}

function resolvePackageKey(fromPath: string, specifier: string, repo: RepoResolution): string | null {
  const language = importLanguageOf(fromPath);
  if (language?.resolver.kind !== 'packageDirectory' || path.posix.normalize(specifier) !== specifier) return null;
  const specifierKey = `${language.id}\0${specifier}`;
  const cached = repo.packageKeyBySpecifier.get(specifierKey);
  if (cached !== undefined) return cached;
  const { excludedTargetPattern, isRecursive, manifestName } = language.resolver;
  const packageKeyOf = (directory: string) => {
    const packageKey = `${language.id}:${directory}`;
    if (repo.packageFilesByKey.has(packageKey)) return packageKey;
    const directoryFiles = isRecursive ? (targetFilesOf(language, manifestName, repo).get(directory) ?? []) : (repo.filesByDirectory.get(directory) ?? []);
    repo.packageFilesByKey.set(packageKey, directoryFiles.filter((candidate) => importLanguageOf(candidate) === language && !excludedTargetPattern?.test(candidate)));
    return packageKey;
  };
  const packageKey = packagePrefixMatches(repo.packages, manifestName, specifier)
    .map(({ manifestPackage, remainder }) => packageKeyOf(path.posix.join(manifestPackage.sourceDirectory, ...remainder)))
    .find((candidateKey) => (repo.packageFilesByKey.get(candidateKey)?.length ?? 0) > 0) ?? null;
  repo.packageKeyBySpecifier.set(specifierKey, packageKey);
  return packageKey;
}

function resolveSpecifier(fromPath: string, specifier: string, repo: RepoResolution): string[] {
  const language = importLanguageOf(fromPath);
  if (language?.resolver.kind === 'candidates') {
    const { paths, suffixes } = fileCandidatesOf(language.id, fromPath, specifier, repo.packages);
    const found = paths.find((candidate) => repo.sourcePaths.has(candidate)) ?? suffixes.map((suffix) => uniqueSuffixMatch(suffix, repo)).find((matches) => matches.length > 0)?.[0];
    return found && repo.knownPaths.has(found) ? [found] : [];
  }
  if (language?.resolver.kind === 'packageDirectory') return [];
  if (language?.id === 'python') {
    const pythonTarget = resolvePythonSpecifier(fromPath, specifier, repo.knownPaths);
    return pythonTarget ? [pythonTarget] : [];
  }
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const aliasTargets = specifier.startsWith('#')
    ? matchPathPatterns(specifier, Object.fromEntries(Object.entries(repo.importsMap).map(([alias, target]) => [alias, [target]])))
    : [];
  const targets = isRelative ? [path.posix.join(path.posix.dirname(fromPath), specifier)] : specifier.startsWith('#') ? aliasTargets : repo.tsconfigTargets(fromPath, specifier);
  for (const target of targets) {
    const candidatePath = path.posix.normalize(target.replace(/^\.\//, ''));
    if (candidatePath.startsWith('../') || candidatePath === '..' || path.posix.isAbsolute(candidatePath)) continue;
    const found = sourceCandidates(candidatePath).find((candidate) => repo.knownPaths.has(candidate));
    if (found) return [found];
  }
  return [];
}

export function buildImportGraph({
  specifiersByPath,
  importsMap,
  tsconfigTargets = () => [],
  manifestTextByPath = new Map(),
  unscannedSourcePaths = [],
}: {
  specifiersByPath: Map<string, string[]>;
  importsMap: Record<string, string>;
  tsconfigTargets?: (fromPath: string, specifier: string) => string[];
  manifestTextByPath?: ReadonlyMap<string, string>;
  unscannedSourcePaths?: readonly string[];
}): ImportGraph {
  const knownPaths = new Set(specifiersByPath.keys());
  const sourcePaths = new Set([...knownPaths, ...unscannedSourcePaths]);
  const repo: RepoResolution = { knownPaths, sourcePaths, filesByDirectory: filesByDirectoryOf(knownPaths), importsMap, tsconfigTargets, packages: manifestPackageIndexOf(manifestTextByPath), packageFilesByKey: new Map(), packageKeyBySpecifier: new Map(), targetFilesByLanguage: new Map(), pathsByBasename: pathsByBasenameOf(sourcePaths), suffixMatchBySuffix: new Map() };
  const dependentsByPath = new Map(
    [...knownPaths].map((knownPath): [string, Set<string>] => [knownPath, new Set()]),
  );
  const dependentsByPackage = new Map<string, Set<string>>();

  for (const [fromPath, specifiers] of specifiersByPath) {
    for (const specifier of specifiers) {
      const packageKey = resolvePackageKey(fromPath, specifier, repo);
      if (packageKey) {
        dependentsByPackage.set(packageKey, (dependentsByPackage.get(packageKey) ?? new Set()).add(fromPath));
        continue;
      }
      for (const importedPath of resolveSpecifier(fromPath, specifier, repo)) {
        dependentsByPath.get(importedPath)?.add(fromPath);
      }
    }
  }

  const packageKeysByPath = new Map<string, string[]>();
  for (const packageKey of dependentsByPackage.keys()) {
    for (const packagePath of repo.packageFilesByKey.get(packageKey) ?? []) {
      const packageKeys = packageKeysByPath.get(packagePath) ?? [];
      packageKeys.push(packageKey);
      packageKeysByPath.set(packagePath, packageKeys);
    }
  }

  return { dependentsByPath, dependentsByPackage, packageKeysByPath };
}

export function expandedEdgeCountOf(graph: ImportGraph): number {
  let edgeCount = 0;
  for (const dependentPaths of graph.dependentsByPath.values()) edgeCount += dependentPaths.size;
  for (const packageKeys of graph.packageKeysByPath.values()) {
    for (const packageKey of packageKeys) edgeCount += graph.dependentsByPackage.get(packageKey)?.size ?? 0;
  }
  return edgeCount;
}

export function directDependentsOf(graph: ImportGraph, importedPath: string): Set<string> {
  const directDependents = new Set(graph.dependentsByPath.get(importedPath));
  for (const packageKey of graph.packageKeysByPath.get(importedPath) ?? []) {
    for (const dependentPath of graph.dependentsByPackage.get(packageKey) ?? []) {
      if (dependentPath !== importedPath) directDependents.add(dependentPath);
    }
  }
  return directDependents;
}

export const TEST_PATH_PATTERN = '(^|/)(tests|test|__tests__)/|(^|/)spec/.*[.]rb$|[.](test|spec)[.][^/]*$|(^|/)(test_[^/]*|[^/]*_test|conftest)[.]py$|_test[.]go$|_spec[.]rb$|(^|/)Tests/.*[.]swift$';
const TEST_PATH = new RegExp(TEST_PATH_PATTERN);

export function isTestPath(repoPath: string): boolean {
  return TEST_PATH.test(repoPath);
}

function collectTransitiveDependents(graph: ImportGraph, changedPath: string, maxDepth: number): Set<string> {
  const visitedPaths = new Set([changedPath]);
  const queuedPaths = [{ repoPath: changedPath, depth: 0 }];

  const expandedPackageKeys = new Set<string>();

  for (let index = 0; index < queuedPaths.length; index++) {
    const { repoPath, depth } = queuedPaths[index];
    if (depth >= maxDepth) continue;
    const unexpandedPackageKeys = (graph.packageKeysByPath.get(repoPath) ?? []).filter((packageKey) => !expandedPackageKeys.has(packageKey));
    for (const packageKey of unexpandedPackageKeys) expandedPackageKeys.add(packageKey);
    const packageDependents = unexpandedPackageKeys.flatMap((packageKey) => [...(graph.dependentsByPackage.get(packageKey) ?? [])]);
    for (const dependentPath of [...(graph.dependentsByPath.get(repoPath) ?? []), ...packageDependents]) {
      if (visitedPaths.has(dependentPath)) continue;
      visitedPaths.add(dependentPath);
      queuedPaths.push({ repoPath: dependentPath, depth: depth + 1 });
    }
  }

  visitedPaths.delete(changedPath);
  return visitedPaths;
}

export function originByDependentPath(dependentsByPath: ReadonlyMap<string, ReadonlySet<string>>, startPaths: Iterable<string>): Map<string, string> {
  const originByPath = new Map([...startPaths].map((startPath): [string, string] => [startPath, startPath]));
  const queuedPaths = [...originByPath.keys()];
  for (let index = 0; index < queuedPaths.length; index++) {
    const queuedPath = queuedPaths[index];
    const origin = originByPath.get(queuedPath) ?? queuedPath;
    for (const dependentPath of dependentsByPath.get(queuedPath) ?? []) {
      if (originByPath.has(dependentPath)) continue;
      originByPath.set(dependentPath, origin);
      queuedPaths.push(dependentPath);
    }
  }
  return originByPath;
}

function compareRepoPaths(leftPath: string, rightPath: string): number {
  if (leftPath < rightPath) return -1;
  if (leftPath > rightPath) return 1;
  return 0;
}

export function computeBlastRadius({
  repoName,
  graph,
  changedPaths,
  maxDepth = 6,
}: {
  repoName: string;
  graph: ImportGraph;
  changedPaths: string[];
  maxDepth?: number;
}): BlastRadiusFact[] {
  const blastRadius: BlastRadiusFact[] = [];

  for (const changedPath of new Set(changedPaths)) {
    if (isTestPath(changedPath)) continue;
    const transitiveDependents = collectTransitiveDependents(graph, changedPath, maxDepth);
    const dependentTests = [...transitiveDependents].filter(isTestPath).sort();

    if (!graph.dependentsByPath.has(changedPath)) continue;
    const directDependents = directDependentsOf(graph, changedPath);
    if (directDependents.size === 0 && dependentTests.length === 0) continue;

    blastRadius.push({
      factId: changeMapFactId('blast', repoName, changedPath),
      path: changedPath,
      directDependents: [...directDependents].sort().slice(0, CHANGE_MAP_LIST_CAP),
      directDependentCount: directDependents.size,
      transitiveDependentCount: transitiveDependents.size,
      dependentTests: dependentTests.slice(0, CHANGE_MAP_LIST_CAP),
      dependentTestCount: dependentTests.length,
    });
  }

  blastRadius.sort((left, right) => right.transitiveDependentCount - left.transitiveDependentCount || compareRepoPaths(left.path, right.path));
  return blastRadius;
}
