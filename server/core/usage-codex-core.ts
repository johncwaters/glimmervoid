import { parseJsonLine, vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOr, rawTextOr } from '../../shared/coerce.ts';

interface CodexTokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

export interface CodexUsageState {
  model: string | null;
  totalTokenUsage: CodexTokenUsage | null;
}

interface CodexLine {
  type?: unknown;
  timestamp?: unknown;
  payload?: {
    type?: unknown;
    model?: unknown;
    thread_settings?: unknown;
    info?: unknown;
  } | null;
}

function createCodexUsageState(): CodexUsageState {
  return { model: null, totalTokenUsage: null };
}

function parseCodexUsageLine(
  line: unknown,
  state: CodexUsageState = createCodexUsageState(),
  { sessionId = null }: { sessionId?: string | null } = {},
): UsageEntry | null {
  const raw = parseJsonLine(line);
  if (!raw) return null;
  const parsed = raw as CodexLine;
  if (parsed.type === 'turn_context') return recordTurnContext(parsed, state);
  if (parsed.payload?.type === 'thread_settings_applied') return recordThreadSettings(parsed, state);
  if (parsed.payload?.type !== 'token_count') return null;

  const timestampMs = Date.parse(String(parsed.timestamp));
  if (!Number.isFinite(timestampMs)) return null;

  const rawInfo = parsed.payload?.info;
  if (!rawInfo || typeof rawInfo !== 'object') return null;
  const info = rawInfo as { total_token_usage?: unknown; last_token_usage?: unknown };
  const totalUsage = usageObjectOrNull(info.total_token_usage);
  if (isSameUsage(totalUsage, state.totalTokenUsage)) return null;
  const tokenUsage = usageObjectOrNull(info.last_token_usage) || deltaFromTotal(totalUsage, state.totalTokenUsage);
  if (!tokenUsage) return null;
  state.totalTokenUsage = totalUsage;

  const inputTokens = numberOr(tokenUsage.input_tokens, 0);
  const cacheRead = numberOr(tokenUsage.cached_input_tokens, 0);
  return vendorUsageEntry({
    timestampMs,
    sessionId: rawTextOr(sessionId, null),
    model: state.model,
    input: Math.max(0, inputTokens - cacheRead),
    output: numberOr(tokenUsage.output_tokens, 0),
    cacheCreate: numberOr(tokenUsage.cache_write_input_tokens, 0),
    cacheRead,
    costUSD: null,
    vendor: 'codex',
  });
}

function codexDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  return [
    entry.vendor,
    entry.sessionId,
    entry.timestampMs,
    entry.model,
    entry.input,
    entry.output,
    entry.cacheCreate,
    entry.cacheRead,
  ].join(':');
}

function recordTurnContext(parsed: CodexLine, state: CodexUsageState): null {
  state.model = rawTextOr(parsed.payload?.model, null);
  return null;
}

function recordThreadSettings(parsed: CodexLine, state: CodexUsageState): null {
  const threadSettings = parsed.payload?.thread_settings as CodexTokenUsage & { model?: unknown } | undefined;
  if (!threadSettings || typeof threadSettings !== 'object') return null;
  state.model = rawTextOr(threadSettings.model, null) || state.model;
  return null;
}

function usageObjectOrNull(value: unknown): CodexTokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  return value as CodexTokenUsage;
}

function isSameUsage(left: CodexTokenUsage | null, right: CodexTokenUsage | null): boolean {
  if (!left || !right) return false;
  return numberOr(left.input_tokens, 0) === numberOr(right.input_tokens, 0)
    && numberOr(left.cached_input_tokens, 0) === numberOr(right.cached_input_tokens, 0)
    && numberOr(left.cache_write_input_tokens, 0) === numberOr(right.cache_write_input_tokens, 0)
    && numberOr(left.output_tokens, 0) === numberOr(right.output_tokens, 0)
    && numberOr(left.reasoning_output_tokens, 0) === numberOr(right.reasoning_output_tokens, 0)
    && numberOr(left.total_tokens, 0) === numberOr(right.total_tokens, 0);
}

function deltaFromTotal(totalUsage: CodexTokenUsage | null, previousTotalUsage: CodexTokenUsage | null): CodexTokenUsage | null {
  if (!totalUsage) return null;
  if (!previousTotalUsage) return totalUsage;
  return {
    input_tokens: numberOr(totalUsage.input_tokens, 0) - numberOr(previousTotalUsage.input_tokens, 0),
    cached_input_tokens: numberOr(totalUsage.cached_input_tokens, 0) - numberOr(previousTotalUsage.cached_input_tokens, 0),
    cache_write_input_tokens: numberOr(totalUsage.cache_write_input_tokens, 0) - numberOr(previousTotalUsage.cache_write_input_tokens, 0),
    output_tokens: numberOr(totalUsage.output_tokens, 0) - numberOr(previousTotalUsage.output_tokens, 0),
    reasoning_output_tokens: numberOr(totalUsage.reasoning_output_tokens, 0) - numberOr(previousTotalUsage.reasoning_output_tokens, 0),
    total_tokens: numberOr(totalUsage.total_tokens, 0) - numberOr(previousTotalUsage.total_tokens, 0),
  };
}

export { codexDedupIdentity, createCodexUsageState, parseCodexUsageLine };
