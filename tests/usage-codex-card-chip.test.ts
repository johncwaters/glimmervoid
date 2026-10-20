
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUsageWiring } from '../server/usage/usage-wiring.ts';
import { createUsageScanner } from '../server/usage/usage-scanner.ts';
import { loadPricing } from '../server/usage/usage-pricing.ts';
import { isolateTranscriptHomes } from './helpers/transcript-homes.ts';

const CODEX_SESSION_ID = '019f43ea-76ac-7041-bd4b-6362e85f6630';
const CARD_ID = 'b0000000-0000-4000-8000-0000000000c0';
const MODEL = 'gpt-5.5';

function writeCodexFixture(codexHome: string, { input, output }: { input: number; output: number }): void {
  const dir = path.join(codexHome, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: '2026-08-20T10:00:00.000Z', type: 'turn_context', payload: { turn_id: 't1', model: MODEL, cwd: 'C:/repo' } }),
    JSON.stringify({
      timestamp: '2026-08-20T10:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, total_tokens: input + output },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 13.0, window_minutes: 300, resets_at: 1792519024 },
          secondary: { used_percent: 2.0, window_minutes: 10080, resets_at: 1793105824 },
        },
      },
    }),
  ];
  fs.writeFileSync(path.join(dir, `rollout-${CODEX_SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);
}

test('a supervised codex card shows its own token/cost chip, and the Codex plan windows, from the Codex transcript', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-codex-chip-'));
  const restoreEnv = isolateTranscriptHomes(root);
  try {
    const homes = path.join(root, 'vendor-homes');
    const codexHome = path.join(homes, 'codex_home');
    const emptyHome = path.join(homes, 'empty');
    fs.mkdirSync(emptyHome, { recursive: true });
    writeCodexFixture(codexHome, { input: 2000, output: 200 });

    const sessions = new Map([[CARD_ID, { ephemeral: false, resumeSessionId: CODEX_SESSION_ID }]]);

    const broadcasts: Record<string, unknown>[] = [];
    const usage = createUsageWiring({
      config: {},
      sessions,
      broadcast: (message) => broadcasts.push(message),
      loadPricingFn: (args) => loadPricing({ ...args, fetchEnabled: false }),
      createScanner: createUsageScanner,
      scannerDeps: { env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: emptyHome, GROK_HOME: emptyHome, HOME: emptyHome, USERPROFILE: emptyHome } },
      logger: { warn: () => {}, log: () => {} },
    });

    await usage.start();

    const message = usage.getSessionsMessage();
    assert.ok(message, 'a usage-sessions message was produced');
    const row = message.sessions.find((candidate) => candidate.id === CARD_ID);
    assert.ok(row, 'the codex card has a usage row');
    assert.equal(row.tokens, 2200, 'the codex transcript tokens are attributed to the card (2000 + 200)');
    assert.ok(row.costUSD > 0, 'priced from the committed snapshot (gpt-5.5 is in it)');
    assert.equal(row.officialCostUSD, null);
    const codexPlanLimits = {
      type: 'plan-limits',
      ts: Date.parse('2026-08-20T10:00:05.000Z'),
      fiveHour: { pct: 13, resetsAtMs: 1792519024000 },
      sevenDay: { pct: 2, resetsAtMs: 1793105824000 },
      source: 'rollout',
      vendor: 'codex',
    };
    assert.deepEqual(broadcasts.filter((broadcast) => broadcast.type === 'plan-limits'), [codexPlanLimits]);
    assert.deepEqual(usage.getPlanLimitsMessage('codex'), codexPlanLimits);
    assert.equal(usage.getPlanLimitsMessage('claude'), null, 'a Codex window never stands in for the Claude one');

    await usage.stop();
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
