import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import { createLineIcon } from '../svg-dom.ts';
import { Button, OutlineIconButton } from '../ui/Button.tsx';
import { mountIsland } from '../ui/island.ts';
import { createSyncedSignal } from '../ui/store-signal.ts';
import { renderAttachmentThumbnail } from './chat-parts.ts';
import {
  ATTACH_ICON_PATH,
  INITIAL_COMPOSER_STATE,
  REMOVE_ICON_PATH,
  SEND_ICON_PATH,
  STOP_ICON_PATH,
  addComposerAttachment,
  applyComposerDraftText,
  carriesFileTransferTypes,
  composerSlotStateOf,
  computeFittedInputHeightPx,
  decideComposerKeydown,
  decideComposerSubmit,
  removeComposerAttachment,
  setComposerDropReady,
  shouldAttachPastedFiles,
} from './composer-core.ts';
import { ModelPicker } from './ModelPicker.tsx';
import type { ModelPickerHandle } from './ModelPicker.tsx';
import { StatusRail } from './StatusRail.tsx';
import type { RailField } from './status-rail-core.ts';

const DEFAULT_PLACEHOLDER = 'Message the agent';

export interface ComposerModelPickerConfig {
  sessionId: string;
  canOpen: () => boolean;
  onFailure: (failureText: string) => void;
}

export interface ComposerHandle {
  element: HTMLFormElement;
  input: HTMLTextAreaElement;
  focus(): void;
  setTurnRunning(isTurnRunning: boolean): void;
  readDraft(): string;
  restoreDraft(text: string): void;
  readAttachments(): string[];
  showAttachment(fileName: string): void;
  showRail(fields: readonly RailField[]): void;
  closeModelPicker(): void;
}

interface ComposerProps {
  uploadUrlOf: (fileName: string) => string;
  class?: string;
  boardIsland?: boolean;
  inputClass?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaAutocomplete?: 'list' | 'none' | 'inline' | 'both';
  ariaActiveDescendant?: string | null;
  maxLength?: number;
  isTurnRunning?: boolean;
  railFields?: readonly RailField[];
  beforeInput?: JSX.Element;
  modelPicker?: ComposerModelPickerConfig;
  onDraft?: (text: string, isImmediate: boolean) => void;
  onSend?: (text: string, attachments: readonly string[]) => void;
  onStop?: () => void;
  onInput?: (value: string, selectionStart: number) => void;
  onBlur?: () => void;
  onInputKeyDownCapture?: (event: KeyboardEvent, currentValue: string) => boolean;
  onHandle?: (handle: ComposerHandle) => void;
}

function fitInputHeight(input: HTMLTextAreaElement | undefined): void {
  if (!input) return;
  input.style.height = '';
  const targetHeightPx = computeFittedInputHeightPx(input.value, input.isConnected, input.scrollHeight);
  if (targetHeightPx === null) return;
  input.style.height = 'auto';
  input.style.height = `${computeFittedInputHeightPx(input.value, input.isConnected, input.scrollHeight) ?? targetHeightPx}px`;
}

function mountAttachmentPreview(
  container: HTMLDivElement,
  fileName: string,
  uploadUrlOf: (fileName: string) => string,
): void {
  const preview = renderAttachmentThumbnail(fileName, uploadUrlOf);
  container.dataset.attachmentKind = preview.classList.contains('chat-prompt-file') ? 'file' : 'image';
  container.prepend(preview);
}

export function Composer(props: ComposerProps): JSX.Element {
  const composerState = createSyncedSignal(INITIAL_COMPOSER_STATE);
  const [isModelPickerOpen, setIsModelPickerOpen] = createSignal(false);
  const [imperativeTurnRunning, setImperativeTurnRunning] = createSignal<boolean | undefined>(undefined);
  const [imperativeRailFields, setImperativeRailFields] = createSignal<readonly RailField[] | undefined>(undefined);

  let formElement: HTMLFormElement | undefined;
  let inputElement: HTMLTextAreaElement | undefined;
  let filePickerElement: HTMLInputElement | undefined;
  let modelPickerHandle: ModelPickerHandle | null = null;

  const isTurnRunning = createMemo(() => props.isTurnRunning ?? imperativeTurnRunning() ?? false);
  const railFields = createMemo(() => props.railFields ?? imperativeRailFields() ?? []);
  const slotState = createMemo(() => composerSlotStateOf(composerState.read(), isTurnRunning()));

  const dispatchDraft = (isImmediate: boolean): void => {
    const text = inputElement?.value ?? '';
    props.onDraft?.(text, isImmediate);
    formElement?.dispatchEvent(new CustomEvent('chat-draft', { bubbles: true, composed: true, detail: { text, isImmediate } }));
  };

  const attachFiles = (files: readonly File[]): void => {
    if (files.length === 0) return;
    formElement?.dispatchEvent(new CustomEvent('chat-attach', { bubbles: true, composed: true, detail: { files } }));
  };

  const submitDraft = (): void => {
    const submitted = decideComposerSubmit(composerState.peek(), inputElement?.value ?? '');
    if (!submitted.shouldSubmit) return;
    if (inputElement) inputElement.value = '';
    composerState.update(submitted.state);
    fitInputHeight(inputElement);
    dispatchDraft(true);
    props.onSend?.(submitted.text, submitted.attachments);
    formElement?.dispatchEvent(new CustomEvent('chat-send', { bubbles: true, composed: true, detail: { text: submitted.text, attachments: submitted.attachments } }));
  };

  const restoreDraft = (text: string): void => {
    if (inputElement) inputElement.value = text;
    composerState.update((previous) => applyComposerDraftText(previous, text));
    fitInputHeight(inputElement);
    dispatchDraft(true);
  };

  const showAttachment = (fileName: string): void => {
    composerState.update((previous) => addComposerAttachment(previous, fileName));
  };

  const notifyHandleWhenReady = (): void => {
    if (!formElement || !inputElement) return;
    const readyForm = formElement;
    const readyInput = inputElement;
    props.onHandle?.({
      element: readyForm,
      input: readyInput,
      focus: () => readyInput.focus(),
      setTurnRunning: (running) => {
        setImperativeTurnRunning(running);
      },
      readDraft: () => readyInput.value,
      restoreDraft,
      readAttachments: () => [...composerState.peek().attachedFileNames],
      showAttachment,
      showRail: (fields) => {
        setImperativeRailFields(fields);
      },
      closeModelPicker: () => modelPickerHandle?.close(),
    });
  };

  const handleInputKeyDown = (event: KeyboardEvent): void => {
    if (props.onInputKeyDownCapture?.(event, inputElement?.value ?? '') === true) return;
    const decision = decideComposerKeydown(event);
    if (decision === 'escape') {
      const escapeRequest = new CustomEvent('chat-escape', { bubbles: true, composed: true, cancelable: true });
      if (formElement?.dispatchEvent(escapeRequest) !== false) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (decision !== 'submit') return;
    event.preventDefault();
    submitDraft();
  };

  const formClassName = createMemo(() => (props.class ? `chat-composer ${props.class}` : 'chat-composer'));
  const inputClassName = createMemo(() => (props.inputClass ? `chat-composer-input ${props.inputClass}` : 'chat-composer-input'));

  return (
    <form
      ref={(element) => {
        formElement = element;
        notifyHandleWhenReady();
      }}
      class={formClassName()}
      data-board-island={props.boardIsland ? '' : undefined}
      data-drop-ready={composerState.read().isDropReady ? '' : undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer || !carriesFileTransferTypes(Array.from(event.dataTransfer.types))) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        composerState.update((previous) => setComposerDropReady(previous, true));
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && formElement?.contains(event.relatedTarget)) return;
        composerState.update((previous) => setComposerDropReady(previous, false));
      }}
      onDrop={(event) => {
        composerState.update((previous) => setComposerDropReady(previous, false));
        if (!event.dataTransfer || !carriesFileTransferTypes(Array.from(event.dataTransfer.types))) return;
        event.preventDefault();
        attachFiles(Array.from(event.dataTransfer.files));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submitDraft();
      }}
    >
      <div class="chat-composer-attachments">
        <For each={composerState.read().attachedFileNames}>
          {(fileName) => (
            <div
              class="chat-composer-attachment"
              ref={(element) => mountAttachmentPreview(element, fileName, props.uploadUrlOf)}
            >
              <Button
                variant="icon"
                size="small"
                label="Remove"
                class="chat-composer-attachment-remove"
                icon={createLineIcon(REMOVE_ICON_PATH, '1.6')}
                onClick={() => composerState.update((previous) => removeComposerAttachment(previous, fileName))}
              />
            </div>
          )}
        </For>
      </div>
      <div class="chat-composer-row">
        <Button
          variant="icon"
          size="large"
          label="Attach"
          class="chat-composer-attach"
          icon={createLineIcon(ATTACH_ICON_PATH, '1.4')}
          onClick={() => filePickerElement?.click()}
        />
        {props.beforeInput}
        <textarea
          ref={(element) => {
            inputElement = element;
            notifyHandleWhenReady();
          }}
          class={inputClassName()}
          data-dashboard-shortcuts="allowed"
          rows={1}
          maxlength={props.maxLength ?? CHAT_SEND_MAX_CHARS}
          placeholder={props.placeholder ?? DEFAULT_PLACEHOLDER}
          aria-label={props.ariaLabel ?? DEFAULT_PLACEHOLDER}
          aria-autocomplete={props.ariaAutocomplete}
          aria-activedescendant={props.ariaActiveDescendant ?? undefined}
          onInput={(event) => {
            const target = event.currentTarget;
            composerState.update((previous) => applyComposerDraftText(previous, target.value));
            fitInputHeight(target);
            dispatchDraft(false);
            props.onInput?.(target.value, target.selectionStart);
          }}
          onFocus={() => fitInputHeight(inputElement)}
          onBlur={() => props.onBlur?.()}
          onPaste={(event) => {
            const clipboard = event.clipboardData;
            if (!clipboard || !shouldAttachPastedFiles(clipboard.files.length, clipboard.getData('text/plain'))) return;
            event.preventDefault();
            attachFiles(Array.from(clipboard.files));
          }}
          onKeyDown={handleInputKeyDown}
        />
        <div
          class="chat-composer-slot"
          data-has-draft={slotState().dataHasDraft}
          data-turn-running={slotState().dataTurnRunning}
        >
          <Button
            ref={(element) => { element.type = 'submit'; }}
            variant="primary-icon"
            size="large"
            label="Send"
            class="chat-composer-send"
            icon={createLineIcon(SEND_ICON_PATH, '1.8')}
            disabled={slotState().isSendDisabled}
          />
          <OutlineIconButton
            label="Stop"
            class="chat-composer-stop"
            icon={createLineIcon(STOP_ICON_PATH, '1.8')}
            size="large"
            disabled={slotState().isStopDisabled}
            states={['idle']}
            onClick={() => {
              props.onStop?.();
              formElement?.dispatchEvent(new CustomEvent('chat-stop', { bubbles: true, composed: true }));
            }}
          />
        </div>
      </div>
      <StatusRail
        fields={railFields()}
        isModelPickerOpen={isModelPickerOpen()}
        onChangeModel={(triggerElement) => modelPickerHandle?.toggle(triggerElement)}
      />
      <input
        ref={(element) => { filePickerElement = element; }}
        class="chat-composer-file-picker"
        type="file"
        multiple={true}
        hidden={true}
        onChange={(event) => {
          const target = event.currentTarget;
          attachFiles(Array.from(target.files ?? []));
          target.value = '';
        }}
      />
      <Show when={props.modelPicker}>
        {(pickerConfig) => (
          <ModelPicker
            sessionId={pickerConfig().sessionId}
            canOpen={pickerConfig().canOpen}
            onFailure={pickerConfig().onFailure}
            onOpenChange={setIsModelPickerOpen}
            onHandle={(handle) => { modelPickerHandle = handle; }}
          />
        )}
      </Show>
    </form>
  );
}

interface MountedComposerIsland extends ComposerHandle {
  dispose(): void;
}

export function mountComposerIsland(
  host: HTMLElement,
  options: {
    uploadUrlOf: (fileName: string) => string;
    modelPicker?: ComposerModelPickerConfig;
    lifecycleHost?: HTMLElement;
  },
): MountedComposerIsland {
  let activeHandle: ComposerHandle | null = null;
  const dispose = mountIsland(
    host,
    () => (
      <Composer
        uploadUrlOf={options.uploadUrlOf}
        modelPicker={options.modelPicker}
        onHandle={(handle) => { activeHandle = handle; }}
      />
    ),
    { lifecycleHost: options.lifecycleHost ?? document.body },
  );
  if (activeHandle === null) throw new Error('Composer island did not mount its handle');
  const mountedHandle: ComposerHandle = activeHandle;
  return {
    element: mountedHandle.element,
    input: mountedHandle.input,
    focus: mountedHandle.focus,
    setTurnRunning: mountedHandle.setTurnRunning,
    readDraft: mountedHandle.readDraft,
    restoreDraft: mountedHandle.restoreDraft,
    readAttachments: mountedHandle.readAttachments,
    showAttachment: mountedHandle.showAttachment,
    showRail: mountedHandle.showRail,
    closeModelPicker: mountedHandle.closeModelPicker,
    dispose,
  };
}
