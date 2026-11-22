import path from 'node:path';
import { vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOr, rawTextOr, textOr } from '../../../shared/coerce.ts';

export interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpenCodeMessageData {
  role?: unknown;
  modelID?: unknown;
  cost?: unknown;
  time?: {
    created?: unknown;
    completed?: unknown;
  } | null;
  path?: {
    cwd?: unknown;
    root?: unknown;
  } | null;
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: {
      read?: unknown;
      write?: unknown;
    } | null;
  } | null;
}

function parseOpenCodeMessageRow(row: OpenCodeMessageRow): UsageEntry | null {
  if (!row || typeof row.data !== 'string' || !row.data.includes('"tokens"')) return null;
  let messagePayload: OpenCodeMessageData | null = null;
  try {
    messagePayload = JSON.parse(row.data) as OpenCodeMessageData;
  } catch {
    return null;
  }
  if (!messagePayload || typeof messagePayload !== 'object') return null;
  if (messagePayload.role !== undefined && messagePayload.role !== 'assistant') return null;
  const tokens = messagePayload.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const model = rawTextOr(messagePayload.modelID, null);
  if (!model) return null;

  const timestampMs = numberOr(messagePayload.time?.completed, null)
    ?? numberOr(messagePayload.time?.created, null)
    ?? numberOr(row.time_created, null);
  if (timestampMs === null || !Number.isFinite(timestampMs) || Math.abs(timestampMs) > 8.64e15) return null;

  const input = numberOr(tokens.input, 0);
  const visibleOutput = numberOr(tokens.output, 0);
  const reasoning = numberOr(tokens.reasoning, 0);
  const output = visibleOutput + reasoning;
  const cacheRead = numberOr(tokens.cache?.read, 0);
  const cacheCreate = numberOr(tokens.cache?.write, 0);
  if (input + output + cacheRead + cacheCreate <= 0) return null;

  const reportedCost = numberOr(messagePayload.cost, null);
  const sessionId = rawTextOr(row.session_id, null);
  const messageId = rawTextOr(row.id, null);
  const entry = vendorUsageEntry({
    timestampMs,
    sessionId,
    model,
    input,
    output,
    cacheCreate,
    cacheRead,
    costUSD: reportedCost,
    vendor: 'opencode',
    messageId,
  });
  const cwd = rawTextOr(messagePayload.path?.cwd, null) ?? rawTextOr(messagePayload.path?.root, null);
  if (!cwd) return entry;
  return { ...entry, cwd };
}

function openCodeDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  if (entry.messageId) return `${entry.vendor}:${entry.sessionId}:${entry.messageId}`;
  return `${entry.vendor}:${entry.sessionId}:${entry.timestampMs}:${entry.model}`;
}

function openCodeDbPaths(env: NodeJS.ProcessEnv = process.env, homeDir: string | null = null): string[] {
  const home = textOr(env?.HOME, null) || textOr(env?.USERPROFILE, null) || homeDir;
  const xdgDataHome = textOr(env?.XDG_DATA_HOME, null) || (home ? path.join(home, '.local', 'share') : null);
  const dataDir = xdgDataHome ? path.join(xdgDataHome, 'opencode') : null;
  const dbOverride = textOr(env?.OPENCODE_DB, null);
  if (dbOverride) {
    if (path.isAbsolute(dbOverride)) return [dbOverride];
    if (dataDir) return [path.join(dataDir, dbOverride)];
    return [path.resolve(dbOverride)];
  }
  if (!dataDir) return [];
  return [path.join(dataDir, 'opencode.db')];
}

export { openCodeDbPaths, openCodeDedupIdentity, parseOpenCodeMessageRow };
