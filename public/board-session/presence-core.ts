import type { TraceRecord } from '#shared/contracts/trace.ts';
import { fileEditsOf } from '../chat/turn-digest-core.ts';

export interface Presence {
  workedPath: string | null;
  namedPaths: readonly string[];
}

const MAX_NAMED_PATHS = 20;
const NAMED_PATH = /(?:^|[\s`'"([])((?:[\w.@-]+\/)+[\w.@-]*)/g;
const TRAILING_PUNCTUATION = /[.,:;)]+$/;

export const NO_PRESENCE: Presence = { workedPath: null, namedPaths: [] };

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

function workedPathOf(record: Extract<TraceRecord, { kind: 'tool_call' }>, workingDirectory: string | null): string | null {
  const editedPath = fileEditsOf(record.input, workingDirectory).find((edit) => edit.path.length > 0)?.path ?? null;
  if (editedPath === null || editedPath.startsWith('/')) return null;
  return editedPath;
}

export function foldPresence(presence: Presence, appendedRecords: readonly TraceRecord[], workingDirectory: string | null): Presence {
  let { workedPath, namedPaths } = presence;
  for (const record of appendedRecords) {
    if (record.agentId !== undefined) continue;
    if (record.kind === 'tool_call') workedPath = workedPathOf(record, workingDirectory) ?? workedPath;
    if (record.kind === 'assistant') namedPaths = namedPathsOf(record.text);
    if (record.kind === 'prompt') namedPaths = [];
  }
  return { workedPath, namedPaths };
}

export function presencePathsOf(presence: Presence): string[] {
  return [...new Set([...(presence.workedPath === null ? [] : [presence.workedPath]), ...presence.namedPaths])];
}
