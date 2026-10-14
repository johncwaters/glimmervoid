import { FILE_ONLY_GROUPS, SETTINGS_REGISTRY } from './registry.ts';
import type { SettingsGroup, SettingsLevel, SettingsRegistry, SettingsSection, SettingsSetting } from './registry.ts';

export interface SettingsBlockSpec {
  name: string;
  booleans: readonly string[];
  blocks: Readonly<Record<string, SettingsBlockSpec>>;
}

export interface SettingsSearchResult {
  section: SettingsSection | null;
  setting: SettingsSetting;
  score: number;
}

interface SettingsIndex {
  byId: ReadonlyMap<string, SettingsSetting>;
  byPath: ReadonlyMap<string, SettingsSetting>;
}

type ClonedContainer = unknown[] | Record<string, unknown>;

export function cloneValue(value: unknown): unknown {
  const containersToFill: [original: object, copy: ClonedContainer][] = [];
  const startCopyOf = (original: unknown): unknown => {
    if (!original || typeof original !== 'object') return original;
    const copy: ClonedContainer = Array.isArray(original) ? [] : {};
    containersToFill.push([original, copy]);
    return copy;
  };
  const root = startCopyOf(value);
  for (let next = containersToFill.pop(); next; next = containersToFill.pop()) {
    const [original, copy] = next;
    for (const [key, nested] of Object.entries(original)) {
      Object.defineProperty(copy, key, { value: startCopyOf(nested), writable: true, enumerable: true, configurable: true });
    }
  }
  return root;
}

export function valueAtPath(source: unknown, path: string): unknown {
  let value: unknown = source;
  for (const part of path.split('.')) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function deleteValueAtPath(target: unknown, path: string) {
  const parts = path.split('.');
  let cursor: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object') return;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor && typeof cursor === 'object') delete (cursor as Record<string, unknown>)[parts.at(-1) as string];
}

export function setValueAtPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1) as string] = cloneValue(value);
}

export function settingsOf(sections: readonly SettingsSection[]): SettingsSetting[] {
  return sections.flatMap((section) => section.settings);
}

export function isReadOnlySetting(setting: SettingsSetting): boolean {
  return setting.access === 'file-only' || setting.control === 'readonly';
}

export function parsePosthogProjectSelection(value: unknown): 'all' | number[] | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'all') return 'all';
  if (text === 'none') return [];
  const tokens = text.split(',').map((token) => token.trim());
  if (!tokens.every((token) => /^\d+$/.test(token) && Number.isSafeInteger(Number(token)) && Number(token) > 0)) return null;
  return tokens.map(Number);
}

export function displayValue(setting: SettingsSetting, value: unknown): unknown {
  if (setting.valueKind !== 'posthog-projects') return cloneValue(value);
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.join(', ');
  return value ?? 'all';
}

export function wireValue(setting: SettingsSetting, value: unknown): unknown {
  if (setting.control === 'number') {
    if (setting.nullable && (value == null || String(value).trim() === '')) return null;
    const number = Number(value);
    if (setting.zeroIsNull && number <= 0) return null;
    return number;
  }
  if (setting.valueKind === 'posthog-projects') {
    return parsePosthogProjectSelection(value);
  }
  if (setting.control === 'text' || setting.control === 'password') {
    const text = String(value ?? '').trim();
    if (setting.nullable && !text) return null;
    return text;
  }
  return cloneValue(value);
}

export function displayNumber(setting: SettingsSetting, stored: number): number {
  return stored / (setting.unit?.storedPerDisplay ?? 1);
}

export function storedNumber(setting: SettingsSetting, display: number): number {
  const stored = display * (setting.unit?.storedPerDisplay ?? 1);
  return setting.integer === false ? stored : Math.round(stored);
}

function searchTokens(value: unknown) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

const EXACT_MATCH_QUALITY = 3;
const PREFIX_MATCH_QUALITY = 2;
const INFIX_MATCH_QUALITY = 1;
const MIN_INFIX_QUERY_LENGTH = 3;
const SEARCH_RESULT_LIMIT = 30;

function tokenMatchQuality(fieldToken: string, queryToken: string) {
  if (fieldToken === queryToken) return EXACT_MATCH_QUALITY;
  if (fieldToken.startsWith(queryToken)) return PREFIX_MATCH_QUALITY;
  if (queryToken.length >= MIN_INFIX_QUERY_LENGTH && fieldToken.includes(queryToken)) return INFIX_MATCH_QUALITY;
  return 0;
}

function fieldScore(tokens: string[], queryTokens: string[], weight: number) {
  let totalMatchQuality = 0;
  for (const queryToken of queryTokens) {
    const bestMatchQuality = Math.max(0, ...tokens.map((fieldToken) => tokenMatchQuality(fieldToken, queryToken)));
    if (bestMatchQuality === 0) return 0;
    totalMatchQuality += bestMatchQuality;
  }
  return totalMatchQuality * weight;
}

function settingScore(setting: SettingsSetting, sectionTokens: string[], queryTokens: string[]) {
  const titleScore = fieldScore(searchTokens(setting.title), queryTokens, 1000);
  const keywordScore = fieldScore(searchTokens(setting.keywords.join(' ')), queryTokens, 100);
  const sectionScore = fieldScore(sectionTokens, queryTokens, 10);
  const descriptionScore = fieldScore(searchTokens(setting.description), queryTokens, 1);
  return titleScore + keywordScore + sectionScore + descriptionScore;
}

function resultGroupTitle(result: SettingsSearchResult) {
  return result.section?.title ?? '';
}

export function scoreSettingsSearch(
  sections: readonly SettingsSection[],
  query: unknown,
  fileOnly: readonly SettingsSetting[] = [],
): SettingsSearchResult[] {
  const queryTokens = searchTokens(query);
  if (queryTokens.length === 0) return [];
  const results: SettingsSearchResult[] = [];
  for (const section of sections) {
    const sectionTokens = searchTokens(section.title);
    for (const setting of section.settings) {
      const score = settingScore(setting, sectionTokens, queryTokens);
      if (score === 0) continue;
      results.push({ section, setting, score });
    }
  }
  for (const setting of fileOnly) {
    const score = settingScore(setting, searchTokens(setting.path), queryTokens);
    if (score === 0) continue;
    results.push({ section: null, setting, score });
  }
  return results
    .sort((left, right) => right.score - left.score
      || resultGroupTitle(left).localeCompare(resultGroupTitle(right))
      || left.setting.title.localeCompare(right.setting.title))
    .slice(0, SEARCH_RESULT_LIMIT);
}

export function parseSettingsHash(
  hash: unknown,
  sections: readonly SettingsSection[],
  aliases: Readonly<Record<string, string>> = {},
  movedSettings: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
) {
  const match = /^#settings\/([^/]+)(?:\/([^/]+))?$/.exec(String(hash || ''));
  if (!match) return null;
  let requestedSectionId: string;
  let requestedSettingId: string | null;
  try {
    requestedSectionId = decodeURIComponent(match[1]);
    requestedSettingId = match[2] ? decodeURIComponent(match[2]) : null;
  } catch {
    return null;
  }
  const movedSectionId = requestedSettingId ? movedSettings[requestedSectionId]?.[requestedSettingId] : undefined;
  const sectionId = movedSectionId || aliases[requestedSectionId] || requestedSectionId;
  const section = sections.find((entry) => entry.id === sectionId);
  if (!section) return null;
  const setting = requestedSettingId
    ? section.settings.find((entry) => entry.id === requestedSettingId)
    : null;
  if (requestedSettingId && !setting) return null;
  return {
    sectionId,
    settingId: setting?.id || null,
    hash: `#settings/${sectionId}${setting ? `/${setting.id}` : ''}`,
  };
}

export function sectionsByLevel(sections: readonly SettingsSection[]): Record<SettingsLevel, SettingsSection[]> {
  const grouped: Record<SettingsLevel, SettingsSection[]> = { browser: [], machine: [], lanes: [], projects: [] };
  for (const section of sections) grouped[section.level].push(section);
  return grouped;
}

export function orderSections(sections: readonly SettingsSection[]): SettingsSection[] {
  const unattendedId = 'lanes-unattended';
  const unattended = sections.find((section) => section.id === unattendedId);
  if (!unattended) return [...sections];
  const ordered = sections.filter((section) => section.id !== unattendedId);
  const lastLaneIndex = ordered.findLastIndex((section) => section.level === 'lanes');
  ordered.splice(lastLaneIndex + 1, 0, unattended);
  return ordered;
}

export function indexSettings(registry: SettingsRegistry): SettingsIndex {
  const byId = new Map<string, SettingsSetting>();
  const byPath = new Map<string, SettingsSetting>();
  for (const setting of [...settingsOf(registry.sections), ...registry.fileOnly]) {
    byId.set(setting.id, setting);
    byPath.set(setting.path, setting);
  }
  return { byId, byPath };
}

export const SETTINGS_INDEX: SettingsIndex = indexSettings(SETTINGS_REGISTRY);

export function settingsGroupOf(groupId: string, registry: SettingsRegistry = SETTINGS_REGISTRY): SettingsGroup | null {
  const section = registry.sections.find((candidate) => candidate.id === groupId);
  if (section) return { title: section.title, description: section.description };
  return FILE_ONLY_GROUPS[groupId] ?? null;
}

interface MutableBlockSpec {
  name: string;
  booleans: string[];
  blocks: Record<string, MutableBlockSpec>;
}

export function settingsBlockSpec(topLevelKey: string, registry: SettingsRegistry = SETTINGS_REGISTRY): SettingsBlockSpec {
  const root: MutableBlockSpec = { name: topLevelKey, booleans: [], blocks: {} };
  const prefix = `${topLevelKey}.`;
  for (const setting of [...settingsOf(registry.sections), ...registry.fileOnly]) {
    if (!setting.path.startsWith(prefix) || setting.control !== 'toggle') continue;
    const parts = setting.path.slice(prefix.length).split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node.blocks[part] ??= { name: `${node.name}.${part}`, booleans: [], blocks: {} };
      node = node.blocks[part];
    }
    node.booleans.push(parts.at(-1) as string);
  }
  return root;
}
