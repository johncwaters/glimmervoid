import { EFFORT_OPTION_ID } from './contracts/agent-models.ts';
import type { AgentSetup, CatalogModel, ModelOption, ModelSelection } from './contracts/agent-models.ts';

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

function optionValue(selection: ModelSelection, optionId: string): string | null {
  return selection.options.find((option) => option.id === optionId)?.value ?? null;
}

type FlagBuilder = (model: string | null, effort: string | null) => string[];

const FLAGS_BY_AGENT: Readonly<Record<string, FlagBuilder>> = Object.freeze({
  'claude-code': (model, effort) => [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
  codex: (model, effort) => [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])],
  kimi: (model) => (model ? ['-m', model] : []),
  grok: (model) => (model ? ['--model', model] : []),
});

function selectionArgs(selection: ModelSelection | null): string[] {
  if (selection === null) return [];
  const buildFlags = FLAGS_BY_AGENT[selection.agent];
  if (!buildFlags) return [];
  return buildFlags(selection.model, optionValue(selection, EFFORT_OPTION_ID));
}

function launchArgs(agent: string, setup: AgentSetup | null): string[] {
  if (setup === null || setup.agent !== agent) return [];
  return selectionArgs({ agent, model: setup.model, options: setup.options });
}

function choiceSelection(agent: string, choice: { model?: string | null; effort?: string | null } | null | undefined): ModelSelection | null {
  const model = trimmedText(choice?.model);
  const effort = trimmedText(choice?.effort);
  if (model === null && effort === null) return null;
  return { agent, model, options: effort === null ? [] : [{ id: EFFORT_OPTION_ID, value: effort }] };
}

export { choiceSelection, launchArgs, parseClaudeInitialize, parseCodexModels, parseKimiModels, selectionArgs };
