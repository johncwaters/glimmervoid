import test from 'node:test';
import assert from 'node:assert/strict';

import {
  costForEntry,
  lookupModelPrice,
  normalizePricingTable,
} from '../server/usage/core/usage-pricing-core.ts';
import pricingSnapshot from '../server/data/claude-pricing.json' with { type: 'json' };

test('the snapshot prices every current Claude 5.x and listed Kimi Code model under its own key instead of an older fuzzy match', () => {
  const table = normalizePricingTable(pricingSnapshot);
  const expectedInputRates: Record<string, number> = {
    'claude-haiku-5-5': 1e-7,
    'claude-opus-5-5': 0.000004,
    'claude-sonnet-5-5': 0.000002,
    'claude-fable-5-1': 0.00001,
    'claude-mythos-5-1': 0.00001,
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
