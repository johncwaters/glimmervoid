import { AgentModelCatalog, type AgentSetup, type ModelSelection } from '#shared/contracts/agent-models.ts';
import { errorMessage } from '#shared/text.ts';
import { agentsWithModels, configuredSetup, defaultSetup, setupModelsOf } from '../arena/lineup-core.ts';
import { setupControls } from '../arena/setup-controls.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { settingsPayloadSnapshot } from '../state/collections/settings.ts';
import { button } from '../ui/button.ts';
import { findSessionUi } from './card-registry.ts';
import { buildDialogShell } from './modal.ts';

const SWITCH_TIMEOUT_MS = 10000;
const AGENT_DEFAULT_MODEL_LABEL = "Agent's default";

const modelSelectionBySessionId = new Map<string, ModelSelection | null>();
const accountIdBySessionId = new Map<string, string | null>();
const workingDirectoryBySessionId = new Map<string, string>();

function currentCatalog(): AgentModelCatalog | null {
  const parsed = AgentModelCatalog.safeParse(settingsPayloadSnapshot().agentModels);
  return parsed.success ? parsed.data : null;
}

function catalogListing(agent: string | null): AgentModelCatalog | null {
  const catalog = currentCatalog();
  if (catalog === null || agent === null || !agentsWithModels(catalog).includes(agent)) return null;
  return catalog;
}

export function canSwitchSessionModel(sessionId: string): boolean {
  const ui = findSessionUi(sessionId);
  return ui !== undefined && ui.card.dataset.ephemeral === undefined && catalogListing(ui.agent ?? null) !== null;
}

export function setSessionModelSelection(sessionId: string, modelSelection: ModelSelection | null): void {
  modelSelectionBySessionId.set(sessionId, modelSelection);
}

export function setSessionAccountId(sessionId: string, accountId: string | null): void {
  accountIdBySessionId.set(sessionId, accountId);
}

export function setSessionWorkingDirectory(sessionId: string, workingDirectory: string | null | undefined): void {
  if (!workingDirectory) return;
  workingDirectoryBySessionId.set(sessionId, workingDirectory);
}

export function sessionWorkingDirectoryOf(sessionId: string): string | null {
  return workingDirectoryBySessionId.get(sessionId) ?? null;
}

export function sessionAccountIdOf(sessionId: string): string | null {
  return accountIdBySessionId.get(sessionId) ?? null;
}

export function sessionModelSelectionOf(sessionId: string): ModelSelection | null {
  return modelSelectionBySessionId.get(sessionId) ?? null;
}

export function resetSessionModelSelections(rows: readonly { id: string; modelSelection?: ModelSelection | null; accountId?: string | null; workingDirectory?: string | null }[]): void {
  modelSelectionBySessionId.clear();
  accountIdBySessionId.clear();
  workingDirectoryBySessionId.clear();
  for (const row of rows) {
    setSessionWorkingDirectory(row.id, row.workingDirectory);
    setSessionModelSelection(row.id, row.modelSelection ?? null);
    setSessionAccountId(row.id, row.accountId ?? null);
  }
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

export function switchableSetupOf(sessionId: string): { catalog: AgentModelCatalog; setup: AgentSetup } | null {
  const agent = findSessionUi(sessionId)?.agent ?? null;
  const catalog = catalogListing(agent);
  if (catalog === null || agent === null) return null;
  return { catalog, setup: shownSetupOf(catalog, agent, modelSelectionBySessionId.get(sessionId) ?? null) };
}

export function switchSessionModel(sessionId: string, setup: AgentSetup): Promise<string | null> {
  return sendControlRequest('switch-session-model', { id: sessionId, setup: selectionOf(setup) }, { timeoutMs: SWITCH_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'switch-session-model-result') return 'Unexpected reply';
      if (reply.ok) return null;
      return reply.error ?? 'The model was not switched.';
    })
    .catch((error: unknown) => `The model was not switched: ${errorMessage(error)}`);
}

export function openSwitchModelDialog(sessionId: string): void {
  const switchable = switchableSetupOf(sessionId);
  if (switchable === null) return;
  const { catalog } = switchable;
  const { overlay, dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Change model' });
  const hint = el('p', 'dialog-message', 'Switching restarts the agent on the model you pick and resumes its conversation. Your default for new sessions stays as it is.');
  const controlsSlot = el('div', 'session-model-controls');
  const statusEl = el('div', 'dialog-hint');
  statusEl.setAttribute('role', 'status');
  const errorEl = el('div', 'dialog-error');
  const btnSwitch = button({ variant: 'primary', label: 'Switch' });
  actions.append(btnSwitch);
  dialog.append(hint, controlsSlot, statusEl, errorEl, actions);

  let pickedSetup = switchable.setup;
  const renderControls = () => {
    const controls = setupControls(catalog, pickedSetup, (next) => {
      pickedSetup = next;
      renderControls();
    }, { showsAgent: false });
    showUnlistedModel(controls, catalog, pickedSetup);
    controlsSlot.replaceChildren(controls);
  };
  renderControls();

  const showRefusal = (refusalText: string) => {
    if (!overlay.isConnected) return;
    btnSwitch.disabled = false;
    statusEl.textContent = '';
    errorEl.textContent = refusalText;
  };
  btnCancel.addEventListener('click', close);
  btnSwitch.addEventListener('click', () => {
    errorEl.textContent = '';
    btnSwitch.disabled = true;
    statusEl.textContent = 'Restarting the agent on the new model.';
    switchSessionModel(sessionId, pickedSetup).then((refusalText) => {
      if (refusalText === null) {
        close();
        return;
      }
      showRefusal(refusalText);
    });
  });
  requestAnimationFrame(() => btnCancel.focus());
}
