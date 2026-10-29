import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, DEFAULT_CONFIG } from '../server/config-store.ts';
import { Config, CONFIG_BLOCK_KEYS, ConfigUpdate, HIDDEN_CONFIG_KEYS } from '../shared/contracts/index.ts';

test('DEFAULT_CONFIG satisfies the persisted Config contract', () => {
  assert.equal(Config.safeParse(DEFAULT_CONFIG).success, true);
  assert.equal(DEFAULT_CONFIG.integrationBranch, null);
  assert.equal(DEFAULT_CONFIG.updateChannel, 'release');
  assert.equal(Config.shape.integrationBranch.safeParse(null).success, true);
  assert.equal(DEFAULT_CONFIG.trace.enabled, true);
  assert.equal(DEFAULT_CONFIG.planReview.enabled, true);
});

test('a config.json still holding the retired changeMap.narrator block loads unchanged', () => {
  const changeMap = { narrator: { enabled: true, engine: 'codex', model: 'sonnet', timeoutSeconds: 15 } };
  const parsed = Config.safeParse({ ...DEFAULT_CONFIG, changeMap });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success && parsed.data.changeMap, changeMap);
});


test('a config still carrying the retired mill, memory, agentApi, antiSlopPrompt, visions and ingest keys parses, and the keys pass through untouched', () => {
  const retired = {
    millEnabled: false,
    packsAutoRebuild: false,
    packDistiller: { enabled: true, intervalHours: 24, timeoutSeconds: 900 },
    millMetrics: { retainDays: 90, holdoutPercent: 50 },
    memory: { enabled: true, retainDays: 365, distill: { enabled: true, intervalMinutes: 60 } },
    agentApi: { enabled: true, token: 'x' },
    antiSlopPrompt: true,
    visions: { enabled: true, dispatch: { enabled: true } },
    ingest: { enabled: true, sources: { terminal: { enabled: true } } },
  };
  const config = {
    ...DEFAULT_CONFIG,
    ...retired,
    projects: [{ id: 'p1', name: 'proj', path: '/repo/proj', packs: ['house-rules'] }],
    posthog: { enabled: false, packs: ['crew-rules'] },
  };
  const parsed = Config.safeParse(config);
  assert.equal(parsed.success, true);
  const data: Record<string, unknown> = parsed.success ? parsed.data : {};
  for (const [key, value] of Object.entries(retired)) assert.deepEqual(data[key], value, key);
  for (const key of Object.keys(retired)) assert.equal(CONFIG_BLOCK_KEYS.includes(key), false, key);
  assert.equal(ConfigUpdate.safeParse({ agentApi: { enabled: true } }).success, false, 'the dashboard can no longer save the retired block');
});

test('hidden persisted config keys never enter the browser settings projection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-contract-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, trace: {} }), 'utf8');
  const previousConfig = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    const settings = createConfigStore().getSettings();
    assert.deepEqual(HIDDEN_CONFIG_KEYS.filter((key) => Object.hasOwn(settings, key)), []);
    assert.deepEqual(settings.trace, { enabled: true });
  } finally {
    if (previousConfig == null) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfig != null) process.env.GLIMMERVOID_CONFIG = previousConfig;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('project title state round-trips through config and old configs need no title field', () => {
  for (const sources of [{ aiTitle: 'Automatic task' }, { customTitle: 'Custom task', refinedTitle: 'Automatic task' }]) {
    const isCustom = 'customTitle' in sources;
    const taskTitleState = { taskTitle: isCustom ? 'Custom task' : 'Automatic task', isCustom, sources };
    const config = Config.parse({ projects: [{ path: '/repo', taskTitleState }] });
    assert.deepEqual(config.projects[0].taskTitleState, taskTitleState);
  }
  assert.equal(Config.parse({ projects: [{ path: '/repo' }] }).projects[0].taskTitleState, undefined);
});

test('invalid persisted title state is dropped without rejecting the project or config', () => {
  const validTitle = { taskTitle: 'Task', isCustom: false, sources: { aiTitle: 'Task' } };
  for (const taskTitleState of [
    null, 'Task', 42, {},
    { ...validTitle, taskTitle: '' },
    { ...validTitle, taskTitle: 'a'.repeat(121) },
    { ...validTitle, taskTitle: 'Task\n' },
    { ...validTitle, isCustom: 'false' },
    { ...validTitle, isCustom: true },
    { ...validTitle, taskTitle: 'Mismatch' },
    { ...validTitle, sources: { aiTitle: 42 } },
    { ...validTitle, sources: { aiTitle: 'Task', refinedTitle: 'Invalid\n' } },
    { ...validTitle, sources: { aiTitle: 'Task', unknownTitle: 'Task' } },
    { ...validTitle, extra: true },
  ]) {
    const parsed = Config.parse({ projects: [{ path: '/repo', taskTitleState, packs: ['house-rules'] }] });
    assert.equal(parsed.projects[0].taskTitleState, undefined);
    assert.equal(parsed.projects[0].path, '/repo');
    assert.deepEqual(parsed.projects[0].packs, ['house-rules']);
  }
});
