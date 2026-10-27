import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { SettingsLevel, SettingsSection, SettingsSetting } from '../shared/settings/registry.ts';
import { SETTINGS_MOVED_SETTINGS, SETTINGS_REGISTRY, SETTINGS_SECTION_ALIASES } from '../shared/settings/registry.ts';
import { SETTINGS_INDEX, displayValue, parseSettingsHash, scoreSettingsSearch, settingsOf, wireValue } from '../shared/settings/registry-core.ts';
import {
  STORED_SECRET_MASK, childSectionsOf, collectDirtyBlocks, displayRange, draftCommitOf,
  fileOnlyDefaultText, hydrateFromSettings, isAtDefault, listFromDraft, needsDangerConfirmation, numberDraftError, numberDraftOf, numberFromDraft,
  pageSectionOf, phoneSettingsScreenOf, pairedSettingOf, resetConfirmationOf, resetValueOf, settingError, settingSavePayload, settingsNavigationGroupsOf, settingsSearchBreadcrumb, shouldShowDangerWarning, topLevelSectionsOf, validateLocally,
  withoutWorkflowRuleDefinitions, workflowRuleSummaryLines, workflowRuleToggleRows,
} from '../public/settings/settings-view-core.ts';
import { settableFromDashboard } from './helpers/settings-allow-list.ts';
import { parseSettingsSearchHash, settingsSearchHash } from '../public/settings/settings-link.ts';

const SECTIONS = SETTINGS_REGISTRY.sections;

function sectionById(id: string): SettingsSection {
  const section = SECTIONS.find((candidate) => candidate.id === id);
  assert.ok(section, `no section ${id}`);
  return section;
}

function settingById(id: string): SettingsSetting {
  const setting = SETTINGS_INDEX.byId.get(id);
  assert.ok(setting, `no setting ${id}`);
  return setting;
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

test('a single-setting save payload carries only that setting over the stored block', () => {
  const payload = { visions: { enabled: false, futureKey: 7 }, posthog: { enabled: false }, workflows: { enabled: true, rules: [{ id: 'x' }] } };
  const stored = hydrateFromSettings(SECTIONS, payload);
  assert.deepEqual(settingSavePayload(SECTIONS, stored, settingById('visions-enabled'), true), { visions: { enabled: true, futureKey: 7 } });
  assert.deepEqual(settingSavePayload(SECTIONS, stored, settingById('visions-enabled'), false), {});
  assert.deepEqual(settingSavePayload(SECTIONS, stored, settingById('workflows-enabled'), false), { workflows: { enabled: false } });
  assert.deepEqual(settingSavePayload(SECTIONS, stored, settingById('auto-resume'), false), { autoResume: false });
  assert.deepEqual(settingSavePayload(SECTIONS, stored, settingById('theme'), 'midnight'), {}, 'a browser preference never reaches the server');
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

test('number drafts are typed in display units, validated against the stored schema bounds and stored as integers', () => {
  const quiet = settingById('file-visions-quiet-delay');
  assert.deepEqual(displayRange(quiet), { min: 0, exclusiveMin: true });
  assert.equal(numberDraftOf(displayValue(quiet, 30000)), '30');
  assert.equal(numberDraftError(quiet, '30'), null);
  assert.equal(wireValue(quiet, numberFromDraft(quiet, '30')), 30000);
  assert.equal(wireValue(quiet, numberFromDraft(quiet, '0.5')), 500);
  assert.equal(numberDraftError(quiet, '0'), 'Must be a positive number of seconds.');
  assert.equal(numberDraftError(quiet, '0.0001'), 'Must be a multiple of 0.001 seconds.');
  assert.equal(numberDraftError(quiet, 'abc'), 'Must be a positive number of seconds.');
  assert.equal(fileOnlyDefaultText(quiet), 'Default 30 seconds, stored as 30000 ms');

  const ttl = settingById('file-visions-intent-thread-ttl');
  assert.equal(numberDraftOf(displayValue(ttl, 259200000)), '3');
  assert.equal(wireValue(ttl, numberFromDraft(ttl, '3')), 259200000);

  const retain = settingById('usage-retain-days');
  assert.deepEqual(displayRange(retain), { min: 1, max: 3650 });
  assert.equal(numberDraftError(retain, '1.5'), 'Must be a whole number of days between 1 and 3650.');
  assert.equal(numberDraftError(retain, '4000'), 'Must be a whole number of days between 1 and 3650.');
  assert.equal(numberDraftError(retain, '90'), null);

  const budget = settingById('usage-daily-budget');
  assert.equal(numberDraftError(budget, ''), null);
  assert.equal(numberFromDraft(budget, ''), null);
  assert.equal(numberFromDraft(budget, '-3'), null);
  assert.equal(numberDraftError(budget, '12.5'), null);
  assert.equal(numberFromDraft(budget, '12.5'), 12.5);
  assert.equal(numberDraftOf(null), '');
  assert.equal(numberDraftError(budget, '', true), 'Must be a positive number of USD.');

  const workers = settingById('workflows-max-concurrent-sessions');
  assert.equal(numberDraftError(workers, '6'), 'Must be a whole number of sessions between 1 and 5.');
});

test('a reversed flying animals minimum and maximum pair reports an error on both fields and on the edited one alone', () => {
  const appearance = sectionById('browser-appearance');
  const original = hydrateFromSettings([appearance], {});
  const reversedGap = { ...original, 'pref:flyingAnimalsMinGapSeconds': 50, 'pref:flyingAnimalsMaxGapSeconds': 40 };
  assert.deepEqual(validateLocally([appearance], reversedGap), {
    'animals-min-gap': 'Minimum must not exceed the maximum (40).',
    'animals-max-gap': 'Maximum must not be below the minimum (50).',
  });
  const reversedDuration = { ...original, 'pref:flyingAnimalsMinDurationSeconds': 12, 'pref:flyingAnimalsMaxDurationSeconds': 8 };
  assert.deepEqual(Object.keys(validateLocally([appearance], reversedDuration)).sort(), ['animals-max-duration', 'animals-min-duration']);
  const equalGap = { ...original, 'pref:flyingAnimalsMinGapSeconds': 30, 'pref:flyingAnimalsMaxGapSeconds': 30 };
  assert.deepEqual(validateLocally([appearance], equalGap), {});
  const outOfRangeAndReversed = { ...original, 'pref:flyingAnimalsMinGapSeconds': 9999, 'pref:flyingAnimalsMaxGapSeconds': 40 };
  assert.deepEqual(Object.keys(validateLocally([appearance], outOfRangeAndReversed)), ['animals-min-gap']);
  const minimumGap = settingById('animals-min-gap');
  const maximumGap = settingById('animals-max-gap');
  const scale = settingById('animals-scale');
  assert.equal(pairedSettingOf([appearance], minimumGap)?.id, 'animals-max-gap');
  assert.equal(pairedSettingOf([appearance], maximumGap)?.id, 'animals-min-gap');
  assert.equal(pairedSettingOf([appearance], scale), undefined);
  assert.equal(settingError(SECTIONS, minimumGap, reversedGap), 'Minimum must not exceed the maximum (40).');
  assert.equal(settingError(SECTIONS, minimumGap, equalGap), null);
  assert.equal(settingError(SECTIONS, scale, { ...original, 'pref:flyingAnimalsScale': 3 }), 'Must be a number of times between 0.5 and 2.');
});

test('every setting resets to its registry default, and a stored secret resets to not configured only after a confirmation', () => {
  assert.equal(resetConfirmationOf(settingById('telegram-bot-token')), 'Reset removes the stored bot token. Anything that relies on it stops until a new one is saved.');
  assert.equal(resetConfirmationOf(settingById('auto-resume')), null);
  assert.equal(isAtDefault(settingById('auto-resume'), true), true);
  assert.equal(isAtDefault(settingById('auto-resume'), false), false);
  assert.deepEqual(resetValueOf(settingById('posthog-projects')), []);
  assert.equal(isAtDefault(settingById('posthog-projects'), []), true);
  assert.equal(isAtDefault(settingById('posthog-projects'), ['1']), false);
  assert.equal(resetValueOf(settingById('telegram-bot-token')), '');
  assert.equal(isAtDefault(settingById('telegram-bot-token'), STORED_SECRET_MASK), false);
  assert.equal(isAtDefault(settingById('telegram-bot-token'), ''), true);
  assert.equal(isAtDefault(settingById('usage-retain-days'), 90), true);
});

test('a danger setting asks for confirmation whenever its new value is not empty', () => {
  assert.equal(needsDangerConfirmation(settingById('skip-permissions-by-default'), true), true);
  assert.equal(needsDangerConfirmation(settingById('skip-permissions-by-default'), false), false);
  assert.equal(needsDangerConfirmation(settingById('auto-resume'), true), false);
  assert.equal(needsDangerConfirmation(settingById('guardrails-unguarded-repos'), ['/repo']), true);
  assert.equal(needsDangerConfirmation(settingById('guardrails-unguarded-repos'), []), false);
});

test('a draft saves only an edit that differs from the value it was rendered from', () => {
  const values = hydrateFromSettings(SECTIONS, { usage: { retainDays: 90, budget: { dailyUsd: null } }, guardrails: { unguardedRepos: [] } });
  const untouchedStaleList = { base: ['/repo'], isDirty: false };
  assert.deepEqual(draftCommitOf(SECTIONS, settingById('guardrails-unguarded-repos'), untouchedStaleList, '/repo', values), { kind: 'unchanged' });
  assert.deepEqual(draftCommitOf(SECTIONS, settingById('usage-retain-days'), { base: 90, isDirty: true }, '90.0', values), { kind: 'unchanged' });
  assert.deepEqual(draftCommitOf(SECTIONS, settingById('usage-daily-budget'), { base: null, isDirty: true }, '0', values), { kind: 'unchanged' });
  assert.deepEqual(draftCommitOf(SECTIONS, settingById('usage-retain-days'), { base: 90, isDirty: true }, '120', values), { kind: 'changed', value: 120 });
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

test('search scores key paths and option labels, keeps editable settings ahead of equal config.json-only hits and returns highlighted matches', () => {
  for (const query of ['spike', 'replay', 'sessions', 'visions.dispatch.quietMs']) {
    const hits = scoreSettingsSearch(SECTIONS, query, SETTINGS_REGISTRY.fileOnly);
    assert.ok(hits.length > 0, query);
    for (const [index, hit] of hits.entries()) {
      const previous = hits[index - 1];
      if (!previous) continue;
      assert.ok(previous.score >= hit.score, query);
      assert.ok(previous.score > hit.score || previous.section !== null || hit.section === null, `${query}: ${hit.setting.id} trails an equal config.json-only hit`);
    }
  }
  const spikeSwitch = scoreSettingsSearch(SECTIONS, 'posthog.trafficSpikeEnabled', SETTINGS_REGISTRY.fileOnly)[0];
  assert.equal(spikeSwitch.setting.path, 'posthog.trafficSpikeEnabled');
  assert.notEqual(spikeSwitch.section, null);
  const sessionsHitIds = scoreSettingsSearch(SECTIONS, 'sessions', SETTINGS_REGISTRY.fileOnly).map((hit) => hit.setting.id);
  for (const id of ['streamer-mode', 'repository-roots', 'custom-agents']) assert.ok(sessionsHitIds.includes(id), id);
  const quiet = scoreSettingsSearch(SECTIONS, 'visions.dispatch.quietMs', SETTINGS_REGISTRY.fileOnly)[0];
  assert.equal(quiet.setting.path, 'visions.dispatch.quietMs');
  assert.equal(settingsSearchBreadcrumb(SECTIONS, quiet.section, quiet.setting), 'Lanes / Visions');
  const keyMatch = quiet.matches.find((match) => match.field === 'path');
  assert.deepEqual(keyMatch?.spans.map((span) => keyMatch.text.slice(span.start, span.end)), ['visions', 'dispatch', 'quietMs']);
  const custom = searchSetting('custom', 'custom.mode', 'Mode', 'Choose a mode.', ['behavior', 'choice']);
  custom.options = [{ value: 'quiet', label: 'Silent operation' }];
  const optionHit = scoreSettingsSearch([searchSection('custom', 'Custom', [custom])], 'silent')[0];
  assert.equal(optionHit.setting.id, custom.id);
  assert.equal(optionHit.matches.find((match) => match.field === 'options')?.text, 'Silent operation');
});

test('settings search hashes round trip query text and clear without taking over setting anchors', () => {
  for (const query of ['replay', 'visions.dispatch.quietMs', 'space + & # / caf\u00e9']) {
    assert.deepEqual(parseSettingsSearchHash(settingsSearchHash(query)), { query });
  }
  assert.equal(settingsSearchHash('  '), '#settings');
  assert.deepEqual(parseSettingsSearchHash('#settings'), { query: '' });
  assert.deepEqual(parseSettingsSearchHash('#settings?q='), { query: '' });
  assert.deepEqual(parseSettingsSearchHash('#settings?q=quiet+delay'), { query: 'quiet delay' });
  assert.equal(parseSettingsSearchHash('#settings/machine-sessions/auto-resume'), null);
  assert.equal(parseSettingsSearchHash('#sessions?q=replay'), null);
  assert.equal(parseSettingsSearchHash(settingsSearchHash('a'.repeat(10_000)))?.query.length, 200);
});

test('settings hashes resolve aliases and canonical anchors', () => {
  const aliases = { general: 'machine-sessions' };
  assert.deepEqual(parseSettingsHash('#settings/general/auto-resume', SECTIONS, aliases), {
    sectionId: 'machine-sessions', settingId: 'auto-resume', hash: '#settings/machine-sessions/auto-resume',
  });
  assert.equal(parseSettingsHash('#settings/missing', SECTIONS, aliases), null);
  assert.equal(parseSettingsHash('#settings/machine-sessions/missing', SECTIONS, aliases), null);
  assert.deepEqual(parseSettingsHash('#settings/machine-sessions', SECTIONS), { sectionId: 'machine-sessions', settingId: null, hash: '#settings/machine-sessions' });
});

test('a child section resolves to its parent page, and the navigation lists parentless sections with lanes under their own heading', () => {
  const section = (id: string, level: SettingsLevel, parent?: string): SettingsSection => ({ id, level, parent, title: id, description: '', settings: [] });
  const sections = [section('a', 'browser'), section('a-child', 'machine', 'a'), section('lane-1', 'lanes'), section('lane-2', 'lanes'), section('z', 'machine')];
  assert.deepEqual(topLevelSectionsOf(sections).map((entry) => entry.id), ['a', 'lane-1', 'lane-2', 'z']);
  assert.deepEqual(childSectionsOf(sections, 'a').map((entry) => entry.id), ['a-child']);
  assert.equal(pageSectionOf(sections, 'a-child')?.id, 'a');
  assert.equal(pageSectionOf(sections, 'z')?.id, 'z');
  assert.equal(pageSectionOf(sections, 'missing'), null);
  assert.equal(pageSectionOf(SECTIONS, 'lanes-posthog')?.id, 'lanes-posthog');
  assert.deepEqual(settingsNavigationGroupsOf(topLevelSectionsOf(sections)).map((group) => [group.heading, group.sections.map((entry) => entry.id)]), [
    [null, ['a', 'z']], ['Lanes', ['lane-1', 'lane-2']],
  ]);
});

test('a list draft keeps each trimmed non-blank line as one entry', () => {
  assert.deepEqual(listFromDraft(' 12 \n\n34\n'), ['12', '34']);
});

test('a danger warning shows only while its value is not empty', () => {
  const dangerSetting = { danger: true, warning: 'Lets agents run unattended.' };
  assert.equal(shouldShowDangerWarning(dangerSetting, true), true);
  assert.equal(shouldShowDangerWarning(dangerSetting, false), false);
  assert.equal(shouldShowDangerWarning(dangerSetting, undefined), false);
  assert.equal(shouldShowDangerWarning(dangerSetting, ['/repo']), true);
  assert.equal(shouldShowDangerWarning(dangerSetting, []), false);
  assert.equal(shouldShowDangerWarning({ warning: 'Plain note.' }, true), false);
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

test('animal aliases and the old Appearance toggle link resolve to the Appearance section', () => {
  for (const sectionId of ['animals', 'flying-animals', 'browser-flying-animals', 'browser-appearance']) {
    assert.deepEqual(parseSettingsHash(`#settings/${sectionId}/flying-animals`, SECTIONS, SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS), {
      sectionId: 'browser-appearance', settingId: 'flying-animals', hash: '#settings/browser-appearance/flying-animals',
    });
  }
});

test('a moved setting redirects only through the moved-settings data it is given', () => {
  assert.equal(parseSettingsHash('#settings/machine-updates/auto-resume', SECTIONS), null);
  const movedSettings = { 'machine-updates': { 'auto-resume': 'machine-sessions' } };
  assert.deepEqual(parseSettingsHash('#settings/machine-updates/auto-resume', SECTIONS, {}, movedSettings), {
    sectionId: 'machine-sessions', settingId: 'auto-resume', hash: '#settings/machine-sessions/auto-resume',
  });
  assert.deepEqual(parseSettingsHash('#settings/machine-updates', SECTIONS, {}, movedSettings)?.sectionId, 'machine-updates');
});

test('animal controls are searchable, range validated and excluded from machine save payloads', () => {
  const appearance = sectionById('browser-appearance');
  for (const query of ['frequency', 'speed', 'size', 'mobile']) {
    assert.ok(scoreSettingsSearch(SECTIONS, query).some((entry) => entry.section?.id === appearance.id));
  }
  const original = hydrateFromSettings([appearance], {});
  const edited = { ...original, 'pref:flyingAnimalsScale': 3, 'pref:flyingAnimalsOnPhone': false };
  assert.deepEqual(collectDirtyBlocks([appearance], original, edited), {});
  assert.deepEqual(Object.keys(validateLocally([appearance], edited)), ['animals-scale']);
  assert.deepEqual(validateLocally([appearance], original), {});
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

test('guardrails expose branch deletion and post-turn mode as editable controls', () => {
  const unattended = sectionById('machine-guardrails');
  const branchDeletion = unattended.settings.find((setting) => setting.path === 'branchGc.deleteUnmerged');
  assert.ok(branchDeletion);
  assert.equal(branchDeletion.control, 'toggle');
  assert.equal(branchDeletion.danger, true);
  assert.ok(branchDeletion.warning);
  assert.equal(branchDeletion.defaultValue, false);
  assert.equal(branchDeletion.access, 'editable');
  assert.equal(settableFromDashboard(branchDeletion.path), true);

  assert.equal(SETTINGS_INDEX.byId.has('file-branch-gc-delete-unmerged'), false);

  const original = hydrateFromSettings([unattended], DEFAULT_CONFIG);
  const edited = { ...original, 'branchGc.deleteUnmerged': true };
  assert.deepEqual(collectDirtyBlocks([unattended], original, edited), {
    branchGc: { ...DEFAULT_CONFIG.branchGc, deleteUnmerged: true },
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

test('phone settings starts with sections, opens canonical and child links, searches above either screen, and hides an open section in streamer mode', () => {
  assert.equal(phoneSettingsScreenOf(SECTIONS, null, '', false), 'list');
  assert.equal(phoneSettingsScreenOf(SECTIONS, 'browser-appearance', '', false), 'section');
  assert.equal(phoneSettingsScreenOf(SECTIONS, 'lanes-posthog', '', false), 'section');
  assert.equal(phoneSettingsScreenOf(SECTIONS, 'missing', '', false), 'list');
  assert.equal(phoneSettingsScreenOf(SECTIONS, null, 'replay', false), 'search');
  assert.equal(phoneSettingsScreenOf(SECTIONS, 'lanes-posthog', 'replay', false), 'search');
  assert.equal(phoneSettingsScreenOf(SECTIONS, 'lanes-posthog', '', true), 'hidden');
});
