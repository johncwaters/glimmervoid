import { attentionSignature } from '../attention-ack-core.ts';
import type { PlanLimitsVendor } from '#shared/contracts/control-messages.ts';
import type { YourDay } from '#shared/contracts/your-day.ts';
import { numberOr, textOr } from '#shared/coerce.ts';

export interface UsageTokenLimit {
  max?: unknown;
  pct?: unknown;
}

export interface UsageProjection {
  projectedTokens?: unknown;
  projectedCostUSD?: unknown;
  remainingMinutes?: unknown;
}

export interface UsageBurn {
  tokensPerMinute?: unknown;
  tokensPerMinuteExCache?: unknown;
  costPerHour?: unknown;
}

export interface UsageBlock {
  startTs?: unknown;
  endTs?: unknown;
  tokens?: unknown;
  costUSD?: unknown;
  isActive?: unknown;
  isGap?: unknown;
  burn?: UsageBurn;
  projection?: UsageProjection;
}

export interface UsageBudgetRow {
  scope?: unknown;
  budgetUsd?: unknown;
  spentUsd?: unknown;
  pct?: unknown;
  tone?: unknown;
}

export interface UsageAnomaly {
  daily?: { baselineDays?: unknown; ratio?: unknown; todayUsd?: unknown; baselineUsd?: unknown } | null;
  burn?: { ratio?: unknown; current?: unknown; baseline?: unknown } | null;
}

export interface CacheSavings {
  cacheReadTokens?: unknown;
  savedUSD?: unknown;
  unpricedModels?: unknown;
}

export interface UsageSavings {
  cache?: CacheSavings | null;
}

interface UsageVendorTotals {
  tokens?: unknown;
  costUSD?: unknown;
}

export interface UsageTotals {
  costUSD?: unknown;
  tokens?: unknown;
  input?: unknown;
  output?: unknown;
  cacheCreate?: unknown;
  cacheRead?: unknown;
  byVendor?: Record<string, UsageVendorTotals | null | undefined>;
}

interface UsageScan {
  dirs?: unknown;
  files?: unknown;
  entries?: unknown;
  lastScanMs?: unknown;
  partial?: unknown;
}

export interface UsageReport {
  ts?: unknown;
  tz?: unknown;
  error?: unknown;
  warning?: unknown;
  byLane?: unknown;
  planWindowLanes?: { fiveHour?: unknown; sevenDay?: unknown } | null;
  budget?: { rows?: unknown } | null;
  tokenLimit?: UsageTokenLimit | null;
  activeBlock?: UsageBlock | null;
  anomaly?: UsageAnomaly | null;
  daily?: unknown;
  blocks?: unknown;
  models?: unknown;
  sessions?: unknown;
  blockHours?: unknown;
  totals?: UsageTotals;
  savings?: UsageSavings;
  scan?: UsageScan;
  pricing?: { missing?: unknown; fetchedAt?: unknown; source?: unknown } | null;
  yourDay?: YourDay | null;
}

export interface UsageSessionUsage {
  tokens?: unknown;
  costUSD?: unknown;
  officialCostUSD?: unknown;
}

export const NO_VALUE = '-';

const TOKEN_LIMIT_WARN_PCT = 80;
export const RANGE_OPTIONS: readonly { value: string; label: string; days: number | null }[] = Object.freeze([
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All retained', days: null },
]);
export const DEFAULT_RANGE_VALUE = 'all';

function groupThousands(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function trimTrailingZeros(fixed: string) {
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

export function tokenLimitTone(pct: unknown) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'ok';
  if (pct >= 100) return 'crit';
  if (pct >= TOKEN_LIMIT_WARN_PCT) return 'warn';
  return 'ok';
}

function limitMax(tokenLimit: UsageTokenLimit | null | undefined) {
  const max = numberOr(tokenLimit?.max, null);
  if (max === null || max <= 0) return null;
  return max;
}

export function limitPct(tokenLimit: UsageTokenLimit | null | undefined) {
  const max = limitMax(tokenLimit);
  const ratio = numberOr(tokenLimit?.pct, null);
  if (max === null || ratio === null) return null;
  return ratio * 100;
}

export function projectedLimitPct(projection: UsageProjection | null | undefined, tokenLimit: UsageTokenLimit | null | undefined) {
  const max = limitMax(tokenLimit);
  const projected = numberOr(projection?.projectedTokens, null);
  if (max === null || projected === null) return null;
  return (projected / max) * 100;
}

const BUDGET_ATTENTION_PCT = 90;

export function budgetRows(report: UsageReport | null | undefined): UsageBudgetRow[] {
  const rows = report?.budget?.rows;
  if (!Array.isArray(rows)) return [];
  return (rows as UsageBudgetRow[]).filter((row) => row && numberOr(row.budgetUsd, null) !== null);
}

export function budgetRowPct(row: UsageBudgetRow | null | undefined) {
  const pct = numberOr(row?.pct, null);
  if (pct === null) return 0;
  return pct;
}

export interface PlanWindow {
  pct?: unknown;
  resetsAtMs?: unknown;
}

export interface PlanLimits {
  ts?: unknown;
  vendor?: unknown;

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

export type { PlanLimitsVendor };

export function planLimitsVendorOf(planLimits: PlanLimits | null | undefined): PlanLimitsVendor {
  if (planLimits?.vendor === 'codex' || planLimits?.vendor === 'kimi') return planLimits.vendor;
  return 'claude';
}

function officialFiveHourPct(planLimits: PlanLimits | null | undefined) {
  return planWindowOf(planLimits, 'fiveHour')?.pct ?? null;
}

export function blockAttentionTone(report: UsageReport | null | undefined, planLimits: PlanLimits | null = null) {
  const official = officialFiveHourPct(planLimits);
  if (official !== null) return tokenLimitTone(official);
  const current = tokenLimitTone(limitPct(report?.tokenLimit));
  if (current !== 'ok') return current;
  return tokenLimitTone(projectedLimitPct(report?.activeBlock?.projection, report?.tokenLimit));
}

export function usageAttentionSignature(report: UsageReport | null | undefined, planLimits: PlanLimits | null = null) {
  const parts: string[] = [];
  const tone = blockAttentionTone(report, planLimits);
  if (tone !== 'ok') parts.push(`block:${tone}`);
  if (report?.anomaly?.daily) parts.push('anomaly:daily');
  if (report?.anomaly?.burn) parts.push('anomaly:burn');
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

function countOf(value: unknown) {
  if (Array.isArray(value)) return value.length;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

export function scanLine(scan: UsageScan | null | undefined) {
  if (!scan || typeof scan !== 'object') return '';
  const parts: string[] = [];
  const dirs = countOf(scan.dirs);
  if (dirs !== null) parts.push(`${formatCount(dirs)} transcript ${dirs === 1 ? 'directory' : 'directories'}`);
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

function sessionChipCost(usage: UsageSessionUsage | null | undefined): { costUSD: number | null; source: string | null } {
  const official = numberOr(usage?.officialCostUSD, null);
  if (official !== null && official > 0) return { costUSD: official, source: 'official' };
  const estimated = numberOr(usage?.costUSD, null);
  if (estimated !== null && estimated > 0) return { costUSD: estimated, source: 'estimated' };
  return { costUSD: null, source: null };
}

export function sessionChipText(usage: UsageSessionUsage | null | undefined) {
  const tokens = Number(usage?.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const { costUSD } = sessionChipCost(usage);
  if (costUSD === null) return formatTokens(tokens);
  return `${formatTokens(tokens)} ${formatUsd(costUSD)}`;
}

export function sessionChipTitle(usage: UsageSessionUsage | null | undefined) {
  const { source } = sessionChipCost(usage);
  if (source === 'official') return 'Tokens counted from the transcript; cost reported by Claude Code for this conversation';
  return 'Tokens and estimated API list-price cost for this conversation';
}
