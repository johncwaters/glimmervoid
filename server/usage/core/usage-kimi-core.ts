import path from 'node:path';
import { parseJsonLine, vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOr, rawTextOr } from '../../../shared/coerce.ts';

const KIMI_USAGE_FILENAME = 'wire.jsonl';
const KIMI_SESSION_FOLDER_PATTERN = /^session_[0-9A-Za-z_-]+$/;

interface KimiUsageLine {
  type?: unknown;
  agentId?: unknown;
  model?: unknown;
  usage?: {
    inputOther?: unknown;
    output?: unknown;
    inputCacheRead?: unknown;
    inputCacheCreation?: unknown;
  } | null;
  usageScope?: unknown;
  time?: unknown;
}

function kimiSessionIdFromPath(filePath: string): string | null {
  const agentsFolder = path.dirname(path.dirname(filePath));
  if (path.basename(agentsFolder) !== 'agents') return null;
  const sessionFolder = path.basename(path.dirname(agentsFolder));
  return KIMI_SESSION_FOLDER_PATTERN.test(sessionFolder) ? sessionFolder : null;
}

function parseKimiUsageLine(line: unknown, filePath: string): UsageEntry | null {
  const raw = parseJsonLine(line, '"usage.record"');
  if (!raw) return null;
  const parsed = raw as KimiUsageLine;
  if (parsed.type !== 'usage.record') return null;
  if (parsed.usageScope === 'session') return null;
  const usage = parsed.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = rawTextOr(parsed.model, null);
  const timestampMs = numberOr(parsed.time, null);
  if (model === null || timestampMs === null) return null;
  const agentId = rawTextOr(parsed.agentId, null) ?? 'main';
  const entry = vendorUsageEntry({
    timestampMs,
    sessionId: kimiSessionIdFromPath(filePath),
    model,
    input: numberOr(usage.inputOther, 0),
    output: numberOr(usage.output, 0),
    cacheCreate: numberOr(usage.inputCacheCreation, 0),
    cacheRead: numberOr(usage.inputCacheRead, 0),
    costUSD: null,
    vendor: 'kimi',
  });
  return { ...entry, messageId: `${agentId}:${timestampMs}` };
}

function kimiDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  return `${entry.vendor}:${entry.sessionId}:${entry.messageId}:${entry.model}`;
}

export { KIMI_USAGE_FILENAME, kimiDedupIdentity, kimiSessionIdFromPath, parseKimiUsageLine };
