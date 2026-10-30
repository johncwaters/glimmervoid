
import { AGENT_URL_ENV, AgentSettingsRequest } from '../../shared/contracts/session.ts';
import type { AgentSettingsReply } from '../../shared/contracts/session.ts';
import {
  SETTINGS_INDEX, cloneValue, displayText, hasScaledUnit, settingsGroupOf, settingsOf, valueAtPath,
} from '../../shared/settings/registry-core.ts';
import { FILE_ONLY_GROUPS, SETTINGS_REGISTRY } from '../../shared/settings/registry.ts';
import type { SettingsSetting } from '../../shared/settings/registry.ts';
import type { Config } from '../../shared/contracts/config.ts';
import { renderTable } from './ascii-figure-core.ts';
import type { ParsedCommand } from './cli-spec-core.ts';
import { readEnvSecrets } from './config-secrets-core.ts';
import { isSettingAvailable } from './experimental-gate-core.ts';

const VALUE_COLUMN_WIDTH = 40;

interface SectionRef {
  id: string;
  title: string;
}

interface SettingDescriptor {
  id: string;
  path: string;
  title: string;
  description: string;
  type: SettingsSetting['control'];
  scope: SettingsSetting['scope'];
  access: SettingsSetting['access'];
  effect: SettingsSetting['takesEffect'];
  default: unknown;
  unit: string | null;
  displayUnit: string | null;
  storedPerDisplay: number;
  section: SectionRef;
  options?: string[];
  range?: SettingsSetting['range'];
  fileOnlyReason?: string;
}

interface SettingReadout extends SettingDescriptor {
  secret: boolean;
  source: string;
  value?: unknown;
  configured?: boolean;
}

interface ConfigFileView {
  configPath: string;
  config: Record<string, unknown>;
  secretSources: Readonly<Record<string, string>>;
  isExperimentalBuild: boolean;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

const SECTION_BY_SETTING_ID: ReadonlyMap<string, SectionRef> = new Map([
  ...SETTINGS_REGISTRY.sections.flatMap((section) => section.settings.map((setting): [string, SectionRef] => [setting.id, { id: section.id, title: section.title }])),
  ...SETTINGS_REGISTRY.fileOnly.map((setting): [string, SectionRef] => {
    const groupId = setting.group ?? '';
    return [setting.id, { id: groupId, title: settingsGroupOf(groupId)?.title ?? groupId }];
  }),
]);

const ALL_SETTINGS: readonly SettingsSetting[] = [...settingsOf(SETTINGS_REGISTRY.sections), ...SETTINGS_REGISTRY.fileOnly];

const SECTION_ORDER: readonly SectionRef[] = [
  ...SETTINGS_REGISTRY.sections.map((section) => ({ id: section.id, title: section.title })),
  ...Object.entries(FILE_ONLY_GROUPS).map(([id, group]) => ({ id, title: group.title })),
];

function fail<T>(message: string): Outcome<T> {
  return { ok: false, message };
}

function succeed<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function isConfigFileSetting(setting: SettingsSetting): boolean {
  return setting.scope === 'machine' && setting.control !== 'readonly';
}

function sectionOf(setting: SettingsSetting): SectionRef {
  return SECTION_BY_SETTING_ID.get(setting.id) ?? { id: '', title: '' };
}

function describeSetting(setting: SettingsSetting): SettingDescriptor {
  const descriptor: SettingDescriptor = {
    id: setting.id,
    path: setting.path,
    title: setting.title,
    description: setting.description,
    type: setting.control,
    scope: setting.scope,
    access: setting.access,
    effect: setting.takesEffect,
    default: cloneValue(setting.defaultValue) ?? null,
    unit: setting.unit?.storedLabel ?? setting.unit?.label ?? null,
    displayUnit: setting.unit?.label ?? null,
    storedPerDisplay: setting.unit?.storedPerDisplay ?? 1,
    section: sectionOf(setting),
  };
  if (setting.options) descriptor.options = setting.options.map((option) => option.value);
  if (setting.range) descriptor.range = setting.range;
  if (setting.fileOnlyReason) descriptor.fileOnlyReason = setting.fileOnlyReason;
  return descriptor;
}

function isStoredSecret(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function readSetting(setting: SettingsSetting, view: ConfigFileView): SettingReadout {
  const stored = valueAtPath(view.config, setting.path);
  const envSource = view.secretSources[setting.path];
  const source = envSource ?? (stored !== undefined ? 'config.json' : 'default');
  const readout: SettingReadout = { ...describeSetting(setting), secret: setting.control === 'password', source };
  if (readout.secret) {
    readout.configured = isStoredSecret(stored);
    return readout;
  }
  readout.value = stored !== undefined ? cloneValue(stored) : readout.default;
  return readout;
}

function fitColumn(text: string): string {
  if (text.length <= VALUE_COLUMN_WIDTH) return text;
  return `${text.slice(0, VALUE_COLUMN_WIDTH - 3)}...`;
}

function storedValueText(setting: SettingsSetting, value: unknown): string {
  if (setting.valueKind) return displayText(setting, value);
  const stored = JSON.stringify(value ?? null);
  if (typeof value !== 'number' || !hasScaledUnit(setting)) return stored;
  return `${stored} (${displayText(setting, value)})`;
}

function valueText(readout: SettingReadout, setting: SettingsSetting): string {
  if (readout.secret) return readout.configured ? 'configured' : 'not configured';
  return storedValueText(setting, readout.value);
}

function defaultText(setting: SettingsSetting): string {
  return storedValueText(setting, setting.defaultValue);
}

function settingsBySection(settings: readonly SettingsSetting[]): { section: SectionRef; settings: SettingsSetting[] }[] {
  return SECTION_ORDER
    .map((section) => ({ section, settings: settings.filter((setting) => sectionOf(setting).id === section.id) }))
    .filter((group) => group.settings.length > 0);
}

function renderSectionTables(settings: readonly SettingsSetting[], headers: string[], rowOf: (setting: SettingsSetting) => string[]): string {
  return settingsBySection(settings)
    .map(({ section, settings: grouped }) => renderTable({ title: section.title, headers, rows: grouped.map(rowOf), align: headers.map(() => 'left') }))
    .join('\n\n');
}

function resolveSetting(argument: string): SettingsSetting | null {
  return SETTINGS_INDEX.byPath.get(argument) ?? SETTINGS_INDEX.byId.get(argument) ?? null;
}

function availableSettings(isExperimentalBuild: boolean): SettingsSetting[] {
  return ALL_SETTINGS.filter((setting) => isSettingAvailable(setting, isExperimentalBuild));
}

function requireConfigFileSetting(argument: string, view: Pick<ConfigFileView, 'configPath' | 'isExperimentalBuild'>): Outcome<SettingsSetting> {
  const { configPath } = view;
  const setting = resolveSetting(argument);
  if (!setting) return fail(`${argument} is not a setting in the registry, so this command cannot read or change it; edit config.json at ${configPath} by hand`);
  if (!isSettingAvailable(setting, view.isExperimentalBuild)) return fail(`${setting.path} is an experimental setting, so it exists only on an experimental build; switch Settings > Updates > Channel to Experimental and update to use it`);
  if (setting.scope === 'browser') return fail(`${setting.id} is a browser preference saved in each browser, not in config.json; change it in the dashboard under Settings > ${sectionOf(setting).title}`);
  if (setting.control === 'readonly') return fail(`${setting.id} is a read-only status row under Settings > ${sectionOf(setting).title}; it has no config.json key`);
  return succeed(setting);
}

function configFileViewOf(configPath: string, config: Config, env: NodeJS.ProcessEnv, isExperimentalBuild: boolean): ConfigFileView {
  const secretSources = Object.fromEntries(readEnvSecrets(env).map((secret) => [`${secret.blockName}.${secret.secretKey}`, secret.environmentVariable]));
  return { configPath, config, secretSources, isExperimentalBuild };
}

interface SettingsReport {
  readout: unknown;
  text: string;
}

function listSettings(view: ConfigFileView): SettingsReport {
  const settings = availableSettings(view.isExperimentalBuild).filter(isConfigFileSetting);
  const readouts = settings.map((setting) => readSetting(setting, view));
  const readoutById = new Map(readouts.map((readout) => [readout.id, readout]));
  const rowOf = (setting: SettingsSetting): string[] => {
    const readout = readoutById.get(setting.id);
    if (!readout) return [setting.path, '', ''];
    return [setting.path, fitColumn(valueText(readout, setting)), readout.source];
  };
  return { readout: readouts, text: renderSectionTables(settings, ['Setting', 'Value', 'Source'], rowOf) };
}

function getSetting(view: ConfigFileView, setting: SettingsSetting): SettingsReport {
  const readout = readSetting(setting, view);
  const sourceNote = readout.secret && !readout.configured ? '' : ` (${readout.source})`;
  return { readout, text: `${setting.path} = ${valueText(readout, setting)}${sourceNote}` };
}

function readSettingsForAgent({ command, path }: AgentSettingsRequest, view: ConfigFileView): AgentSettingsReply {
  if (command === 'list') return { ok: true, ...listSettings(view) };
  if (path === undefined) return { ok: false, error: 'get needs a setting path or id, such as posthog.trafficSpikeEnabled' };
  const resolved = requireConfigFileSetting(path, view);
  if (!resolved.ok) return { ok: false, error: resolved.message };
  return { ok: true, ...getSetting(view, resolved.value) };
}

function settingsRequestForServer({ commandPath, positionals }: Extract<ParsedCommand, { kind: 'run' }>, env: NodeJS.ProcessEnv): AgentSettingsRequest | null {
  if (!env[AGENT_URL_ENV]) return null;
  const parsed = AgentSettingsRequest.safeParse({ command: commandPath[1], ...(positionals[0] === undefined ? {} : { path: positionals[0] }) });
  return parsed.success ? parsed.data : null;
}

export {
  availableSettings, configFileViewOf, defaultText, describeSetting, fail, fitColumn, getSetting, listSettings, readSetting, readSettingsForAgent,
  renderSectionTables, requireConfigFileSetting, sectionOf, settingsRequestForServer, succeed, valueText,
};
export type { ConfigFileView, Outcome };
