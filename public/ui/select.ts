import { el } from '../dom-helpers.ts';

type SelectSize = 'default' | 'small';

type SelectChoice<V extends string> = { readonly value: V; readonly label: string };

type SelectOptions<V extends string> = {
  options: readonly SelectChoice<V>[];
  value?: V | null;
  missingValue?: 'first' | 'blank';
  onChange?: (value: V) => void;
  label?: string;
  labelledBy?: string;
  id?: string;
  size?: SelectSize;
  disabled?: boolean;
};

type Select<V extends string> = {
  readonly element: HTMLSelectElement;
  setOptions(options: readonly SelectChoice<V>[]): void;
};

export function select<const V extends string>(options: SelectOptions<V>): Select<V> {
  const element = el('select', 'ui-select');
  element.dataset.size = options.size ?? 'default';
  if (options.id) element.id = options.id;
  if (options.label) element.setAttribute('aria-label', options.label);
  if (options.labelledBy) element.setAttribute('aria-labelledby', options.labelledBy);
  let choices = options.options;
  element.append(...choices.map(optionElement));
  const { value } = options;
  if (value != null && choices.some((choice) => choice.value === value)) element.value = value;
  else if (value != null && options.missingValue === 'blank') element.selectedIndex = -1;
  element.disabled = options.disabled ?? false;
  const { onChange } = options;
  if (onChange) {
    element.addEventListener('change', () => {
      const chosen = choices.find((choice) => choice.value === element.value);
      if (chosen) onChange(chosen.value);
    });
  }
  const setOptions = (next: readonly SelectChoice<V>[]) => {
    const kept = element.value;
    choices = next;
    element.replaceChildren(...next.map(optionElement));
    if (next.some((choice) => choice.value === kept)) element.value = kept;
  };
  return { element, setOptions };
}

function optionElement(choice: SelectChoice<string>): HTMLOptionElement {
  const option = el('option', null, choice.label);
  option.value = choice.value;
  return option;
}
