import { For, Match, Show, Switch, createEffect, createMemo, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { markAsNotCredential } from '../dom-helpers.ts';
import { switchSessionModel, switchableSetupOf } from '../session-card/card-model.ts';
import { Pressable } from '../ui/Pressable.tsx';
import { createSyncedSignal } from '../ui/store-signal.ts';
import {
  CLOSED_MODEL_PICKER_STATE,
  applyModelPickerQuery,
  decideModelFindKeydown,
  decideModelPickerPanelKeydown,
  modelPickerDisplayOf,
  modelPickerRowsOf,
  openModelPickerState,
  pickEffortChoice,
  pickListedModel,
  pickTypedModel,
  selectModelPickerStep,
} from './model-picker-core.ts';

const FIND_MODEL_PLACEHOLDER = 'Find or type a model';

export interface ModelPickerHandle {
  toggle(triggerElement: HTMLButtonElement): void;
  close(): void;
}

interface ModelPickerProps {
  sessionId: string;
  canOpen: () => boolean;
  onFailure: (failureText: string) => void;
  onOpenChange?: (isOpen: boolean) => void;
  onHandle?: (handle: ModelPickerHandle) => void;
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const pickerState = createSyncedSignal(CLOSED_MODEL_PICKER_STATE);
  let panelElement: HTMLDivElement | undefined;
  let findInputElement: HTMLInputElement | undefined;
  let listElement: HTMLDivElement | undefined;
  let triggerElement: HTMLButtonElement | undefined;

  const focusStepTarget = (target: 'find' | 'selected-effort'): void => {
    if (target === 'find') {
      findInputElement?.focus();
      return;
    }
    listElement?.querySelector<HTMLElement>('.add-session-row[aria-selected="true"]')?.focus();
  };

  const closePicker = (shouldReturnFocus: boolean): void => {
    if (!pickerState.peek().isOpen) return;
    pickerState.update(CLOSED_MODEL_PICKER_STATE);
    flush();
    props.onOpenChange?.(false);
    if (shouldReturnFocus && triggerElement?.isConnected) triggerElement.focus();
  };

  const applyActionOutcome = (actionOutcome: ReturnType<typeof pickListedModel>): void => {
    pickerState.update(actionOutcome.state);
    flush();
    if (actionOutcome.outcome === 'step-effort') {
      focusStepTarget('selected-effort');
      return;
    }
    props.onOpenChange?.(false);
    if (triggerElement?.isConnected) triggerElement.focus();
    if (actionOutcome.switchSetup === null) return;
    void switchSessionModel(props.sessionId, actionOutcome.switchSetup).then((refusalText) => {
      if (refusalText !== null) props.onFailure(refusalText);
    });
  };

  const switchStep = (step: 'models' | 'effort'): void => {
    const current = pickerState.peek();
    if (!current.isOpen) return;
    const transition = selectModelPickerStep(current, step);
    pickerState.update(transition.state);
    flush();
    focusStepTarget(transition.focusTarget);
  };

  const togglePicker = (nextTrigger: HTMLButtonElement): void => {
    if (pickerState.peek().isOpen) {
      closePicker(false);
      return;
    }
    const switchable = switchableSetupOf(props.sessionId);
    if (switchable === null || !props.canOpen()) return;
    triggerElement = nextTrigger;
    pickerState.update(openModelPickerState(switchable.catalog, switchable.setup));
    flush();
    props.onOpenChange?.(true);
    focusStepTarget('find');
  };

  createEffect(
    () => pickerState.read().isOpen,
    (isOpen) => {
      if (!isOpen) return;
      const handleOutsidePointer = (event: PointerEvent): void => {
        if (!(event.target instanceof Node)) return;
        if (panelElement?.contains(event.target) || triggerElement?.contains(event.target)) return;
        closePicker(false);
      };
      const handlePanelKeyDown = (event: KeyboardEvent): void => {
        if (decideModelPickerPanelKeydown(event.key) !== 'close-with-focus') return;
        event.preventDefault();
        event.stopPropagation();
        closePicker(true);
      };
      const activePanel = panelElement;
      document.addEventListener('pointerdown', handleOutsidePointer, true);
      activePanel?.addEventListener('keydown', handlePanelKeyDown);
      return () => {
        document.removeEventListener('pointerdown', handleOutsidePointer, true);
        activePanel?.removeEventListener('keydown', handlePanelKeyDown);
      };
    },
  );

  props.onHandle?.({
    toggle: togglePicker,
    close: () => closePicker(false),
  });

  const openState = createMemo(() => {
    const state = pickerState.read();
    return state.isOpen ? state : undefined;
  });

  return (
    <Show when={openState()}>
      {(activeState) => {
        const display = createMemo(() => modelPickerDisplayOf(activeState()));
        const rows = createMemo(() => modelPickerRowsOf(activeState()));

        return (
          <div
            ref={(element) => {
              panelElement = element;
              element.setAttribute('role', 'group');
              element.setAttribute('aria-label', 'Change model');
            }}
            class="chat-model-pick add-session-popover"
          >
            <p class="add-session-sentence">
              Continue on{' '}
              <Pressable
                class="add-session-word"
                aria-expanded={display().isModelExpanded}
                onClick={() => switchStep('models')}
              >
                {display().modelLabel}
              </Pressable>
              {display().showsEffort ? ' at ' : ''}
              <Pressable
                class="add-session-word"
                aria-expanded={display().isEffortExpanded}
                hidden={!display().showsEffort}
                onClick={() => switchStep('effort')}
              >
                {display().effortLabel}
              </Pressable>
            </p>
            <div class="add-session-pick" data-slot={display().slot}>
              <div class="add-session-top">
                <p class="add-session-slot-title">{display().slotTitle}</p>
                <input
                  ref={(element) => { findInputElement = markAsNotCredential(element); }}
                  class="dialog-input add-session-find"
                  type="text"
                  spellcheck={false}
                  placeholder={FIND_MODEL_PLACEHOLDER}
                  aria-label={FIND_MODEL_PLACEHOLDER}
                  onInput={(event) => {
                    const current = pickerState.peek();
                    if (!current.isOpen) return;
                    pickerState.update(applyModelPickerQuery(current, event.currentTarget.value));
                  }}
                  onKeyDown={(event) => {
                    const current = pickerState.peek();
                    if (!current.isOpen) return;
                    const decision = decideModelFindKeydown(current, event.key);
                    if (decision.kind === 'none') return;
                    event.preventDefault();
                    if (decision.kind === 'pick-listed') {
                      applyActionOutcome(pickListedModel(current, decision.provider, decision.modelId));
                      return;
                    }
                    applyActionOutcome(pickTypedModel(current, decision.provider, decision.modelId));
                  }}
                />
              </div>
              <div
                ref={(element) => { listElement = element; }}
                class="add-session-list"
                role="listbox"
                aria-label="Models"
              >
                <For each={rows()}>
                  {(row) => (
                    <Switch>
                      <Match when={row.kind === 'group-label' ? row : undefined}>
                        {(groupLabel) => (
                          <div class="add-session-list-label" role="presentation">
                            {groupLabel().text}
                          </div>
                        )}
                      </Match>
                      <Match when={row.kind === 'back' ? row : undefined}>
                        {(backRow) => (
                          <Pressable
                            class="add-session-row add-session-row-back"
                            data-key={backRow().key}
                            onClick={() => switchStep('models')}
                          >
                            <span class="add-session-row-chevron" />
                            <span class="add-session-row-name">{backRow().label}</span>
                          </Pressable>
                        )}
                      </Match>
                      <Match when={row.kind === 'typed' ? row : undefined}>
                        {(typedRow) => (
                          <Pressable
                            class="add-session-row add-session-row-choice"
                            data-key={typedRow().key}
                            onClick={() => {
                              const current = pickerState.peek();
                              if (current.isOpen) applyActionOutcome(pickTypedModel(current, typedRow().provider, typedRow().modelId));
                            }}
                          >
                            <span class="add-session-row-name">{typedRow().label}</span>
                            <span class="add-session-row-chevron" />
                          </Pressable>
                        )}
                      </Match>
                      <Match when={row.kind === 'model' ? row : undefined}>
                        {(modelRow) => (
                          <Pressable
                            class="add-session-row"
                            role="option"
                            aria-selected={modelRow().isPicked ? 'true' : 'false'}
                            data-key={modelRow().key}
                            onClick={() => {
                              const current = pickerState.peek();
                              if (current.isOpen) applyActionOutcome(pickListedModel(current, modelRow().provider, modelRow().modelId));
                            }}
                          >
                            <span class="add-session-row-name">{modelRow().label}</span>
                            <Show when={modelRow().meta}>
                              {(meta) => <span class="add-session-row-meta">{meta()}</span>}
                            </Show>
                          </Pressable>
                        )}
                      </Match>
                      <Match when={row.kind === 'effort' ? row : undefined}>
                        {(effortRow) => (
                          <Pressable
                            class="add-session-row"
                            role="option"
                            aria-selected={effortRow().isPicked ? 'true' : 'false'}
                            data-key={effortRow().key}
                            onClick={() => {
                              const current = pickerState.peek();
                              if (current.isOpen) applyActionOutcome(pickEffortChoice(current, effortRow().effort));
                            }}
                          >
                            <span class="add-session-row-name">{effortRow().label}</span>
                          </Pressable>
                        )}
                      </Match>
                    </Switch>
                  )}
                </For>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
