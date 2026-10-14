import { WorkflowsSettings } from '#shared/contracts/workflows.ts';
import type { WorkflowRule } from '#shared/contracts/workflows.ts';
import type { SettingsRange } from '#shared/settings-ranges.ts';
import type { SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import {
  cloneValue, deleteValueAtPath, displayValue, isReadOnlySetting, parsePosthogProjectSelection, setValueAtPath, settingsOf, valueAtPath, wireValue,
} from '#shared/settings/registry-core.ts';
import { projectSelectionChoices, unionProjectSelection } from './settings-projects-core.ts';

export type SettingsValues = Record<string, unknown>;

export interface SettingsPayload {
  prefs?: Record<string, unknown>;
  projectChoices?: unknown;
  [key: string]: unknown;
}

export interface SettingsProject {
  id: string;
  path?: string;
  name?: string;
  agent?: string;
  permissionMode?: string;
  recordNames?: string[];
}

export interface WorkflowRuleToggleRow {
  id: string;
  name: string;
  isEnabled: boolean;
  summary: string;
}

const payloadByHydratedValues = new WeakMap<object, unknown>();

export const SECRET_PRESENCE_SUFFIX = 'Configured';
export const STORED_SECRET_MASK = '\u2022'.repeat(12);

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

export function rehydratePreservingDirtySections(
  sections: readonly SettingsSection[],
  settingsPayload: SettingsPayload,
  currentOriginal: SettingsValues | null | undefined,
  currentEdited: SettingsValues | null | undefined,
  options: { rehydrateSectionIds?: string[] } = {},
) {
  const { rehydrateSectionIds = [] } = options;
  const original = hydrateFromSettings(sections, settingsPayload);
  const edited = hydrateFromSettings(sections, settingsPayload);
  if (!currentOriginal || !currentEdited) return { original, edited };
  const forcedSections = new Set(rehydrateSectionIds);
  for (const section of sections) {
    if (forcedSections.has(section.id)) continue;
    const isDirty = section.settings.some((setting) => {
      if (setting.path.startsWith('pref:')) return false;
      return !valuesEqual(currentOriginal[setting.path], currentEdited[setting.path]);
    });
    if (!isDirty) continue;
    for (const setting of section.settings) {
      original[setting.path] = cloneValue(currentOriginal[setting.path]);
      edited[setting.path] = cloneValue(currentEdited[setting.path]);
    }
  }
  return { original, edited };
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

function rangeMessage(range: SettingsRange, setting: SettingsSetting) {
  const noun = setting.integer === false ? 'number' : 'whole number';
  if (range.exclusiveMin) return `Must be a positive ${noun}.`;
  if (range.max == null) return `Must be a ${noun} of at least ${range.min}.`;
  return `Must be a ${noun} between ${range.min} and ${range.max}.`;
}

function numberError(setting: SettingsSetting, rawValue: unknown) {
  if (setting.nullable && (rawValue == null || String(rawValue).trim() === '')) return null;
  const value = Number(rawValue);
  const range = setting.range;
  if (!range) return 'Allowed range is unavailable.';
  if (!Number.isFinite(value)) return rangeMessage(range, setting);
  if (setting.integer !== false && !Number.isSafeInteger(value)) return rangeMessage(range, setting);
  if (range.exclusiveMin && value <= range.min) {
    if (setting.zeroIsNull && value <= 0) return null;
    return rangeMessage(range, setting);
  }
  if (!range.exclusiveMin && value < range.min) return rangeMessage(range, setting);
  if (range.max != null && value > range.max) return rangeMessage(range, setting);
  return null;
}

function posthogProjectsError(value: unknown) {
  if (parsePosthogProjectSelection(value) !== null) return null;
  return 'Must be "all", "none", or a comma-separated list of positive safe integer ids without empty entries.';
}

export function validateLocally(sections: readonly SettingsSection[], edited: SettingsValues) {
  const errors: Record<string, string> = {};
  for (const setting of settingsOf(sections)) {
    if (isReadOnlySetting(setting)) continue;
    let error: string | null = null;
    if (setting.control === 'number') error = numberError(setting, edited[setting.path]);
    if (setting.valueKind === 'posthog-projects') error = posthogProjectsError(edited[setting.path]);
    if (setting.control === 'select' && !(setting.options ?? []).some((option) => option.value === edited[setting.path])) {
      error = 'Choose one of the available options.';
    }
    if (error) errors[setting.id] = error;
  }
  addReversedPairErrors(settingsOf(sections), edited, errors);
  return errors;
}

function addReversedPairErrors(settings: readonly SettingsSetting[], edited: SettingsValues, errors: Record<string, string>) {
  for (const minimumSetting of settings) {
    const maximumSetting = settings.find((candidate) => candidate.id === minimumSetting.maximumSettingId);
    if (!maximumSetting || errors[minimumSetting.id] || errors[maximumSetting.id]) continue;
    const minimum = Number(edited[minimumSetting.path]);
    const maximum = Number(edited[maximumSetting.path]);
    if (!(minimum > maximum)) continue;
    errors[minimumSetting.id] = `Minimum must not exceed the maximum (${maximum}).`;
    errors[maximumSetting.id] = `Maximum must not be below the minimum (${minimum}).`;
  }
}

export function pairedSettingOf(sections: readonly SettingsSection[], setting: SettingsSetting): SettingsSetting | undefined {
  return settingsOf(sections).find((candidate) => candidate.id === setting.maximumSettingId || candidate.maximumSettingId === setting.id);
}

function projectSetting(projectId: string, suffix: string, fields: Omit<SettingsSetting, 'id' | 'projectId' | 'scope' | 'takesEffect'>): SettingsSetting {
  return {
    id: `project-${projectId}-${suffix}`,
    projectId,
    scope: 'machine',
    takesEffect: 'new-sessions',
    ...fields,
  };
}

function canonicalProjectRecordName(name: unknown) {
  return String(name || '').replace(/\s+\(\d+\)$/, '');
}

function projectPathBasename(projectPath: unknown) {
  const normalizedPath = String(projectPath || '').replace(/[\\/]+$/, '');
  return normalizedPath.split(/[\\/]/).at(-1) || '';
}

function projectSectionTitle(project: SettingsProject): string {
  return projectPathBasename(project?.path)
    || canonicalProjectRecordName(project?.name)
    || project?.id;
}

export function buildProjectSections(projects: SettingsProject[] = []): SettingsSection[] {
  return projects
    .filter((project) => typeof project?.id === 'string' && project.id)
    .map((project) => ({
      id: `project-${project.id}`,
      level: 'projects',
      title: projectSectionTitle(project),
      description: 'Settings scoped to this configured project.',
      caption: (project.recordNames?.length ?? 0) > 1 ? `Cards: ${project.recordNames?.join(', ')}` : '',
      project,
      settings: [
        projectSetting(project.id, 'agent', {
          path: `project:${project.id}:agent`,
          title: 'Agent',
          description: 'Agent configured for this project.',
          control: 'readonly',
          access: 'readout',
          keywords: ['cli', 'runtime'],
          value: project.agent || 'Not available in the current dashboard payload',
        }),
        projectSetting(project.id, 'permission-mode', {
          path: `project:${project.id}:permission-mode`,
          title: 'Default permission mode',
          description: 'Permission mode used for newly spawned sessions.',
          control: 'readonly',
          access: 'readout',
          keywords: ['approval', 'sandbox'],
          value: project.permissionMode || 'Not available in the current dashboard payload',
        }),
        projectSetting(project.id, 'codex-hook-trust', {
          path: `projects.${project.id}.codexBypassHookTrust`,
          title: 'Codex hook trust bypass',
          description: 'Configured only on this project record.',
          control: 'toggle',
          access: 'file-only',
          fileOnlyReason: 'A per-project record field with no dashboard control.',
          keywords: ['hooks', 'codex'],
        }),
      ],
    }));
}

export function firstProjectPerPath(projects: SettingsProject[] = []): SettingsProject[] {
  const seenPaths = new Set<string>();
  return projects.filter((project) => {
    if (typeof project?.id !== 'string' || !project.id) return false;
    if (!project.path) return true;
    if (seenPaths.has(project.path)) return false;
    seenPaths.add(project.path);
    return true;
  });
}

export function enrichProjectsById(projects: SettingsProject[] = [], details: SettingsProject[] = []): SettingsProject[] {
  const detailsById = new Map(details
    .filter((detail) => typeof detail?.id === 'string' && detail.id)
    .map((detail): [string, SettingsProject] => [detail.id, detail]));
  return projects.map((project) => {
    const matchingDetail = detailsById.get(project?.id);
    const projectPath = project?.path || matchingDetail?.path;
    const recordNames = details
      .filter((detail) => projectPath && detail?.path === projectPath)
      .map((detail) => detail?.name)
      .filter((name): name is string => typeof name === 'string' && name !== '');
    return {
      ...matchingDetail,
      ...project,
      path: projectPath,
      recordNames: [...new Set(recordNames)],
    };
  });
}

export function shouldShowDangerWarning(setting: Pick<SettingsSetting, 'danger' | 'warning'>, value: unknown): boolean {
  return setting.danger === true && Boolean(setting.warning) && value === true;
}

export function resolveEntry(sections: readonly SettingsSection[], sectionId: string): SettingsSection | null {
  return sections.find((section) => section.id === sectionId) || sections[0] || null;
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
