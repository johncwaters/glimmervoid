import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { BrowserConfig, Config, CONFIG_BLOCK_KEYS, CONFIG_SCALAR_KEYS, ConfigUpdate } from '../shared/contracts/config.ts';

function validRule(overrides: Record<string, unknown> = {}) {
  return { id: 'ping-me', name: 'Ping me', repos: ['Acme/app'], trigger: 'opened', actions: [{ type: 'notify' }], ...overrides };
}

test('the workflows block is file-only: config.json keeps it, the browser mirror validates it, a dashboard update writes only the switch, limits and rule toggles', () => {
  const workflows = { rules: [validRule()] };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, workflows }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, workflows: { rules: [validRule({ trigger: 'pushed' })] } }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, workflows: 'on' }).success, false);
  assert.equal(BrowserConfig.safeParse({ workflows }).success, true);
  assert.equal(BrowserConfig.safeParse({ workflows: { rules: [validRule({ trigger: 'pushed' })] } }).success, false);
  assert.equal(ConfigUpdate.safeParse({ workflows }).success, false);
  assert.equal(ConfigUpdate.safeParse({ workflows: { enabled: false, maxConcurrentSessions: 5, maxActionsPerPoll: 1, rules: [{ id: validRule().id, enabled: true }] } }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('workflows'), true);
  assert.equal(CONFIG_SCALAR_KEYS.includes('workflows'), false);
});
