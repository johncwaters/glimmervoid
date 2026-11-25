import type { AgentModelCatalog, AgentSetup, ModelProvider } from '#shared/contracts/agent-models.ts';
import { effortOf, providerOf, withEffortChoice } from '../arena/lineup-core.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { switchableSetupOf, switchSessionModel } from '../session-card/card-model.ts';
import { buildEffortRows, buildModelRows, firstModelPickOf, hasEfforts, modelLabelOf, setupAfterModelPick, setupAfterTypedPick } from '../add-session/model-pick.ts';

type ModelPickerStep = 'models' | 'effort';

interface ChatModelPickerOptions {
  composer: HTMLElement;
  modelName: HTMLElement;
  catalog: AgentModelCatalog;
  setup: AgentSetup;
  onSwitch(next: AgentSetup): void;
  onClose(): void;
}

export interface ChatModelPicker {
  close(): void;
}

const FIND_PLACEHOLDER = 'Find or type a model';

function isSameSetup(left: AgentSetup, right: AgentSetup): boolean {
  return providerOf(left) === providerOf(right) && left.model === right.model && effortOf(left) === effortOf(right);
}

export function openChatModelPicker({ composer, modelName, catalog, setup: runningSetup, onSwitch, onClose }: ChatModelPickerOptions): ChatModelPicker {
  const panel = el('div', 'chat-model-pick add-session-popover');
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Change model');
  const modelWord = createPressable('add-session-word');
  const effortWord = createPressable('add-session-word');
  const atText = document.createTextNode(' at ');
  const sentence = el('p', 'add-session-sentence');
  sentence.append('Continue on ', modelWord, atText, effortWord);
  const pick = el('div', 'add-session-pick');
  const top = el('div', 'add-session-top');
  const slotTitle = el('p', 'add-session-slot-title');
  const findInput = markAsNotCredential(el('input', 'dialog-input add-session-find'));
  findInput.type = 'text';
  findInput.spellcheck = false;
  findInput.placeholder = FIND_PLACEHOLDER;
  findInput.setAttribute('aria-label', FIND_PLACEHOLDER);
  top.append(slotTitle, findInput);
  const list = el('div', 'add-session-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Models');
  pick.append(top, list);
  panel.append(sentence, pick);

  let step: ModelPickerStep = 'models';
  let pendingSetup = runningSetup;
  let isOpen = true;

  const close = (shouldReturnFocus: boolean) => {
    if (!isOpen) return;
    isOpen = false;
    panel.remove();
    document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    modelName.setAttribute('aria-expanded', 'false');
    if (shouldReturnFocus && modelName.isConnected) modelName.focus();
    onClose();
  };

  function closeOnOutsidePointer(event: PointerEvent) {
    if (!(event.target instanceof Node)) return;
    if (panel.contains(event.target) || modelName.contains(event.target)) return;
    close(false);
  }

  const commit = (next: AgentSetup) => {
    close(true);
    if (isSameSetup(next, runningSetup)) return;
    onSwitch(next);
  };

  const pickModel = (provider: ModelProvider, modelId: string) => {
    pendingSetup = setupAfterModelPick(catalog, pendingSetup, provider, modelId);
    if (!hasEfforts(catalog, pendingSetup)) {
      commit(pendingSetup);
      return;
    }
    showStep('effort');
  };

  const pickTypedModel = (provider: ModelProvider, modelId: string) => commit(setupAfterTypedPick(catalog, pendingSetup, provider, modelId));

  const pickEffort = (effort: string | null) => commit(withEffortChoice(pendingSetup, effort));

  const render = () => {
    const effort = effortOf(pendingSetup);
    const showsEffort = hasEfforts(catalog, pendingSetup);
    modelWord.textContent = modelLabelOf(catalog, pendingSetup);
    modelWord.setAttribute('aria-expanded', String(step === 'models'));
    effortWord.textContent = effort ?? 'default';
    effortWord.setAttribute('aria-expanded', String(step === 'effort'));
    effortWord.hidden = !showsEffort;
    atText.textContent = showsEffort ? ' at ' : '';
    pick.dataset.slot = step === 'models' ? 'model' : 'effort';
    slotTitle.textContent = step === 'models' ? 'Models' : `${modelLabelOf(catalog, pendingSetup)} effort`;
    const rows = step === 'models'
      ? buildModelRows({ catalog, agent: pendingSetup.agent, setup: pendingSetup, query: findInput.value, onPickModel: pickModel, onPickTypedModel: pickTypedModel })
      : buildEffortRows({ catalog, setup: pendingSetup, onPickEffort: pickEffort, onBack: () => showStep('models') });
    list.replaceChildren(...rows);
  };

  function showStep(next: ModelPickerStep) {
    step = next;
    render();
    if (step === 'models') {
      findInput.focus();
      return;
    }
    list.querySelector<HTMLElement>('.add-session-row[aria-selected="true"]')?.focus();
  }

  modelWord.addEventListener('click', () => showStep('models'));
  effortWord.addEventListener('click', () => showStep('effort'));
  findInput.addEventListener('input', render);
  findInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const firstPick = firstModelPickOf(catalog, pendingSetup.agent, findInput.value);
    if (firstPick?.kind === 'listed') pickModel(firstPick.provider, firstPick.modelId);
    if (firstPick?.kind === 'typed') pickTypedModel(firstPick.provider, firstPick.modelId);
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });

  composer.append(panel);
  document.addEventListener('pointerdown', closeOnOutsidePointer, true);
  modelName.setAttribute('aria-expanded', 'true');
  showStep('models');
  return { close: () => close(false) };
}

interface ModelChangeListenerOptions {
  root: HTMLElement;
  sessionId: string;
  canOpen(): boolean;
  showFailure(failureText: string): void;
  signal?: AbortSignal;
}

export function listenForModelChange({ root, sessionId, canOpen, showFailure, signal }: ModelChangeListenerOptions): ChatModelPicker {
  let openPicker: ChatModelPicker | null = null;
  root.addEventListener('chat-change-model', (event) => {
    if (openPicker !== null) {
      openPicker.close();
      return;
    }
    const modelName = event.target instanceof HTMLElement ? event.target : null;
    const composer = modelName?.closest<HTMLElement>('.chat-composer') ?? null;
    const switchable = switchableSetupOf(sessionId);
    if (modelName === null || composer === null || switchable === null || !canOpen()) return;
    openPicker = openChatModelPicker({
      composer,
      modelName,
      catalog: switchable.catalog,
      setup: switchable.setup,
      onSwitch: (next) => {
        switchSessionModel(sessionId, next).then((refusalText) => {
          if (refusalText !== null) showFailure(refusalText);
        });
      },
      onClose: () => {
        openPicker = null;
      },
    });
  }, { signal });
  return { close: () => openPicker?.close() };
}
