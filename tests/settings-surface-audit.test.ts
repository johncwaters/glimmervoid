import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserConfig, ConfigUpdate } from '../shared/contracts/config.ts';
import { normalizeLegacyConfigNumbers } from '../shared/contracts/config-numbers-core.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import type { SettingsSection, SettingsSetting } from '../shared/settings/registry.ts';
import { SETTINGS_INDEX } from '../shared/settings/registry-core.ts';
import { includesRepositoryRoot, projectSelectionChoices } from '../public/settings/settings-projects-core.ts';
import {
  collectDirtyBlocks, hydrateFromSettings, secretEnvironmentSource, validateLocally,
} from '../public/settings/settings-view-core.ts';

const WHOLE_NUMBER_FIELDS = [
  ['file-replay-buffer', 'replayBufferKB'],
  ['posthog-max-investigations', 'posthog.maxConcurrentInvestigations'],
  ['posthog-min-users', 'posthog.minUsersToInvestigate'],
  ['file-posthog-escalation', 'posthog.userEscalationThreshold'],
  ['file-posthog-traffic-min-users', 'posthog.trafficSpikeMinUsers'],
  ['file-posthog-traffic-baseline', 'posthog.trafficSpikeBaselineDays'],
] as const;

function payloadAtPath(path: string, value: unknown): Record<string, unknown> {
  return path.split('.').reverse().reduce<Record<string, unknown>>((block, key, index) => ({ [key]: index === 0 ? value : block }), {});
}

function registrySetting(id: string): SettingsSetting {
  const setting = SETTINGS_INDEX.byId.get(id);
  assert.ok(setting, `no registry entry ${id}`);
  return setting;
}

function editableSection(id: string): { setting: SettingsSetting; section: SettingsSection } {
  const section = SETTINGS_REGISTRY.sections.find((entry) => entry.settings.some((setting) => setting.id === id));
  assert.ok(section, `${id} is not an editable section entry`);
  const setting = registrySetting(id);
  return { section: { ...section, settings: [setting] }, setting };
}

for (const [id, path] of WHOLE_NUMBER_FIELDS) {
  test(`${id} rejects fractions at browser, save and local boundaries`, () => {
    const setting = registrySetting(id);
    assert.equal(setting.path, path);
    assert.notEqual(setting.integer, false, `${id} is declared a whole number`);
    const fraction = Number(setting.defaultValue) + 0.5;
    const payload = payloadAtPath(path, fraction);
    assert.equal(BrowserConfig.safeParse(payload).success, false);
    assert.equal(ConfigUpdate.safeParse(payload).success, false);
    assert.equal(ConfigUpdate.safeParse(payloadAtPath(path, Number.MAX_SAFE_INTEGER + 1)).success, false);
    assert.equal(ConfigUpdate.safeParse(payloadAtPath(path, setting.defaultValue)).success, true);
    if (setting.access === 'file-only') return;
    const { section } = editableSection(id);
    assert.ok(validateLocally([section], { [path]: fraction })[id]);
    assert.ok(validateLocally([section], { [path]: Number.MAX_SAFE_INTEGER + 1 })[id]);
  });
}

test('legacy numeric migration preserves count comparisons, floors truncated quantities and leaves the input intact', () => {
  const legacy = {
    projects: [], replayBufferKB: 0.5,
    posthog: { maxConcurrentInvestigations: 2.5, minUsersToInvestigate: 2.5, userEscalationThreshold: 2.5, trafficSpikeMinUsers: 2.5, trafficSpikeBaselineDays: 2.5, intervalMinutes: 2.5, future: true },
  };
  const snapshot = structuredClone(legacy);
  const migrated = normalizeLegacyConfigNumbers(legacy);
  assert.deepEqual(migrated, {
    projects: [], replayBufferKB: 64,
    posthog: { maxConcurrentInvestigations: 3, minUsersToInvestigate: 3, userEscalationThreshold: 3, trafficSpikeMinUsers: 3, trafficSpikeBaselineDays: 2, intervalMinutes: 2.5, future: true },
  });
  assert.deepEqual(legacy, snapshot);
  assert.deepEqual(normalizeLegacyConfigNumbers(migrated), migrated);
  assert.deepEqual(normalizeLegacyConfigNumbers({ posthog: null }), { posthog: null });
});

test('environment secret ownership excludes replacement edits and sibling saves carry no secret metadata', () => {
  for (const [id, path, environmentVariable] of [
    ['telegram-bot-token', 'telegram.botToken', 'GLIMMERVOID_TELEGRAM_BOT_TOKEN'],
    ['posthog-api-key', 'posthog.apiKey', 'GLIMMERVOID_POSTHOG_API_KEY'],
  ]) {
    const { setting } = editableSection(id);
    const payload = { ...payloadAtPath(`${path}Configured`, true), secretSources: { [path]: environmentVariable } };
    const original = hydrateFromSettings(SETTINGS_REGISTRY.sections, payload);
    const edited = { ...original, [path]: 'discarded-replacement' };
    assert.equal(secretEnvironmentSource(setting, payload), environmentVariable);
    assert.deepEqual(collectDirtyBlocks(SETTINGS_REGISTRY.sections, original, edited), {});
    edited[path.startsWith('telegram') ? 'telegram.chatId' : 'posthog.enabled'] = path.startsWith('telegram') ? '123' : true;
    const saved = collectDirtyBlocks(SETTINGS_REGISTRY.sections, original, edited);
    assert.equal(JSON.stringify(saved).includes('discarded-replacement'), false);
    assert.equal(JSON.stringify(saved).includes('Configured'), false);
    assert.equal(JSON.stringify(saved).includes('secretSources'), false);
  }
});

test('project selection displays unavailable ids without duplicating configured choices', () => {
  assert.deepEqual(projectSelectionChoices([{ id: 'available', name: 'Available' }], ['available', 'gone', 'gone']), [
    { id: 'available', name: 'Available' }, { id: 'gone', name: 'Unavailable project (gone)' },
  ]);
});

test('repository roots preserve case distinctions under the server path policy and still deduplicate aliases on Windows', () => {
  assert.equal(includesRepositoryRoot(['/repos/Case'], '/repos/case', false), false);
  assert.equal(includesRepositoryRoot(['/repos/Case'], '/repos/Case', false), true);
  assert.equal(includesRepositoryRoot(['C:/repos/Case'], 'c:/repos/case', true), true);
  assert.equal(includesRepositoryRoot(['C:/repos/Case'], 'C:/repos/Other', true), false);
});

