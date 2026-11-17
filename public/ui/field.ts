import { el } from '../dom-helpers.ts';

type FieldLayout = 'stacked' | 'inline' | 'grid';

type FieldOptions = {
  label: string;
  control: HTMLElement;
  labelTarget?: HTMLElement;
  hint?: string;
  layout?: FieldLayout;
};

type Field = {
  readonly element: HTMLElement;
  setError(text: string): void;
  setHint(text: string): void;
};

type Labelable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLMeterElement | HTMLOutputElement | HTMLProgressElement;

let fieldSequence = 0;

function isLabelable(element: HTMLElement): element is Labelable {
  return element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLMeterElement
    || element instanceof HTMLOutputElement
    || element instanceof HTMLProgressElement;
}

function ensureId(element: HTMLElement, fallback: string): string {
  if (!element.id) element.id = fallback;
  return element.id;
}

function setText(element: HTMLElement, text: string) {
  element.textContent = text;
  element.hidden = text === '';
}

export function field({ label, control, labelTarget, hint = '', layout = 'stacked' }: FieldOptions): Field {
  fieldSequence += 1;
  const idPrefix = `ui-field-${fieldSequence}`;
  const target = labelTarget ?? control;
  const element = el('div', 'ui-field');
  element.dataset.layout = layout;

  const labelElement = isLabelable(target) ? el('label', 'ui-field-label', label) : el('span', 'ui-field-label', label);
  labelElement.id = `${idPrefix}-label`;
  if (labelElement instanceof HTMLLabelElement) labelElement.htmlFor = ensureId(target, `${idPrefix}-control`);
  const described = isLabelable(target) || target.hasAttribute('role') || label === '' ? target : element;
  if (described === element) element.setAttribute('role', 'group');
  if (!(labelElement instanceof HTMLLabelElement) && label !== '') described.setAttribute('aria-labelledby', labelElement.id);

  const hintElement = el('span', 'ui-field-hint');
  hintElement.id = `${idPrefix}-hint`;
  setText(hintElement, hint);
  const errorElement = el('span', 'ui-field-error');
  errorElement.id = `${idPrefix}-error`;
  errorElement.setAttribute('role', 'alert');
  setText(errorElement, '');

  const describedBy = [described.getAttribute('aria-describedby'), hintElement.id, errorElement.id].filter((id) => id !== null && id !== '');
  described.setAttribute('aria-describedby', describedBy.join(' '));

  element.append(labelElement, control, hintElement, errorElement);

  const setError = (text: string) => {
    setText(errorElement, text);
    if (text === '') described.removeAttribute('aria-invalid');
    if (text !== '') described.setAttribute('aria-invalid', 'true');
  };

  return { element, setError, setHint: (text: string) => setText(hintElement, text) };
}
