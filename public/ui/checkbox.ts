import { el } from '../dom-helpers.ts';
import { choiceDescriptor } from './checkbox-core.ts';
import type { ChoiceType } from './checkbox-core.ts';

type ChoiceLabel = string | Node;

type CommonChoiceOptions = {
  label: ChoiceLabel;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
  value?: string;
  accessibleName?: string;
};

type CheckboxOptions = CommonChoiceOptions & {
  onChange?: (checked: boolean) => void;
};

type RadioOptions = CommonChoiceOptions & {
  name: string;
  value: string;
  onSelect?: () => void;
};

export type Choice = {
  readonly element: HTMLLabelElement;
  readonly input: HTMLInputElement;
};

let hintCount = 0;

export function checkbox(options: CheckboxOptions): Choice {
  const choice = buildChoice('checkbox', options);
  const { onChange } = options;
  if (onChange) choice.input.addEventListener('change', () => onChange(choice.input.checked));
  return choice;
}

export function radio(options: RadioOptions): Choice {
  const choice = buildChoice('radio', options, options.name);
  const { onSelect } = options;
  if (onSelect) choice.input.addEventListener('change', () => { if (choice.input.checked) onSelect(); });
  return choice;
}

function buildChoice(type: ChoiceType, options: CommonChoiceOptions, name?: string): Choice {
  let hintId: string | undefined;
  if (options.hint) {
    hintCount += 1;
    hintId = `ui-checkbox-hint-${hintCount}`;
  }
  const descriptor = choiceDescriptor({
    type,
    checked: options.checked,
    disabled: options.disabled,
    value: options.value,
    name,
    accessibleName: options.accessibleName,
    hint: options.hint,
    hintId,
  });
  const element = el('label', descriptor.className);
  element.dataset.type = descriptor.type;
  const input = el('input', descriptor.inputClassName);
  input.type = descriptor.type;
  if (descriptor.name !== undefined) input.name = descriptor.name;
  input.checked = descriptor.checked;
  input.disabled = descriptor.disabled;
  if (descriptor.value !== undefined) input.value = descriptor.value;
  if (descriptor.ariaLabel) input.setAttribute('aria-label', descriptor.ariaLabel);
  const text = el('span', descriptor.textClassName);
  text.append(options.label);
  element.append(input, text);
  if (descriptor.hintText && descriptor.hintId) {
    const hint = el('span', descriptor.hintClassName, descriptor.hintText);
    hint.id = descriptor.hintId;
    if (descriptor.ariaDescribedBy) input.setAttribute('aria-describedby', descriptor.ariaDescribedBy);
    element.append(hint);
  }
  return { element, input };
}
