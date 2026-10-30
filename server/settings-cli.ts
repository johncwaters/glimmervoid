import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';

import { isRecord } from '../shared/coerce.ts';
import { BrowserConfig } from '../shared/contracts/config.ts';
import { AGENT_URL_ENV, AgentSettingsReply } from '../shared/contracts/session.ts';
import {
  cloneValue, deleteValueAtPath, parsePosthogProjectSelection, scoreSettingsSearch, setValueAtPath, valueAtPath,
} from '../shared/settings/registry-core.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import type { SettingsSetting } from '../shared/settings/registry.ts';
import { errorCode, errorMessage } from '../shared/text.ts';
import { IS_EXPERIMENTAL_BUILD, loadConfigFile, saveConfigFileOnce, validateConfig } from './config-store.ts';
import type { GlimmervoidConfig } from './config-store.ts';
import { renderTable } from './core/ascii-figure-core.ts';
import { isSettingAvailable } from './core/experimental-gate-core.ts';
import { decideConfigPath, glimmervoidHomeDir } from './core/config-path-core.ts';
import { ENV_SECRET_BINDINGS, readEnvSecrets, withEnvSecrets } from './core/config-secrets-core.ts';
import {
  availableSettings, configFileViewOf, defaultText, describeSetting, fail, fitColumn, getSetting, listSettings, readSetting,
  renderSectionTables, requireConfigFileSetting, sectionOf, settingsRequestForServer, succeed, valueText,
} from './core/settings-readout-core.ts';
import type { ConfigFileView, Outcome } from './core/settings-readout-core.ts';

const usage = `glimmervoid settings: read and change config.json from the command line

  glimmervoid settings list                  every config.json setting with its value and where the value comes from
  glimmervoid settings get <path>            one setting; a secret shows as configured or not configured, never its value
  glimmervoid settings set <path> <value>    validate the whole file and write it; a running Glimmervoid reloads it
  glimmervoid settings unset <path>          remove the key from config.json so the default applies
  glimmervoid settings search <text>         find settings by title, keyword, key path or section
  glimmervoid settings schema                every setting: id, path, type, default, unit, effect and section (needs no config file)

  <path> is a config.json key path such as posthog.trafficSpikeEnabled, or a setting id such as posthog-traffic-enabled.
  <value> is true or false for a toggle, a number, text, a comma-separated or JSON list, or JSON for a structured value.
  A number is in the unit config.json stores, as schema's Stored unit column names: set branchGc.intervalMs 21600000 means 21600000 ms.
  Where the dashboard shows another unit, get, list and set add it in parentheses, such as 30000 (30 seconds).
  A secret (a bot token or API key) is never set or unset here, since a value on the command line lands in shell history;
  change it in the dashboard settings or through its environment variable.
  --json           machine-readable output`;

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

type ConfigMutation = (config: Record<string, unknown>) => void;

type CandidateCheck = (candidate: Record<string, unknown>) => string | null;

type CommandContext = {
  positionals: string[];
  isJson: boolean;
  writeOutput: (text: string) => void;
};

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
  if (setting.control === 'list') return parseListValue(setting.path, raw);
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
  return `cannot read the Glimmervoid home at ${homeDir} (${errorCode(error) ?? errorMessage(error)})`;
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
  return succeed(configFileViewOf(decided.path, loaded.value, env, IS_EXPERIMENTAL_BUILD));
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
  const resolved = requireConfigFileSetting(requirePositional(context.positionals, 1, 'path'), view);
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
    const report = listSettings(requireView());
    return print(context, report.readout, report.text);
  },
  get: (context) => {
    const view = requireView();
    const report = getSetting(view, requireSetting(context, view));
    return print(context, report.readout, report.text);
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
      `${setting.path} = ${valueText(readout, setting)}\n${EFFECT_NOTES[setting.takesEffect]}`,
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
    const results = scoreSettingsSearch(SETTINGS_REGISTRY.sections, query, SETTINGS_REGISTRY.fileOnly)
      .filter((result) => isSettingAvailable(result.setting, IS_EXPERIMENTAL_BUILD));
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
      fitColumn(JSON.stringify(setting.defaultValue ?? null)),
      setting.unit?.storedLabel ?? setting.unit?.label ?? '',
      setting.unit?.label ?? '',
      setting.takesEffect,
    ];
    const settings = availableSettings(IS_EXPERIMENTAL_BUILD);
    return print(context, settings.map(describeSetting), renderSectionTables(settings, ['Id', 'Path', 'Type', 'Default', 'Stored unit', 'Display unit', 'Effect'], rowOf));
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

export async function runSettingsCli(commandArguments: string[], io: SettingsCliIo = processIo()): Promise<number> {
  const serverRequest = settingsRequestForServer(commandArguments, process.env);
  if (!serverRequest) return runSettingsCommand(commandArguments, io);
  const { askAgentApi } = await import('./agent-api-cli.ts');
  const reply = AgentSettingsReply.safeParse(await askAgentApi('settings', serverRequest).catch((error: unknown) => ({ ok: false, error: errorMessage(error) })));
  if (!reply.success) {
    io.writeError('settings: Glimmervoid sent a reply this command cannot read\n');
    return 1;
  }
  if (!reply.data.ok) {
    io.writeError(`settings: ${reply.data.error}\n`);
    return 1;
  }
  const isJson = commandArguments.includes('--json');
  io.writeOutput(`${isJson ? JSON.stringify(reply.data.readout, null, 2) : reply.data.text}\n`);
  return 0;
}

export function runSettingsCommand(commandArguments: string[], io: SettingsCliIo = processIo()): number {
  try {
    return runCommandLine(commandArguments, io);
  } catch (error) {
    io.writeError(`settings: ${errorMessage(error)}\n`);
    return 1;
  }
}
