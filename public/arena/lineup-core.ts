import { CATALOG_AGENT_IDS, EFFORT_OPTION_ID, OPENROUTER_AGENT_IDS } from '#shared/contracts/agent-models.ts';
import type { AgentHomeKind, AgentModelCatalog, AgentSetup, CatalogModel, ModelProvider } from '#shared/contracts/agent-models.ts';
import type { RaceContestant } from '#shared/contracts/race.ts';
import { RACE_MAX_CONTESTANTS } from '#shared/contracts/race.ts';

export const VARY_SETTINGS = ['agent', 'model', 'effort'] as const;
export type VarySetting = typeof VARY_SETTINGS[number];

const AGENT_LABELS: Readonly<Record<string, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', opencode: 'OpenCode' };
const OPENROUTER_VENDOR_BY_AGENT: Readonly<Record<string, string>> = { 'claude-code': 'anthropic/', codex: 'openai/' };

export const PROVIDER_CHOICES: readonly { value: ModelProvider; label: string }[] = [
  { value: 'native', label: 'Agent\'s own' },
  { value: 'openrouter', label: 'OpenRouter' },
];

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

export function modelsOf(catalog: AgentModelCatalog, agent: string): CatalogModel[] {
  return catalog.agents.find((agentModels) => agentModels.agent === agent)?.models ?? [];
}

export function providerOf(setup: AgentSetup): ModelProvider {
  return setup.provider ?? 'native';
}

export function canRunOnOpenRouter(agent: string): boolean {
  return OPENROUTER_AGENT_IDS.includes(agent);
}

export function setupModelsOf(catalog: AgentModelCatalog, setup: AgentSetup): CatalogModel[] {
  return providerOf(setup) === 'openrouter' ? catalog.openrouter.models : modelsOf(catalog, setup.agent);
}

function preferredOpenRouterModel(catalog: AgentModelCatalog, agent: string): string | null {
  const vendor = OPENROUTER_VENDOR_BY_AGENT[agent];
  const models = catalog.openrouter.models;
  const vendorModel = vendor === undefined ? undefined : models.find((model) => model.id.startsWith(vendor));
  return (vendorModel ?? models[0])?.id ?? null;
}

export function withProvider(catalog: AgentModelCatalog, setup: AgentSetup, provider: ModelProvider): AgentSetup {
  if (provider === 'native') return { ...defaultSetup(catalog, setup.agent), instructions: setup.instructions };
  return { agent: setup.agent, provider, model: preferredOpenRouterModel(catalog, setup.agent), options: [], instructions: setup.instructions };
}

export function withTypedModel(setup: AgentSetup, typedModel: string): AgentSetup {
  const model = typedModel.trim();
  return { ...setup, model: model === '' ? null : model };
}

export function agentsWithModels(catalog: AgentModelCatalog): string[] {
  return CATALOG_AGENT_IDS.filter((agent) => modelsOf(catalog, agent).length > 0);
}

export function effortsOf(catalog: AgentModelCatalog, setup: AgentSetup): string[] {
  const model = setupModelsOf(catalog, setup).find((candidate) => candidate.id === setup.model);
  return model?.options.find((option) => option.id === EFFORT_OPTION_ID)?.choices ?? [];
}

export function effortOf(setup: AgentSetup): string | null {
  return setup.options.find((option) => option.id === EFFORT_OPTION_ID)?.value ?? null;
}

function withEffort(setup: AgentSetup, effort: string | null): AgentSetup {
  const otherOptions = setup.options.filter((option) => option.id !== EFFORT_OPTION_ID);
  return { ...setup, options: effort === null ? otherOptions : [...otherOptions, { id: EFFORT_OPTION_ID, value: effort }] };
}

export function defaultSetup(catalog: AgentModelCatalog, agent: string): AgentSetup {
  const models = modelsOf(catalog, agent);
  const model = models.find((candidate) => candidate.isDefault) ?? models[0] ?? null;
  const effort = model?.options.find((option) => option.id === EFFORT_OPTION_ID)?.defaultChoice ?? null;
  return withEffort({ agent, model: model?.id ?? null, options: [], instructions: '' }, effort);
}

export function withModel(catalog: AgentModelCatalog, setup: AgentSetup, modelId: string): AgentSetup {
  const efforts = effortsOf(catalog, { ...setup, model: modelId });
  const currentEffort = effortOf(setup);
  const model = setupModelsOf(catalog, setup).find((candidate) => candidate.id === modelId);
  const keptEffort = currentEffort !== null && efforts.includes(currentEffort) ? currentEffort : model?.options.find((option) => option.id === EFFORT_OPTION_ID)?.defaultChoice ?? null;
  return withEffort({ ...setup, model: modelId }, keptEffort);
}

export function withEffortChoice(setup: AgentSetup, effort: string | null): AgentSetup {
  return withEffort(setup, effort);
}

function autoLabel(setup: AgentSetup, catalog: AgentModelCatalog): string {
  const model = setupModelsOf(catalog, setup).find((candidate) => candidate.id === setup.model);
  const modelText = model?.label ?? setup.model ?? agentLabel(setup.agent);
  const effort = effortOf(setup);
  return (effort === null ? modelText : `${modelText} ${effort}`).slice(0, 60);
}

export function varyChoices(catalog: AgentModelCatalog, base: AgentSetup, setting: VarySetting): { value: string; label: string }[] {
  if (setting === 'agent') return agentsWithModels(catalog).map((agent) => ({ value: agent, label: agentLabel(agent) }));
  if (setting === 'model') return setupModelsOf(catalog, base).map((model) => ({ value: model.id, label: model.label }));
  return effortsOf(catalog, base).map((effort) => ({ value: effort, label: effort }));
}

function variedSetup(catalog: AgentModelCatalog, base: AgentSetup, setting: VarySetting, value: string): AgentSetup {
  if (setting === 'agent') return { ...defaultSetup(catalog, value), instructions: base.instructions };
  if (setting === 'model') return withModel(catalog, base, value);
  return withEffort(base, value);
}

export function contestantsFor(catalog: AgentModelCatalog, entries: readonly { setup: AgentSetup; home: AgentHomeKind }[]): RaceContestant[] {
  const labelCounts = new Map<string, number>();
  return entries.slice(0, RACE_MAX_CONTESTANTS).map(({ setup, home }, index) => {
    const setupLabel = autoLabel(setup, catalog);
    const baseLabel = (home === 'clean' ? `${setupLabel} clean` : setupLabel).slice(0, 60);
    const seen = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, seen);
    return { id: `c${index + 1}`, label: seen === 1 ? baseLabel : `${baseLabel} ${seen}`.slice(0, 60), setup, home };
  });
}

export function varyLineup(catalog: AgentModelCatalog, base: AgentSetup, setting: VarySetting, values: readonly string[]): RaceContestant[] {
  return contestantsFor(catalog, values.map((value) => ({ setup: variedSetup(catalog, base, setting, value), home: 'operator' as const })));
}
