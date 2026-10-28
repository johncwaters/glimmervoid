import { isRecord, numberOr } from '../../../shared/coerce.ts';
import type { PlanLimitsVendor } from '../../../shared/contracts/control-messages.ts';

const PCT_DECIMALS = 1;

const SECONDS_CEILING = 1e12;

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
  if (numeric > SECONDS_CEILING) return Math.round(numeric);
  return Math.round(numeric * 1000);
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

function selectOfficialSessionCost(costMode: string, recordedCostUSD: number | null | undefined): number | null {
  if (costMode === 'calculate') return null;
  return recordedCostUSD ?? null;
}

export { normalizeStatuslinePayload, rateLimitWindow, shouldBroadcastPlanLimits, buildPlanLimitsMessage, selectOfficialSessionCost };
export type { PlanLimitsVendor };
