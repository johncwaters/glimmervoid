import { numberOr } from '../../shared/coerce.ts';

export interface DailyUsageRow {
  day?: unknown;
  costUSD?: unknown;
  tokens?: unknown;
}

export interface DailyBaseline {
  meanUsd: number;
  meanTokens: number;
  days: number;
}

export interface UsageRateBlock {
  isGap?: boolean;
  entries?: unknown;
  startTs?: unknown;
  endTs?: unknown;
  tokens?: unknown;
}

export interface DailyAnomaly {
  kind: 'daily';
  todayUsd: number;
  todayTokens: number;
  baselineUsd: number;
  ratio: number;
}

export interface BurnAnomaly {
  kind: 'burn';
  current: number;
  baseline: number;
  ratio: number;
}

function dailyBaseline(
  dailyRows: DailyUsageRow[] | null | undefined,
  { excludeDay }: { excludeDay?: string } = {},
): DailyBaseline | null {
  const usableRows = (dailyRows || []).filter((row) => isUsableDailyRow(row, excludeDay));
  if (usableRows.length < 7) return null;
  const totalUsd = usableRows.reduce((sum, row) => sum + numberOr(row.costUSD, 0), 0);
  const totalTokens = usableRows.reduce((sum, row) => sum + numberOr(row.tokens, 0), 0);
  return {
    meanUsd: totalUsd / usableRows.length,
    meanTokens: totalTokens / usableRows.length,
    days: usableRows.length,
  };
}

function detectDailyAnomaly({
  todayUsd,
  todayTokens,
  baseline,
  minUsd = 5,
  factor = 1.8,
}: {
  todayUsd?: unknown;
  todayTokens?: unknown;
  baseline?: DailyBaseline | null;
  minUsd?: number;
  factor?: number;
} = {}): DailyAnomaly | null {
  if (!baseline) return null;
  const safeTodayUsd = numberOr(todayUsd, 0);
  const baselineUsd = numberOr(baseline.meanUsd, 0);
  if (safeTodayUsd < minUsd) return null;
  if (baselineUsd <= 0) return null;
  if (safeTodayUsd < baselineUsd * factor) return null;
  return {
    kind: 'daily',
    todayUsd: safeTodayUsd,
    todayTokens: numberOr(todayTokens, 0),
    baselineUsd,
    ratio: safeTodayUsd / baselineUsd,
  };
}

function detectBurnAnomaly({
  currentTokensPerMinute,
  completedBlocks,
  minTokensPerMinute = 200000,
  factor = 2.5,
}: {
  currentTokensPerMinute?: unknown;
  completedBlocks?: UsageRateBlock[] | null;
  minTokensPerMinute?: number;
  factor?: number;
} = {}): BurnAnomaly | null {
  const baselineRates = (completedBlocks || []).map(tokensPerMinute).filter((rate): rate is number => rate !== null);
  if (baselineRates.length < 3) return null;
  const current = numberOr(currentTokensPerMinute, 0);
  const baseline = baselineRates.reduce((sum, rate) => sum + rate, 0) / baselineRates.length;
  if (current < minTokensPerMinute) return null;
  if (baseline <= 0) return null;
  if (current < baseline * factor) return null;
  return {
    kind: 'burn',
    current,
    baseline,
    ratio: current / baseline,
  };
}

function isUsableDailyRow(row: DailyUsageRow | null | undefined, excludeDay: string | undefined): boolean {
  if (!row || row.day === excludeDay) return false;
  if (typeof row.day !== 'string' || row.day.length === 0) return false;
  return Number.isFinite(numberOr(row.costUSD, 0)) && Number.isFinite(numberOr(row.tokens, 0));
}

function tokensPerMinute(block: UsageRateBlock | null | undefined): number | null {
  if (!block || block.isGap || numberOr(block.entries, 0) <= 0) return null;
  const durationMs = numberOr(block.endTs, 0) - numberOr(block.startTs, 0);
  if (durationMs <= 0) return null;
  return numberOr(block.tokens, 0) / (durationMs / 60000);
}

export { dailyBaseline, detectBurnAnomaly, detectDailyAnomaly };
