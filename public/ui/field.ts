import { el } from '../dom-helpers.ts';
import { fieldDescriptor, fieldMessageState, isLabelableTagName } from './field-core.ts';
import type { FieldLayout } from './field-core.ts';

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

let fieldSequence = 0;

function setText(element: HTMLElement, text: string) {
  const message = fieldMessageState(text);
  element.textContent = message.text;
  element.hidden = message.hidden;
}

export function field({ label, control, labelTarget, hint = '', layout = 'stacked' }: FieldOptions): Field {
  fieldSequence += 1;
  const idPrefix = `ui-field-${fieldSequence}`;
  const target = labelTarget ?? control;
  const descriptor = fieldDescriptor({
    idPrefix,
    label,
    isTargetLabelable: isLabelableTagName(target.tagName),
    targetId: target.id,
    targetHasRole: target.hasAttribute('role'),
    existingDescribedBy: target.getAttribute('aria-describedby'),
    hint,
    error: '',
    layout,
  });

  const element = el('div', descriptor.className);
  element.dataset.layout = descriptor.layout;

  const labelElement = el(descriptor.labelTag, 'ui-field-label', label);
  labelElement.id = descriptor.labelId;
  if (descriptor.assignedTargetId) target.id = descriptor.assignedTargetId;
  if (labelElement instanceof HTMLLabelElement && descriptor.labelFor) labelElement.htmlFor = descriptor.labelFor;

  const described = descriptor.describedIsWrapper ? element : target;
  if (descriptor.wrapperRole) element.setAttribute('role', descriptor.wrapperRole);
  if (descriptor.ariaLabelledBy) described.setAttribute('aria-labelledby', descriptor.ariaLabelledBy);

  const hintElement = el('span', 'ui-field-hint');
  hintElement.id = descriptor.hintId;
  setText(hintElement, descriptor.hintText);
  const errorElement = el('span', 'ui-field-error');
  errorElement.id = descriptor.errorId;
  errorElement.setAttribute('role', 'alert');
  setText(errorElement, descriptor.errorText);

  described.setAttribute('aria-describedby', descriptor.ariaDescribedBy);

  element.append(labelElement, control, hintElement, errorElement);

  const setError = (text: string) => {
    setText(errorElement, text);
    if (text === '') described.removeAttribute('aria-invalid');
    if (text !== '') described.setAttribute('aria-invalid', 'true');
  };

  return { element, setError, setHint: (text: string) => setText(hintElement, text) };
}
