import { parseJsonLine, vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOr, rawTextOr } from '../../shared/coerce.ts';

interface GrokCounts {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  costUsdTicks?: unknown;
}

interface GrokLine {
  timestamp?: unknown;
  params?: {
    sessionId?: unknown;
    update?: { sessionUpdate?: unknown; usage?: unknown; prompt_id?: unknown } | null;
    _meta?: { agentTimestampMs?: unknown } | null;
  } | null;
}

function parseGrokUsageLine(line: unknown): UsageEntry | null {
  const raw = parseJsonLine(line, '"turn_completed"');
  if (!raw) return null;
  const parsed = raw as GrokLine;

  const update = parsed.params?.update;
  if (!update || update.sessionUpdate !== 'turn_completed') return null;
  const rawUsage = update.usage;
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const usage = rawUsage as GrokCounts & { modelUsage?: unknown };

  const modelUsage = usage.modelUsage && typeof usage.modelUsage === 'object'
    ? (usage.modelUsage as Record<string, unknown>)
    : null;
  if (!modelUsage) return null;
  const model = Object.keys(modelUsage).find((modelKey) => rawTextOr(modelKey, null) && modelUsage[modelKey]);
  if (!model) return null;

  const modelCountsValue = modelUsage[model];
  const modelCounts: GrokCounts = modelCountsValue && typeof modelCountsValue === 'object'
    ? (modelCountsValue as GrokCounts)
    : usage;
  const timestampMs = timestampMsFrom(parsed);
  if (!Number.isFinite(timestampMs)) return null;

  const inputTokens = numberOr(modelCounts.inputTokens, 0);
  const cacheRead = numberOr(modelCounts.cachedReadTokens, 0);
  const cacheCreate = numberOr(modelCounts.cacheCreationTokens, 0);
  const costUsdTicks = numberOr(modelCounts.costUsdTicks, null) ?? numberOr(usage.costUsdTicks, null);
  const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheCreate);
  const outputTokens = numberOr(modelCounts.outputTokens, 0);
  const entry = vendorUsageEntry({
    timestampMs,
    sessionId: rawTextOr(parsed.params?.sessionId, null),
    model,
    input: uncachedInput,
    output: outputTokens,
    cacheCreate,
    cacheRead,
    costUSD: costUsdTicks === null
      ? grokFallbackCostUSD(model, uncachedInput, outputTokens, cacheRead, cacheCreate)
      : costUsdTicks / 10000000000,
    vendor: 'grok',
  });
  const messageId = rawTextOr(update.prompt_id, null);
  if (messageId === null) return entry;
  return { ...entry, messageId };
}

function grokDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  if (entry.messageId) return `${entry.vendor}:${entry.sessionId}:${entry.messageId}`;
  return `${entry.vendor}:${entry.sessionId}:${entry.timestampMs}:${entry.model}`;
}

function timestampMsFrom(parsed: GrokLine): number {
  const agentTimestampMs = numberOr(parsed.params?._meta?.agentTimestampMs, null);
  if (agentTimestampMs !== null) return agentTimestampMs;
  const seconds = numberOr(parsed.timestamp, null);
  if (seconds === null) return NaN;
  return seconds * 1000;
}

function grokFallbackCostUSD(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
): number | null {
  const normalizedModel = normalizeGrokModel(model);
  if (normalizedModel !== 'grok-4.5' && normalizedModel !== 'grok-4.6') return null;
  const isLongContext = input + cacheRead + cacheCreate > 200000;
  const inputRate = isLongContext ? 4 : 2;
  const outputRate = isLongContext ? 12 : 6;
  const cacheReadRate = isLongContext ? 0.6 : 0.3;
  return ((input + cacheCreate) * inputRate + output * outputRate + cacheRead * cacheReadRate) / 1000000;
}

function normalizeGrokModel(model: unknown): string {
  const stripped = rawTextOr(model, null)?.replace(/^\[grok\]\s+/, '') || '';
  return stripped.endsWith('-build') ? stripped.slice(0, -6) : stripped;
}

export { grokDedupIdentity, parseGrokUsageLine };
