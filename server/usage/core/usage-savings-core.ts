import { lookupModelPrice, ratesForPrice } from './usage-pricing-core.ts';
import { vendorOf } from './usage-aggregate-core.ts';
import { numberOr, rawTextOr } from '../../../shared/coerce.ts';

interface ModelUsageRow {
  model?: string | null;
  vendor?: string;
  cacheRead?: unknown;
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

export { computeCacheSavings };
