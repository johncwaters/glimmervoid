import fs from 'node:fs';
import path from 'node:path';
import { ClientMessage, ServerMessage } from '../shared/contracts/control-messages.ts';
import { requestId as controlRequestId } from '../shared/contracts/control/control-fields.ts';
import {
  CLIENT_MESSAGE_CLASS,
  COLLECTION_NAMES,
  COLLECTION_OF,
  MUTATION_COLLECTIONS,
  SERVER_MESSAGE_CLASS,
} from '../shared/contracts/control/message-classes.ts';
import type {
  ClientMessageClass,
  CollectionName,
  ServerMessageClass,
} from '../shared/contracts/control/message-classes.ts';
import { readTracked, trackedFiles } from '../tests/helpers/tracked-files.ts';

export interface TrackedSourceFile {
  path: string;
  content: string;
}

export interface SourceMatch {
  line: number;
  form: string;
}

export interface SocketCallMatches {
  sendControlMsg: SourceMatch[];
  sendControlRequest: SourceMatch[];
  onControlMessage: SourceMatch[];
}

export interface StorageCallMatches {
  localStorage: SourceMatch[];
  sessionStorage: SourceMatch[];
  indexedDB: SourceMatch[];
  localStoreImports: SourceMatch[];
}

export interface SubscribeExportMatch {
  line: number;
  form: string;
  name: string;
}

export interface SocketCallCount {
  path: string;
  sendControlMsg: number;
  sendControlRequest: number;
  onControlMessage: number;
}

export interface StorageCallCount {
  path: string;
  localStorage: number;
  sessionStorage: number;
  indexedDB: number;
  localStoreImports: number;
}

export interface SubscribeExport {
  path: string;
  name: string;
}

export interface ClientMessageVariant {
  type: ClientMessage['type'];
  hasRequestId: boolean;
  messageClass: ClientMessageClass;
  collections?: readonly CollectionName[];
}

export interface ServerMessageVariant {
  type: ServerMessage['type'];
  messageClass: ServerMessageClass;
  collection?: CollectionName;
  hasAppliedSeq?: boolean;
}

export interface ControlHandlerEntryAnalysis {
  path: string;
  typeName: string;
  line: number;
  messageClass: ClientMessageClass;
  hasReplyApplied: boolean;
  replyAppliedLine: number | null;
  bareReplies: SourceMatch[];
  replyTypes: string[];
}

export interface StateInventory {
  socketCalls: SocketCallCount[];
  storageCalls: StorageCallCount[];
  subscribeModules: SubscribeExport[];
  collections: readonly CollectionName[];
  clientTypes: ClientMessageVariant[];
  serverTypes: ServerMessageVariant[];
  unconvertedMutatingHandlers: Record<string, number>;
  legacyMutatingWithoutRequestId: string[];
  legacyMutatingRepliesWithoutAppliedSeq: string[];
}

export interface SocketCallRatchetEntry {
  sendControlMsg: number;
  sendControlRequest: number;
  onControlMessage: number;
}

export interface StateRatchetData {
  socketCalls: Record<string, SocketCallRatchetEntry>;
  localStoreImports: Record<string, number>;
  subscribeModules: string[];
  unconvertedMutatingHandlers: Record<string, number>;
  legacyMutatingWithoutRequestId: string[];
  legacyMutatingRepliesWithoutAppliedSeq: string[];
}

const REPO_ROOT = path.join(import.meta.dirname, '..');
export const STATE_RATCHETS_RELATIVE_PATH = 'tests/gates/state-ratchets.json';
export const PUBLIC_SOURCE_PATTERN = /^public\/.*\.tsx?$/;
export const CONTROL_HANDLER_PATTERN = /^server\/control\/handlers\/.*-handlers\.ts$/;

const IMPORT_STATEMENT_PATTERN = /^\s*import\s+(?:type\s+)?[^;]*?\bfrom\s+['"][^'"]+['"];?/gm;
const NAMED_CONTROL_WS_IMPORT_PATTERN = /\bimport\s+(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*['"][^'"]*\/control-ws(?:\.[cm]?[jt]s)?['"]/g;
const SEND_CONTROL_MSG_PATTERN = /(?<!\b(?:function|typeof)\s+)\bsendControlMsg\b/g;
const SEND_CONTROL_REQUEST_PATTERN = /(?<!\b(?:function|typeof)\s+)\bsendControlRequest\b/g;
const ON_CONTROL_MESSAGE_PATTERN = /(?<!\b(?:function|typeof)\s+)\bonControlMessage\b/g;
const LOCAL_STORAGE_PATTERN = /\blocalStorage\b/g;
const SESSION_STORAGE_PATTERN = /\bsessionStorage\b/g;
const INDEXED_DB_PATTERN = /\bindexedDB\b/g;
const LOCAL_STORE_IMPORT_PATTERN = /\bfrom\s+['"][^'"]*\/local-store(?:\.[cm]?[jt]s)?['"]|\bimport\s*\(\s*['"][^'"]*\/local-store(?:\.[cm]?[jt]s)?['"]\s*\)/g;
const SUBSCRIBE_DECLARATION_EXPORT_PATTERN = /\bexport\s+(?:default\s+)?(?:(?:async\s+)?function\*?|const|let|var)\s+(subscribe[A-Z][A-Za-z0-9_$]*)/g;
const SUBSCRIBE_EXPORT_LIST_PATTERN = /\bexport\s+(?!type\b)\{([^}]+)\}/g;
const SUBSCRIBE_NAME_PATTERN = /^subscribe[A-Z][A-Za-z0-9_$]*$/;

const SOCKET_EXEMPT_EXACT = new Set([
  'public/control-ws.ts',
  'public/connection-supervisor.ts',
]);

const STORAGE_EXEMPT_EXACT = new Set([
  'public/local-store.ts',
  'public/state/persist.ts',
]);

export function isSocketBoundaryExempt(repoPath: string): boolean {
  if (SOCKET_EXEMPT_EXACT.has(repoPath)) return true;
  return repoPath.startsWith('public/state/') || repoPath.startsWith('public/boot/');
}

export function isStorageBoundaryExempt(repoPath: string): boolean {
  return STORAGE_EXEMPT_EXACT.has(repoPath);
}

export function isStoreModuleExempt(repoPath: string): boolean {
  return repoPath.startsWith('public/state/');
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripImportStatementsPreservingLines(sourceText: string): string {
  return sourceText.replace(IMPORT_STATEMENT_PATTERN, (statement) => statement.replace(/[^\n]/g, ' '));
}

export function findMatchesWithLines(sourceText: string, pattern: RegExp): SourceMatch[] {
  const matches: SourceMatch[] = [];
  let currentLine = 1;
  let scannedOffset = 0;
  for (const match of sourceText.matchAll(pattern)) {
    const matchOffset = match.index ?? 0;
    for (let index = scannedOffset; index < matchOffset; index += 1) {
      if (sourceText.charCodeAt(index) === 10) currentLine += 1;
    }
    scannedOffset = matchOffset;
    matches.push({ line: currentLine, form: match[0] });
  }
  return matches;
}

function controlWsAliasesBySymbol(sourceText: string): Record<keyof SocketCallMatches, Set<string>> {
  const aliasesBySymbol: Record<keyof SocketCallMatches, Set<string>> = {
    sendControlMsg: new Set(),
    sendControlRequest: new Set(),
    onControlMessage: new Set(),
  };
  for (const match of sourceText.matchAll(NAMED_CONTROL_WS_IMPORT_PATTERN)) {
    const specifierBody = match[1] ?? '';
    for (const rawSpecifier of specifierBody.split(',')) {
      const cleaned = rawSpecifier.trim().replace(/^type\s+/, '');
      if (!cleaned) continue;
      const parts = cleaned.split(/\s+as\s+/);
      if (parts.length !== 2) continue;
      const importedName = parts[0]?.trim() ?? '';
      const localAlias = parts[1]?.trim() ?? '';
      if (!localAlias || localAlias === importedName) continue;
      if (importedName === 'sendControlMsg' || importedName === 'sendControlRequest' || importedName === 'onControlMessage') {
        aliasesBySymbol[importedName].add(localAlias);
      }
    }
  }
  return aliasesBySymbol;
}

function matchesForSocketSymbol(
  bodyWithoutImports: string,
  basePattern: RegExp,
  aliases: ReadonlySet<string>,
): SourceMatch[] {
  const matches = findMatchesWithLines(bodyWithoutImports, basePattern);
  if (aliases.size === 0) return matches;
  for (const alias of aliases) {
    const aliasPattern = new RegExp(`(?<!\\b(?:function|typeof)\\s+)\\b${escapeRegExp(alias)}\\b`, 'g');
    matches.push(...findMatchesWithLines(bodyWithoutImports, aliasPattern));
  }
  return matches.sort((left, right) => left.line - right.line);
}

export function findSocketCallsInSource(sourceText: string): SocketCallMatches {
  const aliases = controlWsAliasesBySymbol(sourceText);
  const bodyWithoutImports = stripImportStatementsPreservingLines(sourceText);
  return {
    sendControlMsg: matchesForSocketSymbol(bodyWithoutImports, SEND_CONTROL_MSG_PATTERN, aliases.sendControlMsg),
    sendControlRequest: matchesForSocketSymbol(bodyWithoutImports, SEND_CONTROL_REQUEST_PATTERN, aliases.sendControlRequest),
    onControlMessage: matchesForSocketSymbol(bodyWithoutImports, ON_CONTROL_MESSAGE_PATTERN, aliases.onControlMessage),
  };
}

export function findStorageCallsInSource(sourceText: string): StorageCallMatches {
  return {
    localStorage: findMatchesWithLines(sourceText, LOCAL_STORAGE_PATTERN),
    sessionStorage: findMatchesWithLines(sourceText, SESSION_STORAGE_PATTERN),
    indexedDB: findMatchesWithLines(sourceText, INDEXED_DB_PATTERN),
    localStoreImports: findMatchesWithLines(sourceText, LOCAL_STORE_IMPORT_PATTERN),
  };
}

export function findSubscribeExportsInSource(sourceText: string): SubscribeExportMatch[] {
  const matches: SubscribeExportMatch[] = [];
  let currentLine = 1;
  let scannedOffset = 0;
  const lineAtOffset = (targetOffset: number): number => {
    for (let index = scannedOffset; index < targetOffset; index += 1) {
      if (sourceText.charCodeAt(index) === 10) currentLine += 1;
    }
    scannedOffset = targetOffset;
    return currentLine;
  };

  for (const match of sourceText.matchAll(SUBSCRIBE_DECLARATION_EXPORT_PATTERN)) {
    matches.push({ line: lineAtOffset(match.index ?? 0), form: match[0], name: match[1] });
  }

  currentLine = 1;
  scannedOffset = 0;
  for (const match of sourceText.matchAll(SUBSCRIBE_EXPORT_LIST_PATTERN)) {
    const blockStart = match.index ?? 0;
    const blockText = match[0];
    const specifierBody = match[1] ?? '';
    for (const rawSpecifier of specifierBody.split(',')) {
      const cleaned = rawSpecifier.trim();
      if (!cleaned || cleaned.startsWith('type ')) continue;
      const exportedName = cleaned.split(/\s+as\s+/).at(-1)?.trim() ?? '';
      if (!SUBSCRIBE_NAME_PATTERN.test(exportedName)) continue;
      const offsetInBlock = Math.max(0, blockText.indexOf(exportedName));
      matches.push({
        line: lineAtOffset(blockStart + offsetInBlock),
        form: `export { ${cleaned} }`,
        name: exportedName,
      });
    }
  }

  return matches.sort((left, right) => {
    if (left.line !== right.line) return left.line - right.line;
    return compareText(left.name, right.name);
  });
}

function collectSocketCalls(sourceFiles: readonly TrackedSourceFile[]): SocketCallCount[] {
  const counts: SocketCallCount[] = [];
  for (const sourceFile of sourceFiles) {
    const found = findSocketCallsInSource(sourceFile.content);
    const sendControlMsg = found.sendControlMsg.length;
    const sendControlRequest = found.sendControlRequest.length;
    const onControlMessage = found.onControlMessage.length;
    if (sendControlMsg === 0 && sendControlRequest === 0 && onControlMessage === 0) continue;
    counts.push({
      path: sourceFile.path,
      sendControlMsg,
      sendControlRequest,
      onControlMessage,
    });
  }
  return counts.sort((left, right) => compareText(left.path, right.path));
}

function collectStorageCalls(sourceFiles: readonly TrackedSourceFile[]): StorageCallCount[] {
  const counts: StorageCallCount[] = [];
  for (const sourceFile of sourceFiles) {
    const found = findStorageCallsInSource(sourceFile.content);
    const localStorage = found.localStorage.length;
    const sessionStorage = found.sessionStorage.length;
    const indexedDB = found.indexedDB.length;
    const localStoreImports = found.localStoreImports.length;
    if (localStorage === 0 && sessionStorage === 0 && indexedDB === 0 && localStoreImports === 0) continue;
    counts.push({
      path: sourceFile.path,
      localStorage,
      sessionStorage,
      indexedDB,
      localStoreImports,
    });
  }
  return counts.sort((left, right) => compareText(left.path, right.path));
}

function collectSubscribeModules(sourceFiles: readonly TrackedSourceFile[]): SubscribeExport[] {
  const exportsList: SubscribeExport[] = [];
  for (const sourceFile of sourceFiles) {
    for (const match of findSubscribeExportsInSource(sourceFile.content)) {
      exportsList.push({
        path: sourceFile.path,
        name: match.name,
      });
    }
  }
  return exportsList.sort((left, right) => {
    const pathOrder = compareText(left.path, right.path);
    if (pathOrder !== 0) return pathOrder;
    return compareText(left.name, right.name);
  });
}

function mutationCollectionsFor(type: ClientMessage['type']): readonly CollectionName[] | undefined {
  if (!Object.hasOwn(MUTATION_COLLECTIONS, type)) return undefined;
  return MUTATION_COLLECTIONS[type as keyof typeof MUTATION_COLLECTIONS];
}

function collectionFor(type: ServerMessage['type']): CollectionName | undefined {
  if (!Object.hasOwn(COLLECTION_OF, type)) return undefined;
  return COLLECTION_OF[type as keyof typeof COLLECTION_OF];
}

function collectClientTypes(): ClientMessageVariant[] {
  return ClientMessage.options
    .map((option) => {
      const type = option.shape.type.value;
      const collections = mutationCollectionsFor(type);
      return {
        type,
        hasRequestId: 'requestId' in option.shape && option.shape.requestId === controlRequestId,
        messageClass: CLIENT_MESSAGE_CLASS[type],
        ...(collections === undefined ? {} : { collections }),
      };
    })
    .sort((left, right) => compareText(left.type, right.type));
}

function lineNumberAtOffset(sourceText: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < sourceText.length; index += 1) {
    if (sourceText.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function findMatchingDelimiter(sourceText: string, openOffset: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let index = openOffset;
  let activeQuote: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < sourceText.length) {
    const current = sourceText[index];
    const next = sourceText[index + 1];
    if (inLineComment) {
      if (current === '\n') inLineComment = false;
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (activeQuote !== null) {
      if (current === '\\') {
        index += 2;
        continue;
      }
      if (current === activeQuote) activeQuote = null;
      index += 1;
      continue;
    }
    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (current === '"' || current === '\'' || current === '`') {
      activeQuote = current;
      index += 1;
      continue;
    }
    if (current === openChar) depth += 1;
    if (current === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function findFunctionBodyStart(sourceText: string, parenOpenOffset: number): number {
  const parenCloseOffset = findMatchingDelimiter(sourceText, parenOpenOffset, '(', ')');
  if (parenCloseOffset === -1) return -1;
  let index = parenCloseOffset + 1;
  let angleDepth = 0;
  while (index < sourceText.length) {
    const current = sourceText[index];
    if (current === '<') {
      angleDepth += 1;
      index += 1;
      continue;
    }
    if (current === '>' && angleDepth > 0) {
      angleDepth -= 1;
      index += 1;
      continue;
    }
    if (angleDepth > 0) {
      index += 1;
      continue;
    }
    if (current === '{') {
      const closeOffset = findMatchingDelimiter(sourceText, index, '{', '}');
      if (closeOffset === -1) return -1;
      const trailingToken = sourceText.slice(closeOffset + 1).match(/^\s*([|&{;])/);
      if (trailingToken && (trailingToken[1] === '{' || trailingToken[1] === '|' || trailingToken[1] === '&')) {
        index = closeOffset + 1;
        continue;
      }
      return index;
    }
    if (current === ';') return -1;
    index += 1;
  }
  return -1;
}

interface LocalFunctionBody {
  code: string;
  startOffset: number;
}

const REPLY_SCHEMA_TYPE_SET = new Set<string>(
  ServerMessage.options
    .filter((option) => SERVER_MESSAGE_CLASS[option.shape.type.value] === 'reply')
    .map((option) => option.shape.type.value),
);

function findMatchingOpenBraceBefore(sourceText: string, closeBraceOffset: number): number {
  let depth = 0;
  let index = closeBraceOffset;
  let activeQuote: string | null = null;

  while (index >= 0) {
    const current = sourceText[index];
    if (activeQuote !== null) {
      if (current === activeQuote && sourceText[index - 1] !== '\\') activeQuote = null;
      index -= 1;
      continue;
    }
    if (current === '"' || current === '\'' || current === '`') {
      activeQuote = current;
      index -= 1;
      continue;
    }
    if (current === '}') depth += 1;
    if (current === '{') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index -= 1;
  }
  return -1;
}

function findHandlerTableBounds(sourceText: string): { openOffset: number; closeOffset: number } | null {
  const typedTableMatch = /:\s*ControlHandlerTable\s*=\s*\{/.exec(sourceText);
  if (typedTableMatch) {
    const openOffset = typedTableMatch.index + typedTableMatch[0].length - 1;
    const closeOffset = findMatchingDelimiter(sourceText, openOffset, '{', '}');
    if (closeOffset !== -1) return { openOffset, closeOffset };
  }

  const satisfiesMatch = /\}\s*satisfies\s+ControlHandlerTable\b/.exec(sourceText);
  if (satisfiesMatch) {
    const closeOffset = satisfiesMatch.index;
    const openOffset = findMatchingOpenBraceBefore(sourceText, closeOffset);
    if (openOffset !== -1) return { openOffset, closeOffset };
  }

  return null;
}

function findArrowOrExpressionEnd(sourceText: string, startOffset: number): number {
  let index = startOffset;
  while (index < sourceText.length && /\s/.test(sourceText[index])) index += 1;
  if (sourceText[index] === '{') {
    const closeOffset = findMatchingDelimiter(sourceText, index, '{', '}');
    return closeOffset === -1 ? -1 : closeOffset + 1;
  }
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let activeQuote: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (index < sourceText.length) {
    const current = sourceText[index];
    const next = sourceText[index + 1];
    if (inLineComment) {
      if (current === '\n') inLineComment = false;
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (activeQuote !== null) {
      if (current === '\\') {
        index += 2;
        continue;
      }
      if (current === activeQuote) activeQuote = null;
      index += 1;
      continue;
    }
    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (current === '"' || current === '\'' || current === '`') {
      activeQuote = current;
      index += 1;
      continue;
    }
    if (current === '(') parenDepth += 1;
    if (current === ')') parenDepth -= 1;
    if (current === '{') braceDepth += 1;
    if (current === '}') braceDepth -= 1;
    if (current === '[') bracketDepth += 1;
    if (current === ']') bracketDepth -= 1;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && (current === ';' || current === '\n')) {
      return index;
    }
    index += 1;
  }
  return sourceText.length;
}

interface TopLevelProperty {
  key: string;
  keyOffset: number;
  valueCode: string;
  valueOffset: number;
}

function parseTopLevelObjectProperties(sourceText: string, openOffset: number, closeOffset: number): TopLevelProperty[] {
  const properties: TopLevelProperty[] = [];
  let index = openOffset + 1;

  const skipWhitespaceAndComments = () => {
    while (index < closeOffset) {
      const current = sourceText[index];
      const next = sourceText[index + 1];
      if (/\s/.test(current)) {
        index += 1;
        continue;
      }
      if (current === '/' && next === '/') {
        const lineEnd = sourceText.indexOf('\n', index + 2);
        index = lineEnd === -1 ? closeOffset : lineEnd + 1;
        continue;
      }
      if (current === '/' && next === '*') {
        const blockEnd = sourceText.indexOf('*/', index + 2);
        index = blockEnd === -1 ? closeOffset : blockEnd + 2;
        continue;
      }
      break;
    }
  };

  while (index < closeOffset) {
    skipWhitespaceAndComments();
    if (index >= closeOffset) break;
    if (sourceText[index] === ',') {
      index += 1;
      continue;
    }

    const keyOffset = index;
    let key = '';
    if (sourceText[index] === '\'' || sourceText[index] === '"') {
      const quote = sourceText[index];
      const quoteEnd = sourceText.indexOf(quote, index + 1);
      if (quoteEnd === -1 || quoteEnd >= closeOffset) break;
      key = sourceText.slice(index + 1, quoteEnd);
      index = quoteEnd + 1;
    }
    if (key === '') {
      const identMatch = /^[A-Za-z_$][\w$]*/.exec(sourceText.slice(index, closeOffset));
      if (!identMatch) break;
      key = identMatch[0];
      index += key.length;
    }

    skipWhitespaceAndComments();
    if (sourceText[index] !== ':') {
      while (index < closeOffset && sourceText[index] !== ',') index += 1;
      continue;
    }
    index += 1;
    skipWhitespaceAndComments();
    const valueOffset = index;

    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let activeQuote: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    while (index < closeOffset) {
      const current = sourceText[index];
      const next = sourceText[index + 1];
      if (inLineComment) {
        if (current === '\n') inLineComment = false;
        index += 1;
        continue;
      }
      if (inBlockComment) {
        if (current === '*' && next === '/') {
          inBlockComment = false;
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }
      if (activeQuote !== null) {
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === activeQuote) activeQuote = null;
        index += 1;
        continue;
      }
      if (current === '/' && next === '/') {
        inLineComment = true;
        index += 2;
        continue;
      }
      if (current === '/' && next === '*') {
        inBlockComment = true;
        index += 2;
        continue;
      }
      if (current === '"' || current === '\'' || current === '`') {
        activeQuote = current;
        index += 1;
        continue;
      }
      if (current === '{') braceDepth += 1;
      if (current === '}') braceDepth -= 1;
      if (current === '(') parenDepth += 1;
      if (current === ')') parenDepth -= 1;
      if (current === '[') bracketDepth += 1;
      if (current === ']') bracketDepth -= 1;
      if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && current === ',') break;
      index += 1;
    }

    properties.push({
      key,
      keyOffset,
      valueCode: sourceText.slice(valueOffset, index),
      valueOffset,
    });
    if (sourceText[index] === ',') index += 1;
  }

  return properties;
}

export function analyzeControlHandlerFile(sourceFile: TrackedSourceFile): ControlHandlerEntryAnalysis[] {
  const sourceText = sourceFile.content;
  const tableBounds = findHandlerTableBounds(sourceText);
  if (!tableBounds) return [];

  const localFunctions = new Map<string, LocalFunctionBody>();
  const excludedRanges: Array<{ start: number; end: number }> = [
    { start: tableBounds.openOffset, end: tableBounds.closeOffset },
  ];
  const isInsideExcludedRange = (offset: number): boolean =>
    excludedRanges.some((range) => offset > range.start && offset < range.end);

  for (const match of sourceText.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>\s*)?\(/g)) {
    const declOffset = match.index ?? 0;
    if (isInsideExcludedRange(declOffset)) continue;
    const parenOpenOffset = declOffset + match[0].length - 1;
    const bodyStart = findFunctionBodyStart(sourceText, parenOpenOffset);
    if (bodyStart === -1) continue;
    const bodyEnd = findMatchingDelimiter(sourceText, bodyStart, '{', '}');
    if (bodyEnd === -1) continue;
    const enclosesTable = bodyStart < tableBounds.openOffset && bodyEnd > tableBounds.closeOffset;
    if (enclosesTable) continue;
    localFunctions.set(match[1], { code: sourceText.slice(bodyStart, bodyEnd + 1), startOffset: bodyStart });
    excludedRanges.push({ start: bodyStart, end: bodyEnd });
  }
  for (const match of sourceText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|function\b)/g)) {
    const declOffset = match.index ?? 0;
    if (isInsideExcludedRange(declOffset)) continue;
    const fnName = match[1];
    if (localFunctions.has(fnName)) continue;
    const matchEnd = declOffset + match[0].length;
    const parenOpenOffset = sourceText.indexOf('(', matchEnd - 1);
    if (parenOpenOffset === -1) continue;
    const parenCloseOffset = findMatchingDelimiter(sourceText, parenOpenOffset, '(', ')');
    if (parenCloseOffset === -1) continue;
    const afterParen = sourceText.slice(parenCloseOffset + 1);
    const arrowMatch = /^\s*(?::[^=>]+)?=>/.exec(afterParen);
    if (arrowMatch) {
      const bodyStart = parenCloseOffset + 1 + arrowMatch[0].length;
      const bodyEnd = findArrowOrExpressionEnd(sourceText, bodyStart);
      if (bodyEnd !== -1) {
        const enclosesTable = bodyStart < tableBounds.openOffset && bodyEnd > tableBounds.closeOffset;
        if (!enclosesTable) {
          localFunctions.set(fnName, { code: sourceText.slice(bodyStart, bodyEnd), startOffset: bodyStart });
          excludedRanges.push({ start: bodyStart, end: bodyEnd });
        }
      }
      continue;
    }
    const bodyStart = findFunctionBodyStart(sourceText, parenOpenOffset);
    if (bodyStart === -1) continue;
    const bodyEnd = findMatchingDelimiter(sourceText, bodyStart, '{', '}');
    if (bodyEnd !== -1) {
      const enclosesTable = bodyStart < tableBounds.openOffset && bodyEnd > tableBounds.closeOffset;
      if (!enclosesTable) {
        localFunctions.set(fnName, { code: sourceText.slice(bodyStart, bodyEnd + 1), startOffset: bodyStart });
        excludedRanges.push({ start: bodyStart, end: bodyEnd });
      }
    }
  }

  const tableProperties = parseTopLevelObjectProperties(sourceText, tableBounds.openOffset, tableBounds.closeOffset);
  const analyses: ControlHandlerEntryAnalysis[] = [];

  for (const property of tableProperties) {
    const typeName = property.key;
    if (!Object.hasOwn(CLIENT_MESSAGE_CLASS, typeName)) continue;
    const messageClass = CLIENT_MESSAGE_CLASS[typeName as ClientMessage['type']];

    const visitedFunctions = new Set<string>();
    let hasReplyApplied = false;
    let replyAppliedLine: number | null = null;
    const bareReplies: SourceMatch[] = [];
    const replyTypes = new Set<string>();

    const walkCode = (code: string, baseOffset: number) => {
      const replyAppliedMatch = /\breplyApplied\s*\(/.exec(code);
      if (replyAppliedMatch) {
        hasReplyApplied = true;
        if (replyAppliedLine === null) {
          replyAppliedLine = lineNumberAtOffset(sourceText, baseOffset + replyAppliedMatch.index);
        }
      }
      for (const bareMatch of code.matchAll(/\b(replyTo)\s*\(|\b([A-Za-z_$][\w$]*)\.send\s*\(|\breply\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
        const matchOffset = bareMatch.index ?? 0;
        const form = bareMatch[1]
          ? `${bareMatch[1]}(`
          : (bareMatch[2] ? `${bareMatch[2]}.send(` : `reply(${bareMatch[3]},`);
        bareReplies.push({ line: lineNumberAtOffset(sourceText, baseOffset + matchOffset), form });
      }
      for (const stringMatch of code.matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)) {
        if (REPLY_SCHEMA_TYPE_SET.has(stringMatch[1])) replyTypes.add(stringMatch[1]);
      }
      for (const identMatch of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
        const identName = identMatch[1];
        const localBody = localFunctions.get(identName);
        if (!localBody || visitedFunctions.has(identName)) continue;
        visitedFunctions.add(identName);
        walkCode(localBody.code, localBody.startOffset);
      }
    };

    walkCode(property.valueCode, property.valueOffset);
    bareReplies.sort((left, right) => left.line - right.line);
    analyses.push({
      path: sourceFile.path,
      typeName,
      line: lineNumberAtOffset(sourceText, property.keyOffset),
      messageClass,
      hasReplyApplied,
      replyAppliedLine,
      bareReplies,
      replyTypes: [...replyTypes].sort(compareText),
    });
  }

  return analyses;
}

function collectServerTypes(): ServerMessageVariant[] {
  return ServerMessage.options
    .map((option) => {
      const type = option.shape.type.value;
      const collection = collectionFor(type);
      const messageClass = SERVER_MESSAGE_CLASS[type];
      return {
        type,
        messageClass,
        ...(collection === undefined ? {} : { collection }),
        ...(messageClass === 'reply' ? { hasAppliedSeq: Object.hasOwn(option.shape, 'appliedSeq') } : {}),
      };
    })
    .sort((left, right) => compareText(left.type, right.type));
}

function collectReplyAppliedRatchets(
  handlerFiles: readonly TrackedSourceFile[],
  clientTypes: readonly ClientMessageVariant[],
  serverTypes: readonly ServerMessageVariant[],
): {
  unconvertedMutatingHandlers: Record<string, number>;
  legacyMutatingWithoutRequestId: string[];
  legacyMutatingRepliesWithoutAppliedSeq: string[];
} {
  const unconvertedMutatingHandlers: Record<string, number> = {};
  const mutatingReplyTypes = new Set<string>();
  const sortedHandlerFiles = [...handlerFiles].sort((left, right) => compareText(left.path, right.path));

  for (const handlerFile of sortedHandlerFiles) {
    const entries = analyzeControlHandlerFile(handlerFile);
    let unconvertedCount = 0;
    for (const entry of entries) {
      if (entry.messageClass !== 'mutating') continue;
      for (const replyType of entry.replyTypes) mutatingReplyTypes.add(replyType);
      if (!entry.hasReplyApplied || entry.bareReplies.length > 0) unconvertedCount += 1;
    }
    if (unconvertedCount > 0) unconvertedMutatingHandlers[handlerFile.path] = unconvertedCount;
  }

  const legacyMutatingWithoutRequestId = clientTypes
    .filter((variant) => variant.messageClass === 'mutating' && !variant.hasRequestId)
    .map((variant) => variant.type)
    .sort(compareText);

  const serverReplyHasAppliedSeq = new Map<string, boolean>();
  for (const variant of serverTypes) {
    if (variant.messageClass === 'reply') serverReplyHasAppliedSeq.set(variant.type, variant.hasAppliedSeq === true);
  }

  const legacyMutatingRepliesWithoutAppliedSeq = [...mutatingReplyTypes]
    .filter((replyType) => serverReplyHasAppliedSeq.get(replyType) === false)
    .sort(compareText);

  return {
    unconvertedMutatingHandlers,
    legacyMutatingWithoutRequestId,
    legacyMutatingRepliesWithoutAppliedSeq,
  };
}

export function collectStateInventoryFromFiles(
  sourceFiles: readonly TrackedSourceFile[],
  handlerFiles: readonly TrackedSourceFile[] = [],
): StateInventory {
  const clientTypes = collectClientTypes();
  const serverTypes = collectServerTypes();
  const replyApplied = collectReplyAppliedRatchets(handlerFiles, clientTypes, serverTypes);
  return {
    socketCalls: collectSocketCalls(sourceFiles),
    storageCalls: collectStorageCalls(sourceFiles),
    subscribeModules: collectSubscribeModules(sourceFiles),
    collections: [...COLLECTION_NAMES].sort(compareText),
    clientTypes,
    serverTypes,
    ...replyApplied,
  };
}

export function collectStateInventory(): StateInventory {
  const trackedPaths = trackedFiles(PUBLIC_SOURCE_PATTERN).sort(compareText);
  if (trackedPaths.length === 0) {
    throw new Error('expected tracked TypeScript files under public/, found none');
  }
  const sourceFiles = trackedPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  const handlerPaths = trackedFiles(CONTROL_HANDLER_PATTERN).sort(compareText);
  const handlerFiles = handlerPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  return collectStateInventoryFromFiles(sourceFiles, handlerFiles);
}

export function formatStateInventory(inventory: StateInventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function buildStateRatchetData(inventory: StateInventory): StateRatchetData {
  const socketCalls: Record<string, SocketCallRatchetEntry> = {};
  for (const entry of inventory.socketCalls) {
    if (isSocketBoundaryExempt(entry.path)) continue;
    socketCalls[entry.path] = {
      sendControlMsg: entry.sendControlMsg,
      sendControlRequest: entry.sendControlRequest,
      onControlMessage: entry.onControlMessage,
    };
  }

  const localStoreImports: Record<string, number> = {};
  for (const entry of inventory.storageCalls) {
    if (isStorageBoundaryExempt(entry.path) || entry.localStoreImports === 0) continue;
    localStoreImports[entry.path] = entry.localStoreImports;
  }

  const subscribeModules = [...new Set(
    inventory.subscribeModules
      .map((entry) => entry.path)
      .filter((repoPath) => !isStoreModuleExempt(repoPath)),
  )].sort(compareText);

  return {
    socketCalls,
    localStoreImports,
    subscribeModules,
    unconvertedMutatingHandlers: inventory.unconvertedMutatingHandlers,
    legacyMutatingWithoutRequestId: inventory.legacyMutatingWithoutRequestId,
    legacyMutatingRepliesWithoutAppliedSeq: inventory.legacyMutatingRepliesWithoutAppliedSeq,
  };
}

export function formatStateRatchetData(ratchets: StateRatchetData): string {
  return `${JSON.stringify(ratchets, null, 2)}\n`;
}

export function readCommittedStateRatchets(): StateRatchetData {
  const ratchetsPath = path.join(REPO_ROOT, STATE_RATCHETS_RELATIVE_PATH);
  return JSON.parse(fs.readFileSync(ratchetsPath, 'utf8')) as StateRatchetData;
}

if (import.meta.main) {
  const inventory = collectStateInventory();
  if (process.argv.includes('--write-ratchets')) {
    const ratchetsPath = path.join(REPO_ROOT, STATE_RATCHETS_RELATIVE_PATH);
    fs.writeFileSync(ratchetsPath, formatStateRatchetData(buildStateRatchetData(inventory)), 'utf8');
  }
  if (!process.argv.includes('--write-ratchets')) {
    process.stdout.write(formatStateInventory(inventory));
  }
}
