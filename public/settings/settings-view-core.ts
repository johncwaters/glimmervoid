import { CustomAgentSummaryRow, TelegramDeliveryStatus } from '#shared/contracts/control-messages.ts';
import type { UpdateJournal } from '#shared/contracts/update-journal.ts';
import { WorkflowsSettings } from '#shared/contracts/workflows.ts';
import type { WorkflowRule } from '#shared/contracts/workflows.ts';
import type { SettingsRange } from '#shared/settings-ranges.ts';
import type { SettingsChoicePresentation, SettingsEffect, SettingsSection, SettingsSetting, SettingsVisibleCondition } from '#shared/settings/registry-fields.ts';
import {
  cloneValue, deleteValueAtPath, displayText, displayValue, formatDisplayNumber, hasScaledUnit, isReadOnlySetting, setValueAtPath, settingsOf, valueAtPath,
  settingsGroupOf, wireValue,
} from '#shared/settings/registry-core.ts';
import {
  installedUpdateText,
  isVersionManaged,
  lastUpdateCheckText,
  latestUpdateDetails,
  projectUpdateProgress,
  shouldShowLatestUpdate,
  updateControls,
  updateSummary,
} from '../updates-view-core.ts';
import type { UpdateActionId, UpdateRequestState, UpdateStatusView } from '../updates-view-core.ts';

export type SettingsValues = Record<string, unknown>;

export interface SettingsPayload {
  prefs?: Record<string, unknown>;
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
const STORED_SECRET_MASK = String.fromCharCode(0x2022).repeat(12);
const POSTHOG_PROJECTS_ERROR = 'Each line must be a positive whole-number PostHog project id, or the one word none.';
const SEGMENTED_CHOICE_LIMIT = 3;
const SEGMENTED_LABEL_CHARACTER_BUDGET = 18;
const PATHS_SUMMARIZED_IN_PAYLOAD: ReadonlySet<string> = new Set(['customAgents']);
const INTEGER_TOLERANCE = 1e-9;
const SETTINGS_NAVIGATION_GROUPS = [
  { heading: '', sectionIds: ['machine-home'] },
  { heading: 'Preferences', sectionIds: ['browser-appearance', 'browser-notifications', 'browser-shortcuts', 'browser-status-key'] },
  { heading: 'Agents', sectionIds: ['machine-sessions', 'machine-accounts', 'machine-github', 'machine-hooks', 'machine-packs'] },
  { heading: 'Lanes', sectionIds: ['lanes-features', 'lanes-background-jobs', 'lanes-team-review', 'lanes-posthog', 'lanes-community'] },
  { heading: 'Privacy and security', sectionIds: ['machine-safety', 'machine-vault', 'machine-privacy'] },
  { heading: 'System', sectionIds: ['machine-usage', 'machine-updates', 'machine-server', 'browser-about'] },
] as const;
type SettingsNavigationHeading = typeof SETTINGS_NAVIGATION_GROUPS[number]['heading'];
const NAVIGATION_HEADING_BY_LEVEL: Readonly<Record<SettingsSection['level'], SettingsNavigationHeading>> = {
  browser: 'Preferences',
  machine: 'Agents',
  lanes: 'Lanes',
};

const EFFECT_LABELS: Readonly<Record<SettingsEffect, string>> = Object.freeze({
  now: 'Applies now',
  'new-sessions': 'New sessions',
  restart: 'After restart',
});

export const SCOPE_LABELS: Readonly<Record<SettingsSetting['scope'], string>> = Object.freeze({
  browser: 'This browser',
  machine: 'This machine',
});

type SettingsScope = SettingsSetting['scope'];

export interface SettingsRowChip {
  kind: 'scope' | 'effect';
  text: string;
}

export function pageScopeOf(settings: readonly SettingsSetting[]): SettingsScope | null {
  const countByScope = new Map<SettingsScope, number>();
  for (const setting of settings) countByScope.set(setting.scope, (countByScope.get(setting.scope) ?? 0) + 1);
  let commonestScope: SettingsScope | null = null;
  let commonestCount = 0;
  for (const [scope, count] of countByScope) {
    if (count <= commonestCount) continue;
    commonestScope = scope;
    commonestCount = count;
  }
  return commonestScope;
}

export function rowChipsOf(setting: SettingsSetting, pageScope: SettingsScope | null): SettingsRowChip[] {
  const chips: SettingsRowChip[] = [];
  if (setting.scope !== pageScope) chips.push({ kind: 'scope', text: SCOPE_LABELS[setting.scope] });
  if (setting.takesEffect !== 'now') chips.push({ kind: 'effect', text: EFFECT_LABELS[setting.takesEffect] });
  return chips;
}

export function secretEnvironmentSource(setting: SettingsSetting, payload: SettingsPayload): string | null {
  const sources = payload.secretSources;
  if (!sources || typeof sources !== 'object') return null;
  const source = (sources as Record<string, unknown>)[setting.path];
  return typeof source === 'string' ? source : null;
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

function listFromDraft(draft: string): string[] {
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

function fileOnlyDefaultText(setting: SettingsSetting): string {
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
  return group.level === 'lanes' ? `${NAVIGATION_HEADING_BY_LEVEL.lanes} / ${group.title}` : group.title;
}

export function childSectionsOf(sections: readonly SettingsSection[], sectionId: string): SettingsSection[] {
  return sections.filter((section) => section.parent === sectionId);
}

export function pageSectionOf(sections: readonly SettingsSection[], sectionId: string): SettingsSection | null {
  return sections.find((entry) => entry.id === sectionId) ?? null;
}

export function topLevelSectionsOf(sections: readonly SettingsSection[]): SettingsSection[] {
  return sections.filter((section) => !section.parent);
}

export function settingsNavigationGroupsOf(sections: readonly SettingsSection[]): { heading: string; sections: SettingsSection[] }[] {
  const listedSectionIds = new Set<string>(SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.sectionIds));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const groups = SETTINGS_NAVIGATION_GROUPS.map((group) => {
    const listedSections = group.sectionIds.flatMap((sectionId) => sectionById.get(sectionId) ?? []);
    const unlistedSections = sections.filter((section) => !listedSectionIds.has(section.id) && NAVIGATION_HEADING_BY_LEVEL[section.level] === group.heading);
    return { heading: group.heading, sections: [...listedSections, ...unlistedSections] };
  });
  return groups.filter((group) => group.sections.length > 0);
}

export function phoneSettingsScreenOf(
  sections: readonly SettingsSection[], sectionId: string | null, query: string,
): 'list' | 'section' | 'search' {
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
    setValueAtPath(payload, setting.path, wireValue(setting, edited[setting.path]));
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

function numberDraftError(setting: SettingsSetting, draft: string, isUnparsable = false): string | null {
  if (isUnparsable) return rangeMessage(setting);
  return numberError(setting, draft.trim());
}

function numberFromDraft(setting: SettingsSetting, draft: string): number | null {
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

function pairedSettingOf(sections: readonly SettingsSection[], setting: SettingsSetting): SettingsSetting | undefined {
  return settingsOf(sections).find((candidate) => candidate.id === setting.maximumSettingId || candidate.maximumSettingId === setting.id);
}

function settingError(sections: readonly SettingsSection[], setting: SettingsSetting, values: SettingsValues): string | null {
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
  const optionLabels = (setting.options ?? []).map((option) => option.label);
  if (optionLabels.length > SEGMENTED_CHOICE_LIMIT) return 'select';
  return optionLabels.join('').length <= SEGMENTED_LABEL_CHARACTER_BUDGET ? 'segmented' : 'select';
}

function isNonEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  return value === true;
}

function visibleConditionsOf(setting: SettingsSetting): readonly SettingsVisibleCondition[] {
  const visibleWhen = setting.visibleWhen;
  if (!visibleWhen) return [];
  if (Array.isArray(visibleWhen)) return visibleWhen;
  return [visibleWhen as SettingsVisibleCondition];
}

function conditionValueFor(path: string, values: SettingsValues, payload: SettingsPayload): unknown {
  if (Object.hasOwn(values, path)) return values[path];
  return valueAtPath(payload, path);
}

function matchesVisibleCondition(condition: SettingsVisibleCondition, values: SettingsValues, payload: SettingsPayload): boolean {
  if ('anyOf' in condition) return condition.anyOf.some((nested) => matchesVisibleCondition(nested, values, payload));
  const value = conditionValueFor(condition.path, values, payload);
  if ('equals' in condition) return value === condition.equals;
  return isNonEmptyValue(value) === condition.isSet;
}

function conditionReferencesPath(condition: SettingsVisibleCondition, path: string): boolean {
  if ('anyOf' in condition) return condition.anyOf.some((nested) => conditionReferencesPath(nested, path));
  return condition.path === path;
}

export function isSettingShown(setting: SettingsSetting, values: SettingsValues, payload: SettingsPayload): boolean {
  return visibleConditionsOf(setting).every((condition) => matchesVisibleCondition(condition, values, payload));
}

export function gatesOnPath(settings: readonly SettingsSetting[], path: string): boolean {
  return settings.some((setting) => visibleConditionsOf(setting).some((condition) => conditionReferencesPath(condition, path)));
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

function withoutWorkflowRuleDefinitions(settings: Record<string, unknown>): Record<string, unknown> {
  const workflows = settings.workflows;
  if (typeof workflows !== 'object' || workflows === null || Array.isArray(workflows)) return settings;
  return { ...settings, workflows: Object.fromEntries(Object.entries(workflows).filter(([key]) => key !== 'rules')) };
}

type SettingsSaveTone = 'saving' | 'saved' | 'error';

interface SettingsSaveStatus {
  tone: SettingsSaveTone;
  text: string;
}

interface RowDisplay {
  isReadout: boolean;
  showExperimentalTag: boolean;
  chips: SettingsRowChip[];
  canReset: boolean;
  isFootIdle: boolean;
  saveStatusText: string;
  saveStatusTone: SettingsSaveTone | undefined;
  fieldError: string | null;
  showDangerWarning: boolean;
  dangerWarningText: string;
}

export function rowDisplayOf(
  setting: SettingsSetting,
  section: SettingsSection,
  storedSettingValue: unknown,
  payload: SettingsPayload,
  saveStatus: SettingsSaveStatus | undefined,
  fieldError: string | undefined,
  isExperimentalSettingFlag: boolean,
  isExperimentalSectionFlag: boolean,
): RowDisplay {
  const isReadout = setting.control === 'readonly';
  const canReset = !isReadout && !secretEnvironmentSource(setting, payload) && !isAtDefault(setting, storedSettingValue);
  const pageScope = pageScopeOf(section.settings);
  return {
    isReadout,
    showExperimentalTag: isExperimentalSettingFlag && !isExperimentalSectionFlag,
    chips: rowChipsOf(setting, pageScope),
    canReset,
    isFootIdle: !saveStatus && !canReset,
    saveStatusText: saveStatus?.text ?? '',
    saveStatusTone: saveStatus?.tone,
    fieldError: fieldError ?? null,
    showDangerWarning: shouldShowDangerWarning(setting, storedSettingValue),
    dangerWarningText: setting.warning ?? '',
  };
}

type SettingsControlKind =
  | 'readonly'
  | 'toggle'
  | 'number'
  | 'segmented'
  | 'select'
  | 'list'
  | 'shortcut-key'
  | 'agent-visibility'
  | 'text'
  | 'password';

export function controlKindOf(setting: SettingsSetting): SettingsControlKind {
  if (setting.control === 'readonly') return 'readonly';
  if (setting.control === 'toggle') return 'toggle';
  if (setting.control === 'number') return 'number';
  if (setting.control === 'select') return choicePresentation(setting) === 'segmented' ? 'segmented' : 'select';
  if (setting.control === 'list') return 'list';
  if (setting.control === 'shortcut-key') return 'shortcut-key';
  if (setting.control === 'agent-visibility') return 'agent-visibility';
  if (setting.control === 'password') return 'password';
  return 'text';
}

function inputMinimumOf(setting: SettingsSetting, range: SettingsRange): number | undefined {
  if (!range.exclusiveMin) return range.min;
  if (setting.integer === false) return undefined;
  return range.min + 1;
}

interface NumberInputMeta {
  min: string | undefined;
  max: string | undefined;
  step: string;
  unitLabel: string | null;
}

export function numberInputMetaOf(setting: SettingsSetting): NumberInputMeta {
  const range = displayRange(setting);
  const minimum = range ? inputMinimumOf(setting, range) : undefined;
  return {
    min: minimum != null ? String(minimum) : undefined,
    max: range?.max != null ? String(range.max) : undefined,
    step: setting.integer === false ? String(setting.step ?? 'any') : '1',
    unitLabel: setting.unit?.label ?? null,
  };
}

interface TextInputMeta {
  inputType: 'text' | 'password';
  storedText: string;
  placeholder: string;
  isDisabled: boolean;
  ariaDescription: string | undefined;
  listId: string | undefined;
}

export function textInputMetaOf(
  setting: SettingsSetting,
  storedSettingValue: unknown,
  payload: SettingsPayload,
): TextInputMeta {
  const isPassword = setting.control === 'password';
  const rawStored = String(storedSettingValue ?? '');
  const environmentSource = secretEnvironmentSource(setting, payload);
  let placeholder = '';
  if (isPassword) {
    placeholder = rawStored ? 'Configured' : 'Not configured';
  }
  if (!isPassword && setting.suggestionsFrom) {
    placeholder = setting.suggestionsFrom === 'review-skills' ? 'No skill' : 'Agent default';
  }
  return {
    inputType: isPassword ? 'password' : 'text',
    storedText: isPassword ? '' : rawStored,
    placeholder,
    isDisabled: Boolean(environmentSource),
    ariaDescription: environmentSource ? `Supplied by ${environmentSource}` : undefined,
    listId: setting.suggestionsFrom ? `${setting.id}-suggestions` : undefined,
  };
}

export function listHintTextOf(setting: SettingsSetting, entries: readonly string[]): string {
  const format = setting.valueKind === 'posthog-projects'
    ? 'One project id per line, or none. Shift+Enter for a new line.'
    : 'One per line. Shift+Enter for a new line.';
  if (entries.length > 0 || !setting.listEmptyText) return format;
  return `${setting.listEmptyText} ${format}`;
}

type DraftKeydownAction = 'ignore' | 'commit' | 'restore';

export function decideDraftKeydown(
  key: string,
  shiftKey: boolean,
  isComposing: boolean,
  keyCode: number,
  isMultiline: boolean,
): DraftKeydownAction {
  if (isComposing || keyCode === 229 || key === 'Process') return 'ignore';
  if (key === 'Escape') return 'restore';
  if (key !== 'Enter') return 'ignore';
  if (isMultiline && shiftKey) return 'ignore';
  return 'commit';
}

type ToggleChangeDecision =
  | { kind: 'commit'; value: boolean }
  | { kind: 'confirm-danger'; title: string; message: string };

export function decideToggleChange(setting: SettingsSetting, nextChecked: boolean): ToggleChangeDecision {
  if (needsDangerConfirmation(setting, nextChecked)) {
    return { kind: 'confirm-danger', title: setting.title, message: setting.warning ?? '' };
  }
  return { kind: 'commit', value: nextChecked };
}

type FieldCommitDecision =
  | { kind: 'invalid'; error: string }
  | { kind: 'unchanged'; restoreText: string }
  | { kind: 'confirm-danger'; restoreText: string; title: string; message: string; value: unknown }
  | { kind: 'commit'; value: unknown };

export function decideFieldCommit(
  sections: readonly SettingsSection[],
  setting: SettingsSetting,
  draft: ControlDraft,
  rawValue: string,
  values: SettingsValues,
  storedText: string,
  isUnparsable: boolean,
): FieldCommitDecision {
  const decision = draftCommitOf(sections, setting, draft, rawValue, values, isUnparsable);
  if (decision.kind === 'invalid') return decision;
  if (decision.kind === 'unchanged') return { kind: 'unchanged', restoreText: storedText };
  if (needsDangerConfirmation(setting, decision.value)) {
    return {
      kind: 'confirm-danger',
      restoreText: storedText,
      title: setting.title,
      message: setting.warning ?? '',
      value: decision.value,
    };
  }
  return { kind: 'commit', value: decision.value };
}

type PasswordCommitDecision =
  | { kind: 'ignore' }
  | { kind: 'commit'; secret: string };

export function decidePasswordCommit(rawValue: string): PasswordCommitDecision {
  if (rawValue === '') return { kind: 'ignore' };
  return { kind: 'commit', secret: rawValue };
}

export interface ListedAgent {
  id: string;
  label: string;
  resolvable: boolean;
}

interface AgentVisibilityItem {
  id: string;
  label: string;
  labelId: string;
  isChecked: boolean;
  isDisabled: boolean;
}

interface AgentVisibilityDisplay {
  items: AgentVisibilityItem[];
  noteText: string;
}

export function agentVisibilityDisplayOf(
  settingId: string,
  hiddenIds: readonly string[],
  loadState: 'loading' | 'loaded' | 'error',
  agents: readonly ListedAgent[],
  defaultAgentId: string,
): AgentVisibilityDisplay {
  const items = agents
    .filter((agent) => agent.resolvable)
    .map((agent) => ({
      id: agent.id,
      label: agent.label,
      labelId: `${settingId}-${agent.id}`,
      isChecked: !hiddenIds.includes(agent.id),
      isDisabled: agent.id === defaultAgentId,
    }));
  if (loadState === 'error') {
    return { items, noteText: 'Could not load the agent list. Reopen Settings to try again.' };
  }
  if (loadState === 'loading' && agents.length === 0) {
    return { items, noteText: 'Checking which agents are installed.' };
  }
  const missingLabels = agents.filter((agent) => !agent.resolvable).map((agent) => agent.label);
  return {
    items,
    noteText: missingLabels.length > 0 ? `Not installed: ${missingLabels.join(', ')}.` : '',
  };
}

export function nextHiddenAgentIds(
  currentHiddenIds: readonly string[],
  agentId: string,
  isChecked: boolean,
): string[] {
  const otherHiddenIds = currentHiddenIds.filter((hiddenId) => hiddenId !== agentId);
  return isChecked ? otherHiddenIds : [...otherHiddenIds, agentId];
}

export const SAVED_STATUS_MS = 2200;
export const TELEMETRY_DELETION_TIMEOUT_MS = 15000;
export const ACCOUNT_LINK_LABEL = 'Link to my Glimmervoid account';

export const TELEMETRY_SENT_DETAIL: readonly string[] = Object.freeze([
  'Sent: version, platform, app starts, daily activity, session starts and ends with agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, and per session token counts, models and estimated costs from the usage scan.',
  'Never sent: prompts, project information, error messages from Glimmervoid or an agent, notice text, paths on your machine, repository or branch names, objectives, terminal output, hashes of account ids, emails, names, or anything read from another tool\'s login.',
  'Used only to improve Glimmervoid: never sold, never used for marketing or sales.',
  'A Glimmervoid Cloud server tags its usage with its owner\'s Glimmervoid Cloud account id once the owner signs in. A self-hosted install is tagged only after you choose Link to my Glimmervoid account and confirm.',
  'Delete my data asks for everything sent under this install to be erased and starts a new install id.',
]);

type ReadoutKind =
  | 'server-power'
  | 'agent-accounts'
  | 'lane-accounts'
  | 'remote-setup'
  | 'update-actions'
  | 'custom-agents'
  | 'workflows'
  | 'unavailable';

export function readoutKindOf(status: string | undefined): ReadoutKind {
  if (status === 'server-power') return 'server-power';
  if (status === 'agent-accounts') return 'agent-accounts';
  if (status === 'lane-accounts') return 'lane-accounts';
  if (status === 'remote-setup') return 'remote-setup';
  if (status === 'update-actions') return 'update-actions';
  if (status === 'custom-agents') return 'custom-agents';
  if (status === 'workflows') return 'workflows';
  return 'unavailable';
}

type StatusSlotKind =
  | 'none'
  | 'usage-last-report'
  | 'desktop-notifications'
  | 'telemetry-enabled'
  | 'telegram-delivery'
  | 'vault-connection'
  | 'secret-env';

export function statusSlotKindOf(
  setting: SettingsSetting,
  payload: SettingsPayload,
): { kind: StatusSlotKind; envWarningText: string } {
  if (setting.control === 'readonly') return { kind: 'none', envWarningText: '' };
  if (setting.status === 'usage-last-report') return { kind: 'usage-last-report', envWarningText: '' };
  if (setting.id === 'desktop-notifications') return { kind: 'desktop-notifications', envWarningText: '' };
  if (setting.id === 'telemetry-enabled') return { kind: 'telemetry-enabled', envWarningText: '' };
  if (setting.status === 'telegram-delivery') return { kind: 'telegram-delivery', envWarningText: '' };
  if (setting.status === 'vault-connection') return { kind: 'vault-connection', envWarningText: '' };
  const environmentSource = secretEnvironmentSource(setting, payload);
  if (!environmentSource) return { kind: 'none', envWarningText: '' };
  return {
    kind: 'secret-env',
    envWarningText: `Supplied by ${environmentSource}. Change the server environment and restart to replace this credential.`,
  };
}

function resolvabilityLabel(resolvable: boolean | null): string {
  if (resolvable === null) return 'not probed yet';
  if (resolvable) return 'resolved';
  return 'not found on PATH';
}

export function customAgentLinesOf(customAgents: unknown): string[] {
  if (!Array.isArray(customAgents)) return ['None declared. Add customAgents to config.json.'];
  const rows: CustomAgentSummaryRow[] = [];
  for (const entry of customAgents) {
    const parsed = CustomAgentSummaryRow.safeParse(entry);
    if (parsed.success) rows.push(parsed.data);
  }
  if (rows.length === 0) return ['None declared. Add customAgents to config.json.'];
  return rows.map((row) => {
    const invocation = row.args.length > 0 ? `${row.command} ${row.args.join(' ')}` : row.command;
    const status = row.isShadowedByBuiltIn
      ? 'ignored: a built-in agent has this id, rename it'
      : resolvabilityLabel(row.resolvable);
    return `${row.id}  ${row.label}  ${invocation}  ${status}`;
  });
}

interface WorkflowRuleFeedback {
  tone: 'ok' | 'error';
  text: string;
}

interface WorkflowRulesUiState {
  pendingIds: readonly string[];
  feedbackById: Readonly<Record<string, WorkflowRuleFeedback>>;
}

export const INITIAL_WORKFLOW_RULES_UI_STATE: WorkflowRulesUiState = Object.freeze({
  pendingIds: [],
  feedbackById: {},
});

export function markWorkflowRulePending(state: WorkflowRulesUiState, ruleId: string): WorkflowRulesUiState {
  const nextFeedback = { ...state.feedbackById };
  delete nextFeedback[ruleId];
  const pendingIds = state.pendingIds.includes(ruleId) ? state.pendingIds : [...state.pendingIds, ruleId];
  return { pendingIds, feedbackById: nextFeedback };
}

export function markWorkflowRuleSaved(state: WorkflowRulesUiState, ruleId: string): WorkflowRulesUiState {
  return {
    pendingIds: state.pendingIds.filter((id) => id !== ruleId),
    feedbackById: { ...state.feedbackById, [ruleId]: { tone: 'ok', text: 'Saved' } },
  };
}

export function markWorkflowRuleFailed(
  state: WorkflowRulesUiState,
  ruleId: string,
  errorText: string,
): WorkflowRulesUiState {
  return {
    pendingIds: state.pendingIds.filter((id) => id !== ruleId),
    feedbackById: { ...state.feedbackById, [ruleId]: { tone: 'error', text: errorText } },
  };
}

export function clearWorkflowRuleSaved(state: WorkflowRulesUiState, ruleId: string): WorkflowRulesUiState {
  if (!Object.hasOwn(state.feedbackById, ruleId) || state.feedbackById[ruleId]?.tone !== 'ok') return state;
  const nextFeedback = { ...state.feedbackById };
  delete nextFeedback[ruleId];
  return { ...state, feedbackById: nextFeedback };
}

export function workflowRuleStatusOf(
  state: WorkflowRulesUiState,
  ruleId: string,
): { isPending: boolean; tone: 'busy' | 'ok' | 'error' | null; text: string } {
  if (state.pendingIds.includes(ruleId)) return { isPending: true, tone: 'busy', text: 'Saving' };
  const feedback = Object.hasOwn(state.feedbackById, ruleId) ? state.feedbackById[ruleId] : undefined;
  if (feedback) return { isPending: false, tone: feedback.tone, text: feedback.text };
  return { isPending: false, tone: null, text: '' };
}

export function telegramDeliveryLinesOf(
  telegramDelivery: unknown,
  formatTimestamp: (failedAt: number) => string,
): string[] {
  const parsedDelivery = TelegramDeliveryStatus.safeParse(telegramDelivery);
  if (!parsedDelivery.success) return [];
  const { setupWarning, lastFailure } = parsedDelivery.data;
  const lines = setupWarning ? [setupWarning] : [];
  if (lastFailure) {
    lines.push(`The last Telegram send failed at ${formatTimestamp(lastFailure.failedAt)}: ${lastFailure.message}`);
  }
  return lines;
}

interface ActionFeedbackState {
  isBusy: boolean;
  tone: 'busy' | 'ok' | 'error' | null;
  text: string;
}

export const IDLE_ACTION_FEEDBACK: ActionFeedbackState = Object.freeze({
  isBusy: false,
  tone: null,
  text: '',
});

export function beginActionFeedback(busyText: string): ActionFeedbackState {
  return { isBusy: true, tone: 'busy', text: busyText };
}

export function decideTelegramTestOutcome(
  isOk: boolean,
  errorText: string | undefined,
): ActionFeedbackState {
  if (isOk) return { isBusy: false, tone: 'ok', text: 'Sent. Check the Telegram chat for the test message.' };
  return { isBusy: false, tone: 'error', text: `Not sent: ${errorText ?? 'Telegram refused the message.'}` };
}

export function decideTelemetryDeletionOutcome(isOk: boolean): ActionFeedbackState {
  if (isOk) return { isBusy: false, tone: 'ok', text: 'Deletion requested. New usage starts under a new id.' };
  return { isBusy: false, tone: 'error', text: 'Not sent: PostHog did not take the request. Try again later.' };
}

export function accountLinkDisplayOf(
  telemetryInstallId: unknown,
  accountPageUrl: string,
  linkInstallParam: string,
): { href: string | null; isDisabled: boolean; explanation: string } {
  const linkableInstallId = typeof telemetryInstallId === 'string' && telemetryInstallId !== '' ? telemetryInstallId : null;
  if (linkableInstallId === null) {
    return {
      href: null,
      isDisabled: true,
      explanation: 'Turn on Send usage data to link this install.',
    };
  }
  const accountLinkUrl = new URL(accountPageUrl);
  accountLinkUrl.searchParams.set(linkInstallParam, linkableInstallId);
  return {
    href: accountLinkUrl.href,
    isDisabled: false,
    explanation: 'Opens your Glimmervoid account page. Sign in there to count this install as yours. Optional; Delete my data removes it with a new install id.',
  };
}

interface SettingsUpdateStateInput {
  status: UpdateStatusView | null;
  journal: UpdateJournal | null;
  request: UpdateRequestState;
  lastAutoCheckAt: number | null;
  isCheckInFlight: boolean;
  checkSendFailure: string | null;
}

interface UpdateActionButtonDisplay {
  id: UpdateActionId;
  variant: 'primary' | 'secondary';
  label: string;
  action: string;
  isDisabled: boolean;
}

interface UpdateProgressDisplay {
  state: string;
  terminalLine: string | null;
  isFailed: boolean;
  failureDetail: string | null;
  steps: { id: string; label: string; status: string }[];
  outputText: string;
  outputStepId: string | null;
  outputCaption: string | null;
}

interface UpdateStatusDisplay {
  headline: string;
  tone: string;
  runningText: string;
  showLatest: boolean;
  latestLabel: string;
  latestReleaseUrl: string;
  showLastChecked: boolean;
  lastCheckedText: string;
  actions: UpdateActionButtonDisplay[];
  checkStatusText: string | null;
  note: string | null;
  command: string | null;
  progress: UpdateProgressDisplay | null;
}

function updateActionButtonOf(actionId: UpdateActionId, isCheckInFlight: boolean): UpdateActionButtonDisplay {
  if (actionId === 'update') {
    return { id: 'update', variant: 'primary', label: 'Update', action: 'apply-update', isDisabled: false };
  }
  if (actionId === 'restart') {
    return { id: 'restart', variant: 'primary', label: 'Restart', action: 'restart-server', isDisabled: false };
  }
  return {
    id: 'check',
    variant: 'secondary',
    label: 'Check for updates',
    action: 'check-for-updates',
    isDisabled: isCheckInFlight,
  };
}

export function updateStatusDisplayOf(
  updateState: SettingsUpdateStateInput,
  checkForUpdates: unknown,
  lastCheckedRelativeText: string,
): UpdateStatusDisplay {
  const { status, journal, request, isCheckInFlight, checkSendFailure } = updateState;
  const summary = updateSummary(status, journal);
  const latest = latestUpdateDetails(status);
  const decided = updateControls({ status, journal, request });
  const projection = projectUpdateProgress(journal);
  const progress: UpdateProgressDisplay | null = projection
    ? {
      state: projection.state,
      terminalLine: projection.terminalLine,
      isFailed: projection.state === 'failed',
      failureDetail: projection.failureDetail,
      steps: projection.steps,
      outputText: projection.outputTail.join('\n'),
      outputStepId: projection.outputStepId,
      outputCaption: projection.outputStepLabel ? `Output from ${projection.outputStepLabel}` : null,
    }
    : null;
  return {
    headline: summary.headline,
    tone: summary.tone,
    runningText: installedUpdateText(status),
    showLatest: shouldShowLatestUpdate(status),
    latestLabel: latest.label,
    latestReleaseUrl: latest.releaseUrl,
    showLastChecked: !isVersionManaged(status),
    lastCheckedText: lastUpdateCheckText({
      status,
      checkForUpdates,
      relativeTime: lastCheckedRelativeText,
    }),
    actions: decided.actions.map((actionId) => updateActionButtonOf(actionId, isCheckInFlight)),
    checkStatusText: isCheckInFlight ? 'Checking for updates.' : checkSendFailure,
    note: decided.note,
    command: decided.command,
    progress,
  };
}
