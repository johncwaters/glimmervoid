import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { POST_TURN_CHECK_MODES } from '../shared/contracts/browser-config.ts';
import type { SettingsLevel, SettingsSection, SettingsSetting } from '../shared/settings/registry.ts';
import { SETTINGS_MOVED_SETTINGS, SETTINGS_REGISTRY, SETTINGS_SECTION_ALIASES } from '../shared/settings/registry.ts';
import { SETTINGS_INDEX, orderSections, parseSettingsHash, scoreSettingsSearch, settingsOf } from '../shared/settings/registry-core.ts';
import {
  STORED_SECRET_MASK, buildProjectSections, collectDirtyBlocks, enrichProjectsById, firstProjectPerPath, hydrateFromSettings,
  pairedSettingOf, rehydratePreservingDirtySections, shouldShowDangerWarning, validateLocally, withoutWorkflowRuleDefinitions,
  workflowRuleSummaryLines, workflowRuleToggleRows,
} from '../public/settings/settings-view-core.ts';
import { settableFromDashboard } from './helpers/settings-allow-list.ts';

const SECTIONS = SETTINGS_REGISTRY.sections;

function sectionById(id: string): SettingsSection {
  const section = SECTIONS.find((candidate) => candidate.id === id);
  assert.ok(section, `no section ${id}`);
  return section;
}

function searchSetting(id: string, path: string, title: string, description: string, keywords: string[]): SettingsSetting {
  return { id, path, title, description, keywords, control: 'text', scope: 'machine', access: 'editable', takesEffect: 'now' };
}

function searchSection(id: string, title: string, settings: SettingsSetting[]): SettingsSection {
  return { id, level: 'machine', title, description: title, settings };
}

test('an untouched lane writes nothing', () => {
  const payload = { visions: { enabled: false } };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), {});
});

test('one dirty lane preserves unknown stored keys in its block', () => {
  const payload = { visions: { enabled: false, futureKey: 7 }, posthog: { enabled: false } };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);
  edited['visions.enabled'] = true;
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), {
    visions: { enabled: true, futureKey: 7 },
  });
});

test('a Team review save carries the toggle and keeps the legacy org and team as the file has them', () => {
  const payload = { teamReview: { enabled: false, org: 'PostHog', team: 'product-engineering' } };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);
  assert.equal('teamReview.org' in original, false, 'the legacy key is file-only and never hydrates');
  edited['teamReview.enabled'] = true;
  edited['teamReview.org'] = 'Acme';
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), {
    teamReview: { enabled: true, org: 'PostHog', team: 'product-engineering' },
  });
});

test('an unavailable stored project id can be cleared from a projects-control save', () => {
  const payload = {
    projectChoices: [{ id: 'shown', name: 'Shown' }],
    visions: { enabled: true, projects: ['shown', 'missing'] },
  };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);
  edited['visions.projects'] = [];
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), {
    visions: { enabled: true, projects: [] },
  });
});

test('a settings refresh preserves a dirty lane and updates a clean lane', () => {
  const currentPayload = { visions: { enabled: false }, posthog: { enabled: false } };
  const currentOriginal = hydrateFromSettings(SECTIONS, currentPayload);
  const currentEdited = hydrateFromSettings(SECTIONS, currentPayload);
  currentEdited['visions.enabled'] = true;
  const freshPayload = { visions: { enabled: false }, posthog: { enabled: true } };
  const { original, edited } = rehydratePreservingDirtySections(
    SECTIONS, freshPayload, currentOriginal, currentEdited,
  );
  assert.equal(edited['visions.enabled'], true);
  assert.equal(edited['posthog.enabled'], true);
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), { visions: { enabled: true } });
});

test('zero and negative budgets validate and serialize as no ceiling', () => {
  const usageSection = sectionById('machine-usage');
  const payload = { usage: { budget: { dailyUsd: 20, monthlyUsd: 100 } } };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);
  edited['usage.budget.dailyUsd'] = -1;
  edited['usage.budget.monthlyUsd'] = 0;
  assert.deepEqual(validateLocally([usageSection], edited), {});
  assert.deepEqual(collectDirtyBlocks([usageSection], original, edited), {
    usage: { budget: { dailyUsd: null, monthlyUsd: null } },
  });
});

test('a successful save rehydrates its lane and preserves another dirty lane', () => {
  const currentPayload = { visions: { projects: [] }, posthog: { enabled: false } };
  const currentOriginal = hydrateFromSettings(SECTIONS, currentPayload);
  const currentEdited = hydrateFromSettings(SECTIONS, currentPayload);
  currentEdited['visions.projects'] = ['project-1'];
  currentEdited['posthog.enabled'] = true;
  const freshPayload = { visions: { projects: ['project-1'] }, posthog: { enabled: false } };
  const { original, edited } = rehydratePreservingDirtySections(
    SECTIONS, freshPayload, currentOriginal, currentEdited,
    { rehydrateSectionIds: ['lanes-visions'] },
  );
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), { posthog: { enabled: true } });
});

test('search matches partial tokens, ranks fuller matches first and weights fields', () => {
  const sections = [
    searchSection('feature', 'Feature flags', [
      searchSetting('feature-flag', 'feature.flag', 'Feature flag', 'Controls a switch.', ['toggle', 'option']),
    ]),
    searchSection('thermal', 'Heat controls', [
      searchSetting('temperature', 'thermal.temperature', 'Temperature', 'Controls heat output.', ['thermal', 'warmth']),
      searchSetting('keyword-only', 'thermal.cooling', 'Cooling', 'Controls airflow.', ['heat', 'thermal']),
    ]),
    searchSection('other', 'Other', [
      searchSetting('title-match', 'other.heatLimit', 'Heat limit', 'A ceiling.', ['temperature', 'ceiling']),
    ]),
  ];
  const results = scoreSettingsSearch(sections, 'heat');
  assert.equal(results.some((entry) => entry.setting.id === 'feature-flag'), false);
  assert.equal(results.some((entry) => entry.setting.id === 'keyword-only'), true);
  assert.equal(results[0].setting.id, 'title-match');
  assert.ok(results.findIndex((entry) => entry.setting.id === 'temperature') > 0);
  assert.deepEqual(scoreSettingsSearch(sections, 'temp').map((entry) => entry.setting.id), ['temperature', 'title-match']);
  assert.deepEqual(scoreSettingsSearch(sections, 'heat lim').map((entry) => entry.setting.id), ['title-match']);
  assert.deepEqual(scoreSettingsSearch(sections, 'flow').map((entry) => entry.setting.id), ['keyword-only']);
  assert.deepEqual(scoreSettingsSearch(sections, 'ow'), []);
  const [wholeWordScore, wordStartScore, insideWordScore] = ['airflow', 'air', 'flow'].map((query) => scoreSettingsSearch(sections, query)[0].score);
  assert.ok(wholeWordScore > wordStartScore && wordStartScore > insideWordScore);
  assert.deepEqual(scoreSettingsSearch(sections, 'co').map((entry) => entry.setting.id), ['keyword-only', 'temperature', 'feature-flag']);
  assert.deepEqual(scoreSettingsSearch(sections, ''), []);
});

test('search finds file-only keys and returns them without a section', () => {
  const results = scoreSettingsSearch(SECTIONS, 'cursor blink', SETTINGS_REGISTRY.fileOnly);
  assert.equal(results[0]?.setting.path, 'cursorBlink');
  assert.equal(results[0]?.section, null);
  const quietDelay = scoreSettingsSearch(SECTIONS, 'quiet delay', SETTINGS_REGISTRY.fileOnly).find((entry) => entry.setting.path === 'visions.dispatch.quietMs');
  assert.ok(quietDelay);
  assert.equal(scoreSettingsSearch(SECTIONS, 'cursor blink').some((entry) => entry.setting.path === 'cursorBlink'), false);
});

test('settings hashes resolve aliases and canonical anchors', () => {
  const aliases = { general: 'machine-general' };
  assert.deepEqual(parseSettingsHash('#settings/general/auto-resume', SECTIONS, aliases), {
    sectionId: 'machine-general', settingId: 'auto-resume', hash: '#settings/machine-general/auto-resume',
  });
  assert.equal(parseSettingsHash('#settings/missing', SECTIONS, aliases), null);
  assert.equal(parseSettingsHash('#settings/machine-general/missing', SECTIONS, aliases), null);
});

test('unattended actions sort last within the map', () => {
  const section = (id: string, level: SettingsLevel): SettingsSection => ({ id, level, title: id, description: id, settings: [] });
  const ordered = orderSections([
    section('lanes-unattended', 'lanes'),
    section('lanes-ingest', 'lanes'),
    section('project-one', 'projects'),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.id), [
    'lanes-ingest', 'lanes-unattended', 'project-one',
  ]);
});

test('a danger warning shows only while its toggle is on', () => {
  const dangerSetting = { danger: true, warning: 'Lets agents run unattended.' };
  assert.equal(shouldShowDangerWarning(dangerSetting, true), true);
  assert.equal(shouldShowDangerWarning(dangerSetting, false), false);
  assert.equal(shouldShowDangerWarning(dangerSetting, undefined), false);
  assert.equal(shouldShowDangerWarning({ warning: 'Plain note.' }, true), false);
});

test('project sections derive read-only records', () => {
  const sections = buildProjectSections(
    [{ id: 'p1', name: 'Glimmervoid', agent: 'codex', permissionMode: 'default' }],
  );
  assert.equal(sections[0].id, 'project-p1');
  assert.equal(sections[0].settings[0].value, 'codex');
  assert.equal(sections[0].settings[2].access, 'file-only');
});

test('two configured records on one checkout share a section named for it that lists both cards', () => {
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

test('a stored secret hydrates as a mask and an untouched section sends nothing', () => {
  const payload = { telegram: { chatId: '123', botTokenConfigured: true }, posthog: { enabled: true, apiKeyConfigured: false } };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);

  assert.equal(original['telegram.botToken'], STORED_SECRET_MASK);
  assert.equal(original['posthog.apiKey'], '', 'nothing stored means an empty field');
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), {});
});

test('a sibling edit never carries the mask or the presence flag to the server', () => {
  const payload = { telegram: { chatId: '123', botTokenConfigured: true } };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);
  edited['telegram.chatId'] = '456';

  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), { telegram: { chatId: '456' } });
});

test('a typed secret is sent and an emptied one is sent as a clear', () => {
  const payload = { telegram: { chatId: '123', botTokenConfigured: true } };
  const original = hydrateFromSettings(SECTIONS, payload);
  const typed = hydrateFromSettings(SECTIONS, payload);
  typed['telegram.botToken'] = 'fresh-tok';
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, typed), { telegram: { chatId: '123', botToken: 'fresh-tok' } });

  const emptied = hydrateFromSettings(SECTIONS, payload);
  emptied['telegram.botToken'] = '';
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, emptied), { telegram: { chatId: '123', botToken: '' } });
});

test('animal aliases and existing Appearance toggle links resolve to the new section', () => {
  for (const sectionId of ['animals', 'flying-animals', 'browser-flying-animals', 'browser-appearance']) {
    assert.deepEqual(parseSettingsHash(`#settings/${sectionId}/flying-animals`, SECTIONS, SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS), {
      sectionId: 'browser-flying-animals', settingId: 'flying-animals', hash: '#settings/browser-flying-animals/flying-animals',
    });
  }
});

test('a moved setting redirects only through the moved-settings data it is given', () => {
  assert.equal(parseSettingsHash('#settings/browser-appearance/flying-animals', SECTIONS), null);
  const movedSettings = { 'machine-updates': { 'auto-resume': 'machine-general' } };
  assert.deepEqual(parseSettingsHash('#settings/machine-updates/auto-resume', SECTIONS, {}, movedSettings), {
    sectionId: 'machine-general', settingId: 'auto-resume', hash: '#settings/machine-general/auto-resume',
  });
  assert.deepEqual(parseSettingsHash('#settings/machine-updates', SECTIONS, {}, movedSettings)?.sectionId, 'machine-updates');
});

test('animal controls are searchable, range validated and excluded from machine save payloads', () => {
  const animals = sectionById('browser-flying-animals');
  for (const query of ['frequency', 'speed', 'size', 'mobile']) {
    assert.ok(scoreSettingsSearch(SECTIONS, query).some((entry) => entry.section?.id === animals.id));
  }
  const original = hydrateFromSettings([animals], {});
  const edited = { ...original, 'pref:flyingAnimalsScale': 3, 'pref:flyingAnimalsOnPhone': false };
  assert.deepEqual(collectDirtyBlocks([animals], original, edited), {});
  assert.deepEqual(Object.keys(validateLocally([animals], edited)), ['animals-scale']);
  assert.deepEqual(validateLocally([animals], original), {});
});

test('a reversed flying animals minimum and maximum pair reports an error on both fields', () => {
  const animals = sectionById('browser-flying-animals');
  const original = hydrateFromSettings([animals], {});
  const reversedGap = { ...original, 'pref:flyingAnimalsMinGapSeconds': 50, 'pref:flyingAnimalsMaxGapSeconds': 40 };
  assert.deepEqual(validateLocally([animals], reversedGap), {
    'animals-min-gap': 'Minimum must not exceed the maximum (40).',
    'animals-max-gap': 'Maximum must not be below the minimum (50).',
  });
  const reversedDuration = { ...original, 'pref:flyingAnimalsMinDurationSeconds': 12, 'pref:flyingAnimalsMaxDurationSeconds': 8 };
  assert.deepEqual(Object.keys(validateLocally([animals], reversedDuration)).sort(), ['animals-max-duration', 'animals-min-duration']);
  const equalGap = { ...original, 'pref:flyingAnimalsMinGapSeconds': 30, 'pref:flyingAnimalsMaxGapSeconds': 30 };
  assert.deepEqual(validateLocally([animals], equalGap), {});
  const outOfRangeAndReversed = { ...original, 'pref:flyingAnimalsMinGapSeconds': 9999, 'pref:flyingAnimalsMaxGapSeconds': 40 };
  assert.deepEqual(Object.keys(validateLocally([animals], outOfRangeAndReversed)), ['animals-min-gap']);
  const settingById = (id: string) => animals.settings.find((setting) => setting.id === id);
  const minimumGap = settingById('animals-min-gap');
  const maximumGap = settingById('animals-max-gap');
  const scale = settingById('animals-scale');
  assert.ok(minimumGap && maximumGap && scale);
  assert.equal(pairedSettingOf([animals], minimumGap)?.id, 'animals-max-gap');
  assert.equal(pairedSettingOf([animals], maximumGap)?.id, 'animals-min-gap');
  assert.equal(pairedSettingOf([animals], scale), undefined);
});

test('file-only keys live outside every section, never hydrate and never enter a dirty payload', () => {
  assert.ok(SETTINGS_REGISTRY.fileOnly.length > 50);
  const fileOnlyPaths = new Set(SETTINGS_REGISTRY.fileOnly.map((setting) => setting.path));
  for (const setting of settingsOf(SECTIONS)) assert.equal(fileOnlyPaths.has(setting.path), false, setting.path);
  const original = hydrateFromSettings(SECTIONS, DEFAULT_CONFIG);
  for (const path of fileOnlyPaths) assert.equal(path in original, false, path);
  const edited = { ...original, cursorBlink: true, 'visions.dispatch.quietMs': 1 };
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), {});
});

test('unattended actions expose branch deletion and post-turn mode as editable controls', () => {
  const unattended = sectionById('lanes-unattended');
  const branchDeletion = unattended.settings.find((setting) => setting.path === 'branchGc.deleteUnmerged');
  assert.ok(branchDeletion);
  assert.equal(branchDeletion.control, 'toggle');
  assert.equal(branchDeletion.danger, true);
  assert.ok(branchDeletion.warning);
  assert.equal(branchDeletion.defaultValue, false);
  assert.equal(branchDeletion.access, 'editable');
  assert.equal(settableFromDashboard(branchDeletion.path), true);

  const postTurnMode = unattended.settings.find((setting) => setting.path === 'postTurnChecks.mode');
  assert.ok(postTurnMode);
  assert.equal(postTurnMode.control, 'select');
  assert.deepEqual(postTurnMode.options, POST_TURN_CHECK_MODES.map((value) => ({ value, label: value === 'report' ? 'Report' : 'Fix' })));
  assert.equal(postTurnMode.defaultValue, 'report');
  assert.equal(postTurnMode.access, 'editable');
  assert.equal(settableFromDashboard(postTurnMode.path), true);
  assert.equal(SETTINGS_INDEX.byId.has('file-branch-gc-delete-unmerged'), false);

  const original = hydrateFromSettings([unattended], DEFAULT_CONFIG);
  const edited = { ...original, 'branchGc.deleteUnmerged': true, 'postTurnChecks.mode': 'fix' };
  assert.deepEqual(collectDirtyBlocks([unattended], original, edited), {
    branchGc: { ...DEFAULT_CONFIG.branchGc, deleteUnmerged: true },
    postTurnChecks: { ...DEFAULT_CONFIG.postTurnChecks, mode: 'fix' },
  });
});

test('the workflows summary lists each rule read-only and says so when there are none or the block is invalid', () => {
  assert.deepEqual(workflowRuleSummaryLines(undefined), ['No rules. Add workflows.rules to config.json.']);
  assert.deepEqual(workflowRuleSummaryLines({ rules: [] }), ['No rules. Add workflows.rules to config.json.']);
  assert.deepEqual(workflowRuleSummaryLines({ rules: [
    { id: 'ci', name: 'CI watch', enabled: true, repos: ['Acme/app', 'Acme/web'], trigger: 'checks-failed', actions: [{ type: 'notify' }, { type: 'spawn', promptTemplate: 'Fix {{url}}' }] },
    { id: 'thanks', name: 'Thanks', repos: ['Acme/app'], trigger: 'merged', actions: [{ type: 'comment', body: 'Thanks' }] },
  ] }), [
    'CI watch  enabled  Acme/app, Acme/web  checks-failed  notify, spawn',
    'Thanks  disabled  Acme/app  merged  comment',
  ]);
  assert.match(workflowRuleSummaryLines({ rules: [{ id: 'x', name: 'X', repos: ['Acme/app'], trigger: 'pushed', actions: [{ type: 'notify' }] }] })[0] ?? '', /^The workflows block is invalid, so no rule runs: workflows\.rules\[\]\.trigger must be one of/);
});

test('the Workflows section owns the master switch, the session cap and the rule toggles, whose save never carries rule definitions', () => {
  const section = sectionById('lanes-workflows');
  assert.deepEqual(section.settings.map((setting) => [setting.path, setting.control, setting.defaultValue]), [
    ['workflows.enabled', 'toggle', DEFAULT_CONFIG.workflows.enabled],
    ['workflows.maxConcurrentSessions', 'number', DEFAULT_CONFIG.workflows.maxConcurrentSessions],
    ['status:workflow-rules', 'readonly', undefined],
  ]);
  assert.equal(section.settings.find((setting) => setting.control === 'readonly')?.status, 'workflows');
  for (const setting of section.settings.filter((entry) => entry.control !== 'readonly')) assert.equal(settableFromDashboard(setting.path), true, setting.path);
  assert.deepEqual(SETTINGS_REGISTRY.fileOnly.filter((setting) => setting.path.startsWith('workflows.')).map((setting) => setting.path), ['workflows.maxActionsPerPoll', 'workflows.rules']);

  const stored = { workflows: { maxActionsPerPoll: 9, rules: [{ id: 'one', name: 'One', enabled: true, repos: ['Acme/app'], trigger: 'opened', actions: [{ type: 'notify' }] }] } };
  const original = hydrateFromSettings([section], stored);
  const edited = { ...original, 'workflows.enabled': false };
  assert.deepEqual(withoutWorkflowRuleDefinitions(collectDirtyBlocks([section], original, edited)), { workflows: { maxActionsPerPoll: 9, enabled: false } });
  assert.deepEqual(withoutWorkflowRuleDefinitions({ telegram: { chatId: '1' } }), { telegram: { chatId: '1' } });
});

test('workflow rule toggle rows carry each rule id and state, and none for an absent or invalid block', () => {
  assert.deepEqual(workflowRuleToggleRows(null), []);
  assert.deepEqual(workflowRuleToggleRows({ rules: [{ id: 'x', name: 'X', repos: ['Acme/app'], trigger: 'pushed', actions: [{ type: 'notify' }] }] }), []);
  assert.deepEqual(workflowRuleToggleRows({ rules: [
    { id: 'ci', name: 'CI watch', enabled: true, repos: ['Acme/app'], trigger: 'checks-failed', actions: [{ type: 'notify' }] },
    { id: 'thanks', name: 'Thanks', repos: ['Acme/app'], trigger: 'merged', actions: [{ type: 'comment', body: 'Thanks' }] },
  ] }), [
    { id: 'ci', name: 'CI watch', isEnabled: true, summary: 'Acme/app  checks-failed  notify' },
    { id: 'thanks', name: 'Thanks', isEnabled: false, summary: 'Acme/app  merged  comment' },
  ]);
});
