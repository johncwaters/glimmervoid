import type { Terminal } from '@xterm/xterm';
import type { SessionUi } from './card-registry.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { SHELL_AGENT_ID } from './agent-core.ts';
import { bytesForBackwardDeletion, bytesForSoftKeyboardEdit, isImeProcessingKeydown, isPlainTypedKey, isTypedInputType } from './ime-core.ts';
import { uploadFilesToSession } from '../session-upload.ts';
import { clearTerminalNotice, showTerminalNotice } from './terminal-notices.ts';

const INPUT_QUEUE_MAX = 1024;

const UNSENT_WORD_RESTORE_WINDOW_MS = 60_000;

const HELD_KEYS_TEXT = 'Keys you type now are held and sent once the terminal reconnects.';

const DROPPED_KEYS_TEXT = 'The terminal is still reconnecting and its key buffer is full, so new keys are dropped.';

let isInputHeldForWakeCheck = false;

function sendQueuedInput(ui: SessionUi) {
  const queued = ui._inputQueue;
  const ws = ui.dataWs;
  if (isInputHeldForWakeCheck || !queued?.length || ws?.readyState !== WebSocket.OPEN) return;
  for (const data of queued) ws.send(JSON.stringify({ type: 'input', data }));
  queued.length = 0;
  clearTerminalNotice(ui, 'keys');
}

function sendTerminalInput(ui: SessionUi | null | undefined, data: string | null | undefined, options?: { fromSoftKeyboard?: boolean }) {
  if (!ui || data == null || data === '') return false;
  if (!options?.fromSoftKeyboard) ui._resetSoftKeyboardBuffer?.();
  if (!isInputHeldForWakeCheck && !ui._inputQueue?.length && ui.dataWs?.readyState === WebSocket.OPEN) {
    ui.dataWs.send(JSON.stringify({ type: 'input', data }));
    return true;
  }
  if (!ui._inputQueue) return false;
  const isReconnecting = ui.dataWs?.readyState !== WebSocket.OPEN;
  if (ui._inputQueue.length >= INPUT_QUEUE_MAX) {
    showTerminalNotice(ui, 'keys', 'error', DROPPED_KEYS_TEXT);
    return false;
  }
  ui._inputQueue.push(data);
  if (isReconnecting) showTerminalNotice(ui, 'keys', 'busy', HELD_KEYS_TEXT);
  return true;
}

function wireSoftKeyboardInput(termWrap: HTMLElement, term: Terminal, ui: SessionUi) {
  const textarea = term.textarea;
  if (!textarea) return;

  let alreadySentText = '';
  let unsentWordToRestoreOnFocus = '';
  let unsentWordKeptAtMs = 0;

  const resyncBaseline = () => { alreadySentText = textarea.value; };

  const resetSoftKeyboardBuffer = () => {
    alreadySentText = '';
    unsentWordToRestoreOnFocus = '';
    if (!isPhoneLayout()) return;
    if (textarea.value === '') return;
    textarea.value = '';
  };
  ui._resetSoftKeyboardBuffer = resetSoftKeyboardBuffer;

  const restoreUnsentWord = () => {
    if (!isPhoneLayout()) return;
    const unsentWord = unsentWordToRestoreOnFocus;
    unsentWordToRestoreOnFocus = '';
    if (unsentWord === '') return;
    if (performance.now() - unsentWordKeptAtMs > UNSENT_WORD_RESTORE_WINDOW_MS) return;
    textarea.value = unsentWord;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    resyncBaseline();
  };

  const keepUnsentWordForFocus = () => {
    const unsentWord = alreadySentText.slice(alreadySentText.lastIndexOf(' ') + 1);
    resetSoftKeyboardBuffer();
    unsentWordToRestoreOnFocus = unsentWord;
    unsentWordKeptAtMs = performance.now();
  };

  textarea.addEventListener('focus', () => {
    syncPhoneKeyboardHints(textarea, ui);
    restoreUnsentWord();
  });

  const sendTypedText = () => {
    const bytes = bytesForSoftKeyboardEdit(alreadySentText, textarea.value);
    alreadySentText = textarea.value;
    if (bytes === '') return false;
    sendTerminalInput(ui, bytes, { fromSoftKeyboard: true });
    term.scrollToBottom();
    return true;
  };

  const listenBeforeXterm = <EventName extends keyof HTMLElementEventMap>(
    type: EventName,
    handler: (event: HTMLElementEventMap[EventName]) => void,
  ) => {
    termWrap.addEventListener(type, (event) => {
      if (!isPhoneLayout()) {
        resyncBaseline();
        return;
      }
      handler(event);
    }, true);
  };

  listenBeforeXterm('keydown', (event) => {
    if (isImeProcessingKeydown(event) || isPlainTypedKey(event)) {
      event.stopPropagation();
      return;
    }
    sendTypedText();
    queueMicrotask(resetSoftKeyboardBuffer);
  });

  listenBeforeXterm('keypress', (event) => {
    if (!isPlainTypedKey(event)) return;
    event.stopPropagation();
  });

  listenBeforeXterm('focusout', keepUnsentWordForFocus);

  listenBeforeXterm('compositionstart', (event) => {
    event.stopPropagation();
  });

  listenBeforeXterm('compositionupdate', (event) => {
    event.stopPropagation();
  });

  listenBeforeXterm('compositionend', (event) => {
    event.stopPropagation();
    setTimeout(sendTypedText, 0);
  });

  listenBeforeXterm('input', (event) => {
    if (!isTypedInputType(event.inputType)) {
      queueMicrotask(resetSoftKeyboardBuffer);
      return;
    }
    event.stopPropagation();
    if (sendTypedText()) return;
    const deletion = bytesForBackwardDeletion(event.inputType);
    if (deletion === '') return;
    sendTerminalInput(ui, deletion, { fromSoftKeyboard: true });
    term.scrollToBottom();
  });
}

function syncPhoneKeyboardHints(textarea: HTMLTextAreaElement, ui: SessionUi) {
  if (!isPhoneLayout()) {
    textarea.removeAttribute('enterkeyhint');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.spellcheck = false;
    return;
  }
  textarea.setAttribute('enterkeyhint', 'send');
  textarea.setAttribute('autocorrect', 'on');
  textarea.setAttribute('autocapitalize', ui.agent === SHELL_AGENT_ID ? 'off' : 'sentences');
  textarea.spellcheck = true;
}

function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return !!transfer && Array.from(transfer.types).includes('Files');
}

function wireFileTransfer(termWrap: HTMLElement, sessionId: string, signal: AbortSignal) {
  termWrap.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard || clipboard.files.length === 0) return;
    if (clipboard.getData('text/plain') !== '') return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFilesToSession(sessionId, Array.from(clipboard.files));
  }, { capture: true, signal });

  termWrap.addEventListener('dragover', (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    termWrap.dataset.dropTarget = 'true';
  }, { signal });

  termWrap.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && termWrap.contains(event.relatedTarget)) return;
    delete termWrap.dataset.dropTarget;
  }, { signal });

  termWrap.addEventListener('drop', (event) => {
    delete termWrap.dataset.dropTarget;
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFilesToSession(sessionId, Array.from(event.dataTransfer.files));
  }, { capture: true, signal });
}

function setInputHeldForWakeCheck(next: boolean): void {
  isInputHeldForWakeCheck = next;
}

export { isInputHeldForWakeCheck, sendQueuedInput, sendTerminalInput, setInputHeldForWakeCheck, wireFileTransfer, wireSoftKeyboardInput };
