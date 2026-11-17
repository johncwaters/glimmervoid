import { el } from '../dom-helpers.ts';
import { isImeProcessingKeydown } from '../session-card/ime-core.ts';
import { button } from '../ui/button.ts';

const MAX_INPUT_HEIGHT_PX = 240;

interface ChatComposer {
  element: HTMLElement;
  setTurnRunning(isTurnRunning: boolean): void;
}

function isSubmitKeydown(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  return !event.isComposing && !isImeProcessingKeydown(event);
}

function fitInputHeight(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
}

export function createComposer(): ChatComposer {
  const element = el('form', 'chat-composer');
  const input = el('textarea', 'chat-composer-input');
  input.rows = 1;
  input.placeholder = 'Message the agent';
  input.setAttribute('aria-label', 'Message the agent');
  const sendButton = button({ variant: 'primary', size: 'small', label: 'Send', disabled: true });
  sendButton.type = 'submit';
  const stopButton = button({ variant: 'secondary', size: 'small', label: 'Stop', disabled: true });
  const actions = el('div', 'chat-composer-actions');
  actions.append(stopButton, sendButton);
  element.append(input, actions);

  const submit = () => {
    const text = input.value.trim();
    if (text.length === 0) return;
    element.dispatchEvent(new CustomEvent('chat-send', { bubbles: true, composed: true, detail: { text } }));
    input.value = '';
    sendButton.disabled = true;
    fitInputHeight(input);
  };
  input.addEventListener('input', () => {
    sendButton.disabled = input.value.trim().length === 0;
    fitInputHeight(input);
  });
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
  return { element, setTurnRunning };
}
