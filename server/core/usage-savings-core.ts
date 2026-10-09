import { lookupModelPrice, ratesForPrice } from './usage-pricing-core.ts';
import { vendorOf } from './usage-aggregate-core.ts';
import { isRecord, numberOr, rawTextOr } from '../../shared/coerce.ts';

export interface RtkDailyRow {
  date: string;
  commands: number;
  savedTokens: number;
  savingsPct: number;
}

export interface RtkGain {
  commands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPct: number;
  daily: RtkDailyRow[];
}

interface ModelUsageRow {
  model?: string | null;
  vendor?: string;
  cacheRead?: unknown;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeRtkGain(parsed: unknown): RtkGain | null {
  if (!isRecord(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  if (!isRecord(payload.summary)) return null;
  const summary = payload.summary as Record<string, unknown>;
  return {
    commands: numberOr(summary.total_commands, 0),
    inputTokens: numberOr(summary.total_input, 0),
    outputTokens: numberOr(summary.total_output, 0),
    savedTokens: numberOr(summary.total_saved, 0),
    savingsPct: numberOr(summary.avg_savings_pct, 0),
    daily: normalizeRtkDaily(payload.daily),
  };
}

function normalizeRtkDaily(daily: unknown): RtkDailyRow[] {
  if (!Array.isArray(daily)) return [];
  const rows: RtkDailyRow[] = [];
  for (const rawRow of daily) {
    if (!isRecord(rawRow)) continue;
    const row = rawRow as Record<string, unknown>;
    const date = rawTextOr(row.date, null);
    if (date === null || !DAY_KEY_RE.test(date)) continue;
    rows.push({
      date,
      commands: numberOr(row.commands, 0),
      savedTokens: numberOr(row.saved_tokens, 0),
      savingsPct: numberOr(row.savings_pct, 0),
    });
  }
  return rows;
}

function computeCacheSavings(
  modelRows: ModelUsageRow[] | null | undefined,
  pricingTable: unknown,
): { savedUSD: number; cacheReadTokens: number; unpricedModels: string[] } | null {
  const rows = Array.isArray(modelRows) ? modelRows : [];
  let savedUSD = 0;
  let cacheReadTokens = 0;
  const unpricedModels: string[] = [];
  for (const row of rows) {
    if (vendorOf(row) !== 'claude') continue;
    const cacheRead = numberOr(row?.cacheRead, 0);
    if (cacheRead <= 0) continue;
    cacheReadTokens += cacheRead;
    const resolved = lookupModelPrice(pricingTable, row?.model, {});
    if (!resolved) {
      const name = rawTextOr(row?.model, null);
      if (name !== null && !unpricedModels.includes(name)) unpricedModels.push(name);
      continue;
    }
    const rates = ratesForPrice(resolved.price);
    savedUSD += Math.max(0, cacheRead * (rates.input - rates.cacheRead));
  }
  if (cacheReadTokens <= 0) return null;
  return { savedUSD, cacheReadTokens, unpricedModels };
}

export { computeCacheSavings, normalizeRtkGain };
