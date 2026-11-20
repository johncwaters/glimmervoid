import { EFFORT_OPTION_ID } from '#shared/contracts/agent-models.ts';
import type { AgentModelCatalog, AgentSetup, CatalogModel, ModelProvider } from '#shared/contracts/agent-models.ts';
import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { canRunOnOpenRouter, effortOf, effortsOf, modelsOf, providerOf, setupModelsOf, withEffortChoice, withModel, withProvider, withTypedModel } from '../arena/lineup-core.ts';

interface ModelRowsInput {
  catalog: AgentModelCatalog;
  agent: string;
  setup: AgentSetup;
  query: string;
  onPickModel(provider: ModelProvider, modelId: string): void;
  onPickTypedModel(provider: ModelProvider, modelId: string): void;
}

interface EffortRowsInput {
  catalog: AgentModelCatalog;
  setup: AgentSetup;
  onPickEffort(effort: string | null): void;
  onBack(): void;
}

type FirstModelPick = { kind: 'listed' | 'typed'; provider: ModelProvider; modelId: string };

export function buildPickRow(key: string, name: string, isPicked: boolean, onPick: () => void): HTMLButtonElement {
  const rowEl = createPressable('add-session-row');
  rowEl.setAttribute('role', 'option');
  rowEl.setAttribute('aria-selected', String(isPicked));
  rowEl.dataset.key = key;
  rowEl.append(el('span', 'add-session-row-name', name));
  rowEl.addEventListener('click', onPick);
  return rowEl;
}

export function buildBackRow(label: string, onBack: () => void): HTMLButtonElement {
  const row = createPressable('add-session-row add-session-row-back');
  row.dataset.key = `back:${label}`;
  row.append(el('span', 'add-session-row-chevron'), el('span', 'add-session-row-name', label));
  row.addEventListener('click', onBack);
  return row;
}

export function buildChoiceRow(label: string, onPick: () => void): HTMLButtonElement {
  const row = createPressable('add-session-row add-session-row-choice');
  row.dataset.key = label;
  row.append(el('span', 'add-session-row-name', label), el('span', 'add-session-row-chevron'));
  row.addEventListener('click', onPick);
  return row;
}

export function buildListLabel(text: string): HTMLElement {
  const label = el('div', 'add-session-list-label', text);
  label.setAttribute('role', 'presentation');
  return label;
}

export function modelLabelOf(catalog: AgentModelCatalog, setup: AgentSetup): string {
  const model = setupModelsOf(catalog, setup).find((candidate) => candidate.id === setup.model);
  const modelText = model?.label ?? setup.model ?? 'its default model';
  return providerOf(setup) === 'openrouter' ? `${modelText} via OpenRouter` : modelText;
}

export function hasEfforts(catalog: AgentModelCatalog, setup: AgentSetup): boolean {
  return effortsOf(catalog, setup).length > 0;
}

export function setupAfterModelPick(catalog: AgentModelCatalog, current: AgentSetup, provider: ModelProvider, modelId: string): AgentSetup {
  const onProvider = providerOf(current) === provider ? current : withProvider(catalog, current, provider);
  return withModel(catalog, onProvider, modelId);
}

export function setupAfterTypedPick(catalog: AgentModelCatalog, current: AgentSetup, provider: ModelProvider, modelId: string): AgentSetup {
  const onProvider = providerOf(current) === provider ? current : withProvider(catalog, current, provider);
  return withEffortChoice(withTypedModel(onProvider, modelId), null);
}

function matchesModelSearch(model: CatalogModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle);
}

function visibleModelsByProvider(catalog: AgentModelCatalog, agent: string, query: string): { provider: ModelProvider; models: CatalogModel[] }[] {
  const nativeModels = modelsOf(catalog, agent).filter((model) => matchesModelSearch(model, query));
  const openRouterModels = canRunOnOpenRouter(agent) ? catalog.openrouter.models.filter((model) => matchesModelSearch(model, query)) : [];
  return [{ provider: 'native', models: nativeModels }, { provider: 'openrouter', models: openRouterModels }];
}

function typedModelIdOf(catalog: AgentModelCatalog, agent: string, query: string): string | null {
  const typed = query.trim();
  const isListed = [...modelsOf(catalog, agent), ...catalog.openrouter.models].some((model) => model.id === typed);
  return typed === '' || isListed ? null : typed;
}

export function firstModelPickOf(catalog: AgentModelCatalog, agent: string, query: string): FirstModelPick | null {
  const firstGroup = visibleModelsByProvider(catalog, agent, query).find((group) => group.models.length > 0);
  if (firstGroup) return { kind: 'listed', provider: firstGroup.provider, modelId: firstGroup.models[0].id };
  const typed = typedModelIdOf(catalog, agent, query);
  return typed === null ? null : { kind: 'typed', provider: 'native', modelId: typed };
}

export function buildModelRows({ catalog, agent, setup, query, onPickModel, onPickTypedModel }: ModelRowsInput): HTMLElement[] {
  const buildModelRow = (provider: ModelProvider, model: CatalogModel) => {
    const isPicked = providerOf(setup) === provider && model.id === setup.model;
    const rowEl = buildPickRow(`${provider}:${model.id}`, model.label, isPicked, () => onPickModel(provider, model.id));
    if (model.label !== model.id) rowEl.append(el('span', 'add-session-row-meta', model.id));
    return rowEl;
  };
  const [nativeGroup, openRouterGroup] = visibleModelsByProvider(catalog, agent, query);
  const typed = typedModelIdOf(catalog, agent, query);
  const openRouterRows = openRouterGroup.models.length === 0 ? [] : [buildListLabel('OpenRouter'), ...openRouterGroup.models.map((model) => buildModelRow('openrouter', model))];
  const typedOpenRouterRows = typed !== null && canRunOnOpenRouter(agent) ? [buildChoiceRow(`Use "${typed}" on OpenRouter`, () => onPickTypedModel('openrouter', typed))] : [];
  const typedRows = typed === null ? [] : [buildChoiceRow(`Use "${typed}" as typed`, () => onPickTypedModel('native', typed)), ...typedOpenRouterRows];
  return [...nativeGroup.models.map((model) => buildModelRow('native', model)), ...openRouterRows, ...typedRows];
}

function agentDefaultEffort(catalog: AgentModelCatalog, setup: AgentSetup): string | null {
  const configured = catalog.agents.find((agentModels) => agentModels.agent === setup.agent)?.configuredDefault?.effort ?? null;
  if (providerOf(setup) === 'native' && configured !== null && effortsOf(catalog, setup).includes(configured)) return configured;
  const model = setupModelsOf(catalog, setup).find((candidate) => candidate.id === setup.model);
  return model?.options.find((option) => option.id === EFFORT_OPTION_ID)?.defaultChoice ?? null;
}

export function buildEffortRows({ catalog, setup, onPickEffort, onBack }: EffortRowsInput): HTMLElement[] {
  const defaultEffort = agentDefaultEffort(catalog, setup);
  const defaultRow = buildPickRow('default', defaultEffort === null ? 'Default' : `Default (${defaultEffort})`, effortOf(setup) === null, () => onPickEffort(null));
  const effortRows = effortsOf(catalog, setup).map((effort) => buildPickRow(effort, effort, effortOf(setup) === effort, () => onPickEffort(effort)));
  return [buildBackRow('All models', onBack), defaultRow, ...effortRows];
}
