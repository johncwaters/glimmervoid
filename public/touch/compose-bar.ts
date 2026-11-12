import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';

export function createComposeBar({ submit }: { submit: (text: string) => boolean }) {
  const element = el('form', 'phone-compose');
  const field = el('textarea', 'phone-compose-field');
  field.rows = 1;
  field.placeholder = 'Ask the agent';
  field.setAttribute('aria-label', 'Message to the agent');
  field.setAttribute('enterkeyhint', 'send');
  field.setAttribute('autocapitalize', 'sentences');
  field.setAttribute('autocorrect', 'on');
  field.spellcheck = true;

  const sendButton = button({ variant: 'primary', label: 'Send', action: 'compose-send' });
  sendButton.type = 'submit';
  sendButton.addEventListener('pointerdown', (event) => event.preventDefault());
  element.append(field, sendButton);

  const draftsBySessionId = new Map<string, string>();
  let shownSessionId: string | null = null;

  function fitFieldToText() {
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }

  function rememberDraft() {
    if (!shownSessionId) return;
    if (field.value === '') {
      draftsBySessionId.delete(shownSessionId);
      return;
    }
    draftsBySessionId.set(shownSessionId, field.value);
  }

  function submitDraft() {
    if (!submit(field.value)) return;
    field.value = '';
    rememberDraft();
    fitFieldToText();
  }

  element.addEventListener('submit', (event) => {
    event.preventDefault();
    submitDraft();
    field.focus();
  });

  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submitDraft();
  });

  field.addEventListener('input', () => {
    rememberDraft();
    fitFieldToText();
  });

  function showSession(sessionId: string | null) {
    if (sessionId === shownSessionId) return;
    rememberDraft();
    shownSessionId = sessionId;
    field.value = sessionId ? draftsBySessionId.get(sessionId) ?? '' : '';
    fitFieldToText();
  }

  function insertText(text: string) {
    field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
    rememberDraft();
    fitFieldToText();
  }

  function removeTypedCharacterBeforeCaret() {
    const caret = field.selectionStart;
    if (caret === 0 || caret !== field.selectionEnd) return;
    field.setRangeText('', caret - 1, caret, 'end');
    rememberDraft();
  }

  return {
    element,
    field,
    showSession,
    insertText,
    removeTypedCharacterBeforeCaret,
    setVisible: (isVisible: boolean) => { element.hidden = !isVisible; },
    isFocused: () => document.activeElement === field,
    focus: () => field.focus(),
    blur: () => field.blur(),
  };
}
