import { el, markAsNotCredential } from '../dom-helpers.ts';
import { textAreaDescriptor, textInputDescriptor } from './text-input-core.ts';
import type { TextFieldCoreOptions, TextInputSize, TextInputType } from './text-input-core.ts';

type FieldOptions = TextFieldCoreOptions & {
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
  const descriptor = textInputDescriptor(options);
  const element = el('input', descriptor.className);
  element.type = descriptor.type;
  element.dataset.size = descriptor.size;
  if (!descriptor.isCredentialOptOut) element.autocomplete = descriptor.autocomplete;
  if (descriptor.isCredentialOptOut) markAsNotCredential(element);
  element.spellcheck = descriptor.spellcheck;
  applyFieldOptions(element, descriptor, options);
  return element;
}

export function textArea(options: TextAreaOptions = {}): HTMLTextAreaElement {
  const descriptor = textAreaDescriptor(options);
  const element = el('textarea', descriptor.className);
  element.dataset.size = descriptor.size;
  element.rows = descriptor.rows;
  element.autocomplete = descriptor.autocomplete;
  if (descriptor.spellcheck !== undefined) element.spellcheck = descriptor.spellcheck;
  applyFieldOptions(element, descriptor, options);
  return element;
}

function applyFieldOptions(
  element: HTMLInputElement | HTMLTextAreaElement,
  descriptor: {
    readonly id?: string;
    readonly value?: string;
    readonly placeholder?: string;
    readonly ariaLabel?: string;
    readonly ariaLabelledBy?: string;
    readonly disabled: boolean;
  },
  options: FieldOptions,
) {
  if (descriptor.id) element.id = descriptor.id;
  if (descriptor.value !== undefined) element.value = descriptor.value;
  if (descriptor.placeholder) element.placeholder = descriptor.placeholder;
  if (descriptor.ariaLabel) element.setAttribute('aria-label', descriptor.ariaLabel);
  if (descriptor.ariaLabelledBy) element.setAttribute('aria-labelledby', descriptor.ariaLabelledBy);
  element.disabled = descriptor.disabled;
  const { onInput, onChange } = options;
  if (onInput) element.addEventListener('input', () => onInput(element.value));
  if (onChange) element.addEventListener('change', () => onChange(element.value));
}
