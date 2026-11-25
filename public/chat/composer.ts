import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import { el } from '../dom-helpers.ts';
import { isImeProcessingKeydown } from '../session-card/ime-core.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button, outlineIconButton } from '../ui/button.ts';
import { renderAttachmentThumbnail } from './chat-parts.ts';
import { createStatusRail } from './status-rail.ts';
import type { RailField } from './status-rail-core.ts';

const MAX_INPUT_HEIGHT_PX = 240;
const ATTACH_ICON_PATH = 'M10.5 4.5L5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2';
const SEND_ICON_PATH = 'M8 13V3M3.5 7.5L8 3l4.5 4.5';
const STOP_ICON_PATH = 'M5 5h6v6H5z';
const REMOVE_ICON_PATH = 'M4.5 4.5l7 7M11.5 4.5l-7 7';

interface ChatComposer {
  element: HTMLElement;
  input: HTMLTextAreaElement;
  setTurnRunning(isTurnRunning: boolean): void;
  readDraft(): string;
  restoreDraft(text: string): void;
  readAttachments(): string[];
  showAttachment(fileName: string): void;
  showRail(fields: readonly RailField[]): void;
}

function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && Array.from(transfer.types).includes('Files');
}

function attachmentPreviewOf(fileName: string, uploadUrlOf: (fileName: string) => string, onRemove: () => void): HTMLElement {
  const attachment = el('div', 'chat-composer-attachment');
  const removeButton = button({ variant: 'icon', size: 'small', label: 'Remove', icon: createLineIcon(REMOVE_ICON_PATH, '1.6') });
  removeButton.classList.add('chat-composer-attachment-remove');
  removeButton.addEventListener('click', onRemove);
  attachment.append(renderAttachmentThumbnail(fileName, uploadUrlOf), removeButton);
  return attachment;
}

function isSubmitKeydown(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  return !event.isComposing && !isImeProcessingKeydown(event);
}

function fitInputHeight(input: HTMLTextAreaElement): void {
  input.style.height = '';
  if (input.value === '' || !input.isConnected) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
}

export function createComposer(uploadUrlOf: (fileName: string) => string): ChatComposer {
  const element = el('form', 'chat-composer');
  const input = el('textarea', 'chat-composer-input');
  input.dataset.dashboardShortcuts = 'allowed';
  input.rows = 1;
  input.maxLength = CHAT_SEND_MAX_CHARS;
  input.placeholder = 'Message the agent';
  input.setAttribute('aria-label', 'Message the agent');
  const sendButton = button({ variant: 'primary-icon', size: 'large', label: 'Send', icon: createLineIcon(SEND_ICON_PATH, '1.8'), disabled: true });
  sendButton.type = 'submit';
  sendButton.classList.add('chat-composer-send');
  const stopButton = outlineIconButton({ label: 'Stop', icon: createLineIcon(STOP_ICON_PATH, '1.8'), size: 'large', disabled: true, states: ['idle'] }).element;
  stopButton.classList.add('chat-composer-stop');
  const attachButton = button({ variant: 'icon', size: 'large', label: 'Attach', icon: createLineIcon(ATTACH_ICON_PATH, '1.4') });
  attachButton.classList.add('chat-composer-attach');
  const filePicker = el('input', 'chat-composer-file-picker');
  filePicker.type = 'file';
  filePicker.multiple = true;
  filePicker.accept = 'image/*';
  filePicker.hidden = true;
  const attachments = el('div', 'chat-composer-attachments');
  const sendStopSlot = el('div', 'chat-composer-slot');
  sendStopSlot.append(sendButton, stopButton);
  const inputRow = el('div', 'chat-composer-row');
  inputRow.append(attachButton, input, sendStopSlot);
  const rail = createStatusRail();
  element.append(attachments, inputRow, rail.element, filePicker);

  const attachFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    element.dispatchEvent(new CustomEvent('chat-attach', { bubbles: true, composed: true, detail: { files } }));
  };
  let attachedFileNames: string[] = [];
  const updateSendButton = () => {
    const hasDraft = input.value.trim().length > 0 || attachedFileNames.length > 0;
    sendButton.disabled = !hasDraft;
    sendStopSlot.dataset.hasDraft = String(hasDraft);
  };
  const clearAttachments = () => {
    attachments.replaceChildren();
    attachedFileNames = [];
  };
  attachButton.addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', () => {
    attachFiles(Array.from(filePicker.files ?? []));
    filePicker.value = '';
  });
  input.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard || clipboard.files.length === 0 || clipboard.getData('text/plain') !== '') return;
    event.preventDefault();
    attachFiles(Array.from(clipboard.files));
  });
  element.addEventListener('dragover', (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    element.toggleAttribute('data-drop-ready', true);
  });
  element.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
    element.toggleAttribute('data-drop-ready', false);
  });
  element.addEventListener('drop', (event) => {
    element.toggleAttribute('data-drop-ready', false);
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    attachFiles(Array.from(event.dataTransfer.files));
  });

  const notifyDraftChanged = (isImmediate: boolean) => {
    element.dispatchEvent(new CustomEvent('chat-draft', { bubbles: true, composed: true, detail: { text: input.value, isImmediate } }));
  };
  const submit = () => {
    const text = input.value.trim();
    if (text.length === 0 && attachedFileNames.length === 0) return;
    element.dispatchEvent(new CustomEvent('chat-send', { bubbles: true, composed: true, detail: { text, attachments: [...attachedFileNames] } }));
    input.value = '';
    clearAttachments();
    updateSendButton();
    fitInputHeight(input);
    notifyDraftChanged(true);
  };
  input.addEventListener('input', () => {
    updateSendButton();
    fitInputHeight(input);
    notifyDraftChanged(false);
  });
  input.addEventListener('focus', () => fitInputHeight(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const escapeRequest = new CustomEvent('chat-escape', { bubbles: true, composed: true, cancelable: true });
      if (element.dispatchEvent(escapeRequest)) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!isSubmitKeydown(event)) return;
    event.preventDefault();
    submit();
  });
  element.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  stopButton.addEventListener('click', () => {
    element.dispatchEvent(new CustomEvent('chat-stop', { bubbles: true, composed: true }));
  });
  const setTurnRunning = (isTurnRunning: boolean) => {
    stopButton.disabled = !isTurnRunning;
    sendStopSlot.dataset.turnRunning = String(isTurnRunning);
  };
  const restoreDraft = (text: string) => {
    input.value = text;
    updateSendButton();
    fitInputHeight(input);
    notifyDraftChanged(true);
  };
  const showAttachment = (fileName: string) => {
    if (attachedFileNames.includes(fileName)) return;
    attachedFileNames = [...attachedFileNames, fileName];
    const preview = attachmentPreviewOf(fileName, uploadUrlOf, () => {
      attachedFileNames = attachedFileNames.filter((attachedFileName) => attachedFileName !== fileName);
      preview.remove();
      updateSendButton();
    });
    attachments.append(preview);
    updateSendButton();
  };
  return { element, input, setTurnRunning, readDraft: () => input.value, restoreDraft, readAttachments: () => [...attachedFileNames], showAttachment, showRail: rail.show };
}
