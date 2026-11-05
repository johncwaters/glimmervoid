import { CATALOG_AGENT_IDS, EFFORT_OPTION_ID } from '#shared/contracts/agent-models.ts';
import type { AgentModelCatalog, AgentSetup, CatalogModel } from '#shared/contracts/agent-models.ts';
import type { RaceContestant } from '#shared/contracts/race.ts';
import { RACE_MAX_CONTESTANTS } from '#shared/contracts/race.ts';

export const VARY_SETTINGS = ['agent', 'model', 'effort'] as const;
export type VarySetting = typeof VARY_SETTINGS[number];

const AGENT_LABELS: Readonly<Record<string, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', kimi: 'Kimi Code' };

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

export function modelsOf(catalog: AgentModelCatalog, agent: string): CatalogModel[] {
  return catalog.agents.find((agentModels) => agentModels.agent === agent)?.models ?? [];
}

export function agentsWithModels(catalog: AgentModelCatalog): string[] {
  return CATALOG_AGENT_IDS.filter((agent) => modelsOf(catalog, agent).length > 0);
}

export function effortsOf(catalog: AgentModelCatalog, agent: string, modelId: string | null): string[] {
  const model = modelsOf(catalog, agent).find((candidate) => candidate.id === modelId);
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
  const efforts = effortsOf(catalog, setup.agent, modelId);
  const currentEffort = effortOf(setup);
  const model = modelsOf(catalog, setup.agent).find((candidate) => candidate.id === modelId);
  const keptEffort = currentEffort !== null && efforts.includes(currentEffort) ? currentEffort : model?.options.find((option) => option.id === EFFORT_OPTION_ID)?.defaultChoice ?? null;
  return withEffort({ ...setup, model: modelId }, keptEffort);
}

export function withEffortChoice(setup: AgentSetup, effort: string | null): AgentSetup {
  return withEffort(setup, effort);
}

function autoLabel(setup: AgentSetup, catalog: AgentModelCatalog): string {
  const model = modelsOf(catalog, setup.agent).find((candidate) => candidate.id === setup.model);
  const modelText = model?.label ?? setup.model ?? agentLabel(setup.agent);
  const effort = effortOf(setup);
  return (effort === null ? modelText : `${modelText} ${effort}`).slice(0, 60);
}

export function varyChoices(catalog: AgentModelCatalog, base: AgentSetup, setting: VarySetting): { value: string; label: string }[] {
  if (setting === 'agent') return agentsWithModels(catalog).map((agent) => ({ value: agent, label: agentLabel(agent) }));
  if (setting === 'model') return modelsOf(catalog, base.agent).map((model) => ({ value: model.id, label: model.label }));
  return effortsOf(catalog, base.agent, base.model).map((effort) => ({ value: effort, label: effort }));
}

function variedSetup(catalog: AgentModelCatalog, base: AgentSetup, setting: VarySetting, value: string): AgentSetup {
  if (setting === 'agent') return { ...defaultSetup(catalog, value), instructions: base.instructions };
  if (setting === 'model') return withModel(catalog, base, value);
  return withEffort(base, value);
}

export function contestantsFor(catalog: AgentModelCatalog, setups: readonly AgentSetup[]): RaceContestant[] {
  const labelCounts = new Map<string, number>();
  return setups.slice(0, RACE_MAX_CONTESTANTS).map((setup, index) => {
    const baseLabel = autoLabel(setup, catalog);
    const seen = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, seen);
    return { id: `c${index + 1}`, label: seen === 1 ? baseLabel : `${baseLabel} ${seen}`.slice(0, 60), setup };
  });
}

export function varyLineup(catalog: AgentModelCatalog, base: AgentSetup, setting: VarySetting, values: readonly string[]): RaceContestant[] {
  return contestantsFor(catalog, values.map((value) => variedSetup(catalog, base, setting, value)));
}
