import { AgentModelCatalog, type AgentSetup, type ModelSelection } from '#shared/contracts/agent-models.ts';
import { agentsWithModels, configuredSetup, defaultSetup, setupModelsOf } from '../arena/lineup-core.ts';
import { setupControls } from '../arena/setup-controls.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { settingsPayloadSnapshot } from '../settings/settings-store.ts';

interface ChatModelControl {
  element: HTMLElement;
  render(agent: string | null, selection: ModelSelection | null): void;
  setTurnRunning(isTurnRunning: boolean): void;
}

const SWITCH_TIMEOUT_MS = 10000;
const AGENT_DEFAULT_MODEL_LABEL = "Agent's default";

function catalogOf(agentModels: unknown): AgentModelCatalog | null {
  const parsed = AgentModelCatalog.safeParse(agentModels);
  return parsed.success ? parsed.data : null;
}

function shownSetupOf(catalog: AgentModelCatalog, agent: string, selection: ModelSelection | null): AgentSetup {
  if (selection && selection.agent === agent) return { ...selection, instructions: '' };
  return configuredSetup(catalog, agent) ?? defaultSetup(catalog, agent);
}

function showUnlistedModel(controls: HTMLElement, catalog: AgentModelCatalog, setup: AgentSetup): void {
  const isListed = setup.model !== null && setupModelsOf(catalog, setup).some((model) => model.id === setup.model);
  const modelSelect = controls.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
  if (isListed || !modelSelect) return;
  const currentOption = el('option', null, `${setup.model ?? AGENT_DEFAULT_MODEL_LABEL} (current)`);
  currentOption.value = setup.model ?? '';
  currentOption.selected = true;
  modelSelect.prepend(currentOption);
  modelSelect.value = currentOption.value;
}

function selectionOf({ instructions: _instructions, ...selection }: AgentSetup): ModelSelection {
  return selection;
}

export function createChatModelControl(sessionId: string, showFailure: (failureText: string | null) => void): ChatModelControl {
  const element = el('fieldset', 'chat-model-control');
  element.hidden = true;
  const status = el('span', 'chat-model-status');
  status.setAttribute('role', 'status');
  let isTurnRunning = false;
  let isSwitching = false;

  const syncDisabled = () => {
    element.disabled = isTurnRunning || isSwitching;
  };

  let shownAgent: string | null = null;
  let shownSelection: ModelSelection | null = null;
  let catalog = catalogOf(settingsPayloadSnapshot().agentModels);

  const switchTo = (agent: string, next: AgentSetup) => {
    const selectionBefore = shownSelection;
    isSwitching = true;
    syncDisabled();
    status.textContent = 'Restarting the agent on the new model.';
    showFailure(null);
    sendControlRequest('switch-session-model', { id: sessionId, setup: selectionOf(next) }, { timeoutMs: SWITCH_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type !== 'switch-session-model-result') return;
        if (!reply.ok) {
          showFailure(reply.error ?? 'The model was not switched.');
          render(agent, selectionBefore);
          return;
        }
        render(agent, selectionOf(next));
      })
      .catch((reason: unknown) => {
        showFailure(`The model was not switched: ${reason instanceof Error ? reason.message : String(reason)}`);
        render(agent, selectionBefore);
      })
      .finally(() => {
        isSwitching = false;
        status.textContent = '';
        syncDisabled();
      });
  };

  const render = (agent: string | null, selection: ModelSelection | null) => {
    shownAgent = agent;
    shownSelection = selection;
    const shownCatalog = [catalogOf(settingsPayloadSnapshot().agentModels), catalog].find((candidate) => candidate !== null && agent !== null && agentsWithModels(candidate).includes(agent)) ?? null;
    element.hidden = shownCatalog === null || agent === null;
    if (shownCatalog === null || agent === null) return;
    const shownSetup = shownSetupOf(shownCatalog, agent, selection);
    const controls = setupControls(shownCatalog, shownSetup, (next) => switchTo(agent, next), { showsAgent: false });
    showUnlistedModel(controls, shownCatalog, shownSetup);
    element.replaceChildren(controls, status);
    syncDisabled();
  };

  sendControlRequest('get-settings', {})
    .then((reply) => {
      if (reply.type !== 'settings') return;
      catalog = catalogOf(reply.settings.agentModels) ?? catalog;
      render(shownAgent, shownSelection);
    })
    .catch((reason: unknown) => showFailure(`Could not load the model list: ${reason instanceof Error ? reason.message : String(reason)}`));

  return {
    element,
    render,
    setTurnRunning: (isRunning) => {
      isTurnRunning = isRunning;
      syncDisabled();
    },
  };
}
