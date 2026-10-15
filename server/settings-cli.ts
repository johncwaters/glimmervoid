import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';

import { isRecord } from '../shared/coerce.ts';
import { BrowserConfig } from '../shared/contracts/config.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import {
  SETTINGS_INDEX, cloneValue, deleteValueAtPath, displayValue, parsePosthogProjectSelection, scoreSettingsSearch,
  setValueAtPath, settingsGroupOf, settingsOf, valueAtPath,
} from '../shared/settings/registry-core.ts';
import { FILE_ONLY_GROUPS, SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import type { SettingsSetting } from '../shared/settings/registry.ts';
import { errorCode, errorMessage } from '../shared/text.ts';
import { loadConfigFile, saveConfigFileOnce, validateConfig } from './config-store.ts';
import type { GlimmervoidConfig } from './config-store.ts';
import { renderTable } from './core/ascii-figure-core.ts';
import { decideConfigPath, glimmervoidHomeDir } from './core/config-path-core.ts';
import { ENV_SECRET_BINDINGS, readEnvSecrets, withEnvSecrets } from './core/config-secrets-core.ts';

const usage = `glimmervoid settings: read and change config.json from the command line

  glimmervoid settings list                  every config.json setting with its value and where the value comes from
  glimmervoid settings get <path>            one setting; a secret shows as configured or not configured, never its value
  glimmervoid settings set <path> <value>    validate the whole file and write it; a running Glimmervoid reloads it
  glimmervoid settings unset <path>          remove the key from config.json so the default applies
  glimmervoid settings search <text>         find settings by title, keyword, key path or section
  glimmervoid settings schema                every setting: id, path, type, default, unit, effect and section (needs no config file)

  <path> is a config.json key path such as posthog.trafficSpikeEnabled, or a setting id such as posthog-traffic-enabled.
  <value> is true or false for a toggle, a number, text, a comma-separated or JSON list, or JSON for a structured value.
  A secret (a bot token or API key) is never set or unset here, since a value on the command line lands in shell history;
  change it in the dashboard settings or through its environment variable.
  --json           machine-readable output`;

const VALUE_COLUMN_WIDTH = 40;

const EFFECT_NOTES: Readonly<Record<SettingsSetting['takesEffect'], string>> = Object.freeze({
  now: 'A running Glimmervoid applies it without a restart.',
  'new-sessions': 'Sessions started after this change use it.',
  restart: 'Restart Glimmervoid to apply it.',
});

const HAND_EDITED_SETTING_REASONS: ReadonlyMap<string, string> = new Map([
  ['port', 'a listener port that clashes with remote.port stops Glimmervoid from starting'],
]);

interface SettingsCliIo {
  writeOutput: (text: string) => void;
  writeError: (text: string) => void;
}

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
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

type ConfigMutation = (config: Record<string, unknown>) => void;

type CandidateCheck = (candidate: Record<string, unknown>) => string | null;

type CommandContext = {
  positionals: string[];
  isJson: boolean;
  writeOutput: (text: string) => void;
};

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
    unit: setting.unit?.label ?? null,
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

function valueText(readout: SettingReadout, setting: SettingsSetting): string {
  if (readout.secret) return readout.configured ? 'configured' : 'not configured';
  if (setting.valueKind) return String(displayValue(setting, readout.value));
  return JSON.stringify(readout.value ?? null);
}

function defaultText(setting: SettingsSetting): string {
  return JSON.stringify(setting.defaultValue ?? null);
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

function requireConfigFileSetting(argument: string, configPath: string): Outcome<SettingsSetting> {
  const setting = resolveSetting(argument);
  if (!setting) return fail(`${argument} is not a setting in the registry, so this command cannot read or change it; edit config.json at ${configPath} by hand`);
  if (setting.scope === 'browser') return fail(`${setting.id} is a browser preference saved in each browser, not in config.json; change it in the dashboard under Settings > ${sectionOf(setting).title}`);
  if (setting.control === 'readonly') return fail(`${setting.id} is a read-only status row under Settings > ${sectionOf(setting).title}; it has no config.json key`);
  return succeed(setting);
}

function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) throw new Error(`missing <${name}>\n\n${usage}`);
  return value;
}

function parseListValue(path: string, raw: string): Outcome<string[]> {
  const listError = `${path} must be a comma-separated list or a JSON array of strings`;
  if (!raw.trim().startsWith('[')) return succeed(raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''));
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return succeed(parsed);
  } catch {
    return fail(listError);
  }
  return fail(listError);
}

function parseNumberValue(setting: SettingsSetting, raw: string): Outcome<number | null> {
  if (setting.nullable && raw.trim() === '') return succeed(null);
  const number = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(number)) return fail(`${setting.path} must be a number`);
  if (setting.integer !== false && !Number.isInteger(number)) return fail(`${setting.path} must be a whole number`);
  if (setting.zeroIsNull && number <= 0) return succeed(null);
  return succeed(number);
}

function parseSettingValue(setting: SettingsSetting, raw: string): Outcome<unknown> {
  if (setting.valueKind === 'posthog-projects') {
    const selection = parsePosthogProjectSelection(raw);
    if (selection === null) return fail(`${setting.path} must be all, none or a comma-separated list of positive integer project ids`);
    return succeed(selection);
  }
  if (setting.control === 'toggle') {
    if (/^(true|on|yes|1)$/i.test(raw.trim())) return succeed(true);
    if (/^(false|off|no|0)$/i.test(raw.trim())) return succeed(false);
    return fail(`${setting.path} must be a boolean: true or false`);
  }
  if (setting.control === 'number') return parseNumberValue(setting, raw);
  if (setting.control === 'list' || setting.control === 'projects') return parseListValue(setting.path, raw);
  if (setting.control === 'json') {
    try {
      return succeed(JSON.parse(raw));
    } catch (error) {
      return fail(`${setting.path} must be JSON: ${errorMessage(error)}`);
    }
  }
  const text = raw.trim();
  if (setting.nullable && text === '') return succeed(null);
  return succeed(text);
}

function rangeLabel(range: NonNullable<SettingsSetting['range']>): string {
  if (range.label) return range.label;
  if (range.max !== undefined) return `between ${range.min} and ${range.max}`;
  return range.exclusiveMin ? `greater than ${range.min}` : `at least ${range.min}`;
}

function registryValueError(setting: SettingsSetting, value: unknown): string | null {
  if (value === null) return null;
  if (setting.control === 'number' && typeof value === 'number' && setting.range) {
    const belowMin = setting.range.exclusiveMin ? value <= setting.range.min : value < setting.range.min;
    const aboveMax = setting.range.max !== undefined && value > setting.range.max;
    if (belowMin || aboveMax) return `${setting.path} must be ${rangeLabel(setting.range)}`;
  }
  if (setting.options && typeof value === 'string' && !setting.options.some((option) => option.value === value)) {
    return `${setting.path} must be one of ${setting.options.map((option) => option.value).join(', ')}`;
  }
  return null;
}

function isBrowserConfigKey(key: string): key is keyof typeof BrowserConfig.shape {
  return Object.hasOwn(BrowserConfig.shape, key);
}

function dashboardSchemaCheck(setting: SettingsSetting): CandidateCheck {
  const [topLevelKey, ...nestedParts] = setting.path.split('.');
  return (candidate) => {
    if (!isBrowserConfigKey(topLevelKey)) return null;
    const parsed = BrowserConfig.shape[topLevelKey].safeParse(candidate[topLevelKey]);
    if (parsed.success) return null;
    const issue = parsed.error.issues.find((candidateIssue) => nestedParts.every((part, index) => String(candidateIssue.path[index]) === part)) ?? parsed.error.issues.at(0);
    if (!issue) return null;
    const issueKeyPath = [topLevelKey, ...issue.path.map(String)].join('.');
    return issue.message.includes(issueKeyPath) ? issue.message : `${issueKeyPath}: ${issue.message}`;
  };
}

function validationErrorOf(view: ConfigFileView, mutate: ConfigMutation, settingPath: string, checks: readonly CandidateCheck[]): string | null {
  const candidate = cloneValue(view.config);
  if (!isRecord(candidate)) return 'config must be a plain object';
  mutate(candidate);
  const validation = validateConfig(withEnvSecrets(candidate, readEnvSecrets(process.env)));
  if (!validation.ok) {
    const schemaMessage = validation.errors.join('; ');
    return schemaMessage.includes(settingPath) ? schemaMessage : `${settingPath}: ${schemaMessage}`;
  }
  for (const check of checks) {
    const error = check(candidate);
    if (error) return error;
  }
  return null;
}

function applyValidatedMutation(view: ConfigFileView, setting: SettingsSetting, mutate: ConfigMutation, checks: readonly CandidateCheck[] = []): GlimmervoidConfig {
  const validationError = validationErrorOf(view, mutate, setting.path, checks);
  if (validationError) throw new Error(validationError);
  const saved = saveConfigFileOnce(view.configPath, mutate);
  if (!saved.ok) throw new Error(saved.message);
  return saved.config;
}

function unreadableHomeMessage(homeDir: string, error: unknown): string {
  return `cannot read the Glimmervoid home at ${homeDir} (${errorCode(error) ?? errorMessage(error)}). A session with guardrails cannot read it; run this command from a shell outside the session`;
}

function homeReadError(homeDir: string): string | null {
  try {
    fs.accessSync(homeDir, fs.constants.R_OK);
    return null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && !process.env[AGENT_URL_ENV]) return null;
    return unreadableHomeMessage(homeDir, error);
  }
}

function readConfigFile(configPath: string, homeDir: string): Outcome<GlimmervoidConfig> {
  try {
    const loaded = loadConfigFile(configPath, { exitOnError: false });
    if (!loaded.config) return fail(loaded.message);
    return succeed(loaded.config);
  } catch (error) {
    if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') return fail(unreadableHomeMessage(homeDir, error));
    return fail(`could not read ${configPath}: ${errorMessage(error)}`);
  }
}

function openConfigFile(): Outcome<ConfigFileView> {
  const env = process.env;
  const homeDir = glimmervoidHomeDir(os.homedir(), env);
  const homeError = homeReadError(homeDir);
  if (homeError) return fail(homeError);
  const decided = decideConfigPath({ env, homeDir }, (candidate) => fs.existsSync(candidate));
  if (!decided.path && decided.source === 'env') return fail(`config file not found: ${decided.envPath}`);
  if (!decided.path) return fail(`no config.json at ${decided.homePath}. Start Glimmervoid once to create it; glimmervoid settings schema needs no config file`);
  const loaded = readConfigFile(decided.path, homeDir);
  if (!loaded.ok) return fail(loaded.message);
  const secretSources = Object.fromEntries(readEnvSecrets(env).map((secret) => [`${secret.blockName}.${secret.secretKey}`, secret.environmentVariable]));
  return succeed({ configPath: decided.path, config: loaded.value, secretSources });
}

function print(context: CommandContext, jsonValue: unknown, text: string): number {
  context.writeOutput(`${context.isJson ? JSON.stringify(jsonValue, null, 2) : text}\n`);
  return 0;
}

function requireView(): ConfigFileView {
  const opened = openConfigFile();
  if (!opened.ok) throw new Error(opened.message);
  return opened.value;
}

function requireSetting(context: CommandContext, view: ConfigFileView): SettingsSetting {
  const resolved = requireConfigFileSetting(requirePositional(context.positionals, 1, 'path'), view.configPath);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.value;
}

function secretRefusal(setting: SettingsSetting): string {
  const binding = ENV_SECRET_BINDINGS.find((candidate) => `${candidate.blockName}.${candidate.secretKey}` === setting.path);
  const environmentWay = binding ? `, or set ${binding.environmentVariable} in the environment Glimmervoid starts with` : '';
  return `${setting.path} is a secret, so this command never takes or removes it, since a value on the command line lands in shell history; change it in the dashboard under Settings > ${sectionOf(setting).title}${environmentWay}`;
}

function writeRefusal(setting: SettingsSetting, configPath: string): string | null {
  if (setting.control === 'password') return secretRefusal(setting);
  const handEditedReason = HAND_EDITED_SETTING_REASONS.get(setting.path);
  if (handEditedReason) return `${setting.path} cannot be changed from this command, because ${handEditedReason}; edit config.json at ${configPath} by hand`;
  return null;
}

function requireWritableSetting(context: CommandContext, view: ConfigFileView): SettingsSetting {
  const setting = requireSetting(context, view);
  const refusal = writeRefusal(setting, view.configPath);
  if (refusal) throw new Error(refusal);
  return setting;
}

const commands: Record<string, (context: CommandContext) => number> = {
  list: (context) => {
    const view = requireView();
    const settings = ALL_SETTINGS.filter(isConfigFileSetting);
    const readouts = settings.map((setting) => readSetting(setting, view));
    const readoutById = new Map(readouts.map((readout) => [readout.id, readout]));
    const rowOf = (setting: SettingsSetting): string[] => {
      const readout = readoutById.get(setting.id);
      if (!readout) return [setting.path, '', ''];
      return [setting.path, fitColumn(valueText(readout, setting)), readout.source];
    };
    return print(context, readouts, renderSectionTables(settings, ['Setting', 'Value', 'Source'], rowOf));
  },
  get: (context) => {
    const view = requireView();
    const setting = requireSetting(context, view);
    const readout = readSetting(setting, view);
    const sourceNote = readout.secret && !readout.configured ? '' : ` (${readout.source})`;
    return print(context, readout, `${setting.path} = ${valueText(readout, setting)}${sourceNote}`);
  },
  set: (context) => {
    const view = requireView();
    const setting = requireWritableSetting(context, view);
    const parsed = parseSettingValue(setting, requirePositional(context.positionals, 2, 'value'));
    if (!parsed.ok) throw new Error(parsed.message);
    const previous = cloneValue(valueAtPath(view.config, setting.path)) ?? null;
    const checks: CandidateCheck[] = [() => registryValueError(setting, parsed.value), dashboardSchemaCheck(setting)];
    const written = applyValidatedMutation(view, setting, (config) => setValueAtPath(config, setting.path, parsed.value), checks);
    const readout = readSetting(setting, { ...view, config: written });
    return print(
      context,
      { ...readout, previous, configPath: view.configPath },
      `${setting.path} = ${JSON.stringify(parsed.value)}\n${EFFECT_NOTES[setting.takesEffect]}`,
    );
  },
  unset: (context) => {
    const view = requireView();
    const setting = requireWritableSetting(context, view);
    if (valueAtPath(view.config, setting.path) === undefined) {
      return print(context, { ...readSetting(setting, view), configPath: view.configPath, changed: false }, `${setting.path} is not set in config.json; the default ${defaultText(setting)} already applies`);
    }
    const written = applyValidatedMutation(view, setting, (config) => deleteValueAtPath(config, setting.path), [dashboardSchemaCheck(setting)]);
    const readout = readSetting(setting, { ...view, config: written });
    return print(
      context,
      { ...readout, configPath: view.configPath, changed: true },
      `${setting.path} unset; the default ${defaultText(setting)} applies\n${EFFECT_NOTES[setting.takesEffect]}`,
    );
  },
  search: (context) => {
    const query = context.positionals.slice(1).join(' ');
    if (query.trim() === '') throw new Error(`missing <text>\n\n${usage}`);
    const results = scoreSettingsSearch(SETTINGS_REGISTRY.sections, query, SETTINGS_REGISTRY.fileOnly);
    const rows = results.map((result) => [
      result.setting.scope === 'browser' ? `${result.setting.id} (browser preference)` : result.setting.path,
      result.setting.title,
      sectionOf(result.setting).title,
    ]);
    const text = results.length === 0
      ? '(no matches)'
      : renderTable({ title: `Settings matching ${query}`, headers: ['Setting', 'Title', 'Section'], rows, align: ['left', 'left', 'left'] });
    return print(context, results.map((result) => ({ ...describeSetting(result.setting), score: result.score })), text);
  },
  schema: (context) => {
    const rowOf = (setting: SettingsSetting): string[] => [
      setting.id,
      setting.scope === 'browser' ? `${setting.path} (browser)` : setting.path,
      setting.control,
      fitColumn(defaultText(setting)),
      setting.unit?.label ?? '',
      setting.takesEffect,
    ];
    return print(context, ALL_SETTINGS.map(describeSetting), renderSectionTables(ALL_SETTINGS, ['Id', 'Path', 'Type', 'Default', 'Unit', 'Effect'], rowOf));
  },
};

function runCommandLine(commandArguments: string[], io: SettingsCliIo): number {
  const { values, positionals } = parseArgs({
    args: commandArguments,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const commandName = positionals[0];
  const command = commandName === undefined ? undefined : commands[commandName];
  if (values.help || commandName === undefined || command === undefined) {
    io.writeOutput(`${usage}\n`);
    return values.help ? 0 : 1;
  }
  return command({ positionals, isJson: values.json, writeOutput: io.writeOutput });
}

function processIo(): SettingsCliIo {
  return {
    writeOutput: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  };
}

export function runSettingsCommand(commandArguments: string[], io: SettingsCliIo = processIo()): number {
  try {
    return runCommandLine(commandArguments, io);
  } catch (error) {
    io.writeError(`settings: ${errorMessage(error)}\n`);
    return 1;
  }
}
