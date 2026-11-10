import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  costForEntry,
  lookupModelPrice,
  normalizePricingTable,
} from '../server/usage/core/usage-pricing-core.ts';
import { loadPricing } from '../server/usage/usage-pricing.ts';
import pricingSnapshot from '../server/data/claude-pricing.json' with { type: 'json' };

test('the snapshot prices every current Claude 5.x and listed Kimi Code model under its own key instead of an older fuzzy match', () => {
  const table = normalizePricingTable(pricingSnapshot);
  const expectedInputRates: Record<string, number> = {
    'claude-haiku-5-5': 1e-7,
    'claude-opus-5-5': 0.000004,
    'claude-sonnet-5-5': 0.000002,
    'claude-fable-5-1': 0.00001,
    'claude-mythos-5-1': 0.00001,
    'claude-fable-5-2': 0.000008,
    'claude-mythos-5-2': 0.000008,
    'kimi-code/k3.1-pro': 0.000002,
    'kimi-code/k3': 0.000003,
  };
  for (const [model, inputRate] of Object.entries(expectedInputRates)) {
    const resolved = lookupModelPrice(table, model);
    assert.equal(resolved?.key, model);
    assert.equal(resolved?.price?.input_cost_per_token, inputRate);
  }
});

test('claude-haiku-5-5 bills the whole request at its long-context rates once the prompt passes 100K tokens', () => {
  const haikuPrice = lookupModelPrice(normalizePricingTable(pricingSnapshot), 'claude-haiku-5-5')?.price;
  const promptAtThreshold = { input: 100000, output: 1000 };
  const promptOverThreshold = { input: 100001, output: 1000 };
  assert.ok(Math.abs(costForEntry(promptAtThreshold, haikuPrice, { costMode: 'calculate' }).costUSD - 0.0105) < 1e-12);
  assert.ok(Math.abs(costForEntry(promptOverThreshold, haikuPrice, { costMode: 'calculate' }).costUSD - 0.0525005) < 1e-12);
});

test('a live litellm fetch keeps the snapshot 5.2 rows and fast multipliers it does not carry', async (context) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pricing-overlay-'));
  context.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const liveOpusRow = { input_cost_per_token: 0.000004, output_cost_per_token: 0.00002, litellm_provider: 'anthropic' };
  const fetchLiteLlm = async () => Response.json({ 'claude-opus-5-5': liveOpusRow });
  const { table, source } = await loadPricing({ fetchEnabled: true, fetchFn: fetchLiteLlm, cachePath: path.join(cacheDir, 'pricing.json') });
  assert.equal(source, 'fetched');
  const oneMillionInputTokens = { input: 1_000_000, output: 0 };
  const fastCostOf = (model: string) => costForEntry({ ...oneMillionInputTokens, speed: 'fast' }, lookupModelPrice(table, model)?.price, { costMode: 'calculate' }).costUSD;
  assert.ok(Math.abs(fastCostOf('claude-opus-5-5') - 8) < 1e-9);
  assert.ok(Math.abs(fastCostOf('claude-fable-5-2') - 16) < 1e-9);
  assert.ok(Math.abs(fastCostOf('claude-mythos-5-2') - 16) < 1e-9);
});

test('a flat-priced model keeps its own cache read rate on cached tokens past 200K', () => {
  const fablePrice = lookupModelPrice(normalizePricingTable(pricingSnapshot), 'claude-fable-5-2')?.price;
  const oneMillionCachedTokens = { input: 0, output: 0, cacheRead: 1_000_000 };
  assert.ok(Math.abs(costForEntry(oneMillionCachedTokens, fablePrice, { costMode: 'calculate' }).costUSD - 0.2) < 1e-9);
});
