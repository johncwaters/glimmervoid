import type { CatalogModel, ConfiguredDefault, ModelOption, ModelSelection } from './contracts/agent-models.ts';

export const EFFORT_OPTION_ID = 'effort';
export const SAFE_LAUNCH_ARGUMENT_PATTERN = /^[A-Za-z0-9._:/[\]-]+$/;
export const OPENROUTER_KEY_NAME = 'OPENROUTER_API_KEY';
export const OPENROUTER_AGENT_IDS: readonly string[] = ['claude-code', 'codex', 'opencode', 'pi'];

const CLAUDE_DEFAULT_POINTER = 'default';
const CODEX_HIDDEN_VISIBILITY = 'hide';
const EFFORT_LABEL = 'Effort';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(trimmedText).filter((text): text is string => text !== null);
}

function effortOption(choices: string[], defaultChoice: string | null): ModelOption[] {
  if (choices.length === 0) return [];
  return [{ id: EFFORT_OPTION_ID, label: EFFORT_LABEL, choices, defaultChoice: defaultChoice !== null && choices.includes(defaultChoice) ? defaultChoice : null }];
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function claudeInitializeModels(streamJsonOutput: string): unknown[] | null {
  for (const line of streamJsonOutput.split(/\r?\n/)) {
    const message = parseJsonLine(line);
    if (!isRecord(message) || message.type !== 'control_response' || !isRecord(message.response)) continue;
    const initialize = message.response.response;
    if (isRecord(initialize) && Array.isArray(initialize.models)) return initialize.models;
  }
  return null;
}

function addClaudeEntry(modelsById: Map<string, CatalogModel>, defaultIds: Set<string>, entry: unknown): void {
  if (!isRecord(entry)) return;
  const alias = trimmedText(entry.value);
  if (alias === null) return;
  const id = trimmedText(entry.resolvedModel) ?? alias;
  if (alias === CLAUDE_DEFAULT_POINTER) {
    defaultIds.add(id);
    return;
  }
  const existing = modelsById.get(id);
  if (existing) {
    if (alias !== id && !existing.aliases.includes(alias)) existing.aliases.push(alias);
    return;
  }
  const efforts = entry.supportsEffort === true ? textList(entry.supportedEffortLevels) : [];
  modelsById.set(id, {
    id,
    label: trimmedText(entry.displayName) ?? id,
    aliases: alias === id ? [] : [alias],
    isDefault: false,
    options: effortOption(efforts, null),
  });
}

function parseClaudeInitialize(streamJsonOutput: string): CatalogModel[] | null {
  const entries = claudeInitializeModels(streamJsonOutput);
  if (entries === null) return null;
  const modelsById = new Map<string, CatalogModel>();
  const defaultIds = new Set<string>();
  for (const entry of entries) addClaudeEntry(modelsById, defaultIds, entry);
  return [...modelsById.values()].map((model) => ({ ...model, isDefault: defaultIds.has(model.id) }));
}

function codexModel(entry: unknown): CatalogModel | null {
  if (!isRecord(entry) || entry.visibility === CODEX_HIDDEN_VISIBILITY) return null;
  const id = trimmedText(entry.slug);
  if (id === null) return null;
  const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
  const efforts = levels.map((level) => (isRecord(level) ? trimmedText(level.effort) : null)).filter((effort): effort is string => effort !== null);
  return { id, label: trimmedText(entry.display_name) ?? id, aliases: [], isDefault: false, options: effortOption(efforts, trimmedText(entry.default_reasoning_level)) };
}

function parseCodexModels(debugModelsOutput: string): CatalogModel[] | null {
  const parsed = parseJsonLine(debugModelsOutput);
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
  const listedModels = parsed.models.map(codexModel).filter((model): model is CatalogModel => model !== null);
  return listedModels.map((model, index) => ({ ...model, isDefault: index === 0 }));
}

const TOML_MODELS_HEADER = /^\[\s*models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
const TOML_STRING_KEY = /^([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;

function parseKimiModels(configToml: string): CatalogModel[] | null {
  const models: CatalogModel[] = [];
  let defaultModelId: string | null = null;
  let currentModel: CatalogModel | null = null;
  let hasUnreadModelTable = false;
  for (const rawLine of configToml.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = TOML_MODELS_HEADER.exec(line);
    if (header) {
      const id = header[1] ?? header[2] ?? header[3];
      currentModel = { id, label: id, aliases: [], isDefault: false, options: [] };
      models.push(currentModel);
      continue;
    }
    if (line.startsWith('[')) {
      hasUnreadModelTable ||= /^\[\s*models\./.test(line);
      currentModel = null;
      continue;
    }
    const keyValue = TOML_STRING_KEY.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1];
    const value = keyValue[2] ?? keyValue[3];
    if (currentModel === null && key === 'default_model') defaultModelId = value;
    if (currentModel !== null && key === 'display_name' && value.trim() !== '') currentModel.label = value.trim();
  }
  if (models.length === 0 && hasUnreadModelTable) return null;
  return models.map((model) => ({ ...model, isDefault: model.id === defaultModelId }));
}

const NO_CONFIGURED_DEFAULT: ConfiguredDefault = { model: null, effort: null };
const CONTEXT_WINDOW_SUFFIX = /\[[^\]]+\]$/;

function namesOf(model: CatalogModel): string[] {
  return [model.id, ...model.aliases];
}

function configuredModelOf(models: CatalogModel[], configuredModel: string | null): CatalogModel | null {
  if (configuredModel === null) return models.find((model) => model.isDefault) ?? null;
  const candidates = [configuredModel, configuredModel.replace(CONTEXT_WINDOW_SUFFIX, '')];
  return models.find((model) => namesOf(model).some((name) => candidates.includes(name))) ?? null;
}

function listedEffortOf(model: CatalogModel, effort: string | null): string | null {
  const choices = model.options.find((option) => option.id === EFFORT_OPTION_ID)?.choices ?? [];
  return effort !== null && choices.includes(effort) ? effort : null;
}

function resolvedConfiguredDefault(models: CatalogModel[], configuredModel: string | null, effortFor: (model: CatalogModel) => string | null): ConfiguredDefault {
  const model = configuredModelOf(models, configuredModel);
  if (model === null) return NO_CONFIGURED_DEFAULT;
  const effort = listedEffortOf(model, effortFor(model));
  if (configuredModel === null && effort === null) return NO_CONFIGURED_DEFAULT;
  return { model: model.id, effort };
}

function claudeConfiguredDefault(settingsJson: string, models: CatalogModel[]): ConfiguredDefault | undefined {
  const settings = parseJsonLine(settingsJson);
  if (!isRecord(settings)) return undefined;
  const settingsByModel = isRecord(settings.modelSettings) ? settings.modelSettings : {};
  const modelEffort = (model: CatalogModel) => {
    const modelSettings = namesOf(model).map((name) => settingsByModel[name]).find(isRecord);
    return modelSettings ? trimmedText(modelSettings.effortLevel) : null;
  };
  return resolvedConfiguredDefault(models, trimmedText(settings.model), modelEffort);
}

function codexConfiguredDefault(configToml: string, models: CatalogModel[]): ConfiguredDefault {
  const topLevel = new Map<string, string>();
  for (const rawLine of configToml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) break;
    const keyValue = TOML_STRING_KEY.exec(line);
    if (keyValue) topLevel.set(keyValue[1], keyValue[2] ?? keyValue[3]);
  }
  const effort = trimmedText(topLevel.get('model_reasoning_effort'));
  return resolvedConfiguredDefault(models, trimmedText(topLevel.get('model')), () => effort);
}

const OPENCODE_MODEL_LINE = /^[A-Za-z0-9._-]+\/\S+$/;

function parseOpenCodeModels(modelsOutput: string): CatalogModel[] | null {
  const lines = modelsOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const modelIds = lines.filter((line) => OPENCODE_MODEL_LINE.test(line));
  if (modelIds.length === 0 && lines.length > 0) return null;
  return modelIds.map((id) => ({ id, label: id, aliases: [], isDefault: false, options: [] }));
}

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PI_MODEL_ROW = /^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(yes|no)\b/;
const PI_NO_MODELS_NOTICE = /^No models available\b/;

function parsePiModels(listOutput: string): CatalogModel[] | null {
  const rows = listOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (rows.length === 0 || PI_NO_MODELS_NOTICE.test(rows[0] ?? '')) return [];
  if (!/^provider\s+model\b/.test(rows[0] ?? '')) return null;
  return rows.slice(1).flatMap((row) => {
    const match = PI_MODEL_ROW.exec(row);
    if (!match) return [];
    const id = `${match[1]}/${match[2]}`;
    if (!SAFE_LAUNCH_ARGUMENT_PATTERN.test(id)) return [];
    return [{ id, label: id, aliases: [], isDefault: false, options: effortOption(match[3] === 'yes' ? PI_THINKING_LEVELS : [], null) }];
  });
}

const ANTIGRAVITY_MODEL_ROW = /^(\S+)\t(.+)$/;

function parseAntigravityModels(modelsOutput: string): CatalogModel[] | null {
  const lines = modelsOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const models = lines.flatMap((line) => {
    const match = ANTIGRAVITY_MODEL_ROW.exec(line);
    if (!match || !SAFE_LAUNCH_ARGUMENT_PATTERN.test(match[1])) return [];
    return [{ id: match[1], label: match[2].trim(), aliases: [], isDefault: false, options: [] }];
  });
  if (models.length === 0 && lines.length > 0) return null;
  return models;
}

const OPENROUTER_AGENT_ENDPOINTS = ['/api/v1/messages', '/api/v1/responses', '/api/v1/chat/completions'];

function isAgentReadyOpenRouterModel(entry: Record<string, unknown>): boolean {
  const supportedParameters = textList(entry.supported_parameters);
  const endpoints = textList(entry.endpoints);
  return supportedParameters.includes('tools') && OPENROUTER_AGENT_ENDPOINTS.every((endpoint) => endpoints.includes(endpoint));
}

function parseOpenRouterModels(modelsBody: string): CatalogModel[] | null {
  const body = parseJsonLine(modelsBody);
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  return body.data.filter(isRecord).filter(isAgentReadyOpenRouterModel).flatMap((entry) => {
    const id = trimmedText(entry.id);
    if (id === null || !SAFE_LAUNCH_ARGUMENT_PATTERN.test(id)) return [];
    return [{ id, label: trimmedText(entry.name) ?? id, aliases: [], isDefault: false, options: [] }];
  });
}

function optionValue(selection: ModelSelection, optionId: string): string | null {
  return selection.options.find((option) => option.id === optionId)?.value ?? null;
}

type FlagBuilder = (model: string | null, effort: string | null) => string[];

const FLAGS_BY_AGENT: Readonly<Record<string, FlagBuilder>> = Object.freeze({
  'claude-code': (model, effort) => [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
  codex: (model, effort) => [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])],
  kimi: (model) => (model ? ['-m', model] : []),
  grok: (model) => (model ? ['--model', model] : []),
  pi: (model, effort) => [...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : [])],
  antigravity: (model) => (model ? ['--model', model] : []),
});

function selectionArgs(selection: ModelSelection | null): string[] {
  if (selection === null) return [];
  const buildFlags = FLAGS_BY_AGENT[selection.agent];
  if (!buildFlags) return [];
  return buildFlags(selection.model, optionValue(selection, EFFORT_OPTION_ID));
}

function unsafeLaunchValueOf(selections: readonly ModelSelection[]): string | null {
  const commandLineSelections = selections.filter((selection) => selection.agent in FLAGS_BY_AGENT || isOpenRouter(selection));
  const launchValues = commandLineSelections.flatMap((selection) => [...(selection.model === null ? [] : [selection.model]), ...selection.options.map((option) => option.value)]);
  return launchValues.find((value) => !SAFE_LAUNCH_ARGUMENT_PATTERN.test(value)) ?? null;
}

interface LaunchPlan {
  args: string[];
  env: Record<string, string>;
  secretEnv: Record<string, string>;
}

const NATIVE_LAUNCH_PLAN: LaunchPlan = Object.freeze({ args: [], env: {}, secretEnv: {} });
const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
const OPENROUTER_OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
const CODEX_OPENROUTER_PROVIDER_ID = 'glimmervoid-openrouter';
const CLAUDE_MODEL_ENV_NAMES = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

function isOpenRouter(selection: ModelSelection | null): boolean {
  return selection?.provider === 'openrouter';
}

function codexOpenRouterAuth(platform: string): string {
  if (platform === 'win32') return `{command="powershell",args=["-NoProfile","-Command","Write-Output $env:${OPENROUTER_KEY_NAME}"]}`;
  return `{command="sh",args=["-c","echo $${OPENROUTER_KEY_NAME}"]}`;
}

type OpenRouterPlanBuilder = (model: string | null, effort: string | null, platform: string) => LaunchPlan;

const OPENROUTER_PLAN_BY_AGENT: Readonly<Record<string, OpenRouterPlanBuilder>> = Object.freeze({
  'claude-code': (model, effort) => ({
    args: effort ? ['--effort', effort] : [],
    env: { ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: '', ...(model ? Object.fromEntries(CLAUDE_MODEL_ENV_NAMES.map((name) => [name, model])) : {}) },
    secretEnv: { ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY_NAME },
  }),
  codex: (model, effort, platform) => ({
    args: ['-c', `model_provider="${CODEX_OPENROUTER_PROVIDER_ID}"`, '-c', `model_providers.${CODEX_OPENROUTER_PROVIDER_ID}={name="OpenRouter",base_url="${OPENROUTER_OPENAI_BASE_URL}",auth=${codexOpenRouterAuth(platform)}}`, ...FLAGS_BY_AGENT.codex(model, effort)],
    env: {},
    secretEnv: { [OPENROUTER_KEY_NAME]: OPENROUTER_KEY_NAME },
  }),
  opencode: () => ({ args: [], env: {}, secretEnv: { [OPENROUTER_KEY_NAME]: OPENROUTER_KEY_NAME } }),
  pi: (model, effort) => ({ args: ['--provider', 'openrouter', ...FLAGS_BY_AGENT.pi(model, effort)], env: {}, secretEnv: { [OPENROUTER_KEY_NAME]: OPENROUTER_KEY_NAME } }),
});

function launchPlanFor(agent: string, setup: ModelSelection | null, platform: string): LaunchPlan {
  if (setup === null || setup.agent !== agent) return NATIVE_LAUNCH_PLAN;
  const effort = optionValue(setup, EFFORT_OPTION_ID);
  const buildOpenRouterPlan = OPENROUTER_PLAN_BY_AGENT[agent];
  if (isOpenRouter(setup) && buildOpenRouterPlan) return buildOpenRouterPlan(setup.model, effort, platform);
  return { args: selectionArgs(setup), env: {}, secretEnv: {} };
}

function launchSecretNames(plan: LaunchPlan): string[] {
  return [...new Set(Object.values(plan.secretEnv))];
}

function configModelOf(selection: ModelSelection | null): string | null {
  if (selection === null || selection.model === null) return null;
  return isOpenRouter(selection) ? `openrouter/${selection.model}` : selection.model;
}

function providerRefusalOf(selections: readonly ModelSelection[]): string | null {
  const unsupported = selections.find((selection) => isOpenRouter(selection) && !OPENROUTER_AGENT_IDS.includes(selection.agent));
  if (unsupported) return `${unsupported.agent} cannot run on OpenRouter`;
  const modelless = selections.find((selection) => isOpenRouter(selection) && selection.model === null);
  if (modelless) return `pick an OpenRouter model for ${modelless.agent}`;
  return null;
}

function cleanHomeArgs(agent: string, isCleanHome: boolean): string[] {
  if (!isCleanHome || agent !== 'claude-code') return [];
  return ['--setting-sources', 'project,local'];
}

function choiceSelection(agent: string, choice: { model?: string | null; effort?: string | null } | null | undefined): ModelSelection | null {
  const model = trimmedText(choice?.model);
  const effort = trimmedText(choice?.effort);
  if (model === null && effort === null) return null;
  return { agent, model, options: effort === null ? [] : [{ id: EFFORT_OPTION_ID, value: effort }] };
}

export { choiceSelection, claudeConfiguredDefault, codexConfiguredDefault, cleanHomeArgs, configModelOf, launchPlanFor, launchSecretNames, providerRefusalOf, parseAntigravityModels, parseClaudeInitialize, parseCodexModels, parseKimiModels, parseOpenCodeModels, parseOpenRouterModels, parsePiModels, selectionArgs, unsafeLaunchValueOf };
export type { LaunchPlan };
