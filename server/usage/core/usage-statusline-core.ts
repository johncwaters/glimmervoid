import { isRecord, numberOr, positiveNumberOr, textOr } from '../../../shared/coerce.ts';
import type { PlanLimitsVendor } from '../../../shared/contracts/control-messages.ts';
import type { SessionMeterReading } from '../../../shared/contracts/control/lane-messages.ts';

const PCT_DECIMALS = 1;

const SECONDS_CEILING = 1e12;
const MAX_RESET_AT_MS = 8.64e15;
const MAX_RESET_IN_SECONDS = 366 * 86_400;
const RESET_FALLBACK_QUANTUM_MS = 60_000;
const MAX_METER_TEXT_CHARS = 128;

export interface RateLimitWindow {
  pct: number | null;
  resetsAtMs: number | null;
}

export interface RateLimitWindows {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
}

export interface StatuslineSnapshot {
  rateLimits: RateLimitWindows | null;
  sessionCostUSD: number | null;
  contextPct: number | null;
  claudeSessionId: string | null;
  ts: number;
}

function roundPct(value: unknown): number | null {
  const numeric = numberOr(value, null);
  if (numeric === null) return null;
  const factor = 10 ** PCT_DECIMALS;
  return Math.max(0, Math.round(numeric * factor) / factor);
}

function resetsAtMs(value: unknown): number | null {
  const numeric = numberOr(value, null);
  if (numeric === null || numeric <= 0) return null;
  const epochMs = numeric > SECONDS_CEILING ? Math.round(numeric) : Math.round(numeric * 1000);
  return epochMs <= MAX_RESET_AT_MS ? epochMs : null;
}

function rateLimitWindow(usedPct: unknown, resetsAt: unknown): RateLimitWindow | null {
  const pct = roundPct(usedPct);
  const resetsAtMsValue = resetsAtMs(resetsAt);
  if (pct === null && resetsAtMsValue === null) return null;
  return { pct, resetsAtMs: resetsAtMsValue };
}

function normalizeWindow(raw: unknown): RateLimitWindow | null {
  if (!isRecord(raw)) return null;
  return rateLimitWindow(raw.used_percentage, raw.resets_at);
}

function normalizeRateLimits(raw: unknown): RateLimitWindows | null {
  if (!isRecord(raw)) return null;
  const limits = raw as Record<string, unknown>;
  const fiveHour = normalizeWindow(limits.five_hour);
  const sevenDay = normalizeWindow(limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function normalizeStatuslinePayload(payload: unknown, nowMs: unknown): StatuslineSnapshot | null {
  if (!isRecord(payload)) return null;
  const fields = payload as Record<string, unknown>;
  const sessionId = typeof fields.session_id === 'string' ? fields.session_id.trim() : '';
  const cost = isRecord(fields.cost) ? (fields.cost as Record<string, unknown>) : null;
  const context = isRecord(fields.context_window) ? (fields.context_window as Record<string, unknown>) : null;
  return {
    rateLimits: normalizeRateLimits(fields.rate_limits),
    sessionCostUSD: cost ? numberOr(cost.total_cost_usd, null) : null,
    contextPct: context ? roundPct(context.used_percentage) : null,
    claudeSessionId: sessionId || null,
    ts: numberOr(nowMs, null) ?? 0,
  };
}

function windowSignature(win: RateLimitWindow | null): string {
  if (!win) return 'none';
  return `${win.pct}:${win.resetsAtMs}`;
}

function planLimitsSignature(snapshot: { rateLimits?: RateLimitWindows | null } | null | undefined): string | null {
  const limits = snapshot?.rateLimits;
  if (!limits) return null;
  return `${windowSignature(limits.fiveHour)}|${windowSignature(limits.sevenDay)}`;
}

function shouldBroadcastPlanLimits(
  previous: { rateLimits?: RateLimitWindows | null } | null | undefined,
  next: { rateLimits?: RateLimitWindows | null } | null | undefined,
): boolean {
  const nextSignature = planLimitsSignature(next);
  if (nextSignature === null) return false;
  return nextSignature !== planLimitsSignature(previous);
}


const PLAN_LIMITS_SOURCE_BY_VENDOR: Readonly<Record<PlanLimitsVendor, string>> = Object.freeze({
  claude: 'statusline',
  codex: 'rollout',
  kimi: 'usages',
  antigravity: 'agentstate',
});

function buildPlanLimitsMessage(
  snapshot: { rateLimits?: RateLimitWindows | null; ts?: number } | null | undefined,
  vendor: PlanLimitsVendor = 'claude',
) {
  if (!snapshot?.rateLimits) return null;
  return {
    type: 'plan-limits',
    ts: snapshot.ts,
    fiveHour: snapshot.rateLimits.fiveHour,
    sevenDay: snapshot.rateLimits.sevenDay,
    source: PLAN_LIMITS_SOURCE_BY_VENDOR[vendor],
    vendor,
  };
}

function buildAccountPlanLimitsMessage(
  snapshot: { rateLimits?: RateLimitWindows | null; ts?: number } | null | undefined,
  vendor: PlanLimitsVendor,
  accountId: string | null,
) {
  const vendorMessage = buildPlanLimitsMessage(snapshot, vendor);
  if (!vendorMessage) return null;
  return { ...vendorMessage, type: 'account-plan-limits', accountId };
}

type CallCostOf = (modelId: string, contextTokens: number) => number | null;

function contextTokensOf(context: Record<string, unknown> | null): number | null {
  const currentUsage = context?.current_usage;
  if (!isRecord(currentUsage)) return null;
  const promptParts = [currentUsage.input_tokens, currentUsage.cache_creation_input_tokens, currentUsage.cache_read_input_tokens].map((tokens) => numberOr(tokens, 0));
  return Math.max(0, promptParts.reduce((total, tokens) => total + tokens, 0));
}

function cappedMeterText(value: unknown, fallback: string | null = null): string | null {
  const text = textOr(value, fallback);
  if (text === null) return null;
  return text.length > MAX_METER_TEXT_CHARS ? text.slice(0, MAX_METER_TEXT_CHARS) : text;
}

function effortOf(effort: unknown): string | null {
  if (isRecord(effort)) return cappedMeterText(effort.level, null);
  return cappedMeterText(effort, null);
}

interface SessionMeterInputs {
  model: string | null;
  pricingModelId: string | null;
  effort: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  outputStyle: string | null;
}

interface MeteredStatusline {
  reading: SessionMeterReading;
  pricingModelId: string | null;
}

function sessionMeterInputsOf(payload: unknown): SessionMeterInputs | null {
  if (!isRecord(payload)) return null;
  const model = isRecord(payload.model) ? payload.model : null;
  const pricingModelId = cappedMeterText(model?.id, null);
  const context = isRecord(payload.context_window) ? payload.context_window : null;
  const inputs: SessionMeterInputs = {
    model: cappedMeterText(model?.display_name, pricingModelId),
    pricingModelId,
    effort: effortOf(payload.effort) ?? effortOf(model?.effort),
    contextTokens: contextTokensOf(context),
    contextWindow: positiveNumberOr(context?.context_window_size, null),
    outputStyle: isRecord(payload.output_style) ? cappedMeterText(payload.output_style.name, null) : null,
  };
  if (inputs.model === null && inputs.effort === null && inputs.contextTokens === null && inputs.contextWindow === null && inputs.outputStyle === null) return null;
  return inputs;
}

function sessionMeterOf(payload: unknown, callCostOf: CallCostOf): MeteredStatusline | null {
  const inputs = sessionMeterInputsOf(payload);
  if (!inputs) return null;
  const callCostUSD = inputs.pricingModelId !== null && inputs.contextTokens !== null ? callCostOf(inputs.pricingModelId, inputs.contextTokens) : null;
  const reading: SessionMeterReading = {
    model: inputs.model,
    effort: inputs.effort,
    contextTokens: inputs.contextTokens,
    contextWindow: inputs.contextWindow,
    callCostUSD,
    outputStyle: inputs.outputStyle,
  };
  return { reading, pricingModelId: inputs.pricingModelId };
}

function antigravityResetAtMs(bucket: Record<string, unknown>, nowMs: number): number | null {
  if (typeof bucket.reset_time === 'string') {
    const parsedMs = Date.parse(bucket.reset_time);
    if (Number.isFinite(parsedMs) && parsedMs > 0 && parsedMs <= MAX_RESET_AT_MS) return Math.round(parsedMs);
  }
  const resetInSeconds = numberOr(bucket.reset_in_seconds, null);
  if (resetInSeconds === null || resetInSeconds < 0 || resetInSeconds > MAX_RESET_IN_SECONDS || !Number.isFinite(nowMs) || nowMs <= 0) return null;
  const quantizedMs = Math.round((nowMs + resetInSeconds * 1000) / RESET_FALLBACK_QUANTUM_MS) * RESET_FALLBACK_QUANTUM_MS;
  return quantizedMs <= MAX_RESET_AT_MS ? quantizedMs : null;
}

function antigravityQuotaWindow(bucket: unknown, nowMs: number): RateLimitWindow | null {
  if (!isRecord(bucket)) return null;
  const remainingFraction = numberOr(bucket.remaining_fraction, null);
  const usedPct = remainingFraction === null ? null : (1 - Math.min(1, Math.max(0, remainingFraction))) * 100;
  return rateLimitWindow(usedPct, antigravityResetAtMs(bucket, nowMs));
}

function tightestQuotaWindow(first: RateLimitWindow | null, second: RateLimitWindow | null): RateLimitWindow | null {
  if (!first) return second;
  if (!second) return first;
  if (first.pct === null) return second;
  if (second.pct === null) return first;
  if (second.pct !== first.pct) return second.pct > first.pct ? second : first;
  if (first.resetsAtMs === null) return second;
  if (second.resetsAtMs === null) return first;
  return second.resetsAtMs < first.resetsAtMs ? second : first;
}

function normalizeAntigravityQuota(payload: unknown, nowMs: unknown): RateLimitWindows | null {
  if (!isRecord(payload) || !isRecord(payload.quota)) return null;
  const nowMsValue = numberOr(nowMs, null) ?? 0;
  const fiveHour = tightestQuotaWindow(
    antigravityQuotaWindow(payload.quota['gemini-5h'], nowMsValue),
    antigravityQuotaWindow(payload.quota['3p-5h'], nowMsValue),
  );
  const sevenDay = tightestQuotaWindow(
    antigravityQuotaWindow(payload.quota['gemini-weekly'], nowMsValue),
    antigravityQuotaWindow(payload.quota['3p-weekly'], nowMsValue),
  );
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function selectOfficialSessionCost(costMode: string, recordedCostUSD: number | null | undefined): number | null {
  if (costMode === 'calculate') return null;
  return recordedCostUSD ?? null;
}

export { normalizeAntigravityQuota, normalizeStatuslinePayload, rateLimitWindow, sessionMeterInputsOf, sessionMeterOf, shouldBroadcastPlanLimits, buildPlanLimitsMessage, buildAccountPlanLimitsMessage, selectOfficialSessionCost };
export type { PlanLimitsVendor };
