import { For, createEffect, createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { findSelectChoice, selectDescriptor } from './select-core.ts';
import type { SelectChoice, SelectMissingValue, SelectSelection, SelectSize } from './select-core.ts';

type SelectProps<V extends string> = {
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

function applySelection<V extends string>(element: HTMLSelectElement | null, selection: SelectSelection<V>): void {
  if (!element) return;
  if (selection.kind === 'value') {
    element.value = selection.value;
    return;
  }
  if (selection.kind === 'blank') {
    element.selectedIndex = -1;
    return;
  }
  element.selectedIndex = element.options.length > 0 ? 0 : -1;
}

export function Select<const V extends string>(props: SelectProps<V>): JSX.Element {
  const [selectElement, setSelectElement] = createSignal<HTMLSelectElement | null>(null);
  const descriptor = createMemo(() => selectDescriptor({
    options: props.options,
    value: props.value,
    missingValue: props.missingValue,
    label: props.label,
    labelledBy: props.labelledBy,
    id: props.id,
    size: props.size,
    disabled: props.disabled,
  }));

  createEffect(
    () => ({
      element: selectElement(),
      selection: descriptor().selection,
      optionValues: props.options.map((choice) => choice.value).join('\0'),
    }),
    ({ element, selection }) => applySelection(element, selection),
  );

  return (
    <select
      ref={(element) => {
        setSelectElement(element);
        applySelection(element, descriptor().selection);
      }}
      class={descriptor().className}
      data-size={descriptor().size}
      id={descriptor().id}
      aria-label={descriptor().ariaLabel}
      aria-labelledby={descriptor().ariaLabelledBy}
      disabled={descriptor().disabled}
      onChange={(event) => {
        if (!props.onChange) return;
        const chosen = findSelectChoice(props.options, event.currentTarget.value);
        if (chosen) props.onChange(chosen.value);
      }}
    >
      <For each={props.options}>
        {(choice) => <option value={choice.value}>{choice.label}</option>}
      </For>
    </select>
  );
}
