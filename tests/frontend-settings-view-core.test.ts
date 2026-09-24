import test from 'node:test';
import assert from 'node:assert/strict';

import type { SettingsSection } from '../public/settings-map.ts';
import { SETTINGS_RANGES } from '../shared/settings-ranges.ts';

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

test('the legacy memory retention alias moves with retainDays', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { memory: { retainDays: 90, memoryRetainDays: 120 } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  assert.equal(original['memory.retainDays'], 120);
  edited['memory.retainDays'] = 180;
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    memory: { retainDays: 180, memoryRetainDays: 180 },
  });
});

test('an unrendered stored project id survives a projects-control save', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = {
    projectChoices: [{ id: 'shown', name: 'Shown' }],
    visions: { enabled: true, projects: ['shown', 'missing'] },
  };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['visions.projects'] = [];
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    visions: { enabled: true, projects: ['missing'] },
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
    section('lanes-mill', 'lanes'),
    section('project-one', 'projects'),
  ]);
  assert.deepEqual(ordered.map((section) => section.id), [
    'lanes-mill', 'lanes-unattended', 'project-one',
  ]);
});

test('danger toggles require an exact confirmation only when turning on', async () => {
  const { decideDangerToggle } = await load();
  assert.equal(decideDangerToggle(false, true, 'visions', 'VISIONS'), false);
  assert.equal(decideDangerToggle(false, true, 'VISIONS', 'VISIONS'), true);
  assert.equal(decideDangerToggle(true, false, '', 'VISIONS'), false);
});

test('project sections derive read-only records and carry no pack control', async () => {
  const { buildProjectSections } = await load();
  const sections = buildProjectSections(
    [{ id: 'p1', name: 'Glimmervoid', agent: 'codex', permissionMode: 'default' }],
  );
  assert.equal(sections[0].id, 'project-p1');
  assert.equal(sections[0].settings.some((setting) => setting.control === 'pack-toggles'), false);
  assert.equal(sections[0].settings[0].value, 'codex');
  assert.equal(sections[0].settings[2].fileOnly, true);
});

test('two card records on one Mill project use the checkout name and list both cards', async () => {
  const { buildProjectSections, enrichProjectsById } = await load();
  const groupedProjects = [{ id: 'p1', name: 'glimmervoid' }];
  const cardRecords = [
    { id: 'p1', name: 'glimmervoid', path: '/repos/glimmervoid', agent: 'codex' },
    { id: 'p2', name: 'glimmervoid (2)', path: '/repos/glimmervoid', agent: 'claude-code' },
  ];
  const projects = enrichProjectsById(groupedProjects, cardRecords);
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
