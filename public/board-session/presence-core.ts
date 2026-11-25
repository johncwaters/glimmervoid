import type { TraceRecord } from '#shared/contracts/trace.ts';
import { fileEditsOf } from '#shared/file-edits-core.ts';

export interface Presence {
  workedPath: string | null;
  namedPaths: readonly string[];
  readPaths: readonly string[];
  editedPaths: readonly string[];
}

const MAX_NAMED_PATHS = 20;
const NAMED_PATH = /(?:^|[\s`'"([])((?:[\w.@-]+\/)+[\w.@-]*)/g;
const TRAILING_PUNCTUATION = /[.,:;)]+$/;

export const NO_PRESENCE: Presence = { workedPath: null, namedPaths: [], readPaths: [], editedPaths: [] };

function namedPathsOf(replyText: string): string[] {
  const namedPaths = new Set<string>();
  for (const match of replyText.matchAll(NAMED_PATH)) {
    const namedPath = (match[1] ?? '').replace(TRAILING_PUNCTUATION, '').replace(/^\.\//, '');
    if (namedPath.length === 0 || namedPath.startsWith('/') || namedPath.includes('://')) continue;
    namedPaths.add(namedPath);
    if (namedPaths.size === MAX_NAMED_PATHS) break;
  }
  return [...namedPaths];
}

function isOutsidePath(tracedPath: string): boolean {
  return tracedPath.startsWith('/');
}

function workedPathOf(record: Extract<TraceRecord, { kind: 'tool_call' }>, workingDirectory: string | null, keepsOutsidePaths: boolean): string | null {
  const editedPath = fileEditsOf(record.input, workingDirectory).find((edit) => edit.path.length > 0)?.path ?? null;
  if (editedPath === null || (isOutsidePath(editedPath) && !keepsOutsidePaths)) return null;
  return editedPath;
}

function isPatchInput(input: unknown): boolean {
  return typeof input === 'object' && input !== null && typeof Reflect.get(input, 'changes') === 'object';
}

function addTrailPaths(record: Extract<TraceRecord, { kind: 'tool_call' }>, workingDirectory: string | null, keepsOutsidePaths: boolean, readPaths: Set<string>, editedPaths: Set<string>): void {
  for (const edit of fileEditsOf(record.input, workingDirectory)) {
    if (edit.path.length === 0 || (isOutsidePath(edit.path) && !keepsOutsidePaths)) continue;
    if (edit.hasLineCounts || isPatchInput(record.input)) {
      editedPaths.add(edit.path);
      readPaths.delete(edit.path);
      continue;
    }
    if (!editedPaths.has(edit.path)) readPaths.add(edit.path);
  }
}

export function foldPresence(presence: Presence, appendedRecords: readonly TraceRecord[], workingDirectory: string | null, keepsOutsidePaths = false): Presence {
  let { workedPath, namedPaths } = presence;
  let readPaths = new Set(presence.readPaths);
  let editedPaths = new Set(presence.editedPaths);
  for (const record of appendedRecords) {
    if (record.agentId !== undefined) continue;
    if (record.kind === 'tool_call') {
      workedPath = workedPathOf(record, workingDirectory, keepsOutsidePaths) ?? workedPath;
      addTrailPaths(record, workingDirectory, keepsOutsidePaths, readPaths, editedPaths);
    }
    if (record.kind === 'assistant') namedPaths = namedPathsOf(record.text);
    if (record.kind === 'prompt') {
      namedPaths = [];
      readPaths = new Set();
      editedPaths = new Set();
    }
  }
  return { workedPath, namedPaths, readPaths: [...readPaths], editedPaths: [...editedPaths] };
}

export function presencePathsOf(presence: Presence): string[] {
  return [...new Set([...(presence.workedPath === null ? [] : [presence.workedPath]), ...presence.namedPaths, ...presence.readPaths, ...presence.editedPaths])];
}

