import { WorkflowsSettings } from '#shared/contracts/workflows.ts';
import type { WorkflowRule } from '#shared/contracts/workflows.ts';
import type { SettingsRange } from '#shared/settings-ranges.ts';
import type { SettingsChoicePresentation, SettingsEffect, SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import {
  cloneValue, deleteValueAtPath, displayText, displayValue, formatDisplayNumber, hasScaledUnit, isReadOnlySetting, setValueAtPath, settingsOf, valueAtPath,
  settingsGroupOf, wireValue,
} from '#shared/settings/registry-core.ts';
import { projectSelectionChoices, unionProjectSelection } from './settings-projects-core.ts';

export type SettingsValues = Record<string, unknown>;

export interface SettingsPayload {
  prefs?: Record<string, unknown>;
  projectChoices?: unknown;
  [key: string]: unknown;
}

export interface WorkflowRuleToggleRow {
  id: string;
  name: string;
  isEnabled: boolean;
  summary: string;
}

export interface ControlDraft {
  base: unknown;
  isDirty: boolean;
}

type DraftCommit =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string }
  | { kind: 'changed'; value: unknown };

const payloadByHydratedValues = new WeakMap<object, unknown>();

export const SECRET_PRESENCE_SUFFIX = 'Configured';
export const STORED_SECRET_MASK = String.fromCharCode(0x2022).repeat(12);
const POSTHOG_PROJECTS_ERROR = 'Each line must be a positive whole-number PostHog project id, or the one word none.';
const SEGMENTED_CHOICE_LIMIT = 3;
const MAX_SEARCH_QUERY_LENGTH = 200;
const PATHS_SUMMARIZED_IN_PAYLOAD: ReadonlySet<string> = new Set(['customAgents']);
const INTEGER_TOLERANCE = 1e-9;
const LANES_HEADING = 'Lanes';

export const EFFECT_LABELS: Readonly<Record<SettingsEffect, string>> = Object.freeze({
  now: 'Applies now',
  'new-sessions': 'New sessions',
  restart: 'After restart',
});

export const SCOPE_LABELS: Readonly<Record<SettingsSetting['scope'], string>> = Object.freeze({
  browser: 'This browser',
  machine: 'This machine',
});

export function secretEnvironmentSource(setting: SettingsSetting, payload: SettingsPayload): string | null {
  const sources = payload.secretSources;
  if (!sources || typeof sources !== 'object') return null;
  const source = (sources as Record<string, unknown>)[setting.path];
  return typeof source === 'string' ? source : null;
}

export function rtkInstallStatusText(payload: SettingsPayload): string {
  const install = payload.rtkInstall as { status?: string; reason?: string } | undefined;
  if (install?.status === 'installing') return 'No rtk binary found. Glimmervoid is installing it into ~/.glimmervoid/bin now.';
  if (payload.rtkInstallSupported === false) return 'No rtk binary found. Automatic installation is unavailable on this server platform; install a compatible binary manually.';
  if (install?.status === 'failed') return `No rtk binary found. The last install attempt failed: ${install.reason || 'unknown reason'}. A save can retry after the ten-minute failure cooldown; saves during the cooldown skip installation.`;
  return 'No rtk binary found. Saving requests installation into ~/.glimmervoid/bin on supported server platforms, subject to installer eligibility.';
}

function isSecretSetting(setting: SettingsSetting) {
  return setting.control === 'password';
}

function secretPresencePath(setting: SettingsSetting) {
  return `${setting.path}${SECRET_PRESENCE_SUFFIX}`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return (left as unknown[]).every((value, index) => valuesEqual(value, (right as unknown[])[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key)
    && valuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function hydratedPayload(values: SettingsValues): SettingsPayload | null {
  return (payloadByHydratedValues.get(values) || null) as SettingsPayload | null;
}

export function listValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((entry) => String(entry));
}

export function listFromDraft(draft: string): string[] {
  return draft.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

export function displayRange(setting: SettingsSetting): SettingsRange | null {
  const range = setting.range;
  if (!range) return null;
  const scaled: SettingsRange = { min: Number(displayValue(setting, range.min)) };
  if (range.max != null) scaled.max = Number(displayValue(setting, range.max));
  if (range.exclusiveMin) scaled.exclusiveMin = true;
  return scaled;
}

export function fileOnlyDefaultText(setting: SettingsSetting): string {
  const shown = `Default ${displayText(setting, setting.defaultValue)}`;
  if (!hasScaledUnit(setting)) return shown;
  return `${shown}, stored as ${JSON.stringify(setting.defaultValue)} ${setting.unit?.storedLabel ?? ''}`.trimEnd();
}

export function fileOnlySearchCard(setting: SettingsSetting, payload: SettingsPayload) {
  const defaultText = fileOnlyDefaultText(setting);
  const currentValue = PATHS_SUMMARIZED_IN_PAYLOAD.has(setting.path) ? undefined : valueAtPath(payload, setting.path);
  if (currentValue === undefined) return { currentText: null, defaultText, jsonFragment: null };
  const fragment: Record<string, unknown> = {};
  setValueAtPath(fragment, setting.path, currentValue);
  return {
    currentText: `Current ${displayText(setting, currentValue)}`,
    defaultText,
    jsonFragment: JSON.stringify(fragment, null, 2),
  };
}

export function settingsSearchBreadcrumb(sections: readonly SettingsSection[], section: SettingsSection | null, setting: SettingsSetting): string {
  const group = section ?? sections.find((entry) => entry.id === setting.group);
  if (!group) return settingsGroupOf(setting.group ?? '')?.title ?? 'config.json';
  const parent = sections.find((entry) => entry.id === group.parent);
  if (parent) return `${parent.title} / ${group.title}`;
  return group.level === 'lanes' ? `${LANES_HEADING} / ${group.title}` : group.title;
}

export function parseSettingsSearchHash(hash: unknown): { query: string } | null {
  const match = /^#settings(?:\?(.*))?$/.exec(String(hash ?? ''));
  if (!match) return null;
  const query = new URLSearchParams(match[1] ?? '').get('q') ?? '';
  return { query: Array.from(query.trim()).slice(0, MAX_SEARCH_QUERY_LENGTH).join('').trim() };
}

export function childSectionsOf(sections: readonly SettingsSection[], sectionId: string): SettingsSection[] {
  return sections.filter((section) => section.parent === sectionId);
}

export function pageSectionOf(sections: readonly SettingsSection[], sectionId: string): SettingsSection | null {
  const section = sections.find((entry) => entry.id === sectionId);
  if (!section) return null;
  if (!section.parent) return section;
  return sections.find((entry) => entry.id === section.parent) ?? section;
}

export function topLevelSectionsOf(sections: readonly SettingsSection[]): SettingsSection[] {
  return sections.filter((section) => !section.parent);
}

export function settingsNavigationGroupsOf(sections: readonly SettingsSection[]): { heading: string | null; sections: SettingsSection[] }[] {
  const laneSections = sections.filter((section) => section.level === 'lanes');
  const otherSections = sections.filter((section) => section.level !== 'lanes');
  const groups = [{ heading: null, sections: otherSections }, { heading: LANES_HEADING, sections: laneSections }];
  return groups.filter((group) => group.sections.length > 0);
}

export function phoneSettingsScreenOf(
  sections: readonly SettingsSection[], sectionId: string | null, query: string, isStreamerMode: boolean,
): 'hidden' | 'list' | 'section' | 'search' {
  if (isStreamerMode) return 'hidden';
  if (query.trim()) return 'search';
  if (sectionId && pageSectionOf(sections, sectionId)) return 'section';
  return 'list';
}

export function hydrateFromSettings(sections: readonly SettingsSection[], settingsPayload: SettingsPayload = {}): SettingsValues {
  const values: SettingsValues = {};
  for (const setting of settingsOf(sections)) {
    if (isReadOnlySetting(setting)) continue;
    if (setting.path.startsWith('pref:')) {
      const preferenceName = setting.path.slice(5);
      const preferenceValue = settingsPayload.prefs?.[preferenceName] ?? settingsPayload[setting.path];
      values[setting.path] = displayValue(setting, preferenceValue ?? setting.defaultValue);
      continue;
    }
    if (isSecretSetting(setting)) {
      const isStored = valueAtPath(settingsPayload, secretPresencePath(setting)) === true;
      values[setting.path] = isStored ? STORED_SECRET_MASK : '';
      continue;
    }
    const value = valueAtPath(settingsPayload, setting.path);
    values[setting.path] = displayValue(setting, value ?? setting.defaultValue);
  }
  payloadByHydratedValues.set(values, cloneValue(settingsPayload));
  return values;
}

export function collectDirtyBlocks(sections: readonly SettingsSection[], original: SettingsValues, edited: SettingsValues): SettingsPayload {
  const changedSettings = settingsOf(sections).filter((setting) => {
    if (isReadOnlySetting(setting)) return false;
    if (setting.path.startsWith('pref:')) return false;
    if (secretEnvironmentSource(setting, hydratedPayload(original) || {})) return false;
    if (isSecretSetting(setting) && edited[setting.path] === STORED_SECRET_MASK) return false;
    return !valuesEqual(original[setting.path], edited[setting.path]);
  });
  if (changedSettings.length === 0) return {};

  const originalPayload = hydratedPayload(original) || {};
  const projectChoices: { id?: unknown }[] = Array.isArray(originalPayload.projectChoices) ? originalPayload.projectChoices : [];
  const renderedProjectIds = projectChoices.map((project) => project.id).filter((id): id is string => typeof id === 'string');
  const payload: SettingsPayload = {};
  const initializedBlocks = new Set();

  for (const setting of changedSettings) {
    const [topLevel] = setting.path.split('.');
    if (!setting.path.includes('.')) {
      payload[topLevel] = wireValue(setting, edited[setting.path]);
      continue;
    }
    if (!initializedBlocks.has(topLevel)) {
      const storedBlock = originalPayload[topLevel];
      payload[topLevel] = storedBlock && typeof storedBlock === 'object' && !Array.isArray(storedBlock)
        ? cloneValue(storedBlock)
        : {};
      initializedBlocks.add(topLevel);
    }
    let value: unknown = wireValue(setting, edited[setting.path]);
    if (setting.control === 'projects') {
      const storedSelection = original[setting.path];
      value = unionProjectSelection({
        checked: Array.isArray(value) ? value : [],
        stored: Array.isArray(storedSelection) ? storedSelection : [],
        rendered: projectSelectionChoices(renderedProjectIds.map((id) => ({ id, name: id })),
          Array.isArray(storedSelection) ? storedSelection : []).map((project) => project.id),
      });
    }
    setValueAtPath(payload, setting.path, value);
  }
  for (const setting of settingsOf(sections)) {
    if (!isSecretSetting(setting)) continue;
    deleteValueAtPath(payload, secretPresencePath(setting));
  }
  delete payload.secretSources;
  return payload;
}

export function settingSavePayload(sections: readonly SettingsSection[], stored: SettingsValues, setting: SettingsSetting, value: unknown): SettingsPayload {
  return withoutWorkflowRuleDefinitions(collectDirtyBlocks(sections, stored, { ...stored, [setting.path]: value }));
}

function unitPhrase(setting: SettingsSetting): string {
  const label = setting.unit?.label;
  return label ? ` of ${label}` : '';
}

function rangeMessage(setting: SettingsSetting) {
  const range = displayRange(setting);
  if (!range) return 'Allowed range is unavailable.';
  const isWhole = setting.integer !== false && !hasScaledUnit(setting);
  const noun = `${isWhole ? 'whole number' : 'number'}${unitPhrase(setting)}`;
  if (range.exclusiveMin && range.min === 0) return `Must be a positive ${noun}.`;
  if (range.max == null) return `Must be a ${noun} ${range.exclusiveMin ? 'above' : 'of at least'} ${formatDisplayNumber(range.min)}.`;
  return `Must be a ${noun} between ${formatDisplayNumber(range.min)} and ${formatDisplayNumber(range.max)}.`;
}

function storedGranularityMessage(setting: SettingsSetting) {
  return `Must be a multiple of ${displayText(setting, 1)}.`;
}

function isNearInteger(value: number) {
  return Math.abs(value - Math.round(value)) < INTEGER_TOLERANCE && Number.isSafeInteger(Math.round(value));
}

function unroundedStoredNumber(setting: SettingsSetting, value: number): number {
  return Number(wireValue({ ...setting, integer: false, nullable: false, zeroIsNull: false }, value));
}

function numberError(setting: SettingsSetting, rawValue: unknown) {
  if (setting.nullable && (rawValue == null || String(rawValue).trim() === '')) return null;
  const range = setting.range;
  if (!range) return 'Allowed range is unavailable.';
  if (rawValue == null || String(rawValue).trim() === '') return rangeMessage(setting);
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return rangeMessage(setting);
  if (setting.zeroIsNull && value <= 0) return null;
  const stored = unroundedStoredNumber(setting, value);
  if (setting.integer !== false && !isNearInteger(stored)) {
    return hasScaledUnit(setting) ? storedGranularityMessage(setting) : rangeMessage(setting);
  }
  const wired = Number(wireValue(setting, value));
  if (range.exclusiveMin && wired <= range.min) return rangeMessage(setting);
  if (!range.exclusiveMin && wired < range.min) return rangeMessage(setting);
  if (range.max != null && wired > range.max) return rangeMessage(setting);
  return null;
}

export function numberDraftError(setting: SettingsSetting, draft: string, isUnparsable = false): string | null {
  if (isUnparsable) return rangeMessage(setting);
  return numberError(setting, draft.trim());
}

export function numberFromDraft(setting: SettingsSetting, draft: string): number | null {
  const text = draft.trim();
  if (setting.nullable && text === '') return null;
  const value = Number(text);
  if (setting.zeroIsNull && value <= 0) return null;
  return value;
}

export function numberDraftOf(value: unknown): string {
  if (value == null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return formatDisplayNumber(number);
}

function listError(setting: SettingsSetting, value: unknown) {
  if (!Array.isArray(value)) return 'Must be a list.';
  if (setting.valueKind === 'posthog-projects' && wireValue(setting, value) === null) return POSTHOG_PROJECTS_ERROR;
  return null;
}

export function validateLocally(sections: readonly SettingsSection[], values: SettingsValues) {
  const errors: Record<string, string> = {};
  for (const setting of settingsOf(sections)) {
    if (isReadOnlySetting(setting)) continue;
    let error: string | null = null;
    if (setting.control === 'number') error = numberError(setting, values[setting.path]);
    if (setting.control === 'list') error = listError(setting, values[setting.path]);
    if (setting.control === 'select' && setting.options && !setting.options.some((option) => option.value === values[setting.path])) {
      error = 'Choose one of the available options.';
    }
    if (error) errors[setting.id] = error;
  }
  addReversedPairErrors(settingsOf(sections), values, errors);
  return errors;
}

function addReversedPairErrors(settings: readonly SettingsSetting[], values: SettingsValues, errors: Record<string, string>) {
  for (const minimumSetting of settings) {
    const maximumSetting = settings.find((candidate) => candidate.id === minimumSetting.maximumSettingId);
    if (!maximumSetting || errors[minimumSetting.id] || errors[maximumSetting.id]) continue;
    const minimum = values[minimumSetting.path];
    const maximum = values[maximumSetting.path];
    if (!(Number(wireValue(minimumSetting, minimum)) > Number(wireValue(maximumSetting, maximum)))) continue;
    errors[minimumSetting.id] = `Minimum must not exceed the maximum (${numberDraftOf(maximum)}).`;
    errors[maximumSetting.id] = `Maximum must not be below the minimum (${numberDraftOf(minimum)}).`;
  }
}

export function pairedSettingOf(sections: readonly SettingsSection[], setting: SettingsSetting): SettingsSetting | undefined {
  return settingsOf(sections).find((candidate) => candidate.id === setting.maximumSettingId || candidate.maximumSettingId === setting.id);
}

export function settingError(sections: readonly SettingsSection[], setting: SettingsSetting, values: SettingsValues): string | null {
  const pair = pairedSettingOf(sections, setting);
  const scoped: SettingsSection = { id: 'scoped', level: 'machine', title: '', description: '', settings: pair ? [setting, pair] : [setting] };
  return validateLocally([scoped], values)[setting.id] ?? null;
}

function draftValueOf(setting: SettingsSetting, draftText: string): unknown {
  if (setting.control === 'number') return numberFromDraft(setting, draftText);
  if (setting.control === 'list') return listFromDraft(draftText);
  return draftText;
}

function wiredDraftBase(setting: SettingsSetting, base: unknown): unknown {
  return wireValue(setting, setting.control === 'list' ? listValue(base) : base);
}

export function hasUnsavedEdit(draft: ControlDraft | undefined): boolean {
  return draft?.isDirty === true;
}

export function draftCommitOf(
  sections: readonly SettingsSection[], setting: SettingsSetting, draft: ControlDraft, draftText: string, values: SettingsValues, isUnparsable = false,
): DraftCommit {
  if (!hasUnsavedEdit(draft)) return { kind: 'unchanged' };
  const draftError = setting.control === 'number' ? numberDraftError(setting, draftText, isUnparsable) : null;
  if (draftError) return { kind: 'invalid', error: draftError };
  const value = draftValueOf(setting, draftText);
  if (valuesEqual(wireValue(setting, value), wiredDraftBase(setting, draft.base))) return { kind: 'unchanged' };
  const error = settingError(sections, setting, { ...values, [setting.path]: value });
  if (error) return { kind: 'invalid', error };
  return { kind: 'changed', value };
}

export function resetValueOf(setting: SettingsSetting): unknown {
  if (isSecretSetting(setting)) return '';
  return displayValue(setting, setting.defaultValue);
}

export function isAtDefault(setting: SettingsSetting, value: unknown): boolean {
  return valuesEqual(value, resetValueOf(setting));
}

export function choicePresentation(setting: SettingsSetting): SettingsChoicePresentation {
  if (setting.presentation) return setting.presentation;
  return (setting.options?.length ?? 0) <= SEGMENTED_CHOICE_LIMIT ? 'segmented' : 'select';
}

function isNonEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return value === true;
}

export function shouldShowDangerWarning(setting: Pick<SettingsSetting, 'danger' | 'warning'>, value: unknown): boolean {
  return setting.danger === true && Boolean(setting.warning) && isNonEmptyValue(value);
}

export function needsDangerConfirmation(setting: SettingsSetting, value: unknown): boolean {
  return shouldShowDangerWarning(setting, value);
}

function titleInSentence(setting: SettingsSetting): string {
  return setting.title.charAt(0).toLowerCase() + setting.title.slice(1);
}

export function resetConfirmationOf(setting: SettingsSetting): string | null {
  if (isSecretSetting(setting)) return `Reset removes the stored ${titleInSentence(setting)}. Anything that relies on it stops until a new one is saved.`;
  if (needsDangerConfirmation(setting, resetValueOf(setting))) return setting.warning ?? '';
  return null;
}

function workflowRuleSummary(rule: WorkflowRule): string {
  return [rule.repos.join(', '), rule.trigger, rule.actions.map((action) => action.type).join(', ')].join('  ');
}

export function workflowRuleSummaryLines(workflows: unknown): string[] {
  if (workflows === null || workflows === undefined) return ['No rules. Add workflows.rules to config.json.'];
  const parsed = WorkflowsSettings.safeParse(workflows);
  if (!parsed.success) return [`The workflows block is invalid, so no rule runs: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`];
  if (parsed.data.rules.length === 0) return ['No rules. Add workflows.rules to config.json.'];
  return parsed.data.rules.map((rule) => [rule.name, rule.enabled ? 'enabled' : 'disabled', workflowRuleSummary(rule)].join('  '));
}

export function workflowRuleToggleRows(workflows: unknown): WorkflowRuleToggleRow[] {
  const parsed = WorkflowsSettings.safeParse(workflows ?? {});
  if (!parsed.success) return [];
  return parsed.data.rules.map((rule) => ({ id: rule.id, name: rule.name, isEnabled: rule.enabled, summary: workflowRuleSummary(rule) }));
}

export function withoutWorkflowRuleDefinitions(settings: Record<string, unknown>): Record<string, unknown> {
  const workflows = settings.workflows;
  if (typeof workflows !== 'object' || workflows === null || Array.isArray(workflows)) return settings;
  return { ...settings, workflows: Object.fromEntries(Object.entries(workflows).filter(([key]) => key !== 'rules')) };
}
