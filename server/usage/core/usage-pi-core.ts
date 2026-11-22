import path from 'node:path';
import { parseJsonLine, vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOr, rawTextOr } from '../../../shared/coerce.ts';

export interface PiUsageState {
  sessionId: string | null;
  cwd: string | null;
}

interface PiUsageCounts {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cacheWrite1h?: unknown;
  cost?: {
    total?: unknown;
  } | null;
}

interface PiLine {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  model?: unknown;
  usage?: PiUsageCounts | null;
  message?: {
    role?: unknown;
    model?: unknown;
    responseModel?: unknown;
    responseId?: unknown;
    timestamp?: unknown;
    usage?: PiUsageCounts | null;
  } | null;
}

function createPiUsageState(): PiUsageState {
  return { sessionId: null, cwd: null };
}

function piSessionIdFromPath(filePath: string): string | null {
  const base = path.basename(filePath, '.jsonl');
  if (!base) return null;
  const separatorIndex = base.lastIndexOf('_');
  if (separatorIndex > 0 && separatorIndex < base.length - 1) return base.slice(separatorIndex + 1);
  return base;
}

function parseIsoTimestampMs(value: unknown): number {
  const numeric = numberOr(value, null);
  if (numeric !== null) return numeric;
  const text = rawTextOr(value, null);
  if (!text) return NaN;
  return Date.parse(text);
}

function applyPiHeaderLine(line: unknown, state: PiUsageState): boolean {
  const raw = parseJsonLine(line, '"session"');
  if (!raw) return false;
  const parsed = raw as PiLine;
  if (parsed.type !== 'session') return false;
  const sessionId = rawTextOr(parsed.id, null);
  const cwd = rawTextOr(parsed.cwd, null);
  if (sessionId) state.sessionId = sessionId;
  if (cwd) state.cwd = cwd;
  return true;
}

function extractPiUsagePayload(parsed: PiLine): {
  usage: PiUsageCounts;
  model: string | null;
  timestampMs: number;
  responseId: string | null;
} | null {
  if (parsed.type === 'message' && parsed.message && typeof parsed.message === 'object') {
    const usage = parsed.message.usage;
    if (!usage || typeof usage !== 'object') return null;
    const model = rawTextOr(parsed.message.responseModel, null) ?? rawTextOr(parsed.message.model, null);
    const messageTimestampMs = parseIsoTimestampMs(parsed.message.timestamp);
    const timestampMs = Number.isFinite(messageTimestampMs) ? messageTimestampMs : parseIsoTimestampMs(parsed.timestamp);
    const responseId = rawTextOr(parsed.message.responseId, null);
    return { usage, model, timestampMs, responseId };
  }
  const usageRecordTypes = new Set(['usage', 'compaction', 'branch_summary']);
  if (!usageRecordTypes.has(String(parsed.type ?? ''))) return null;
  const usage = parsed.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = rawTextOr(parsed.model, null);
  const timestampMs = parseIsoTimestampMs(parsed.timestamp);
  return { usage, model, timestampMs, responseId: null };
}

function parsePiUsageLine(
  line: unknown,
  filePath: string,
  state?: PiUsageState | null,
): UsageEntry | null {
  const raw = parseJsonLine(line, '"usage"');
  if (!raw) return null;
  const parsed = raw as PiLine;
  const payload = extractPiUsagePayload(parsed);
  if (!payload) return null;
  if (!payload.model || !Number.isFinite(payload.timestampMs)) return null;

  const input = numberOr(payload.usage.input, 0);
  const output = numberOr(payload.usage.output, 0);
  const cacheRead = numberOr(payload.usage.cacheRead, 0);
  const cacheCreate = numberOr(payload.usage.cacheWrite, 0);
  const cacheCreation1h = numberOr(payload.usage.cacheWrite1h, 0);
  const cacheCreation5m = Math.max(0, cacheCreate - cacheCreation1h);
  const reportedCost = numberOr(payload.usage.cost?.total, null);

  const entryId = rawTextOr(parsed.id, null);
  const messageId = entryId
    ? (payload.responseId ? `${entryId}:${payload.responseId}` : entryId)
    : payload.responseId;
  const sessionId = state?.sessionId ?? piSessionIdFromPath(filePath);
  const entry = vendorUsageEntry({
    timestampMs: payload.timestampMs,
    sessionId,
    model: payload.model,
    input,
    output,
    cacheCreate,
    cacheRead,
    costUSD: reportedCost,
    vendor: 'pi',
    messageId,
  });
  const withCacheSplit: UsageEntry = {
    ...entry,
    cacheCreation5m,
    cacheCreation1h,
  };
  if (!state?.cwd) return withCacheSplit;
  return { ...withCacheSplit, cwd: state.cwd };
}

function piDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  if (entry.messageId) return `${entry.vendor}:${entry.messageId}:${entry.timestampMs}`;
  return `${entry.vendor}:${entry.sessionId}:${entry.timestampMs}:${entry.model}`;
}

export {
  applyPiHeaderLine,
  createPiUsageState,
  parsePiUsageLine,
  piDedupIdentity,
  piSessionIdFromPath,
};
