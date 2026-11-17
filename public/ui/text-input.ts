import { el, markAsNotCredential } from '../dom-helpers.ts';

type TextInputType = 'text' | 'search' | 'number' | 'url' | 'password';
type TextInputSize = 'default' | 'compact';

type FieldOptions = {
  id?: string;
  value?: string;
  placeholder?: string;
  label?: string;
  labelledBy?: string;
  spellcheck?: boolean;
  disabled?: boolean;
  onInput?: (value: string) => void;
  onChange?: (value: string) => void;
};

type TextInputOptions = FieldOptions & {
  type?: TextInputType;
  size?: TextInputSize;
};

type TextAreaOptions = FieldOptions & {
  rows?: number;
};

export function textInput(options: TextInputOptions = {}): HTMLInputElement {
  const element = el('input', 'ui-input');
  const type = options.type ?? 'text';
  element.type = type;
  element.dataset.size = options.size ?? 'default';
  if (type === 'password') element.autocomplete = 'off';
  else markAsNotCredential(element);
  element.spellcheck = options.spellcheck ?? false;
  applyFieldOptions(element, options);
  return element;
}

export function textArea(options: TextAreaOptions = {}): HTMLTextAreaElement {
  const element = el('textarea', 'ui-input');
  element.dataset.size = 'default';
  element.rows = options.rows ?? 3;
  element.autocomplete = 'off';
  if (options.spellcheck !== undefined) element.spellcheck = options.spellcheck;
  applyFieldOptions(element, options);
  return element;
}

function applyFieldOptions(element: HTMLInputElement | HTMLTextAreaElement, options: FieldOptions) {
  if (options.id) element.id = options.id;
  if (options.value !== undefined) element.value = options.value;
  if (options.placeholder) element.placeholder = options.placeholder;
  if (options.label) element.setAttribute('aria-label', options.label);
  if (options.labelledBy) element.setAttribute('aria-labelledby', options.labelledBy);
  element.disabled = options.disabled ?? false;
  const { onInput, onChange } = options;
  if (onInput) element.addEventListener('input', () => onInput(element.value));
  if (onChange) element.addEventListener('change', () => onChange(element.value));
}
