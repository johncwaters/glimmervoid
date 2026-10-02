import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { DASHBOARD_SETTING_PATHS } from '../server/control-handlers.ts';
import { INGEST_SPEC } from '../server/core/settings-block-core.ts';
import * as settingsRanges from '../shared/settings-ranges.ts';
import type { SettingsBlockSpec } from '../server/core/settings-block-core.ts';
import type { SettingsSetting } from '../public/settings-map.ts';

const loadMap = () => import('../public/settings-map.ts');

const DASHBOARD_SETTING_PATH_SET = new Set(DASHBOARD_SETTING_PATHS);
const OPTION_CATALOGS = new Set(['sounds', 'themes']);

function specAllows(spec: SettingsBlockSpec, parts: readonly string[]): boolean {
  if (parts.length === 0) return true;
  const [key, ...remaining] = parts;
  if (spec.booleans.includes(key) && remaining.length === 0) return true;
  const block = spec.blocks[key];
  if (!block) return false;
  return specAllows(block, remaining);
}

const DEFAULT_CONFIG_RECORD: Record<string, unknown> = DEFAULT_CONFIG;
const BLOCK_SPECS_BY_KEY: Record<string, SettingsBlockSpec> = { ingest: INGEST_SPEC };

function walkPath(root: unknown, parts: readonly string[]): boolean {
  let cursor = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return true;
}

function pathIsKnown(path: string): boolean {
  if (path.startsWith('pref:')) return true;
  const [topLevel, ...remaining] = path.split('.');
  if (Object.hasOwn(DEFAULT_CONFIG_RECORD, topLevel)) {
    return walkPath(DEFAULT_CONFIG_RECORD[topLevel], remaining);
  }
  if (DASHBOARD_SETTING_PATH_SET.has(path)) return true;
  const blockSpec = BLOCK_SPECS_BY_KEY[topLevel];
  return !!blockSpec && specAllows(blockSpec, remaining);
}

function pathExistsInDefaultConfig(path: string): boolean {
  return walkPath(DEFAULT_CONFIG_RECORD, path.split('.'));
}

test('the map has unique ids, known paths, range-backed numbers and searchable keywords', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const sectionIds = new Set();
  const settingIds = new Set();
  for (const section of SETTINGS_MAP) {
    assert.equal(sectionIds.has(section.id), false, `duplicate section id ${section.id}`);
    sectionIds.add(section.id);
    const sectionSettings: SettingsSetting[] = section.settings;
    for (const setting of sectionSettings) {
      assert.equal(settingIds.has(setting.id), false, `duplicate setting id ${setting.id}`);
      settingIds.add(setting.id);
      assert.equal(pathIsKnown(setting.path), true, `unknown path ${setting.path}`);
      assert.ok(Array.isArray(setting.keywords) && setting.keywords.length >= 2, `${setting.id} needs keywords`);
      if (setting.control === 'number') assert.ok(setting.range && Object.hasOwn(settingsRanges, setting.range), `${setting.id} needs a shared range`);
      if (setting.optionsFrom) assert.equal(OPTION_CATALOGS.has(setting.optionsFrom), true, `${setting.id} needs a known option catalog`);
    }
  }
});

test('the removed automatic PR controls are absent from settings', async () => {
  const { SETTINGS_MAP } = await loadMap();
  assert.equal(SETTINGS_MAP.some((section) => section.id === 'lanes-pr-review'), false);
  assert.equal(SETTINGS_MAP.some((section) => section.settings.some((setting) => setting.id.startsWith('pr-review-'))), false);
});

test('the map never exposes remote and ingest keys stay inside the dashboard allow-list', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const settings = SETTINGS_MAP.flatMap<SettingsSetting>((section) => section.settings);
  assert.equal(settings.some((setting) => setting.path === 'remote' || setting.path.startsWith('remote.')), false);
  for (const setting of settings.filter((entry) => entry.path.startsWith('ingest.'))) {
    assert.equal(specAllows(INGEST_SPEC, setting.path.split('.').slice(1)), true, setting.path);
  }
  assert.equal(pathIsKnown('visions.dispatch.quietMS'), false);
});

test('aliases resolve without shadowing canonical section ids', async () => {
  const { SETTINGS_MAP, SETTINGS_SECTION_ALIASES } = await loadMap();
  const sectionIds = new Set(SETTINGS_MAP.map((section) => section.id));
  for (const [alias, sectionId] of Object.entries(SETTINGS_SECTION_ALIASES)) {
    assert.equal(sectionIds.has(alias), false, `${alias} shadows a section id`);
    assert.equal(sectionIds.has(sectionId), true, `${alias} resolves to missing ${sectionId}`);
  }
});

test('the machine Updates section owns its alias, channel, status rows, actions and moved toggle', async () => {
  const { SETTINGS_MAP, SETTINGS_SECTION_ALIASES } = await loadMap();
  const updates = SETTINGS_MAP.find((section) => section.id === 'machine-updates');
  assert.ok(updates);
  assert.equal(updates.level, 'machine');
  assert.equal(SETTINGS_SECTION_ALIASES.updates, 'machine-updates');
  const updateSettings: SettingsSetting[] = updates.settings;
  assert.deepEqual(updateSettings.map((setting) => setting.id), [
    'update-summary',
    'update-actions',
    'update-installed',
    'update-latest',
    'update-last-checked',
    'update-channel',
    'check-updates',
  ]);
  assert.deepEqual(updateSettings.find((setting) => setting.id === 'update-channel')?.options, [
    { value: 'release', label: 'Release' },
    { value: 'main', label: 'Main' },
  ]);
  const toggleOwners = SETTINGS_MAP.filter((section) => section.settings.some((setting) => setting.id === 'check-updates'));
  assert.deepEqual(toggleOwners.map((section) => section.id), ['machine-updates']);
});

test('the update deep link the banner and the Radar ops row share resolves to a real section and setting', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const { UPDATES_ACTIONS_SETTING_ID, UPDATES_SECTION_ID } = await import('../public/radar-core.ts');
  const section = SETTINGS_MAP.find((entry) => entry.id === UPDATES_SECTION_ID);
  assert.ok(section, 'the deep link names a missing section');
  assert.ok(
    section.settings.some((setting: SettingsSetting) => setting.id === UPDATES_ACTIONS_SETTING_ID),
    'the deep link names a missing setting',
  );
});

test('file-only paths exist in defaults and never enter a dirty payload', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const { collectDirtyBlocks, hydrateFromSettings } = await import('../public/settings-view-core.ts');
  const allSettings = SETTINGS_MAP.flatMap<SettingsSetting>((section) => section.settings);
  const fileOnlySettings = allSettings.filter((setting) => setting.fileOnly);
  const original = hydrateFromSettings(SETTINGS_MAP, DEFAULT_CONFIG);
  const edited = hydrateFromSettings(SETTINGS_MAP, DEFAULT_CONFIG);
  for (const setting of fileOnlySettings) {
    assert.equal(pathExistsInDefaultConfig(setting.path), true, setting.path);
    edited[setting.path] = 'changed';
  }
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {});
});

test('the agent API toggle is dashboard-writable and the custom agents row stays file-only', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const settings = SETTINGS_MAP.flatMap<SettingsSetting>((section) => section.settings);

  const agentApi = settings.find((setting) => setting.path === 'agentApi.enabled');
  assert.ok(agentApi, 'the map exposes agentApi.enabled');
  assert.equal(agentApi.control, 'toggle');
  assert.equal(agentApi.danger, true);
  assert.ok(agentApi.warning);
  assert.equal(agentApi.fileOnly, undefined);
  assert.equal(DASHBOARD_SETTING_PATH_SET.has('agentApi.enabled'), true);

  const customAgents = settings.find((setting) => setting.path === 'customAgents');
  assert.ok(customAgents, 'the map exposes customAgents');
  assert.equal(customAgents.control, 'readonly');
  assert.equal(customAgents.fileOnly, true);
  assert.equal(DASHBOARD_SETTING_PATH_SET.has('customAgents'), false);
});

test('unattended actions expose branch deletion and post-turn mode as editable controls', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const unattended = SETTINGS_MAP.find((section) => section.id === 'lanes-unattended');
  assert.ok(unattended);
  const unattendedSettings: SettingsSetting[] = unattended.settings;
  const branchDeletion = unattendedSettings.find((setting) => setting.path === 'branchGc.deleteUnmerged');
  assert.ok(branchDeletion);
  assert.equal(branchDeletion.control, 'toggle');
  assert.equal(branchDeletion.danger, true);
  assert.ok(branchDeletion.warning);
  assert.equal(branchDeletion.defaultValue, false);
  assert.equal(branchDeletion.fileOnly, undefined);
  assert.equal(DASHBOARD_SETTING_PATH_SET.has(branchDeletion.path), true);

  const postTurnMode = unattendedSettings.find((setting) => setting.path === 'postTurnChecks.mode');
  assert.ok(postTurnMode);
  assert.equal(postTurnMode.control, 'select');
  assert.deepEqual(postTurnMode.options, [{ value: 'report', label: 'Report' }, { value: 'fix', label: 'Fix' }]);
  assert.equal(postTurnMode.defaultValue, 'report');
  assert.equal(postTurnMode.fileOnly, undefined);
  assert.equal(DASHBOARD_SETTING_PATH_SET.has(postTurnMode.path), true);
  assert.equal(SETTINGS_MAP.some((section) => section.settings.some((setting) => setting.id === 'file-branch-gc-delete-unmerged')), false);

  const { collectDirtyBlocks, hydrateFromSettings } = await import('../public/settings-view-core.ts');
  const original = hydrateFromSettings([unattended], DEFAULT_CONFIG);
  const edited = { ...original, 'branchGc.deleteUnmerged': true, 'postTurnChecks.mode': 'fix' };
  assert.deepEqual(collectDirtyBlocks([unattended], original, edited), {
    branchGc: { ...DEFAULT_CONFIG.branchGc, deleteUnmerged: true },
    postTurnChecks: { ...DEFAULT_CONFIG.postTurnChecks, mode: 'fix' },
  });
});

test('the Team review lane section owns its settings and deep link', async () => {
  const { SETTINGS_MAP, SETTINGS_SECTION_ALIASES } = await loadMap();
  const { TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID } = await import('../public/team-review-view-core.ts');
  const section = SETTINGS_MAP.find((entry) => entry.id === TEAM_REVIEW_SETTINGS_SECTION_ID);
  assert.ok(section, 'the empty-state link names a missing section');
  assert.equal(section.level, 'lanes');
  assert.equal(SETTINGS_SECTION_ALIASES['team-review'], TEAM_REVIEW_SETTINGS_SECTION_ID);
  const teamReviewSettings: SettingsSetting[] = section.settings;
  assert.deepEqual(teamReviewSettings.map((setting) => [setting.id, setting.path, setting.control]), [
    ['team-review-enabled', 'teamReview.enabled', 'toggle'],
    ['team-review-org', 'teamReview.org', 'text'],
    ['team-review-team', 'teamReview.team', 'text'],
    ['team-review-re-review-after-hours', 'teamReview.reReviewAfterHours', 'number'],
    ['team-review-skip-idle-after-days', 'teamReview.skipIdleAfterDays', 'number'],
    ['team-review-skill', 'teamReview.skill', 'text'],
    ['team-review-auto-rebase-my-prs', 'teamReview.autoRebaseMyPrs', 'toggle'],
  ]);
  assert.equal(teamReviewSettings.some((setting) => setting.id === TEAM_REVIEW_SETTINGS_SETTING_ID), true);
  for (const setting of teamReviewSettings) assert.equal(DASHBOARD_SETTING_PATH_SET.has(setting.path), true, setting.path);
});

test('Flying animals follows Appearance and owns its stable toggle and searchable advanced controls', async () => {
  const { SETTINGS_MAP, SETTINGS_SECTION_ALIASES } = await loadMap();
  const appearanceIndex = SETTINGS_MAP.findIndex((section) => section.id === 'browser-appearance');
  const animals = SETTINGS_MAP[appearanceIndex + 1];
  assert.equal(animals.id, 'browser-flying-animals');
  assert.equal(animals.level, 'browser');
  assert.equal(SETTINGS_SECTION_ALIASES.animals, animals.id);
  assert.equal(SETTINGS_SECTION_ALIASES['flying-animals'], animals.id);
  const settings: SettingsSetting[] = animals.settings;
  assert.equal(settings.find((setting) => setting.id === 'flying-animals')?.path, 'pref:flyingAnimalsEnabled');
  assert.equal(SETTINGS_MAP[appearanceIndex].settings.some((setting) => setting.id === 'flying-animals'), false);
  assert.equal(settings.filter((setting) => setting.advanced).length, 6);
  assert.equal(settings.filter((setting) => setting.control === 'number').every((setting) => setting.commitOnChange === true), true);
  assert.equal(settings.every((setting) => setting.path.startsWith('pref:')), true);
});

test('the machine Privacy section owns the telemetry toggle and the privacy deep link', async () => {
  const { SETTINGS_MAP, SETTINGS_SECTION_ALIASES } = await loadMap();
  const privacy = SETTINGS_MAP.find((section) => section.id === 'machine-privacy');
  assert.ok(privacy);
  assert.equal(privacy.level, 'machine');
  assert.equal(SETTINGS_SECTION_ALIASES.privacy, 'machine-privacy');
  const privacySettings: SettingsSetting[] = privacy.settings;
  const toggle = privacySettings.find((setting) => setting.path === 'telemetry.enabled');
  assert.equal(toggle?.control, 'toggle');
  assert.equal(toggle?.defaultValue, DEFAULT_CONFIG.telemetry.enabled);
  assert.equal(DASHBOARD_SETTING_PATH_SET.has('telemetry.enabled'), true);
});
