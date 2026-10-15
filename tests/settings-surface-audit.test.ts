import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserConfig, Config, ConfigUpdate } from '../shared/contracts/config.ts';
import { normalizeLegacyConfigNumbers } from '../shared/contracts/config-numbers-core.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import type { SettingsSection, SettingsSetting } from '../shared/settings/registry.ts';
import { SETTINGS_INDEX, parsePosthogProjectSelection, wireValue } from '../shared/settings/registry-core.ts';
import { includesRepositoryRoot, projectSelectionChoices } from '../public/settings/settings-projects-core.ts';
import {
  collectDirtyBlocks, hydrateFromSettings, numberDraftError, numberFromDraft, rtkInstallStatusText, secretEnvironmentSource, validateLocally,
} from '../public/settings/settings-view-core.ts';

const WHOLE_NUMBER_FIELDS = [
  ['file-replay-buffer', 'replayBufferKB'],
  ['file-visions-quiet-delay', 'visions.dispatch.quietMs'],
  ['file-visions-cooldown', 'visions.dispatch.cooldownMs'],
  ['visions-max-per-hour', 'visions.dispatch.maxPerHour'],
  ['file-visions-activity-max-per-hour', 'visions.dispatch.activityMaxPerHour'],
  ['file-visions-dispatch-timeout', 'visions.dispatch.dispatchTimeoutSeconds'],
  ['file-visions-intent-thread-ttl', 'visions.intent.threadTtlMs'],
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

test('replay buffer bounds agree across file, browser and save validation', () => {
  for (const value of [0, 63, 64.5, 16385]) {
    const payload = { projects: [], replayBufferKB: value };
    for (const schema of [Config, BrowserConfig, ConfigUpdate]) {
      const candidate = schema === ConfigUpdate ? { replayBufferKB: value } : payload;
      assert.equal(schema.safeParse(candidate).success, false);
    }
  }
  for (const value of [64, 16384]) assert.equal(Config.safeParse({ projects: [], replayBufferKB: value }).success, true);
  assert.deepEqual(registrySetting('file-replay-buffer').range, { min: 64, max: 16384 });
});

test('posthog-interval accepts and serializes a fractional value unchanged', () => {
  const { section, setting } = editableSection('posthog-interval');
  const original = hydrateFromSettings([section], {});
  const value = Number(setting.defaultValue) + 0.5;
  const edited = { ...original, [setting.path]: String(value) };
  assert.equal(setting.integer, false);
  assert.equal(setting.step, 'any');
  assert.deepEqual(validateLocally([section], edited), {});
  const serialized = collectDirtyBlocks([section], original, edited);
  assert.deepEqual(serialized, payloadAtPath(setting.path, value));
  assert.equal(ConfigUpdate.safeParse(serialized).success, true);
});

test('a duration typed in its display unit stores the schema unit as a whole number the file accepts', () => {
  for (const [id, draft, stored] of [
    ['file-visions-quiet-delay', '45', 45000],
    ['file-visions-cooldown', '2', 120000],
    ['file-visions-intent-thread-ttl', '7', 604800000],
    ['file-posthog-fix-timeout', '20', 1200],
  ] as const) {
    const setting = registrySetting(id);
    assert.equal(numberDraftError(setting, draft), null, id);
    const value = wireValue(setting, numberFromDraft(setting, draft));
    assert.equal(value, stored, id);
    assert.equal(ConfigUpdate.safeParse(payloadAtPath(setting.path, value)).success, true, id);
    assert.equal(Config.safeParse({ projects: [], ...payloadAtPath(setting.path, value) }).success, true, id);
  }
  const quiet = registrySetting('file-visions-quiet-delay');
  assert.ok(numberDraftError(quiet, '0.0001'));
  assert.equal(ConfigUpdate.safeParse(payloadAtPath(quiet.path, 0.1)).success, false);
});

for (const id of ['file-posthog-investigation-timeout', 'file-posthog-fix-timeout', 'file-posthog-traffic-multiplier', 'file-posthog-traffic-cooldown']) {
  test(`${id} stays fractional in config.json`, () => {
    const setting = registrySetting(id);
    assert.equal(setting.integer, false);
    assert.equal(setting.step, 'any');
    assert.equal(ConfigUpdate.safeParse(payloadAtPath(setting.path, Number(setting.defaultValue) + 0.5)).success, true);
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

test('PostHog projects share one parser for the CLI text form and the dashboard list form, including none and unsafe ids', () => {
  const { section, setting } = editableSection('posthog-projects');
  for (const invalid of ['1,', '1,,2', ',1', '0', '-1', '1.5', '9007199254740992']) {
    assert.equal(parsePosthogProjectSelection(invalid), null);
  }
  for (const [text, expected] of [['1, 2', [1, 2]], ['none', []], ['ALL', 'all'], ['', 'all'], ['9007199254740991', [Number.MAX_SAFE_INTEGER]]] as const) {
    assert.deepEqual(parsePosthogProjectSelection(text), expected);
  }
  for (const invalid of [['0'], ['-1'], ['1.5'], ['9007199254740992'], ['abc'], ['1', 'none']]) {
    assert.equal(wireValue(setting, invalid), null);
    assert.ok(validateLocally([section], { [setting.path]: invalid })[setting.id]);
  }
  for (const [list, expected] of [[['1', '2'], [1, 2]], [[], 'all'], [['none'], []], [['9007199254740991'], [Number.MAX_SAFE_INTEGER]]] as const) {
    const original = hydrateFromSettings([section], { posthog: { projects: [9] } });
    const edited = { ...original, [setting.path]: [...list] };
    assert.deepEqual(wireValue(setting, [...list]), expected);
    assert.deepEqual(validateLocally([section], edited), {});
    assert.deepEqual(collectDirtyBlocks([section], original, edited), { posthog: { projects: expected } });
  }
  assert.deepEqual(hydrateFromSettings([section], { posthog: { projects: [] } })[setting.path], ['none']);
  assert.deepEqual(hydrateFromSettings([section], { posthog: { projects: 'all' } })[setting.path], []);
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

test('RTK installation copy exposes platform refusal and conditional cooldown retry', () => {
  assert.match(rtkInstallStatusText({ rtkInstallSupported: false }), /unavailable on this server platform/);
  assert.match(rtkInstallStatusText({ rtkInstallSupported: true, rtkInstall: { status: 'failed', reason: 'fetch failed' } }), /fetch failed.*ten-minute failure cooldown/);
  assert.match(rtkInstallStatusText({ rtkInstall: { status: 'installing' } }), /installing.*now/);
  assert.match(rtkInstallStatusText({}), /supported server platforms.*eligibility/);
});
