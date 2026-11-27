import { el } from '../dom-helpers.ts';
import { findSelectChoice, resolveSelectSelection, selectDescriptor } from './select-core.ts';
import type { SelectChoice, SelectMissingValue, SelectSelection, SelectSize } from './select-core.ts';

type SelectOptions<V extends string> = {
  options: readonly SelectChoice<V>[];
  value?: V | null;
  missingValue?: SelectMissingValue;
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

function applySelection<V extends string>(element: HTMLSelectElement, selection: SelectSelection<V>): void {
  if (selection.kind === 'value') {
    element.value = selection.value;
    return;
  }
  if (selection.kind === 'blank') {
    element.selectedIndex = -1;
  }
}

export function select<const V extends string>(options: SelectOptions<V>): Select<V> {
  const descriptor = selectDescriptor(options);
  const element = el('select', descriptor.className);
  element.dataset.size = descriptor.size;
  if (descriptor.id) element.id = descriptor.id;
  if (descriptor.ariaLabel) element.setAttribute('aria-label', descriptor.ariaLabel);
  if (descriptor.ariaLabelledBy) element.setAttribute('aria-labelledby', descriptor.ariaLabelledBy);
  let choices = options.options;
  element.append(...choices.map(optionElement));
  applySelection(element, descriptor.selection);
  element.disabled = descriptor.disabled;
  const { onChange } = options;
  if (onChange) {
    element.addEventListener('change', () => {
      const chosen = findSelectChoice(choices, element.value);
      if (chosen) onChange(chosen.value);
    });
  }
  const setOptions = (next: readonly SelectChoice<V>[]) => {
    const kept = element.value as V;
    choices = next;
    element.replaceChildren(...next.map(optionElement));
    applySelection(element, resolveSelectSelection(next, kept));
  };
  return { element, setOptions };
}

function optionElement(choice: SelectChoice<string>): HTMLOptionElement {
  const option = el('option', null, choice.label);
  option.value = choice.value;
  return option;
}
