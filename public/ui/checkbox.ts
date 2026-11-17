import { el } from '../dom-helpers.ts';

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
  const choice = buildChoice('radio', options);
  choice.input.name = options.name;
  const { onSelect } = options;
  if (onSelect) choice.input.addEventListener('change', () => { if (choice.input.checked) onSelect(); });
  return choice;
}

function buildChoice(type: 'checkbox' | 'radio', options: CommonChoiceOptions): Choice {
  const element = el('label', 'ui-checkbox');
  element.dataset.type = type;
  const input = el('input', 'ui-checkbox-input');
  input.type = type;
  input.checked = options.checked ?? false;
  input.disabled = options.disabled ?? false;
  if (options.value !== undefined) input.value = options.value;
  if (options.accessibleName) input.setAttribute('aria-label', options.accessibleName);
  const text = el('span', 'ui-checkbox-text');
  text.append(options.label);
  element.append(input, text);
  if (options.hint) {
    hintCount += 1;
    const hint = el('span', 'ui-checkbox-hint', options.hint);
    hint.id = `ui-checkbox-hint-${hintCount}`;
    input.setAttribute('aria-describedby', hint.id);
    element.append(hint);
  }
  return { element, input };
}
