import test from 'node:test';
import assert from 'node:assert/strict';

import type { SettingsSection } from '../public/settings-map.ts';
import { SETTINGS_RANGES } from '../shared/settings-ranges.ts';
import { SETTINGS_MOVED_SETTINGS, SETTINGS_SECTION_ALIASES } from '../public/settings-map.ts';

async function load() {
  const [{ SETTINGS_MAP }, core] = await Promise.all([
    import('../public/settings-map.ts'),
    import('../public/settings-view-core.ts'),
  ]);
  return { SETTINGS_MAP, ...core };
}

test('an untouched lane writes nothing', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { visions: { enabled: false } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {});
});

test('one dirty lane preserves unknown stored keys in its block', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { visions: { enabled: false, futureKey: 7 }, posthog: { enabled: false } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['visions.enabled'] = true;
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    visions: { enabled: true, futureKey: 7 },
  });
});

test('a dirty Team review section saves its trimmed org and team with the toggle', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { teamReview: { enabled: false, org: '', team: '' } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['teamReview.enabled'] = true;
  edited['teamReview.org'] = ' PostHog ';
  edited['teamReview.team'] = 'product-engineering';
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    teamReview: { enabled: true, org: 'PostHog', team: 'product-engineering' },
  });
});

test('an unavailable stored project id can be cleared from a projects-control save', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = {
    projectChoices: [{ id: 'shown', name: 'Shown' }],
    visions: { enabled: true, projects: ['shown', 'missing'] },
  };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['visions.projects'] = [];
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    visions: { enabled: true, projects: [] },
  });
});

test('a settings refresh preserves a dirty lane and updates a clean lane', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, rehydratePreservingDirtySections } = await load();
  const currentPayload = { visions: { enabled: false }, posthog: { enabled: false } };
  const currentOriginal = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  const currentEdited = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  currentEdited['visions.enabled'] = true;
  const freshPayload = { visions: { enabled: false }, posthog: { enabled: true } };
  const { original, edited } = rehydratePreservingDirtySections(
    SETTINGS_MAP, freshPayload, currentOriginal, currentEdited,
  );
  assert.equal(edited['visions.enabled'], true);
  assert.equal(edited['posthog.enabled'], true);
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), { visions: { enabled: true } });
});

test('zero and negative budgets validate and serialize as no ceiling', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, validateLocally } = await load();
  const usageSection = SETTINGS_MAP.find((section) => section.id === 'machine-usage');
  assert.ok(usageSection, 'the usage section is part of the shipped map');
  const payload = { usage: { budget: { dailyUsd: 20, monthlyUsd: 100 } } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['usage.budget.dailyUsd'] = -1;
  edited['usage.budget.monthlyUsd'] = 0;
  assert.deepEqual(validateLocally([usageSection], edited, SETTINGS_RANGES), {});
  assert.deepEqual(collectDirtyBlocks([usageSection], original, edited), {
    usage: { budget: { dailyUsd: null, monthlyUsd: null } },
  });
});

test('a successful save rehydrates its lane and preserves another dirty lane', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, rehydratePreservingDirtySections } = await load();
  const currentPayload = { visions: { projects: [] }, posthog: { enabled: false } };
  const currentOriginal = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  const currentEdited = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  currentEdited['visions.projects'] = ['project-1'];
  currentEdited['posthog.enabled'] = true;
  const freshPayload = { visions: { projects: ['project-1'] }, posthog: { enabled: false } };
  const { original, edited } = rehydratePreservingDirtySections(
    SETTINGS_MAP, freshPayload, currentOriginal, currentEdited,
    { rehydrateSectionIds: ['lanes-visions'] },
  );
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), { posthog: { enabled: true } });
});

test('search uses exact tokens and weighted fields', async () => {
  const { scoreSettingsSearch } = await load();
  const map = [
    { id: 'feature', level: 'machine', title: 'Feature flags', settings: [
      { id: 'feature-flag', path: 'feature.flag', title: 'Feature flag', description: 'Controls a switch.', keywords: ['toggle', 'option'] },
    ] },
    { id: 'thermal', level: 'machine', title: 'Heat controls', settings: [
      { id: 'temperature', path: 'thermal.temperature', title: 'Temperature', description: 'Controls heat output.', keywords: ['thermal', 'warmth'] },
      { id: 'keyword-only', path: 'thermal.cooling', title: 'Cooling', description: 'Controls airflow.', keywords: ['heat', 'thermal'] },
    ] },
    { id: 'other', level: 'machine', title: 'Other', settings: [
      { id: 'title-match', path: 'other.heatLimit', title: 'Heat limit', description: 'A ceiling.', keywords: ['temperature', 'ceiling'] },
    ] },
  ];
  const results = scoreSettingsSearch(map, 'heat');
  assert.equal(results.some((entry) => entry.setting.id === 'feature-flag'), false);
  assert.equal(results.some((entry) => entry.setting.id === 'keyword-only'), true);
  assert.equal(results[0].setting.id, 'title-match');
  assert.ok(results.findIndex((entry) => entry.setting.id === 'temperature') > 0);
  assert.deepEqual(scoreSettingsSearch(map, ''), []);
});

test('settings hashes resolve aliases and canonical anchors', async () => {
  const { SETTINGS_MAP, parseSettingsHash } = await load();
  const aliases = { general: 'machine-general' };
  assert.deepEqual(parseSettingsHash('#settings/general/auto-resume', SETTINGS_MAP, aliases), {
    sectionId: 'machine-general', settingId: 'auto-resume', hash: '#settings/machine-general/auto-resume',
  });
  assert.equal(parseSettingsHash('#settings/missing', SETTINGS_MAP, aliases), null);
  assert.equal(parseSettingsHash('#settings/machine-general/missing', SETTINGS_MAP, aliases), null);
});

test('unattended actions sort last within the map', async () => {
  const { orderSections } = await load();
  const section = (id: string, level: string): SettingsSection => ({ id, level, title: id, settings: [] });
  const ordered = orderSections([
    section('lanes-unattended', 'lanes'),
    section('lanes-ingest', 'lanes'),
    section('project-one', 'projects'),
  ]);
  assert.deepEqual(ordered.map((section) => section.id), [
    'lanes-ingest', 'lanes-unattended', 'project-one',
  ]);
});

test('a danger warning shows only while its toggle is on', async () => {
  const { shouldShowDangerWarning } = await load();
  const dangerSetting = { danger: true, warning: 'Lets agents run unattended.' };
  assert.equal(shouldShowDangerWarning(dangerSetting, true), true);
  assert.equal(shouldShowDangerWarning(dangerSetting, false), false);
  assert.equal(shouldShowDangerWarning(dangerSetting, undefined), false);
  assert.equal(shouldShowDangerWarning({ warning: 'Plain note.' }, true), false);
});

test('project sections derive read-only records', async () => {
  const { buildProjectSections } = await load();
  const sections = buildProjectSections(
    [{ id: 'p1', name: 'Glimmervoid', agent: 'codex', permissionMode: 'default' }],
  );
  assert.equal(sections[0].id, 'project-p1');
  assert.equal(sections[0].settings[0].value, 'codex');
  assert.equal(sections[0].settings[2].fileOnly, true);
});

test('two configured records on one checkout share a section named for it that lists both cards', async () => {
  const { buildProjectSections, enrichProjectsById, firstProjectPerPath } = await load();
  const configuredProjects = [
    { id: 'p1', name: 'glimmervoid', path: '/repos/glimmervoid' },
    { id: 'p2', name: 'glimmervoid (2)', path: '/repos/glimmervoid' },
    { id: 'p3', name: 'no path yet' },
  ];
  const cardRecords = [
    { id: 'p1', name: 'glimmervoid', path: '/repos/glimmervoid', agent: 'codex' },
    { id: 'p2', name: 'glimmervoid (2)', path: '/repos/glimmervoid', agent: 'claude-code' },
  ];
  assert.deepEqual(firstProjectPerPath(configuredProjects).map((project) => project.id), ['p1', 'p3']);
  const projects = enrichProjectsById(firstProjectPerPath(configuredProjects).slice(0, 1), cardRecords);
  const sections = buildProjectSections(projects);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'project-p1');
  assert.equal(sections[0].title, 'glimmervoid');
  assert.equal(sections[0].caption, 'Cards: glimmervoid, glimmervoid (2)');
  assert.equal(sections[0].settings[0].value, 'codex');
});

test('a stored secret hydrates as a mask and an untouched section sends nothing', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, STORED_SECRET_MASK } = await load();
  const payload = { telegram: { chatId: '123', botTokenConfigured: true }, posthog: { enabled: true, apiKeyConfigured: false } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);

  assert.equal(original['telegram.botToken'], STORED_SECRET_MASK);
  assert.equal(original['posthog.apiKey'], '', 'nothing stored means an empty field');
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {});
});

test('a sibling edit never carries the mask or the presence flag to the server', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { telegram: { chatId: '123', botTokenConfigured: true } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['telegram.chatId'] = '456';

  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), { telegram: { chatId: '456' } });
});

test('a typed secret is sent and an emptied one is sent as a clear', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { telegram: { chatId: '123', botTokenConfigured: true } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const typed = hydrateFromSettings(SETTINGS_MAP, payload);
  typed['telegram.botToken'] = 'fresh-tok';
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, typed), { telegram: { chatId: '123', botToken: 'fresh-tok' } });

  const emptied = hydrateFromSettings(SETTINGS_MAP, payload);
  emptied['telegram.botToken'] = '';
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, emptied), { telegram: { chatId: '123', botToken: '' } });
});

test('animal aliases and existing Appearance toggle links resolve to the new section', async () => {
  const { SETTINGS_MAP, parseSettingsHash } = await load();
  for (const sectionId of ['animals', 'flying-animals', 'browser-flying-animals', 'browser-appearance']) {
    assert.deepEqual(parseSettingsHash(`#settings/${sectionId}/flying-animals`, SETTINGS_MAP, SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS), {
      sectionId: 'browser-flying-animals', settingId: 'flying-animals', hash: '#settings/browser-flying-animals/flying-animals',
    });
  }
});

test('a moved setting redirects only through the moved-settings data it is given', async () => {
  const { SETTINGS_MAP, parseSettingsHash } = await load();
  assert.equal(parseSettingsHash('#settings/browser-appearance/flying-animals', SETTINGS_MAP), null);
  const movedSettings = { 'machine-terminal': { 'auto-resume': 'machine-general' } };
  assert.deepEqual(parseSettingsHash('#settings/machine-terminal/auto-resume', SETTINGS_MAP, {}, movedSettings), {
    sectionId: 'machine-general', settingId: 'auto-resume', hash: '#settings/machine-general/auto-resume',
  });
  assert.deepEqual(parseSettingsHash('#settings/machine-terminal', SETTINGS_MAP, {}, movedSettings)?.sectionId, 'machine-terminal');
});

test('animal controls are searchable, range validated and excluded from machine save payloads', async () => {
  const { SETTINGS_MAP, scoreSettingsSearch, hydrateFromSettings, collectDirtyBlocks, validateLocally } = await load();
  const animals = SETTINGS_MAP.find((section) => section.id === 'browser-flying-animals');
  assert.ok(animals);
  for (const query of ['frequency', 'speed', 'size', 'mobile']) {
    assert.ok(scoreSettingsSearch(SETTINGS_MAP, query).some((entry) => entry.section.id === animals.id));
  }
  const original = hydrateFromSettings([animals], {});
  const edited = { ...original, 'pref:flyingAnimalsScale': 3, 'pref:flyingAnimalsOnPhone': false };
  assert.deepEqual(collectDirtyBlocks([animals], original, edited), {});
  assert.deepEqual(Object.keys(validateLocally([animals], edited, SETTINGS_RANGES)), ['animals-scale']);
  assert.deepEqual(validateLocally([animals], original, SETTINGS_RANGES), {});
});

test('a reversed flying animals minimum and maximum pair reports an error on both fields', async () => {
  const { SETTINGS_MAP, hydrateFromSettings, validateLocally, pairedSettingOf } = await load();
  const animals = SETTINGS_MAP.find((section) => section.id === 'browser-flying-animals');
  assert.ok(animals);
  const original = hydrateFromSettings([animals], {});
  const reversedGap = { ...original, 'pref:flyingAnimalsMinGapSeconds': 50, 'pref:flyingAnimalsMaxGapSeconds': 40 };
  assert.deepEqual(validateLocally([animals], reversedGap, SETTINGS_RANGES), {
    'animals-min-gap': 'Minimum must not exceed the maximum (40).',
    'animals-max-gap': 'Maximum must not be below the minimum (50).',
  });
  const reversedDuration = { ...original, 'pref:flyingAnimalsMinDurationSeconds': 12, 'pref:flyingAnimalsMaxDurationSeconds': 8 };
  assert.deepEqual(Object.keys(validateLocally([animals], reversedDuration, SETTINGS_RANGES)).sort(), ['animals-max-duration', 'animals-min-duration']);
  const equalGap = { ...original, 'pref:flyingAnimalsMinGapSeconds': 30, 'pref:flyingAnimalsMaxGapSeconds': 30 };
  assert.deepEqual(validateLocally([animals], equalGap, SETTINGS_RANGES), {});
  const outOfRangeAndReversed = { ...original, 'pref:flyingAnimalsMinGapSeconds': 9999, 'pref:flyingAnimalsMaxGapSeconds': 40 };
  assert.deepEqual(Object.keys(validateLocally([animals], outOfRangeAndReversed, SETTINGS_RANGES)), ['animals-min-gap']);
  const settingById = (id: string) => animals.settings.find((setting) => setting.id === id);
  const minimumGap = settingById('animals-min-gap');
  const maximumGap = settingById('animals-max-gap');
  const scale = settingById('animals-scale');
  assert.ok(minimumGap && maximumGap && scale);
  assert.equal(pairedSettingOf([animals], minimumGap)?.id, 'animals-max-gap');
  assert.equal(pairedSettingOf([animals], maximumGap)?.id, 'animals-min-gap');
  assert.equal(pairedSettingOf([animals], scale), undefined);
});
