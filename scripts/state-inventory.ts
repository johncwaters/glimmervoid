import { ClientMessage, ServerMessage } from '../shared/contracts/control-messages.ts';
import { readTracked, trackedFiles } from '../tests/helpers/tracked-files.ts';

export interface TrackedSourceFile {
  path: string;
  content: string;
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
  type: string;
  hasRequestId: boolean;
}

export interface StateInventory {
  socketCalls: SocketCallCount[];
  storageCalls: StorageCallCount[];
  subscribeModules: SubscribeExport[];
  clientTypes: ClientMessageVariant[];
  serverTypes: string[];
}

const PUBLIC_SOURCE_PATTERN = /^public\/.*\.tsx?$/;
const IMPORT_STATEMENT_PATTERN = /^\s*import\s+(?:type\s+)?[\s\S]*?from\s+['"][^'"]+['"];?/gm;
const SEND_CONTROL_MSG_PATTERN = /(?<!\b(?:function|typeof)\s+)\bsendControlMsg\b/g;
const SEND_CONTROL_REQUEST_PATTERN = /(?<!\b(?:function|typeof)\s+)\bsendControlRequest\b/g;
const ON_CONTROL_MESSAGE_PATTERN = /(?<!\b(?:function|typeof)\s+)\bonControlMessage\b/g;
const LOCAL_STORAGE_PATTERN = /\blocalStorage\b/g;
const SESSION_STORAGE_PATTERN = /\bsessionStorage\b/g;
const INDEXED_DB_PATTERN = /\bindexedDB\b/g;
const LOCAL_STORE_IMPORT_PATTERN = /\bfrom\s+['"][^'"]*\/local-store(?:\.ts)?['"]|\bimport\s*\(\s*['"][^'"]*\/local-store(?:\.ts)?['"]\s*\)/g;
const SUBSCRIBE_EXPORT_PATTERN = /\bexport\s+function\s+(subscribe[A-Z][A-Za-z0-9_$]*)/g;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function countMatches(sourceText: string, pattern: RegExp): number {
  return (sourceText.match(pattern) ?? []).length;
}

function stripImportStatements(sourceText: string): string {
  return sourceText.replace(IMPORT_STATEMENT_PATTERN, '');
}

function collectSocketCalls(sourceFiles: readonly TrackedSourceFile[]): SocketCallCount[] {
  const counts: SocketCallCount[] = [];
  for (const sourceFile of sourceFiles) {
    const bodyWithoutImports = stripImportStatements(sourceFile.content);
    const sendControlMsg = countMatches(bodyWithoutImports, SEND_CONTROL_MSG_PATTERN);
    const sendControlRequest = countMatches(bodyWithoutImports, SEND_CONTROL_REQUEST_PATTERN);
    const onControlMessage = countMatches(bodyWithoutImports, ON_CONTROL_MESSAGE_PATTERN);
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
    const localStorage = countMatches(sourceFile.content, LOCAL_STORAGE_PATTERN);
    const sessionStorage = countMatches(sourceFile.content, SESSION_STORAGE_PATTERN);
    const indexedDB = countMatches(sourceFile.content, INDEXED_DB_PATTERN);
    const localStoreImports = countMatches(sourceFile.content, LOCAL_STORE_IMPORT_PATTERN);
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
    for (const match of sourceFile.content.matchAll(SUBSCRIBE_EXPORT_PATTERN)) {
      exportsList.push({
        path: sourceFile.path,
        name: match[1],
      });
    }
  }
  return exportsList.sort((left, right) => {
    const pathOrder = compareText(left.path, right.path);
    if (pathOrder !== 0) return pathOrder;
    return compareText(left.name, right.name);
  });
}

function collectClientTypes(): ClientMessageVariant[] {
  return ClientMessage.options
    .map((option) => ({
      type: String(option.shape.type.value),
      hasRequestId: Object.hasOwn(option.shape, 'requestId'),
    }))
    .sort((left, right) => compareText(left.type, right.type));
}

function collectServerTypes(): string[] {
  return ServerMessage.options
    .map((option) => String(option.shape.type.value))
    .sort(compareText);
}

export function collectStateInventoryFromFiles(sourceFiles: readonly TrackedSourceFile[]): StateInventory {
  return {
    socketCalls: collectSocketCalls(sourceFiles),
    storageCalls: collectStorageCalls(sourceFiles),
    subscribeModules: collectSubscribeModules(sourceFiles),
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

if (import.meta.main) {
  process.stdout.write(formatStateInventory(collectStateInventory()));
}
