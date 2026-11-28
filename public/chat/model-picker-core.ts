import { EFFORT_OPTION_ID } from '#shared/contracts/agent-models.ts';
import type { AgentModelCatalog, AgentSetup, CatalogModel, ModelProvider } from '#shared/contracts/agent-models.ts';
import {
  canRunOnOpenRouter,
  effortOf,
  effortsOf,
  modelsOf,
  providerOf,
  setupModelsOf,
  withEffortChoice,
  withModel,
  withProvider,
  withTypedModel,
} from '../arena/lineup-core.ts';

type ModelPickerStep = 'models' | 'effort';

interface OpenModelPickerState {
  readonly isOpen: true;
  readonly catalog: AgentModelCatalog;
  readonly runningSetup: AgentSetup;
  readonly pendingSetup: AgentSetup;
  readonly step: ModelPickerStep;
  readonly query: string;
}

type ModelPickerState = { readonly isOpen: false } | OpenModelPickerState;

export const CLOSED_MODEL_PICKER_STATE: ModelPickerState = { isOpen: false };

interface ModelPickerDisplay {
  readonly modelLabel: string;
  readonly effortLabel: string;
  readonly showsEffort: boolean;
  readonly slot: 'model' | 'effort';
  readonly slotTitle: string;
  readonly isModelExpanded: 'true' | 'false';
  readonly isEffortExpanded: 'true' | 'false';
}

export type ModelPickerRow =
  | {
    readonly kind: 'model';
    readonly key: string;
    readonly label: string;
    readonly meta: string | null;
    readonly isPicked: boolean;
    readonly provider: ModelProvider;
    readonly modelId: string;
  }
  | {
    readonly kind: 'group-label';
    readonly key: string;
    readonly text: string;
  }
  | {
    readonly kind: 'typed';
    readonly key: string;
    readonly label: string;
    readonly provider: ModelProvider;
    readonly modelId: string;
  }
  | {
    readonly kind: 'back';
    readonly key: string;
    readonly label: string;
  }
  | {
    readonly kind: 'effort';
    readonly key: string;
    readonly label: string;
    readonly isPicked: boolean;
    readonly effort: string | null;
  };

type ModelPickerActionResult =
  | { readonly outcome: 'step-effort'; readonly state: OpenModelPickerState; readonly switchSetup: null }
  | { readonly outcome: 'commit'; readonly state: ModelPickerState; readonly switchSetup: AgentSetup | null };

type ModelFindKeydownDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'pick-listed' | 'pick-typed'; readonly provider: ModelProvider; readonly modelId: string };

type ModelPickerPanelKeydownDecision = 'close-with-focus' | 'none';

function isSameAgentSetup(left: AgentSetup, right: AgentSetup): boolean {
  return providerOf(left) === providerOf(right) && left.model === right.model && effortOf(left) === effortOf(right);
}

export function openModelPickerState(catalog: AgentModelCatalog, setup: AgentSetup): OpenModelPickerState {
  return {
    isOpen: true,
    catalog,
    runningSetup: setup,
    pendingSetup: setup,
    step: 'models',
    query: '',
  };
}

export function applyModelPickerQuery(state: OpenModelPickerState, query: string): OpenModelPickerState {
  if (state.query === query) return state;
  return { ...state, query };
}

export function selectModelPickerStep(
  state: OpenModelPickerState,
  step: ModelPickerStep,
): { readonly state: OpenModelPickerState; readonly focusTarget: 'find' | 'selected-effort' } {
  return {
    state: { ...state, step },
    focusTarget: step === 'models' ? 'find' : 'selected-effort',
  };
}

export function modelLabelOf(catalog: AgentModelCatalog, setup: AgentSetup): string {
  const model = setupModelsOf(catalog, setup).find((candidate) => candidate.id === setup.model);
  const modelText = model?.label ?? setup.model ?? 'its default model';
  return providerOf(setup) === 'openrouter' ? `${modelText} via OpenRouter` : modelText;
}

export function hasModelEfforts(catalog: AgentModelCatalog, setup: AgentSetup): boolean {
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

function visibleModelsByProvider(catalog: AgentModelCatalog, agent: string, query: string): readonly { provider: ModelProvider; models: CatalogModel[] }[] {
  const nativeModels = modelsOf(catalog, agent).filter((model) => matchesModelSearch(model, query));
  const openRouterModels = canRunOnOpenRouter(agent) ? catalog.openrouter.models.filter((model) => matchesModelSearch(model, query)) : [];
  return [
    { provider: 'native', models: nativeModels },
    { provider: 'openrouter', models: openRouterModels },
  ];
}

function typedModelIdOf(catalog: AgentModelCatalog, agent: string, query: string): string | null {
  const typed = query.trim();
  const listedModels = canRunOnOpenRouter(agent)
    ? [...modelsOf(catalog, agent), ...catalog.openrouter.models]
    : modelsOf(catalog, agent);
  const isListed = listedModels.some((model) => model.id === typed);
  return typed === '' || isListed ? null : typed;
}

function agentDefaultEffort(catalog: AgentModelCatalog, setup: AgentSetup): string | null {
  const configured = catalog.agents.find((agentModels) => agentModels.agent === setup.agent)?.configuredDefault?.effort ?? null;
  if (providerOf(setup) === 'native' && configured !== null && effortsOf(catalog, setup).includes(configured)) return configured;
  const model = setupModelsOf(catalog, setup).find((candidate) => candidate.id === setup.model);
  return model?.options.find((option) => option.id === EFFORT_OPTION_ID)?.defaultChoice ?? null;
}

export function modelPickerDisplayOf(state: OpenModelPickerState): ModelPickerDisplay {
  const modelLabel = modelLabelOf(state.catalog, state.pendingSetup);
  const effort = effortOf(state.pendingSetup);
  const showsEffort = hasModelEfforts(state.catalog, state.pendingSetup);
  return {
    modelLabel,
    effortLabel: effort ?? 'default',
    showsEffort,
    slot: state.step === 'models' ? 'model' : 'effort',
    slotTitle: state.step === 'models' ? 'Models' : `${modelLabel} effort`,
    isModelExpanded: state.step === 'models' ? 'true' : 'false',
    isEffortExpanded: state.step === 'effort' ? 'true' : 'false',
  };
}

export function modelListRowsOf(
  catalog: AgentModelCatalog,
  agent: string,
  setup: AgentSetup,
  query: string,
): ModelPickerRow[] {
  const toModelRow = (provider: ModelProvider, model: CatalogModel): ModelPickerRow => ({
    kind: 'model',
    key: `${provider}:${model.id}`,
    label: model.label,
    meta: model.label !== model.id ? model.id : null,
    isPicked: providerOf(setup) === provider && model.id === setup.model,
    provider,
    modelId: model.id,
  });
  const [nativeGroup, openRouterGroup] = visibleModelsByProvider(catalog, agent, query);
  const typed = typedModelIdOf(catalog, agent, query);
  const openRouterRows: ModelPickerRow[] = openRouterGroup.models.length === 0
    ? []
    : [{ kind: 'group-label', key: 'group:OpenRouter', text: 'OpenRouter' }, ...openRouterGroup.models.map((model) => toModelRow('openrouter', model))];
  const typedOpenRouterRows: ModelPickerRow[] = typed !== null && canRunOnOpenRouter(agent)
    ? [{ kind: 'typed', key: `Use "${typed}" on OpenRouter`, label: `Use "${typed}" on OpenRouter`, provider: 'openrouter', modelId: typed }]
    : [];
  const typedRows: ModelPickerRow[] = typed === null
    ? []
    : [{ kind: 'typed', key: `Use "${typed}" as typed`, label: `Use "${typed}" as typed`, provider: 'native', modelId: typed }, ...typedOpenRouterRows];
  return [...nativeGroup.models.map((model) => toModelRow('native', model)), ...openRouterRows, ...typedRows];
}

export function effortListRowsOf(catalog: AgentModelCatalog, setup: AgentSetup): ModelPickerRow[] {
  const defaultEffort = agentDefaultEffort(catalog, setup);
  const defaultRow: ModelPickerRow = {
    kind: 'effort',
    key: 'default',
    label: defaultEffort === null ? 'Default' : `Default (${defaultEffort})`,
    isPicked: effortOf(setup) === null,
    effort: null,
  };
  const effortRows: ModelPickerRow[] = effortsOf(catalog, setup).map((effort) => ({
    kind: 'effort',
    key: effort,
    label: effort,
    isPicked: effortOf(setup) === effort,
    effort,
  }));
  return [{ kind: 'back', key: 'back:All models', label: 'All models' }, defaultRow, ...effortRows];
}

export function modelPickerRowsOf(state: OpenModelPickerState): ModelPickerRow[] {
  if (state.step === 'models') return modelListRowsOf(state.catalog, state.pendingSetup.agent, state.pendingSetup, state.query);
  return effortListRowsOf(state.catalog, state.pendingSetup);
}

function commitModelSetup(runningSetup: AgentSetup, nextSetup: AgentSetup): ModelPickerActionResult {
  return {
    outcome: 'commit',
    state: CLOSED_MODEL_PICKER_STATE,
    switchSetup: isSameAgentSetup(nextSetup, runningSetup) ? null : nextSetup,
  };
}

export function pickListedModel(
  state: OpenModelPickerState,
  provider: ModelProvider,
  modelId: string,
): ModelPickerActionResult {
  const nextSetup = setupAfterModelPick(state.catalog, state.pendingSetup, provider, modelId);
  if (!hasModelEfforts(state.catalog, nextSetup)) {
    return commitModelSetup(state.runningSetup, nextSetup);
  }
  return {
    outcome: 'step-effort',
    state: { ...state, pendingSetup: nextSetup, step: 'effort' },
    switchSetup: null,
  };
}

export function pickTypedModel(
  state: OpenModelPickerState,
  provider: ModelProvider,
  modelId: string,
): ModelPickerActionResult {
  const nextSetup = setupAfterTypedPick(state.catalog, state.pendingSetup, provider, modelId);
  return commitModelSetup(state.runningSetup, nextSetup);
}

export function pickEffortChoice(state: OpenModelPickerState, effort: string | null): ModelPickerActionResult {
  const nextSetup = withEffortChoice(state.pendingSetup, effort);
  return commitModelSetup(state.runningSetup, nextSetup);
}

export function firstModelPickOf(catalog: AgentModelCatalog, agent: string, query: string): ModelFindKeydownDecision {
  const firstGroup = visibleModelsByProvider(catalog, agent, query).find((group) => group.models.length > 0);
  if (firstGroup) {
    return { kind: 'pick-listed', provider: firstGroup.provider, modelId: firstGroup.models[0].id };
  }
  const typed = typedModelIdOf(catalog, agent, query);
  if (typed === null) return { kind: 'none' };
  return { kind: 'pick-typed', provider: 'native', modelId: typed };
}

export function decideModelFindKeydown(state: OpenModelPickerState, key: string): ModelFindKeydownDecision {
  if (key !== 'Enter') return { kind: 'none' };
  return firstModelPickOf(state.catalog, state.pendingSetup.agent, state.query);
}

export function decideModelPickerPanelKeydown(key: string): ModelPickerPanelKeydownDecision {
  if (key === 'Escape') return 'close-with-focus';
  return 'none';
}
