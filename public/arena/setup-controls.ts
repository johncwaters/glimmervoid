import type { AgentModelCatalog, AgentSetup } from '#shared/contracts/agent-models.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { select } from '../ui/select.ts';
import { el } from '../dom-helpers.ts';
import { textInput } from '../ui/text-input.ts';
import { agentLabel, agentsWithModels, canRunOnOpenRouter, defaultSetup, effortOf, effortsOf, PROVIDER_CHOICES, providerOf, setupModelsOf, withEffortChoice, withModel, withProvider, withTypedModel } from './lineup-core.ts';

interface SetupControlOptions {
  allowedAgents?: readonly string[] | null;
  showsAgent?: boolean;
  allowsOpenRouter?: boolean;
}

let modelListCount = 0;

export function buildSelect(choices: readonly { value: string; label: string }[], selected: string | null, onChange: (value: string) => void, ariaLabel: string): HTMLSelectElement {
  const { element } = select({ options: choices, value: selected, onChange, label: ariaLabel });
  element.classList.add('arena-select');
  return element;
}

function openRouterModelInput(catalog: AgentModelCatalog, setup: AgentSetup, onChange: (next: AgentSetup) => void): HTMLElement[] {
  modelListCount += 1;
  const listId = `openrouter-models-${modelListCount}`;
  const modelList = el('datalist');
  modelList.id = listId;
  for (const model of catalog.openrouter.models) {
    const option = el('option');
    option.value = model.id;
    option.label = model.label;
    modelList.append(option);
  }
  const input = textInput({ value: setup.model ?? '', placeholder: 'vendor/model', label: 'OpenRouter model', onChange: (value) => onChange(withTypedModel(setup, value)) });
  input.classList.add('arena-model-input');
  input.setAttribute('list', listId);
  return [input, modelList];
}

export function setupControls(catalog: AgentModelCatalog, setup: AgentSetup, onChange: (next: AgentSetup) => void, { allowedAgents = null, showsAgent = true, allowsOpenRouter = true }: SetupControlOptions = {}): HTMLElement {
  const controls = el('div', 'arena-setup');
  if (showsAgent) {
    const agentChoices = agentsWithModels(catalog).filter((agent) => !allowedAgents || allowedAgents.includes(agent)).map((agent) => ({ value: agent, label: agentLabel(agent) }));
    controls.append(buildSelect(agentChoices, setup.agent, (agent) => onChange({ ...defaultSetup(catalog, agent), instructions: setup.instructions }), 'Agent'));
  }
  const provider = providerOf(setup);
  if (allowsOpenRouter && canRunOnOpenRouter(setup.agent)) controls.append(buildSelect(PROVIDER_CHOICES, provider, (choice) => onChange(withProvider(catalog, setup, choice === 'openrouter' ? 'openrouter' : 'native')), 'Provider'));
  if (provider === 'openrouter') {
    controls.append(...openRouterModelInput(catalog, setup, onChange));
    return controls;
  }
  const modelChoices = setupModelsOf(catalog, setup).map((model) => ({ value: model.id, label: model.label }));
  controls.append(buildSelect(modelChoices, setup.model, (modelId) => onChange(withModel(catalog, setup, modelId)), 'Model'));
  const efforts = effortsOf(catalog, setup);
  if (efforts.length > 0) controls.append(buildSelect(efforts.map((effort) => ({ value: effort, label: effort })), effortOf(setup), (effort) => onChange(withEffortChoice(setup, effort)), 'Effort'));
  return controls;
}
