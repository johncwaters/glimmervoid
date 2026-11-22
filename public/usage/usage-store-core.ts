import { attentionSignature } from '../attention-ack-core.ts';
import type { PlanLimitsVendor, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { UsageBudgetRow, UsageScanSummary } from '#shared/contracts/usage-report.ts';
import { numberOr, textOr } from '#shared/coerce.ts';

export type UsageReport = ServerMessageOf<'usage-report'>;
export type { PlanLimitsVendor };

export const NO_VALUE = '-';

const TOKEN_LIMIT_WARN_PCT = 80;
export const DEFAULT_RANGE_VALUE: 'today' | 'week' | 'month' = 'week';
export const RANGE_OPTIONS: readonly { value: 'today' | 'week' | 'month'; label: string }[] = Object.freeze([
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
]);

function groupThousands(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function trimTrailingZeros(fixed: string) {
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

export function formatCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${groupThousands(String(Math.abs(rounded)))}`;
}

export function formatUsd(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  const abs = Math.abs(value);
  if (abs === 0) return '$0.00';
  const sign = value < 0 ? '-' : '';
  if (abs < 0.0001) return value < 0 ? 'above -$0.0001' : '<$0.0001';
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  const [whole, cents] = abs.toFixed(2).split('.');
  return `${sign}$${groupThousands(whole)}.${cents}`;
}

export function formatTokens(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) {
    const rounded = Math.round(abs);
    return `${rounded === 0 ? '' : sign}${rounded}`;
  }
  if (abs < 999950) return `${sign}${trimTrailingZeros((abs / 1000).toFixed(1))}k`;
  if (abs < 999995000) return `${sign}${trimTrailingZeros((abs / 1e6).toFixed(2))}M`;
  return `${sign}${trimTrailingZeros((abs / 1e9).toFixed(2))}B`;
}

export function planWindowTone(pct: unknown) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'ok';
  if (pct >= 100) return 'crit';
  if (pct >= TOKEN_LIMIT_WARN_PCT) return 'warn';
  return 'ok';
}

const BUDGET_ATTENTION_PCT = 90;

export function budgetRows(report: UsageReport | null | undefined): UsageBudgetRow[] {
  const rows = report?.budget?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => numberOr(row.budgetUsd, null) !== null);
}

function budgetRowPct(row: UsageBudgetRow | null | undefined) {
  const pct = numberOr(row?.pct, null);
  if (pct === null) return 0;
  return pct;
}

interface PlanWindow {
  pct?: unknown;
  resetsAtMs?: unknown;
}

export interface PlanLimits {
  ts?: unknown;
  vendor?: unknown;
  accountId?: string | null;
  source?: unknown;
  fiveHour?: PlanWindow | null;
  sevenDay?: PlanWindow | null;
}

export function planWindowOf(planLimits: PlanLimits | null | undefined, key: 'fiveHour' | 'sevenDay') {
  const window = planLimits?.[key];
  if (!window || typeof window !== 'object') return null;
  const pct = numberOr(window.pct, null);
  const resetsAtMs = numberOr(window.resetsAtMs, null);
  if (pct === null && resetsAtMs === null) return null;
  return { pct, resetsAtMs };
}

export function planLimitsVendorOf(planLimits: PlanLimits | null | undefined): PlanLimitsVendor {
  if (planLimits?.vendor === 'codex' || planLimits?.vendor === 'kimi') return planLimits.vendor;
  return 'claude';
}

export function usageAttentionSignature(report: UsageReport | null | undefined, planLimits: PlanLimits | null = null) {
  const parts: string[] = [];
  const tone = planWindowTone(planWindowOf(planLimits, 'fiveHour')?.pct);
  if (tone !== 'ok') parts.push(`block:${tone}`);
  for (const row of budgetRows(report)) {
    const pct = budgetRowPct(row);
    if (pct < BUDGET_ATTENTION_PCT) continue;
    const scope = typeof row?.scope === 'string' && row.scope ? row.scope : 'budget';
    parts.push(`budget:${scope}:${pct >= 100 ? 'over' : 'near'}`);
  }
  return attentionSignature(parts);
}

export function pricingSourceLine(pricing: { source?: unknown } | null | undefined, agoText = '') {
  const source = pricing?.source;
  if (source === 'fetched') {
    const ago = textOr(agoText, '');
    if (!ago) return 'Prices fetched from the public model price table.';
    return `Prices fetched from the public model price table, ${ago}.`;
  }
  if (source === 'cache') {
    const ago = textOr(agoText, '');
    if (!ago) return 'Prices from the cached public model price table.';
    return `Prices from the cached public model price table, ${ago}.`;
  }
  if (source === 'snapshot') return 'Prices from the price table bundled with this Glimmervoid build.';
  if (source === 'unavailable') return 'Model prices could not be loaded, so every cost below counts as zero.';
  return 'Pricing source not reported yet.';
}

export function pricingFetchedAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function scanLine(scan: UsageScanSummary | null | undefined) {
  if (!scan || typeof scan !== 'object') return '';
  const parts: string[] = [];
  if (Array.isArray(scan.dirs)) {
    const dirCount = scan.dirs.length;
    parts.push(`${formatCount(dirCount)} transcript ${dirCount === 1 ? 'directory' : 'directories'}`);
  }
  if (Number.isFinite(scan.files)) parts.push(`${formatCount(scan.files)} files`);
  if (Number.isFinite(scan.entries)) parts.push(`${formatCount(scan.entries)} entries`);
  if (Number.isFinite(scan.lastScanMs)) parts.push(`last pass ${formatCount(scan.lastScanMs)}ms`);
  if (parts.length === 0) return '';
  const head = `Scanned ${parts.join(', ')}.`;
  if (scan.partial !== true) return head;
  return `${head} Some files were skipped this pass and will be re-read on the next one.`;
}

export function usageErrorLine(report: UsageReport | null | undefined) {
  return textOr(report?.error, '');
}

export function shouldApplyUsageReport(msg: unknown, latestRequestId: unknown) {
  if (!msg || typeof msg !== 'object') return false;
  const id = (msg as { requestId?: unknown }).requestId;
  if (id == null) return true;
  return id === latestRequestId;
}
