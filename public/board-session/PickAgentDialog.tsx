import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import switchSessionAgentAction, { listAcpAgents } from '../state/actions/switch-session-agent.ts';
import { Radio } from '../ui/Checkbox.tsx';
import { Dialog } from '../ui/Dialog.tsx';
import { mountIsland } from '../ui/island.ts';
import {
  PICK_AGENT_DIALOG_CHROME,
  PICK_AGENT_RADIO_GROUP_NAME,
  applyPickAgentListFailure,
  applyPickAgentListReply,
  applyPickAgentSelection,
  applyPickAgentStartFailure,
  beginPickAgentStart,
  canStartPickAgent,
  initialPickAgentDialogState,
  pickAgentStatusClassName,
  shouldFocusChosenAgentRadio,
} from './pick-agent-dialog-core.ts';
import type { PickAgentDialogState } from './pick-agent-dialog-core.ts';

interface PickAgentDialogProps {
  sessionId: string;
  onDone: () => void;
}

function PickAgentDialog(props: PickAgentDialogProps): JSX.Element {
  const [state, setState] = createSignal<PickAgentDialogState>(initialPickAgentDialogState());
  const [isAlive, setIsAlive] = createSignal(true);
  const [statusElement, setStatusElement] = createSignal<HTMLParagraphElement | null>(null);
  const [listElement, setListElement] = createSignal<HTMLFieldSetElement | null>(null);
  const [hasFocusedRadio, setHasFocusedRadio] = createSignal(false);

  onCleanup(() => setIsAlive(false));

  createEffect(
    () => ({ element: statusElement(), status: state().status }),
    ({ element, status }) => {
      if (!element || !status) return;
      paintActionStatus(element, status.tone, status.text);
    },
  );

  createEffect(
    () => ({ list: listElement(), currentState: state(), focused: hasFocusedRadio() }),
    ({ list, currentState, focused }) => {
      if (!list || !shouldFocusChosenAgentRadio(currentState, focused)) return;
      const checkedInput = list.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      if (!checkedInput) return;
      checkedInput.focus();
      setHasFocusedRadio(true);
    },
  );

  void listAcpAgents()
    .then((reply) => {
      if (!isAlive()) return;
      setState((previous) => applyPickAgentListReply(previous, reply));
    })
    .catch((reason: unknown) => {
      if (!isAlive()) return;
      setState((previous) => applyPickAgentListFailure(previous, requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)));
    });

  const handleConfirm = () => {
    const current = state();
    if (!canStartPickAgent(current) || current.chosenAgentId === null) return;
    const chosenAgentId = current.chosenAgentId;
    setState(beginPickAgentStart(current));
    void switchSessionAgentAction({ id: props.sessionId, agent: chosenAgentId }).then((outcome) => {
      if (!isAlive()) return;
      if (outcome.ok) {
        props.onDone();
        return;
      }
      setState((previous) => applyPickAgentStartFailure(previous, outcome.error.message));
    });
  };

  return (
    <Dialog
      title={PICK_AGENT_DIALOG_CHROME.title}
      message={PICK_AGENT_DIALOG_CHROME.message}
      confirmLabel={PICK_AGENT_DIALOG_CHROME.confirmLabel}
      closeOnConfirm={PICK_AGENT_DIALOG_CHROME.closeOnConfirm}
      defaultAction={PICK_AGENT_DIALOG_CHROME.defaultAction}
      canConfirm={canStartPickAgent(state())}
      open={true}
      onConfirm={handleConfirm}
      onClose={props.onDone}
    >
      <fieldset ref={setListElement} class="dialog-workspace-list" aria-label="Agents">
        <For each={state().options}>
          {(option) => (
            <Radio
              name={PICK_AGENT_RADIO_GROUP_NAME}
              value={option.id}
              label={option.label}
              checked={option.id === state().chosenAgentId}
              disabled={state().isStarting}
              onSelect={() => setState((previous) => applyPickAgentSelection(previous, option.id))}
            />
          )}
        </For>
      </fieldset>
      <Show when={state().status}>
        {(status) => (
          <p
            ref={setStatusElement}
            class={pickAgentStatusClassName(status().tone)}
            role="status"
          />
        )}
      </Show>
    </Dialog>
  );
}

export function openPickAgentDialog(sessionId: string): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let disposeIsland = () => {};
  const unmount = () => {
    disposeIsland();
    host.remove();
  };
  disposeIsland = mountIsland(host, () => PickAgentDialog({ sessionId, onDone: unmount }));
}
