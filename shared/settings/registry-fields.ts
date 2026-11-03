import type { SettingsRange } from '../settings-ranges.ts';

type SettingsScope = 'browser' | 'machine';
type SettingsAccess = 'editable' | 'advanced' | 'readout' | 'file-only';
export type SettingsEffect = 'now' | 'new-sessions' | 'restart';
type SettingsLevel = 'browser' | 'machine' | 'lanes';
type SettingsControl = 'toggle' | 'number' | 'text' | 'password' | 'select' | 'list' | 'json' | 'readonly' | 'shortcut-key' | 'tab-order';
export type SettingsChoicePresentation = 'segmented' | 'select';

interface SettingsOption {
  value: string;
  label: string;
}

interface SettingsUnit {
  label: string;
  storedPerDisplay: number;
  storedLabel?: string;
}

interface SettingsLegacyId {
  sectionId: string;
  settingId: string;
}

export interface SettingsSetting {
  id: string;
  path: string;
  title: string;
  description: string;
  keywords: readonly string[];
  control: SettingsControl;
  scope: SettingsScope;
  access: SettingsAccess;
  takesEffect: SettingsEffect;
  fileOnlyReason?: string;
  group?: string;
  legacyIds?: readonly SettingsLegacyId[];
  options?: readonly SettingsOption[];
  optionsFrom?: string;
  suggestionsFrom?: string;
  presentation?: SettingsChoicePresentation;
  listPlaceholder?: string;
  listEmptyText?: string;
  defaultValue?: unknown;
  integer?: boolean;
  nullable?: boolean;
  zeroIsNull?: boolean;
  step?: number | 'any';
  range?: SettingsRange;
  unit?: SettingsUnit;
  maximumSettingId?: string;
  valueKind?: string;
  warning?: string;
  danger?: boolean;
  status?: string;
}

export interface SettingsSection {
  id: string;
  level: SettingsLevel;
  title: string;
  description: string;
  parent?: string;
  legacyIds?: readonly string[];
  settings: readonly SettingsSetting[];
}

export interface SettingsGroup {
  title: string;
  description: string;
}

export interface SettingsRegistry {
  sections: readonly SettingsSection[];
  fileOnly: readonly SettingsSetting[];
}

export const BROWSER_NOW = { scope: 'browser', access: 'editable', takesEffect: 'now' } as const;
export const BROWSER_ADVANCED = { scope: 'browser', access: 'advanced', takesEffect: 'now' } as const;
export const MACHINE_NOW = { scope: 'machine', access: 'editable', takesEffect: 'now' } as const;
export const MACHINE_NEW_SESSIONS = { scope: 'machine', access: 'editable', takesEffect: 'new-sessions' } as const;
export const READOUT = { scope: 'machine', access: 'readout', takesEffect: 'now' } as const;
export const FILE_ONLY = { scope: 'machine', access: 'file-only' } as const;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;

export const INVESTIGATIONS: SettingsUnit = { label: 'investigations', storedPerDisplay: 1 };
export const SESSIONS: SettingsUnit = { label: 'sessions', storedPerDisplay: 1 };
export const RECURRENCES: SettingsUnit = { label: 'recurrences', storedPerDisplay: 1 };
export const ACTIONS: SettingsUnit = { label: 'actions', storedPerDisplay: 1 };
export const SECONDS: SettingsUnit = { label: 'seconds', storedPerDisplay: 1 };
export const MINUTES: SettingsUnit = { label: 'minutes', storedPerDisplay: 1 };
export const HOURS: SettingsUnit = { label: 'hours', storedPerDisplay: 1 };
export const DAYS: SettingsUnit = { label: 'days', storedPerDisplay: 1 };
export const SECONDS_STORED_AS_MS: SettingsUnit = { label: 'seconds', storedPerDisplay: MS_PER_SECOND, storedLabel: 'ms' };
export const MINUTES_STORED_AS_MS: SettingsUnit = { label: 'minutes', storedPerDisplay: MS_PER_MINUTE, storedLabel: 'ms' };
export const MINUTES_STORED_AS_SECONDS: SettingsUnit = { label: 'minutes', storedPerDisplay: SECONDS_PER_MINUTE, storedLabel: 'seconds' };
export const HOURS_STORED_AS_MS: SettingsUnit = { label: 'hours', storedPerDisplay: MS_PER_HOUR, storedLabel: 'ms' };
export const HOURS_STORED_AS_MINUTES: SettingsUnit = { label: 'hours', storedPerDisplay: MINUTES_PER_HOUR, storedLabel: 'minutes' };
export const USD: SettingsUnit = { label: 'USD', storedPerDisplay: 1 };
export const USERS: SettingsUnit = { label: 'users', storedPerDisplay: 1 };
export const MULTIPLIER: SettingsUnit = { label: 'times', storedPerDisplay: 1 };

export const TUNING_KNOB = 'A tuning knob kept out of the Settings view; the default suits almost every install.';
export const DIAGNOSTIC = 'A diagnostic switch kept out of the Settings view; change it in config.json while investigating.';
export const PROCESS_SETTING = 'Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind.';
export const STRUCTURED_VALUE = 'A structured value with no dashboard control; edit it in config.json.';
export const BY_RULE = 'Never editable from the dashboard by rule; edit it in config.json.';

export function capitalizedOptions(values: readonly string[]): SettingsOption[] {
  return values.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
}
