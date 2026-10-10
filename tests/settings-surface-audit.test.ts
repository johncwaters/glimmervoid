import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserConfig, Config, ConfigUpdate } from '../shared/contracts/config.ts';
import { normalizeLegacyConfigNumbers } from '../shared/contracts/config-numbers-core.ts';
import { SETTINGS_MAP } from '../public/settings-map.ts';
import type { SettingsSection, SettingsSetting } from '../public/settings-map.ts';
import { SETTINGS_RANGES } from '../shared/settings-ranges.ts';
import { includesRepositoryRoot, projectSelectionChoices } from '../public/settings-projects-core.ts';
import {
  collectDirtyBlocks, hydrateFromSettings, parsePosthogProjectSelection, rtkInstallStatusText,
  secretEnvironmentSource, validateLocally, visionsActivityLimitText,
} from '../public/settings-view-core.ts';

const INTEGER_FIELDS = [
  ['replay-buffer', 'replayBufferKB'],
  ['visions-quiet-delay', 'visions.dispatch.quietMs'],
  ['visions-cooldown', 'visions.dispatch.cooldownMs'],
  ['visions-max-per-hour', 'visions.dispatch.maxPerHour'],
  ['visions-activity-max-per-hour', 'visions.dispatch.activityMaxPerHour'],
  ['visions-dispatch-timeout', 'visions.dispatch.dispatchTimeoutSeconds'],
  ['visions-intent-thread-ttl', 'visions.intent.threadTtlMs'],
  ['posthog-max-investigations', 'posthog.maxConcurrentInvestigations'],
  ['posthog-min-users', 'posthog.minUsersToInvestigate'],
  ['posthog-escalation', 'posthog.userEscalationThreshold'],
  ['posthog-traffic-min-users', 'posthog.trafficSpikeMinUsers'],
  ['posthog-traffic-baseline', 'posthog.trafficSpikeBaselineDays'],
] as const;

function payloadAtPath(path: string, value: unknown): Record<string, unknown> {
  return path.split('.').reverse().reduce<Record<string, unknown>>((block, key, index) => ({ [key]: index === 0 ? value : block }), {});
}

function settingSection(id: string): { setting: SettingsSetting; section: SettingsSection } {
  const section = SETTINGS_MAP.find((entry) => entry.settings.some((setting) => setting.id === id));
  assert.ok(section);
  const setting: SettingsSetting | undefined = section.settings.find((entry) => entry.id === id);
  assert.ok(setting);
  return { section: { ...section, settings: [setting] }, setting };
}

for (const [id, path] of INTEGER_FIELDS) {
  test(`${id} rejects fractions at browser, save and local boundaries`, () => {
    const { section, setting } = settingSection(id);
    const fraction = Number(setting.defaultValue) + 0.5;
    const payload = payloadAtPath(path, fraction);
    assert.equal(BrowserConfig.safeParse(payload).success, false);
    assert.equal(ConfigUpdate.safeParse(payload).success, false);
    assert.ok(validateLocally([section], { [path]: fraction }, SETTINGS_RANGES)[id]);
    assert.equal(ConfigUpdate.safeParse(payloadAtPath(path, Number.MAX_SAFE_INTEGER + 1)).success, false);
    assert.ok(validateLocally([section], { [path]: Number.MAX_SAFE_INTEGER + 1 }, SETTINGS_RANGES)[id]);
    assert.equal(ConfigUpdate.safeParse(payloadAtPath(path, setting.defaultValue)).success, true);
  });
}

test('replay buffer bounds agree across file, browser, save and local validation', () => {
  const { section } = settingSection('replay-buffer');
  for (const value of [0, 63, 64.5, 16385]) {
    const payload = { projects: [], replayBufferKB: value };
    for (const schema of [Config, BrowserConfig, ConfigUpdate]) {
      const candidate = schema === ConfigUpdate ? { replayBufferKB: value } : payload;
      assert.equal(schema.safeParse(candidate).success, false);
    }
    assert.ok(validateLocally([section], { replayBufferKB: value }, SETTINGS_RANGES)['replay-buffer']);
  }
  for (const value of [64, 16384]) assert.equal(Config.safeParse({ projects: [], replayBufferKB: value }).success, true);
});

for (const id of ['posthog-interval', 'posthog-investigation-timeout', 'posthog-fix-timeout', 'posthog-traffic-multiplier', 'posthog-traffic-cooldown']) {
  test(`${id} accepts and serializes a fractional value unchanged`, () => {
    const { section, setting } = settingSection(id);
    const original = hydrateFromSettings([section], {});
    const value = Number(setting.defaultValue) + 0.5;
    const edited = { ...original, [setting.path]: String(value) };
    assert.equal(setting.integer, false);
    assert.equal(setting.step, 'any');
    assert.deepEqual(validateLocally([section], edited, SETTINGS_RANGES), {});
    const serialized = collectDirtyBlocks([section], original, edited);
    assert.deepEqual(serialized, payloadAtPath(setting.path, value));
    assert.equal(ConfigUpdate.safeParse(serialized).success, true);
  });
}

test('legacy numeric migration preserves count comparisons, floors truncated quantities and leaves the input intact', () => {
  const legacy = {
    projects: [], replayBufferKB: 0.5,
    visions: { dispatch: { quietMs: 20.9, cooldownMs: 30.8, maxPerHour: 6.9, activityMaxPerHour: 2.9, dispatchTimeoutSeconds: 0.5 }, intent: { threadTtlMs: 80.9 }, future: true },
    posthog: { maxConcurrentInvestigations: 2.5, minUsersToInvestigate: 2.5, userEscalationThreshold: 2.5, trafficSpikeMinUsers: 2.5, trafficSpikeBaselineDays: 2.5, intervalMinutes: 2.5 },
  };
  const snapshot = structuredClone(legacy);
  const migrated = normalizeLegacyConfigNumbers(legacy);
  assert.deepEqual(migrated, {
    projects: [], replayBufferKB: 64,
    visions: { dispatch: { quietMs: 20, cooldownMs: 30, maxPerHour: 6, activityMaxPerHour: 2, dispatchTimeoutSeconds: 1 }, intent: { threadTtlMs: 80 }, future: true },
    posthog: { maxConcurrentInvestigations: 3, minUsersToInvestigate: 3, userEscalationThreshold: 3, trafficSpikeMinUsers: 3, trafficSpikeBaselineDays: 2, intervalMinutes: 2.5 },
  });
  assert.deepEqual(legacy, snapshot);
  assert.deepEqual(normalizeLegacyConfigNumbers(migrated), migrated);
  assert.deepEqual(normalizeLegacyConfigNumbers({ visions: null, posthog: null }), { visions: null, posthog: null });
});

test('PostHog projects share one parser for validation and serialization, including none and unsafe ids', () => {
  const { section, setting } = settingSection('posthog-projects');
  for (const invalid of ['1,', '1,,2', ',1', '0', '-1', '1.5', '9007199254740992']) {
    assert.equal(parsePosthogProjectSelection(invalid), null);
    assert.ok(validateLocally([section], { [setting.path]: invalid }, SETTINGS_RANGES)[setting.id]);
  }
  for (const [text, expected] of [['1, 2', [1, 2]], ['none', []], ['ALL', 'all'], ['', 'all'], ['9007199254740991', [Number.MAX_SAFE_INTEGER]]] as const) {
    const original = hydrateFromSettings([section], { posthog: { projects: [9] } });
    const edited = { ...original, [setting.path]: text };
    assert.deepEqual(parsePosthogProjectSelection(text), expected);
    assert.deepEqual(validateLocally([section], edited, SETTINGS_RANGES), {});
    assert.deepEqual(collectDirtyBlocks([section], original, edited), { posthog: { projects: expected } });
  }
  assert.equal(hydrateFromSettings([section], { posthog: { projects: [] } })[setting.path], 'none');
});

test('environment secret ownership excludes replacement edits and sibling saves carry no secret metadata', () => {
  for (const [id, path, environmentVariable] of [
    ['telegram-bot-token', 'telegram.botToken', 'GLIMMERVOID_TELEGRAM_BOT_TOKEN'],
    ['posthog-api-key', 'posthog.apiKey', 'GLIMMERVOID_POSTHOG_API_KEY'],
  ]) {
    const { setting } = settingSection(id);
    const payload = { ...payloadAtPath(`${path}Configured`, true), secretSources: { [path]: environmentVariable } };
    const original = hydrateFromSettings(SETTINGS_MAP, payload);
    const edited = { ...original, [path]: 'discarded-replacement' };
    assert.equal(secretEnvironmentSource(setting, payload), environmentVariable);
    assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {});
    edited[path.startsWith('telegram') ? 'telegram.chatId' : 'posthog.enabled'] = path.startsWith('telegram') ? '123' : true;
    const saved = collectDirtyBlocks(SETTINGS_MAP, original, edited);
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

test('activity limit reports the reserved slot and zero when only one overall slot exists', () => {
  assert.equal(visionsActivityLimitText({ 'visions.dispatch.maxPerHour': 6, 'visions.dispatch.activityMaxPerHour': 20 }), 'Effective activity limit: 5 per hour. One slot is reserved for edit reviews.');
  assert.match(visionsActivityLimitText({ 'visions.dispatch.maxPerHour': 1, 'visions.dispatch.activityMaxPerHour': 2 }), /limit: 0 per hour/);
  assert.equal(visionsActivityLimitText({ 'visions.dispatch.maxPerHour': 'invalid' }), '');
});

test('RTK installation copy exposes platform refusal and conditional cooldown retry', () => {
  assert.match(rtkInstallStatusText({ rtkInstallSupported: false }), /unavailable on this server platform/);
  assert.match(rtkInstallStatusText({ rtkInstallSupported: true, rtkInstall: { status: 'failed', reason: 'fetch failed' } }), /fetch failed.*ten-minute failure cooldown/);
  assert.match(rtkInstallStatusText({ rtkInstall: { status: 'installing' } }), /installing.*now/);
  assert.match(rtkInstallStatusText({}), /supported server platforms.*eligibility/);
});
