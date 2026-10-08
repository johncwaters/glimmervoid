import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPricing } from '../server/usage-pricing.ts';
import type { LoadPricingOptions } from '../server/usage-pricing.ts';
import { costForEntry } from '../server/core/usage-pricing-core.ts';
import type { ModelPrice } from '../server/core/usage-pricing-core.ts';

type PricingFileSystem = NonNullable<LoadPricingOptions['fsPromises']>;

function priceOf(table: Map<string, ModelPrice>, model: string): ModelPrice {
  const price = table.get(model);
  if (!price) throw new Error(`the table carries no price for ${model}`);
  return price;
}

function parseCacheText(text: string): { fetchedAt: unknown; models: Record<string, ModelPrice> } {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the cache write was not a JSON object');
  const { fetchedAt, models } = parsed as { fetchedAt?: unknown; models?: unknown };
  if (typeof models !== 'object' || models === null) throw new Error('the cache write carries no models');
  return { fetchedAt, models: models as Record<string, ModelPrice> };
}

test('fetch keeps anthropic and openai entries, drops other providers, writes cache and overlays snapshot', async () => {
  const writes: { file: string; text: string }[] = [];
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      writeFile: async (file, text) => { writes.push({ file, text }); },
    }),
    fetchFn: async () => okResponse({
      'claude-test': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 9,
        output_cost_per_token: 10,
        ignored: true,
      },
      'openai-test': {
        litellm_provider: 'openai',
        input_cost_per_token: 99,
        ignored: true,
      },
      'mistral-test': {
        litellm_provider: 'mistral',
        input_cost_per_token: 7,
      },
    }),
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'fetched');
  assert.equal(priceOf(pricing.table, 'claude-test').input_cost_per_token, 9);

  assert.equal(priceOf(pricing.table, 'openai-test').input_cost_per_token, 99);

  assert.equal(pricing.table.has('mistral-test'), false);
  assert.equal(pricing.table.has('claude-sonnet-4-20250514'), true);
  assert.equal(pricing.table.has('gpt-5.5'), true, 'the bundled snapshot carries the gpt family');
  const written = parseCacheText(writes[0].text).models;
  assert.equal(written['claude-test']?.ignored, undefined);
  assert.equal(written['openai-test']?.ignored, undefined, 'unknown fields are trimmed for every provider');
});

test('fresh cache skips fetchFn entirely', async () => {
  let fetchCalls = 0;
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: '2026-08-19T11:00:00.000Z',
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      fetchCalls += 1;
      return okResponse({});
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'cache');
  assert.equal(priceOf(pricing.table, 'claude-cache').input_cost_per_token, 3);
  assert.equal(fetchCalls, 0);
});

test('stale cache refetches', async () => {
  let fetchCalls = 0;
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: '2026-08-17T11:00:00.000Z',
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      fetchCalls += 1;
      return okResponse({ 'claude-fetch': { input_cost_per_token: 7, litellm_provider: 'anthropic' } });
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'fetched');
  assert.equal(priceOf(pricing.table, 'claude-fetch').input_cost_per_token, 7);
  assert.equal(fetchCalls, 1);
});

test('fetch failure falls back to stale cache, then snapshot', async () => {
  const warnings: string[] = [];
  const staleCache = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: '2026-08-17T11:00:00.000Z',
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      throw new Error('offline');
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
    logger: { warn: (message) => { warnings.push(message); } },
  });
  assert.equal(staleCache.source, 'cache');
  assert.equal(priceOf(staleCache.table, 'claude-cache').input_cost_per_token, 3);
  assert.deepEqual(warnings, ['[usage] pricing fetch failed error=offline']);

  const snapshot = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs(),
    fetchFn: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(snapshot.source, 'snapshot');
  assert.equal(snapshot.table.has('claude-sonnet-4-20250514'), true);
});

test('fetchEnabled false performs zero network and zero cache IO', async () => {
  const calls: string[] = [];
  const pricing = await loadPricing({
    fetchEnabled: false,
    fsPromises: fakeFs({
      readFile: async () => {
        calls.push('readFile');
        return '';
      },
      writeFile: async () => { calls.push('writeFile'); },
    }),
    fetchFn: async () => {
      calls.push('fetch');
      return okResponse({});
    },
  });

  assert.equal(pricing.source, 'snapshot');
  assert.equal(pricing.table.has('claude-sonnet-4-20250514'), true);
  assert.deepEqual(calls, []);
});

test('cache write failure is swallowed', async () => {
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      writeFile: async () => {
        throw new Error('disk full');
      },
    }),
    fetchFn: async () => okResponse({ 'claude-fetch': { input_cost_per_token: 7, litellm_provider: 'anthropic' } }),
  });

  assert.equal(pricing.source, 'fetched');
  assert.equal(priceOf(pricing.table, 'claude-fetch').input_cost_per_token, 7);
});

test('fetched cache round trips as fresh ISO data and expires after 24 hours', async () => {
  const cache = new Map<string, string>();
  const fsPromises = fakeFs({
    readFile: async (file) => {
      const text = cache.get(file);
      if (text === undefined) throw new Error('missing');
      return text;
    },
    writeFile: async (file, text) => {
      cache.set(file, text);
    },
  });
  let fetchCalls = 0;
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const fetchFn = async () => {
    fetchCalls += 1;
    return okResponse({ [`claude-fetch-${fetchCalls}`]: { input_cost_per_token: fetchCalls, litellm_provider: 'anthropic' } });
  };

  const first = await loadPricing({
    fetchEnabled: true,
    fsPromises,
    fetchFn,
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => now,
  });
  assert.equal(first.source, 'fetched');
  const firstWrite = cache.get('C:/cache/pricing.json');
  assert.ok(firstWrite, 'the fetch wrote the cache');
  assert.equal(parseCacheText(firstWrite).fetchedAt, '2026-08-19T12:00:00.000Z');

  now = Date.parse('2026-08-20T11:00:00.000Z');
  const second = await loadPricing({
    fetchEnabled: true,
    fsPromises,
    fetchFn,
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => now,
  });
  assert.equal(second.source, 'cache');
  assert.equal(fetchCalls, 1);
  assert.equal(priceOf(second.table, 'claude-fetch-1').input_cost_per_token, 1);

  now = Date.parse('2026-08-20T13:00:00.000Z');
  const third = await loadPricing({
    fetchEnabled: true,
    fsPromises,
    fetchFn,
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => now,
  });
  assert.equal(third.source, 'fetched');
  assert.equal(fetchCalls, 2);
  assert.equal(priceOf(third.table, 'claude-fetch-2').input_cost_per_token, 2);
});

test('numeric fetchedAt cache entries remain fresh for backward compatibility', async () => {
  let fetchCalls = 0;
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: Date.parse('2026-08-19T11:00:00.000Z'),
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      fetchCalls += 1;
      return okResponse({});
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'cache');
  assert.equal(fetchCalls, 0);
});

test('fetch receives AbortSignal and timeout falls back to snapshot', async () => {
  const observed: { signal: AbortSignal | null } = { signal: null };
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs(),
    timeoutMs: 1,
    fetchFn: async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('the pricing fetch carried no abort signal');
      observed.signal = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  const seen = observed.signal;
  assert.ok(seen, 'the pricing fetch carried an abort signal');
  assert.equal(seen.aborted, true);
  assert.equal(pricing.source, 'snapshot');
});

const HAIKU_UPPER_CARD_COST_FOR_150K_PROMPT = 150000 * 5e-7 + 1000 * 0.0000025;

function costOf150kPrompt(price: ModelPrice): number {
  return costForEntry({ input: 150000, output: 1000 }, price, { costMode: 'calculate' }).costUSD;
}

async function pricingWithFetchedHaiku(fetchedHaikuRow: Record<string, unknown>): Promise<ModelPrice> {
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs(),
    fetchFn: async () => okResponse({ 'claude-haiku-5-5': { litellm_provider: 'anthropic', ...fetchedHaikuRow } }),
  });
  assert.equal(pricing.source, 'fetched');
  return priceOf(pricing.table, 'claude-haiku-5-5');
}

test('a fetched base-rate-only row keeps the snapshot long context threshold and tier rates', async () => {
  const haiku = await pricingWithFetchedHaiku({ input_cost_per_token: 1e-7, output_cost_per_token: 5e-7 });

  assert.equal(haiku.long_context_threshold, 100000);
  assert.equal(haiku.input_cost_per_token_above_200k_tokens, 5e-7);
  assert.equal(haiku.output_cost_per_token_above_200k_tokens, 0.0000025);
  assert.equal(haiku.cache_creation_input_token_cost_above_200k_tokens, 6.25e-7);
  assert.equal(haiku.cache_read_input_token_cost_above_200k_tokens, 5e-8);
  assert.ok(Math.abs(costOf150kPrompt(haiku) - HAIKU_UPPER_CARD_COST_FOR_150K_PROMPT) < 1e-12);
});

test('a fetched row with marginal above_200k rates but no threshold takes the snapshot tier as a pair', async () => {
  const haiku = await pricingWithFetchedHaiku({
    input_cost_per_token: 2e-7,
    output_cost_per_token: 5e-7,
    input_cost_per_token_above_200k_tokens: 9e-7,
    output_cost_per_token_above_200k_tokens: 0.000009,
    cache_creation_input_token_cost_above_200k_tokens: 0.000001,
    cache_read_input_token_cost_above_200k_tokens: 9e-8,
  });

  assert.equal(haiku.input_cost_per_token, 2e-7, 'base rates keep fetched precedence');
  assert.equal(haiku.long_context_threshold, 100000);
  assert.equal(haiku.input_cost_per_token_above_200k_tokens, 5e-7);
  assert.equal(haiku.output_cost_per_token_above_200k_tokens, 0.0000025);
  assert.equal(haiku.cache_creation_input_token_cost_above_200k_tokens, 6.25e-7);
  assert.equal(haiku.cache_read_input_token_cost_above_200k_tokens, 5e-8);
  assert.ok(Math.abs(costOf150kPrompt(haiku) - HAIKU_UPPER_CARD_COST_FOR_150K_PROMPT) < 1e-12);
});

test('a fetched row carrying its own long context threshold is left untouched', async () => {
  const haiku = await pricingWithFetchedHaiku({
    input_cost_per_token: 2e-7,
    output_cost_per_token: 5e-7,
    long_context_threshold: 300000,
    input_cost_per_token_above_200k_tokens: 9e-7,
    output_cost_per_token_above_200k_tokens: 0.000009,
  });

  assert.equal(haiku.long_context_threshold, 300000);
  assert.equal(haiku.input_cost_per_token_above_200k_tokens, 9e-7);
  assert.equal(haiku.output_cost_per_token_above_200k_tokens, 0.000009);
  assert.equal(haiku.cache_creation_input_token_cost_above_200k_tokens, undefined);
  assert.equal(haiku.cache_read_input_token_cost_above_200k_tokens, undefined);
});

test('a cached base-rate-only row keeps the snapshot long context tier', async () => {
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: '2026-08-19T11:00:00.000Z',
        models: { 'claude-haiku-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 1e-7, output_cost_per_token: 5e-7 } },
      }),
    }),
    fetchFn: async () => okResponse({}),
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'cache');
  const haiku = priceOf(pricing.table, 'claude-haiku-5-5');
  assert.equal(haiku.long_context_threshold, 100000);
  assert.ok(Math.abs(costOf150kPrompt(haiku) - HAIKU_UPPER_CARD_COST_FOR_150K_PROMPT) < 1e-12);
});

function fakeFs(overrides: Partial<PricingFileSystem> = {}): PricingFileSystem {
  return {
    readFile: async () => {
      throw new Error('missing');
    },
    mkdir: async () => undefined,
    writeFile: async () => {},
    ...overrides,
  };
}

function okResponse(models: Record<string, unknown>): Response {
  return Response.json(models);
}
