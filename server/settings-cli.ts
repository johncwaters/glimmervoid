import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isRecord } from '../shared/coerce.ts';
import { BrowserConfig, Config } from '../shared/contracts/config.ts';
import { AGENT_URL_ENV, AgentSettingsReply } from '../shared/contracts/session.ts';
import {
  cloneValue, deleteValueAtPath, parsePosthogProjectSelection, scoreSettingsSearch, setValueAtPath, valueAtPath,
} from '../shared/settings/registry-core.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import type { SettingsSetting } from '../shared/settings/registry.ts';
import { errorCode, errorMessage } from '../shared/text.ts';
import { DEFAULT_CONFIG, loadConfigFile, saveConfigFileOnce, validateConfig } from './config-store.ts';
import type { GlimmervoidConfig } from './config-store.ts';
import { renderTable } from './core/ascii-figure-core.ts';
import { OWNED_COMMAND_SPECS, parseCommand } from './core/cli-spec-core.ts';
import type { ParsedCommand } from './core/cli-spec-core.ts';
import { decideConfigPath, glimmervoidHomeDir } from './core/config-path-core.ts';
import { glimmervoidSecretPaths } from './secrets/core/secret-files-core.ts';
import { normalizeRemoteConfig, resolveLocalPort, validateRemoteConfig } from './core/remote-config.ts';
import { ENV_SECRET_BINDINGS, readEnvSecrets, withEnvSecrets, withoutEnvSecrets } from './core/config-secrets-core.ts';
import {
  availableSettings, configFileViewOf, defaultText, describeSetting, fail, fitColumn, getSetting, listSettings, readSetting,
  renderSectionTables, requireConfigFileSetting, sectionOf, settingsRequestForServer, succeed, valueText,
} from './core/settings-readout-core.ts';
import type { ConfigFileView, Outcome } from './core/settings-readout-core.ts';

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
  filePath: string | null;
  writeOutput: (text: string) => void;
};

function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) throw new Error(`missing <${name}>; run glimmervoid settings --help for the usage`);
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

function saveValidatedConfig(view: ConfigFileView, settingPath: string, mutate: ConfigMutation, checks: readonly CandidateCheck[] = []): GlimmervoidConfig {
  const validationError = validationErrorOf(view, mutate, settingPath, checks);
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

function readConfigFile(configPath: string, homeDir: string): Outcome<{ config: GlimmervoidConfig; secretsFileKeys: string[] }> {
  try {
    const loaded = loadConfigFile(configPath, { exitOnError: false });
    if (!loaded.config) return fail(loaded.message);
    return succeed({ config: loaded.config, secretsFileKeys: loaded.secretsFileKeys });
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
  return succeed(configFileViewOf(decided.path, loaded.value.config, env, loaded.value.secretsFileKeys));
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

function realPathOrSelf(candidatePath: string): string {
  try {
    return fs.realpathSync(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

function readPlannedKeys(filePath: string, view: ConfigFileView): Record<string, unknown> {
  const secretPaths = glimmervoidSecretPaths({ glimmervoidHome: glimmervoidHomeDir(os.homedir(), process.env), configPath: view.configPath }).map(realPathOrSelf);
  const plannedRealPath = realPathOrSelf(filePath);
  if (secretPaths.some((secretPath) => plannedRealPath === secretPath || plannedRealPath.startsWith(`${secretPath}${path.sep}`))) throw new Error(`${filePath} is one of Glimmervoid's own secret files, so set --file never reads it`);
  let planned: unknown;
  try {
    planned = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (errorCode(error)) throw new Error(`could not read ${filePath} (${errorCode(error)})`);
    throw new Error(`${filePath} is not valid JSON`);
  }
  if (!isRecord(planned)) throw new Error(`${filePath} must hold a JSON object of top-level config keys`);
  if (Object.keys(planned).length === 0) throw new Error(`${filePath} names no config keys`);
  return planned;
}

function plannedKeysRefusal(planned: Record<string, unknown>, view: ConfigFileView): string | null {
  const unknownKeys = Object.keys(planned).filter((key) => !Object.hasOwn(Config.shape, key));
  if (unknownKeys.length > 0) return `${unknownKeys.join(', ')} ${unknownKeys.length === 1 ? 'is not a config key' : 'are not config keys'}; set --file takes only top-level config.json keys`;
  for (const binding of ENV_SECRET_BINDINGS) {
    const block = planned[binding.blockName];
    if (isRecord(block) && Object.hasOwn(block, binding.secretKey)) return `${binding.blockName}.${binding.secretKey} is a secret, so set --file never takes it; remove it from the file and change it in the dashboard or through ${binding.environmentVariable}`;
    const savedBlock = view.config[binding.blockName as keyof GlimmervoidConfig];
    const hasSavedSecret = isRecord(savedBlock) && Object.hasOwn(savedBlock, binding.secretKey);
    if (Object.hasOwn(planned, binding.blockName) && !isRecord(block) && hasSavedSecret) return `${binding.blockName} holds a saved secret, so set --file only takes it as an object; the secret stays as it is`;
  }
  for (const [key, reason] of HAND_EDITED_SETTING_REASONS) {
    if (!Object.hasOwn(planned, key)) continue;
    if (JSON.stringify(planned[key]) === JSON.stringify(view.config[key as keyof GlimmervoidConfig])) continue;
    return `${key} cannot be changed from this command, because ${reason}; edit config.json at ${view.configPath} by hand`;
  }
  return null;
}

function replaceKeepingSecrets(config: Record<string, unknown>, planned: Record<string, unknown>): void {
  const keptSecrets = ENV_SECRET_BINDINGS.flatMap((binding) => {
    const block = config[binding.blockName];
    if (!Object.hasOwn(planned, binding.blockName) || !isRecord(block) || !Object.hasOwn(block, binding.secretKey)) return [];
    return [{ binding, value: block[binding.secretKey] }];
  });
  for (const [key, value] of Object.entries(planned)) config[key] = cloneValue(value);
  for (const { binding, value } of keptSecrets) {
    const block = config[binding.blockName];
    if (isRecord(block)) block[binding.secretKey] = value;
  }
}

function remotePortClash(candidate: Record<string, unknown>): string | null {
  const localPort = resolveLocalPort({ envPort: process.env.GLIMMERVOID_PORT, configPort: candidate.port, defaultPort: DEFAULT_CONFIG.port });
  return validateRemoteConfig(normalizeRemoteConfig(candidate.remote), localPort).error;
}

function registryChecksFor(planned: Record<string, unknown>): CandidateCheck[] {
  const settingChecks = availableSettings().flatMap((setting) => {
    const value = valueAtPath(planned, setting.path);
    if (value === undefined) return [];
    return [() => registryValueError(setting, value), dashboardSchemaCheck(setting)];
  });
  return [...settingChecks, remotePortClash];
}

function setFromFile(context: CommandContext, filePath: string): number {
  if (process.env[AGENT_URL_ENV]) throw new Error('set --file is for the operator\'s own terminal, so a session cannot run it; use glimmervoid settings set <path> <value>');
  if (context.positionals.length > 1) throw new Error('set takes either <path> <value> or --file <file>, not both');
  const view = requireView();
  const planned = readPlannedKeys(filePath, view);
  const refusal = plannedKeysRefusal(planned, view);
  if (refusal) throw new Error(refusal);
  const plannedKeys = Object.keys(planned);
  saveValidatedConfig(view, plannedKeys.join(', '), (config) => replaceKeepingSecrets(config, planned), registryChecksFor(planned));
  return print(context, { configPath: view.configPath, keys: plannedKeys }, `Replaced ${plannedKeys.join(', ')} in ${view.configPath}\nA running Glimmervoid reloads it; a setting that needs a restart applies after one.`);
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
  export: (context) => {
    const view = requireView();
    context.writeOutput(`${JSON.stringify(withoutEnvSecrets(view.config, ENV_SECRET_BINDINGS), null, 2)}\n`);
    return 0;
  },
  set: (context) => {
    if (context.filePath !== null) return setFromFile(context, context.filePath);
    const view = requireView();
    const setting = requireWritableSetting(context, view);
    const parsed = parseSettingValue(setting, requirePositional(context.positionals, 2, 'value'));
    if (!parsed.ok) throw new Error(parsed.message);
    const previous = cloneValue(valueAtPath(view.config, setting.path)) ?? null;
    const checks: CandidateCheck[] = [() => registryValueError(setting, parsed.value), dashboardSchemaCheck(setting)];
    const written = saveValidatedConfig(view, setting.path, (config) => setValueAtPath(config, setting.path, parsed.value), checks);
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
    const written = saveValidatedConfig(view, setting.path, (config) => deleteValueAtPath(config, setting.path), [dashboardSchemaCheck(setting)]);
    const readout = readSetting(setting, { ...view, config: written });
    return print(
      context,
      { ...readout, configPath: view.configPath, changed: true },
      `${setting.path} unset; the default ${defaultText(setting)} applies\n${EFFECT_NOTES[setting.takesEffect]}`,
    );
  },
  describe: (context) => {
    const resolved = requireConfigFileSetting(requirePositional(context.positionals, 1, 'path'), { configPath: 'config.json' });
    if (!resolved.ok) throw new Error(resolved.message);
    const descriptor = describeSetting(resolved.value);
    const lines = [`${descriptor.path}: ${descriptor.title}`, descriptor.description, `Default: ${defaultText(resolved.value)}`];
    if (descriptor.fileOnlyReason) lines.push(descriptor.fileOnlyReason);
    if (descriptor.jsonSchema !== undefined) lines.push('JSON Schema:', JSON.stringify(descriptor.jsonSchema, null, 2));
    if (descriptor.example !== undefined) lines.push('Example:', JSON.stringify(descriptor.example, null, 2));
    return print(context, descriptor, lines.join('\n'));
  },
  search: (context) => {
    const query = context.positionals.slice(1).join(' ');
    if (query.trim() === '') throw new Error('missing <text>; run glimmervoid settings --help for the usage');
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
      fitColumn(JSON.stringify(setting.defaultValue ?? null)),
      setting.unit?.storedLabel ?? setting.unit?.label ?? '',
      setting.unit?.label ?? '',
      setting.takesEffect,
    ];
    const settings = availableSettings();
    return print(context, settings.map(describeSetting), renderSectionTables(settings, ['Id', 'Path', 'Type', 'Default', 'Stored unit', 'Display unit', 'Effect'], rowOf));
  },
};

function processIo(): SettingsCliIo {
  return {
    writeOutput: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  };
}

type ParsedSettingsRun = Extract<ParsedCommand, { kind: 'run' }>;

function runParsedSettingsCommand(parsed: ParsedSettingsRun, io: SettingsCliIo): number {
  const commandName = parsed.commandPath[1] ?? '';
  const command = commands[commandName];
  if (!command) {
    io.writeError(`settings: unknown command ${commandName}\n`);
    return 1;
  }
  try {
    const filePath = typeof parsed.values.file === 'string' ? parsed.values.file : null;
    return command({ positionals: [commandName, ...parsed.positionals], isJson: parsed.values.json === true, filePath, writeOutput: io.writeOutput });
  } catch (error) {
    io.writeError(`settings: ${errorMessage(error)}\n`);
    return 1;
  }
}


export async function runParsedSettingsCli(parsed: ParsedSettingsRun, io: SettingsCliIo = processIo()): Promise<number> {
  const serverRequest = settingsRequestForServer(parsed, process.env);
  if (!serverRequest) return runParsedSettingsCommand(parsed, io);
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
  io.writeOutput(`${parsed.values.json === true ? JSON.stringify(reply.data.readout, null, 2) : reply.data.text}\n`);
  return 0;
}

export function runSettingsCommand(commandArguments: string[], io: SettingsCliIo = processIo()): number {
  const parsed = parseCommand(OWNED_COMMAND_SPECS.settings, commandArguments);
  if (parsed.kind === 'help') {
    io.writeOutput(`${parsed.text}\n`);
    return 0;
  }
  if (parsed.kind === 'refused') {
    io.writeError(`${parsed.text}\n`);
    return 1;
  }
  return runParsedSettingsCommand(parsed, io);
}
