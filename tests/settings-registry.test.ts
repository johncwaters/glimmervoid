import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { DASHBOARD_SETTING_PATHS } from '../server/control-handlers.ts';
import { INGEST_SPEC } from '../server/core/settings-block-core.ts';
import type { SettingsBlockSpec } from '../server/core/settings-block-core.ts';
import { UPDATE_CHANNELS } from '../shared/contracts/browser-config.ts';
import { BranchGcFileSettings, Config, ConfigUpdate } from '../shared/contracts/config.ts';
import { FLYING_ANIMALS_DEFAULTS } from '../shared/settings-ranges.ts';
import { FILE_ONLY_GROUPS, SETTINGS_MOVED_SETTINGS, SETTINGS_REGISTRY, SETTINGS_SECTION_ALIASES } from '../shared/settings/registry.ts';
import type { SettingsSetting } from '../shared/settings/registry.ts';
import {
  SETTINGS_INDEX, displayNumber, indexSettings, parseSettingsHash, settingsBlockSpec, settingsGroupOf, settingsOf, storedNumber,
} from '../shared/settings/registry-core.ts';
import { UPDATES_ACTIONS_SETTING_ID, UPDATES_SECTION_ID } from '../public/radar/radar-core.ts';
import { TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID } from '../public/github/team-review-view-core.ts';

const ROOT = path.join(import.meta.dirname, '..');
const ALL_ENTRIES: readonly SettingsSetting[] = [...settingsOf(SETTINGS_REGISTRY.sections), ...SETTINGS_REGISTRY.fileOnly];
const CONFIG_ENTRIES = ALL_ENTRIES.filter((setting) => !setting.path.startsWith('pref:') && !setting.path.startsWith('status:'));
const SCOPES = new Set(['browser', 'machine']);
const ACCESS_VALUES = new Set(['editable', 'advanced', 'readout', 'file-only']);
const EFFECTS = new Set(['now', 'new-sessions', 'restart']);
const INGEST_SOURCE_TOGGLE = /^ingest\.sources\.[A-Za-z]+\.enabled$/;

interface SchemaDef {
  type: string;
  innerType?: unknown;
  in?: unknown;
  element?: unknown;
  shape?: Record<string, unknown>;
  entries?: Record<string, unknown>;
}

const WRAPPER_TYPES = new Set(['optional', 'nullable', 'default', 'prefault', 'nonoptional', 'catch', 'readonly']);

function defOf(schema: unknown): SchemaDef {
  const def = (schema as { _zod?: { def?: SchemaDef } } | null | undefined)?._zod?.def;
  assert.ok(def, 'expected a zod schema');
  return def;
}

function leafDef(schema: unknown): SchemaDef {
  let def = defOf(schema);
  while (WRAPPER_TYPES.has(def.type) || def.type === 'pipe') {
    def = defOf(def.type === 'pipe' ? def.in : def.innerType);
  }
  return def;
}

function leafPaths(schema: unknown, prefix = ''): Map<string, SchemaDef> {
  const leaves = new Map<string, SchemaDef>();
  for (const [key, child] of Object.entries(leafDef(schema).shape ?? {})) {
    const childDef = leafDef(child);
    const childPath = `${prefix}${key}`;
    if (childDef.type === 'object' && Object.keys(childDef.shape ?? {}).length > 0) {
      for (const [nestedPath, nestedDef] of leafPaths(child, `${childPath}.`)) leaves.set(nestedPath, nestedDef);
      continue;
    }
    leaves.set(childPath, childDef);
  }
  return leaves;
}

const UPDATE_LEAVES = leafPaths(ConfigUpdate);
const FILE_LEAVES = leafPaths(Config);
const BRANCH_GC_LEAVES = leafPaths(BranchGcFileSettings, 'branchGc.');

function schemaLeafOf(settingPath: string): SchemaDef | undefined {
  return UPDATE_LEAVES.get(settingPath) ?? FILE_LEAVES.get(settingPath) ?? BRANCH_GC_LEAVES.get(settingPath);
}

function payloadAtPath(settingPath: string, value: unknown): Record<string, unknown> {
  return settingPath.split('.').reverse().reduce<Record<string, unknown>>((block, key, index) => ({ [key]: index === 0 ? value : block }), {});
}

function schemaAccepts(settingPath: string, value: unknown): boolean {
  if (UPDATE_LEAVES.has(settingPath)) return ConfigUpdate.safeParse(payloadAtPath(settingPath, value)).success;
  if (FILE_LEAVES.has(settingPath)) return Config.safeParse({ projects: [], ...payloadAtPath(settingPath, value) }).success;
  assert.ok(BRANCH_GC_LEAVES.has(settingPath), `${settingPath} has no schema to probe`);
  return BranchGcFileSettings.safeParse(payloadAtPath(settingPath, value).branchGc).success;
}

function expectedControls(def: SchemaDef): readonly string[] {
  if (def.type === 'boolean') return ['toggle'];
  if (def.type === 'number') return ['number'];
  if (def.type === 'string') return ['text', 'password'];
  if (def.type === 'enum') return ['select'];
  if (def.type === 'array') return leafDef(def.element).type === 'string' ? ['list', 'projects'] : ['json'];
  if (def.type === 'record' || def.type === 'object') return ['json'];
  if (def.type === 'union') return ['text'];
  assert.fail(`no control is defined for a ${def.type} leaf`);
}

function defaultAtPath(settingPath: string): unknown {
  let cursor: unknown = DEFAULT_CONFIG;
  for (const segment of settingPath.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

test('every key the update schema accepts has exactly one registry entry', () => {
  assert.ok(UPDATE_LEAVES.size > 80, `expected to enumerate the update schema, found ${UPDATE_LEAVES.size} leaves`);
  const entriesByPath = new Map<string, SettingsSetting[]>();
  for (const setting of CONFIG_ENTRIES) entriesByPath.set(setting.path, [...(entriesByPath.get(setting.path) ?? []), setting]);
  const uncovered = [...UPDATE_LEAVES.keys()].filter((leaf) => (entriesByPath.get(leaf) ?? []).length !== 1);
  assert.deepEqual(uncovered, [], 'each update key needs one section entry or one file-only listing');
});

test('ids and paths are unique across sections and the file-only listing', () => {
  const ids = ALL_ENTRIES.map((setting) => setting.id);
  const paths = ALL_ENTRIES.map((setting) => setting.path);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(paths).size, paths.length);
  const sectionIds = SETTINGS_REGISTRY.sections.map((section) => section.id);
  assert.equal(new Set(sectionIds).size, sectionIds.length);
});

test('each control agrees with its schema type', () => {
  for (const setting of CONFIG_ENTRIES) {
    const def = schemaLeafOf(setting.path);
    if (!def) {
      assert.match(setting.path, INGEST_SOURCE_TOGGLE, `${setting.path} names no schema leaf`);
      assert.equal(setting.control, 'toggle', setting.path);
      continue;
    }
    assert.ok(expectedControls(def).includes(setting.control), `${setting.path} is a ${def.type} leaf but uses the ${setting.control} control`);
    if (def.type === 'enum') assert.deepEqual(setting.options?.map((option) => option.value), Object.values(def.entries ?? {}), setting.path);
    if (def.type === 'union') assert.ok(setting.valueKind, `${setting.path} needs a valueKind to parse its union`);
  }
});

test('each number has a unit and a range the schema agrees with at its edges', () => {
  const numbers = CONFIG_ENTRIES.filter((setting) => setting.control === 'number');
  assert.ok(numbers.length > 30);
  for (const setting of numbers) {
    const { range, unit } = setting;
    assert.ok(range, `${setting.path} has no range`);
    assert.ok(unit?.label && unit.storedPerDisplay > 0, `${setting.path} has no display unit`);
    const isWhole = setting.integer !== false;
    const step = isWhole ? 1 : 0.5;
    const lowestValid = range.exclusiveMin ? range.min + step : range.min;
    const belowRange = range.exclusiveMin ? range.min : range.min - step;
    assert.equal(schemaAccepts(setting.path, lowestValid), true, `${setting.path} rejects ${lowestValid}, its range floor`);
    assert.equal(schemaAccepts(setting.path, belowRange), false, `${setting.path} accepts ${belowRange}, below its range`);
    if (range.max == null) {
      assert.equal(schemaAccepts(setting.path, isWhole ? Number.MAX_SAFE_INTEGER : 1e12), true, `${setting.path} has a ceiling its range does not name`);
    }
    if (range.max != null) {
      assert.equal(schemaAccepts(setting.path, range.max), true, `${setting.path} rejects ${range.max}, its range ceiling`);
      assert.equal(schemaAccepts(setting.path, range.max + step), false, `${setting.path} accepts ${range.max + step}, above its range`);
    }
    const fraction = (range.exclusiveMin ? range.min + 1 : range.min) + 0.5;
    assert.equal(schemaAccepts(setting.path, fraction), !isWhole, `${setting.path} disagrees with the schema on whole numbers`);
  }
});

test('each entry has a title, a description, two keywords, a scope, an access and an effect value', () => {
  for (const setting of ALL_ENTRIES) {
    assert.ok(setting.title.trim(), `${setting.id} needs a title`);
    assert.ok(setting.description.trim(), `${setting.id} needs a description`);
    assert.ok(setting.keywords.length >= 2, `${setting.id} needs two keywords`);
    assert.ok(SCOPES.has(setting.scope), `${setting.id} scope ${setting.scope}`);
    assert.ok(ACCESS_VALUES.has(setting.access), `${setting.id} access ${setting.access}`);
    assert.ok(EFFECTS.has(setting.takesEffect), `${setting.id} effect ${setting.takesEffect}`);
    assert.equal(setting.scope === 'browser', setting.path.startsWith('pref:'), `${setting.id} scope disagrees with its path`);
    assert.equal(setting.access === 'file-only', Boolean(setting.fileOnlyReason), `${setting.id} needs a fileOnlyReason exactly when file-only`);
    assert.equal(setting.control === 'readonly', setting.access === 'readout', `${setting.id} readout rows are the readonly controls`);
    if (setting.access !== 'readout') assert.ok('defaultValue' in setting, `${setting.id} needs a defaultValue`);
  }
  for (const setting of settingsOf(SETTINGS_REGISTRY.sections)) assert.notEqual(setting.access, 'file-only', `${setting.id} is file-only and belongs in the file-only listing`);
  for (const setting of SETTINGS_REGISTRY.fileOnly) {
    assert.equal(setting.access, 'file-only', setting.id);
    assert.ok(setting.group && settingsGroupOf(setting.group), `${setting.id} names no reference group`);
  }
  for (const groupId of Object.keys(FILE_ONLY_GROUPS)) assert.equal(SETTINGS_REGISTRY.sections.some((section) => section.id === groupId), false, `${groupId} is both a section and a file-only group`);
});

test('every default equals DEFAULT_CONFIG wherever that names the path', () => {
  let compared = 0;
  for (const setting of CONFIG_ENTRIES) {
    const serverDefault = defaultAtPath(setting.path);
    if (serverDefault === undefined) continue;
    compared += 1;
    assert.deepEqual(setting.defaultValue, serverDefault, `${setting.path} default drifted from DEFAULT_CONFIG`);
  }
  assert.ok(compared > 40, `expected DEFAULT_CONFIG to name most registry paths, compared ${compared}`);
});

test('the alias and moved-setting tables come from the legacy ids and resolve to live sections', () => {
  assert.deepEqual(SETTINGS_SECTION_ALIASES, {
    animals: 'browser-flying-animals',
    'flying-animals': 'browser-flying-animals',
    shortcuts: 'browser-shortcuts',
    general: 'machine-general',
    updates: 'machine-updates',
    repos: 'machine-repositories',
    repositories: 'machine-repositories',
    telegram: 'machine-telegram',
    notifications: 'machine-telegram',
    usage: 'machine-usage',
    privacy: 'machine-privacy',
    telemetry: 'machine-privacy',
    'change-map': 'lanes-change-map',
    visions: 'lanes-visions',
    ingest: 'lanes-ingest',
    posthog: 'lanes-posthog',
    'team-review': 'lanes-team-review',
    reviews: 'lanes-team-review',
    benchmarks: 'lanes-benchmarks',
    factory: 'lanes-factory',
    'knowledge-graph': 'lanes-knowledge-graph',
    workflows: 'lanes-workflows',
    unattended: 'lanes-unattended',
  });
  assert.deepEqual(SETTINGS_MOVED_SETTINGS, { 'browser-appearance': { 'flying-animals': 'browser-flying-animals' } });
  const sectionIds = new Set(SETTINGS_REGISTRY.sections.map((section) => section.id));
  for (const [alias, sectionId] of Object.entries(SETTINGS_SECTION_ALIASES)) {
    assert.equal(sectionIds.has(alias), false, `${alias} shadows a section id`);
    assert.equal(sectionIds.has(sectionId), true, `${alias} resolves to missing ${sectionId}`);
  }
});

test('the byId and byPath maps cover every entry from one pass', () => {
  assert.equal(SETTINGS_INDEX.byId.size, ALL_ENTRIES.length);
  assert.equal(SETTINGS_INDEX.byPath.size, ALL_ENTRIES.length);
  assert.equal(SETTINGS_INDEX.byPath.get('cursorBlink')?.id, 'file-cursor-blink');
  assert.equal(SETTINGS_INDEX.byId.get('visions-enabled')?.path, 'visions.enabled');
  const small = indexSettings({ sections: [SETTINGS_REGISTRY.sections[0]], fileOnly: [] });
  assert.deepEqual([...small.byId.keys()], SETTINGS_REGISTRY.sections[0].settings.map((setting) => setting.id));
});

test('unit conversion scales both ways and rounds whole-number settings', () => {
  const quiet = SETTINGS_INDEX.byPath.get('visions.dispatch.quietMs');
  assert.ok(quiet);
  const inSeconds: SettingsSetting = { ...quiet, unit: { label: 'seconds', storedPerDisplay: 1000 } };
  assert.equal(displayNumber(inSeconds, 30000), 30);
  assert.equal(storedNumber(inSeconds, 30), 30000);
  assert.equal(storedNumber(inSeconds, 0.0004), 0);
  assert.equal(storedNumber({ ...inSeconds, integer: false }, 0.0004), 0.4);
  for (const setting of CONFIG_ENTRIES.filter((entry) => entry.control === 'number' && typeof entry.defaultValue === 'number')) {
    assert.equal(storedNumber(setting, displayNumber(setting, setting.defaultValue as number)), setting.defaultValue, setting.path);
  }
});

test('the block spec builder reproduces the server ingest spec from the registry', () => {
  assert.deepEqual(settingsBlockSpec('ingest'), INGEST_SPEC);
  assert.deepEqual(settingsBlockSpec('telemetry'), { name: 'telemetry', booleans: ['enabled'], blocks: {} });
});

const KNOWN_LINK_IDS: Readonly<Record<string, string>> = Object.freeze({
  UPDATES_SECTION_ID, UPDATES_ACTIONS_SETTING_ID, TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID,
});

function browserSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : browserSourceFiles(absolutePath);
    return entry.name.endsWith('.ts') ? [absolutePath] : [];
  });
}

function linkArgument(raw: string, file: string): string {
  const literal = /^['"]([^'"]+)['"]$/.exec(raw);
  if (literal) return literal[1];
  const known = KNOWN_LINK_IDS[raw];
  assert.ok(known, `${file}: createSettingsLink argument ${raw} is neither a string literal nor a known id constant`);
  return known;
}

function resolvesToLiveIds(sectionId: string, settingId: string | null) {
  const hash = `#settings/${sectionId}${settingId ? `/${settingId}` : ''}`;
  return parseSettingsHash(hash, SETTINGS_REGISTRY.sections, SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS) !== null;
}

test('every createSettingsLink call and #settings/ literal in public/ names a live id', () => {
  let linkCount = 0;
  for (const file of browserSourceFiles(path.join(ROOT, 'public'))) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(ROOT, file);
    for (const match of source.matchAll(/(?<!function )createSettingsLink\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,/g)) {
      linkCount += 1;
      const sectionId = linkArgument(match[1], relative);
      const settingId = linkArgument(match[2], relative);
      assert.ok(resolvesToLiveIds(sectionId, settingId), `${relative}: #settings/${sectionId}/${settingId} names a missing id`);
    }
    for (const match of source.matchAll(/['"`]#settings\/([^'"`$]+)['"`]/g)) {
      linkCount += 1;
      const [sectionId, settingId = null] = match[1].split('/');
      assert.ok(resolvesToLiveIds(sectionId, settingId), `${relative}: #settings/${match[1]} names a missing id`);
    }
  }
  assert.ok(linkCount >= 6, `expected the banner, notice and panel links, found ${linkCount}`);
  for (const section of SETTINGS_REGISTRY.sections) {
    for (const link of section.unattendedLinks ?? []) assert.ok(resolvesToLiveIds('lanes-unattended', link.settingId), `${section.id} links to missing ${link.settingId}`);
  }
});

test('the pre-existing deep links from the banner, the notice and the panels still open their settings', () => {
  for (const [sectionId, settingId] of [
    [UPDATES_SECTION_ID, UPDATES_ACTIONS_SETTING_ID],
    ['privacy', 'telemetry-enabled'],
    ['lanes-visions', 'visions-enabled'],
    ['machine-usage', 'usage-daily-budget'],
    ['lanes-posthog', 'posthog-enabled'],
    [TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID],
  ]) {
    assert.ok(resolvesToLiveIds(sectionId, settingId), `#settings/${sectionId}/${settingId}`);
  }
});

const SECTIONS = SETTINGS_REGISTRY.sections;

function settingById(id: string): SettingsSetting {
  const setting = SETTINGS_INDEX.byId.get(id);
  assert.ok(setting, `no registry entry ${id}`);
  return setting;
}

function sectionById(id: string) {
  const section = SECTIONS.find((candidate) => candidate.id === id);
  assert.ok(section, `no section ${id}`);
  return section;
}

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

function pathIsKnown(settingPath: string): boolean {
  if (settingPath.startsWith('pref:')) return true;
  const [topLevel, ...remaining] = settingPath.split('.');
  if (Object.hasOwn(DEFAULT_CONFIG_RECORD, topLevel)) {
    return walkPath(DEFAULT_CONFIG_RECORD[topLevel], remaining);
  }
  if (DASHBOARD_SETTING_PATH_SET.has(settingPath)) return true;
  const blockSpec = BLOCK_SPECS_BY_KEY[topLevel];
  return !!blockSpec && specAllows(blockSpec, remaining);
}

test('the registry has known paths, status readouts and searchable option catalogs', () => {
  for (const setting of ALL_ENTRIES) {
    if (setting.path.startsWith('status:')) {
      assert.equal(setting.control, 'readonly', setting.id);
      if (setting.path.startsWith('status:update-')) assert.equal(setting.status, setting.id);
      assert.ok(setting.status, `${setting.id} needs a status readout`);
      continue;
    }
    assert.equal(pathIsKnown(setting.path), true, `unknown path ${setting.path}`);
    if (setting.optionsFrom) assert.equal(OPTION_CATALOGS.has(setting.optionsFrom), true, `${setting.id} needs a known option catalog`);
  }
});

test('the registry never exposes remote and ingest keys stay inside the dashboard allow-list', () => {
  assert.equal(ALL_ENTRIES.some((setting) => setting.path === 'remote' || setting.path.startsWith('remote.')), false);
  for (const setting of ALL_ENTRIES.filter((entry) => entry.path.startsWith('ingest.'))) {
    assert.equal(specAllows(INGEST_SPEC, setting.path.split('.').slice(1)), true, setting.path);
  }
  assert.equal(pathIsKnown('visions.dispatch.quietMS'), false);
});

test('the machine Updates section owns its alias, channel, status rows, actions and moved toggle', () => {
  const updates = sectionById('machine-updates');
  assert.equal(updates.level, 'machine');
  assert.equal(SETTINGS_SECTION_ALIASES.updates, 'machine-updates');
  assert.deepEqual(updates.settings.map((setting) => setting.id), [
    'update-summary',
    'update-actions',
    'update-installed',
    'update-latest',
    'update-last-checked',
    'update-channel',
    'check-updates',
  ]);
  assert.deepEqual(settingById('update-channel').options,
    UPDATE_CHANNELS.map((value) => ({ value, label: value === 'release' ? 'Release' : 'Main' })));
  const toggleOwners = SECTIONS.filter((section) => section.settings.some((setting) => setting.id === 'check-updates'));
  assert.deepEqual(toggleOwners.map((section) => section.id), ['machine-updates']);
});

test('the update deep link the banner and the Radar ops row share resolves to a real section and setting', () => {
  const section = sectionById(UPDATES_SECTION_ID);
  assert.ok(section.settings.some((setting) => setting.id === UPDATES_ACTIONS_SETTING_ID), 'the deep link names a missing setting');
});

test('the tuning knobs, diagnostics and legacy team keys are the file-only listing', () => {
  const fileOnlyPaths = SETTINGS_REGISTRY.fileOnly.map((setting) => setting.path);
  for (const settingPath of [
    'teamReview.org', 'teamReview.team',
    'visions.dispatch.quietMs', 'visions.dispatch.cooldownMs', 'visions.dispatch.dispatchTimeoutSeconds', 'visions.dispatch.activityMaxPerHour', 'visions.intent.threadTtlMs',
    'posthog.investigationTimeoutSeconds', 'posthog.fixTimeoutSeconds', 'posthog.userEscalationThreshold',
    'posthog.trafficSpikeMultiplier', 'posthog.trafficSpikeMinUsers', 'posthog.trafficSpikeCooldownMinutes', 'posthog.trafficSpikeBaselineDays',
    'changeMap.narrator.timeoutSeconds', 'workflows.maxActionsPerPoll',
    'usage.scanIntervalMinutes', 'usage.fetchPricing', 'usage.costMode', 'usage.vendors.codex', 'usage.vendors.grok',
    'replayBufferKB', 'cursorBlink',
    'ingest.sources.terminal.enabled', 'ingest.sources.agentLogs.enabled', 'ingest.sources.git.enabled', 'ingest.sources.fs.enabled', 'ingest.sources.shellHistory.enabled', 'ingest.sources.editor.enabled',
    'debugMode', 'recordSignals', 'trace.enabled', 'detectScheduledWakeups',
    'autoRecoverSeconds', 'inputGraceSeconds', 'promptDetectionMs', 'notifyDebounceMs', 'phoneEscalationMs',
  ]) {
    assert.ok(fileOnlyPaths.includes(settingPath), `${settingPath} should be file-only`);
  }
  const editable = settingsOf(SECTIONS).filter((setting) => setting.access === 'editable' || setting.access === 'advanced');
  assert.ok(editable.length >= 60 && editable.length <= 80, `${editable.length} editable entries`);
  assert.equal(settingById('file-team-review-org').group, 'lanes-team-review');
  assert.match(settingById('file-team-review-team').fileOnlyReason ?? '', /legacy/);
});

test('the agent API row is gone and the custom agents readout sits beside its file-only key', () => {
  assert.equal(ALL_ENTRIES.some((setting) => setting.path.startsWith('agentApi')), false);
  assert.equal(DASHBOARD_SETTING_PATH_SET.has('agentApi.enabled'), false);

  const readout = settingById('custom-agents');
  assert.equal(readout.control, 'readonly');
  assert.equal(readout.status, 'custom-agents');
  assert.ok(sectionById('machine-general').settings.includes(readout));
  const key = settingById('file-custom-agents');
  assert.equal(key.path, 'customAgents');
  assert.equal(key.access, 'file-only');
  assert.equal(DASHBOARD_SETTING_PATH_SET.has('customAgents'), false);
});

test('the Team review lane section owns its settings and deep link, with org and team left to config.json', () => {
  const section = sectionById(TEAM_REVIEW_SETTINGS_SECTION_ID);
  assert.equal(section.level, 'lanes');
  assert.equal(SETTINGS_SECTION_ALIASES['team-review'], TEAM_REVIEW_SETTINGS_SECTION_ID);
  assert.deepEqual(section.settings.map((setting) => [setting.id, setting.path, setting.control]), [
    ['team-review-enabled', 'teamReview.enabled', 'toggle'],
    ['github-teams', 'github.teams', 'list'],
    ['team-review-re-review-after-hours', 'teamReview.reReviewAfterHours', 'number'],
    ['team-review-skip-idle-after-days', 'teamReview.skipIdleAfterDays', 'number'],
    ['team-review-skill', 'teamReview.skill', 'text'],
    ['team-review-auto-rebase-my-prs', 'teamReview.autoRebaseMyPrs', 'toggle'],
    ['team-review-keep-mergeable-enabled', 'teamReview.keepMergeableEnabled', 'toggle'],
    ['team-review-keep-mergeable-timeout', 'teamReview.keepMergeableTimeoutMinutes', 'number'],
    ['team-review-merge-queue-enabled', 'teamReview.mergeQueueEnabled', 'toggle'],
  ]);
  assert.equal(section.settings.some((setting) => setting.id === TEAM_REVIEW_SETTINGS_SETTING_ID), true);
  for (const setting of section.settings) assert.equal(DASHBOARD_SETTING_PATH_SET.has(setting.path), true, setting.path);
  assert.deepEqual(SETTINGS_REGISTRY.fileOnly.filter((setting) => setting.path.startsWith('teamReview.')).map((setting) => setting.path), ['teamReview.org', 'teamReview.team']);
});

test('Flying animals follows Appearance and owns its stable toggle and searchable advanced controls', () => {
  const appearanceIndex = SECTIONS.findIndex((section) => section.id === 'browser-appearance');
  const animals = SECTIONS[appearanceIndex + 1];
  assert.equal(animals.id, 'browser-flying-animals');
  assert.equal(animals.level, 'browser');
  assert.equal(SETTINGS_SECTION_ALIASES.animals, animals.id);
  assert.equal(SETTINGS_SECTION_ALIASES['flying-animals'], animals.id);
  const settings = animals.settings;
  assert.equal(settings.find((setting) => setting.id === 'flying-animals')?.path, 'pref:flyingAnimalsEnabled');
  assert.equal(SECTIONS[appearanceIndex].settings.some((setting) => setting.id === 'flying-animals'), false);
  assert.equal(settings.filter((setting) => setting.access === 'advanced').length, 6);
  assert.equal(settings.filter((setting) => setting.control === 'number').every((setting) => setting.commitOnChange === true), true);
  assert.equal(settings.every((setting) => setting.path.startsWith('pref:') && setting.scope === 'browser'), true);
  for (const [key, value] of Object.entries(FLYING_ANIMALS_DEFAULTS)) {
    assert.equal(settings.find((setting) => setting.path === `pref:${key}`)?.defaultValue, value, key);
  }
});

test('the machine Privacy section owns the telemetry toggle and the privacy deep link', () => {
  const privacy = sectionById('machine-privacy');
  assert.equal(privacy.level, 'machine');
  assert.equal(SETTINGS_SECTION_ALIASES.privacy, 'machine-privacy');
  const toggle = privacy.settings.find((setting) => setting.path === 'telemetry.enabled');
  assert.equal(toggle?.control, 'toggle');
  assert.equal(toggle?.defaultValue, DEFAULT_CONFIG.telemetry.enabled);
  assert.equal(DASHBOARD_SETTING_PATH_SET.has('telemetry.enabled'), true);
});
