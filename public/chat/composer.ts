import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import { el } from '../dom-helpers.ts';
import { isImeProcessingKeydown } from '../session-card/ime-core.ts';
import { button } from '../ui/button.ts';

const MAX_INPUT_HEIGHT_PX = 240;

interface ChatComposer {
  element: HTMLElement;
  setTurnRunning(isTurnRunning: boolean): void;
  readDraft(): string;
  restoreDraft(text: string): void;
  showAttachment(file: File): void;
}

function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && Array.from(transfer.types).includes('Files');
}

function attachmentPreviewOf(file: File): HTMLElement {
  const attachment = el('div', 'chat-composer-attachment');
  if (!file.type.startsWith('image/')) {
    attachment.textContent = file.name;
    return attachment;
  }
  const preview = el('img', 'chat-composer-attachment-image');
  preview.alt = file.name;
  preview.src = URL.createObjectURL(file);
  attachment.append(preview);
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

export function createComposer(): ChatComposer {
  const element = el('form', 'chat-composer');
  const input = el('textarea', 'chat-composer-input');
  input.rows = 1;
  input.maxLength = CHAT_SEND_MAX_CHARS;
  input.placeholder = 'Message the agent';
  input.setAttribute('aria-label', 'Message the agent');
  const sendButton = button({ variant: 'primary', textCase: 'sentence', label: 'Send', disabled: true });
  sendButton.type = 'submit';
  const stopButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Stop', disabled: true });
  const attachButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Attach' });
  const filePicker = el('input', 'chat-composer-file-picker');
  filePicker.type = 'file';
  filePicker.multiple = true;
  filePicker.accept = 'image/*';
  filePicker.hidden = true;
  const attachments = el('div', 'chat-composer-attachments');
  const actions = el('div', 'chat-composer-actions');
  actions.append(attachButton, stopButton, sendButton);
  const inputRow = el('div', 'chat-composer-row');
  inputRow.append(input, actions);
  element.append(attachments, inputRow, filePicker);

  const attachFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    element.dispatchEvent(new CustomEvent('chat-attach', { bubbles: true, composed: true, detail: { files } }));
  };
  const clearAttachments = () => {
    for (const preview of attachments.querySelectorAll('img')) URL.revokeObjectURL(preview.src);
    attachments.replaceChildren();
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
  });
  element.addEventListener('drop', (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    attachFiles(Array.from(event.dataTransfer.files));
  });

  const submit = () => {
    const text = input.value.trim();
    if (text.length === 0) return;
    element.dispatchEvent(new CustomEvent('chat-send', { bubbles: true, composed: true, detail: { text } }));
    input.value = '';
    clearAttachments();
    sendButton.disabled = true;
    fitInputHeight(input);
  };
  input.addEventListener('input', () => {
    sendButton.disabled = input.value.trim().length === 0;
    fitInputHeight(input);
  });
  input.addEventListener('focus', () => fitInputHeight(input));
  input.addEventListener('keydown', (event) => {
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
  };
  const restoreDraft = (text: string) => {
    input.value = text;
    sendButton.disabled = text.trim().length === 0;
    fitInputHeight(input);
  };
  const showAttachment = (file: File) => attachments.append(attachmentPreviewOf(file));
  return { element, setTurnRunning, readDraft: () => input.value, restoreDraft, showAttachment };
}
