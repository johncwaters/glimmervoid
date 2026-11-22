import path from 'node:path';
import { parseJsonLine, vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOr, rawTextOr } from '../../../shared/coerce.ts';

const ANTIGRAVITY_USAGE_FILENAME = 'transcript_full.jsonl';
const ANTIGRAVITY_TRANSCRIPT_SEGMENTS = ['.system_generated', 'logs', ANTIGRAVITY_USAGE_FILENAME] as const;
const ANTIGRAVITY_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STEP_TOKENS = 1_000_000_000;

interface AntigravityUsageLine {
  type?: unknown;
  step_index?: unknown;
  created_at?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
}

function isAntigravitySessionDir(name: string): boolean {
  return ANTIGRAVITY_SESSION_ID_PATTERN.test(name);
}

function isValidTokenCount(value: number): boolean {
  return value >= 0 && value <= MAX_STEP_TOKENS;
}

function antigravitySessionIdFromPath(filePath: string): string | null {
  const logsFolder = path.dirname(filePath);
  const systemGeneratedFolder = path.dirname(logsFolder);
  if (path.basename(logsFolder) !== 'logs' || path.basename(systemGeneratedFolder) !== '.system_generated') return null;
  const sessionFolder = path.basename(path.dirname(systemGeneratedFolder));
  return isAntigravitySessionDir(sessionFolder) ? sessionFolder : null;
}

function parseAntigravityUsageLine(line: unknown, filePath: string): UsageEntry | null {
  const raw = parseJsonLine(line, '"PLANNER_RESPONSE"');
  if (!raw) return null;
  const parsed = raw as AntigravityUsageLine;
  if (parsed.type !== 'PLANNER_RESPONSE') return null;
  const sessionId = antigravitySessionIdFromPath(filePath);
  const model = rawTextOr(parsed.model, null);
  const stepIndex = numberOr(parsed.step_index, null);
  const timestampMs = typeof parsed.created_at === 'string' ? Date.parse(parsed.created_at) : Number.NaN;
  if (sessionId === null || model === null || stepIndex === null || !Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  const input = numberOr(parsed.input_tokens, 0);
  const output = numberOr(parsed.output_tokens, 0);
  const cacheRead = numberOr(parsed.cache_read_tokens, 0);
  if (!isValidTokenCount(input) || !isValidTokenCount(output) || !isValidTokenCount(cacheRead)) return null;
  if (input <= 0 && output <= 0 && cacheRead <= 0) return null;
  const entry = vendorUsageEntry({
    timestampMs,
    sessionId,
    model,
    input,
    output,
    cacheCreate: 0,
    cacheRead,
    costUSD: null,
    vendor: 'antigravity',
  });
  return { ...entry, messageId: `step-${stepIndex}` };
}

function antigravityDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  return `${entry.vendor}:${entry.sessionId}:${entry.messageId}:${entry.model}`;
}

export { ANTIGRAVITY_TRANSCRIPT_SEGMENTS, ANTIGRAVITY_USAGE_FILENAME, antigravityDedupIdentity, isAntigravitySessionDir, parseAntigravityUsageLine };
