import fs from 'node:fs';
import path from 'node:path';
import { ClientMessage, ServerMessage } from '../shared/contracts/control-messages.ts';
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
}

export interface StateInventory {
  socketCalls: SocketCallCount[];
  storageCalls: StorageCallCount[];
  subscribeModules: SubscribeExport[];
  collections: readonly CollectionName[];
  clientTypes: ClientMessageVariant[];
  serverTypes: ServerMessageVariant[];
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
}

const REPO_ROOT = path.join(import.meta.dirname, '..');
export const STATE_RATCHETS_RELATIVE_PATH = 'tests/gates/state-ratchets.json';
export const PUBLIC_SOURCE_PATTERN = /^public\/.*\.tsx?$/;

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
        hasRequestId: Object.hasOwn(option.shape, 'requestId'),
        messageClass: CLIENT_MESSAGE_CLASS[type],
        ...(collections === undefined ? {} : { collections }),
      };
    })
    .sort((left, right) => compareText(left.type, right.type));
}

function collectServerTypes(): ServerMessageVariant[] {
  return ServerMessage.options
    .map((option) => {
      const type = option.shape.type.value;
      const collection = collectionFor(type);
      return {
        type,
        messageClass: SERVER_MESSAGE_CLASS[type],
        ...(collection === undefined ? {} : { collection }),
      };
    })
    .sort((left, right) => compareText(left.type, right.type));
}

export function collectStateInventoryFromFiles(sourceFiles: readonly TrackedSourceFile[]): StateInventory {
  return {
    socketCalls: collectSocketCalls(sourceFiles),
    storageCalls: collectStorageCalls(sourceFiles),
    subscribeModules: collectSubscribeModules(sourceFiles),
    collections: [...COLLECTION_NAMES].sort(compareText),
    clientTypes: collectClientTypes(),
    serverTypes: collectServerTypes(),
  };
}

export function collectStateInventory(): StateInventory {
  const trackedPaths = trackedFiles(PUBLIC_SOURCE_PATTERN).sort(compareText);
  if (trackedPaths.length === 0) {
    throw new Error('expected tracked TypeScript files under public/, found none');
  }
  const sourceFiles = trackedPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  return collectStateInventoryFromFiles(sourceFiles);
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
