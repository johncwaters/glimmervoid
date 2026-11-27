import { el } from '../dom-helpers.ts';
import { createPressable } from './pressable.ts';
import { nextSegmentedValue, segmentedDescriptor, segmentedOptionStates } from './segmented-core.ts';
import type { SegmentedSize, SegmentedWidth } from './segmented-core.ts';

type SegmentedChoice<V extends string> = { readonly value: V; readonly label: string; readonly icon?: SVGElement };

type SegmentedName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

type SegmentedOptions<V extends string> = SegmentedName & {
  options: readonly SegmentedChoice<V>[];
  value: V;
  onChange: (value: V) => void;
  width?: SegmentedWidth;
  size?: SegmentedSize;
};

export type Segmented<V extends string> = {
  readonly element: HTMLDivElement;
  setValue(value: V): void;
  focus(): void;
};

export function segmented<const V extends string>(options: SegmentedOptions<V>): Segmented<V> {
  const descriptor = segmentedDescriptor({
    label: options.label,
    labelledBy: options.labelledBy,
    width: options.width,
    size: options.size,
  });
  const element = el('div', descriptor.className);
  element.setAttribute('role', descriptor.role);
  if (descriptor.ariaLabel !== undefined) element.setAttribute('aria-label', descriptor.ariaLabel);
  if (descriptor.ariaLabelledBy !== undefined) element.setAttribute('aria-labelledby', descriptor.ariaLabelledBy);
  element.dataset.width = descriptor.width;
  element.dataset.size = descriptor.size;
  const choices = options.options;
  const choiceValues = choices.map((choice) => choice.value);
  const segments = choices.map((choice) => {
    const segment = createPressable(descriptor.optionClassName, choice.label);
    segment.dataset.value = choice.value;
    if (choice.icon) {
      choice.icon.setAttribute('aria-hidden', 'true');
      segment.prepend(choice.icon);
    }
    segment.setAttribute('role', descriptor.optionRole);
    segment.addEventListener('click', () => choose(choice.value));
    return segment;
  });
  element.append(...segments);
  let current = options.value;

  const paint = () => {
    const states = segmentedOptionStates(choiceValues, current);
    for (const [index, segment] of segments.entries()) {
      segment.setAttribute('aria-checked', states[index].ariaChecked);
      segment.tabIndex = states[index].tabIndex;
    }
  };

  const setValue = (value: V) => {
    current = value;
    paint();
  };

  const choose = (value: V) => {
    if (value === current) return;
    setValue(value);
    options.onChange(value);
  };

  const focus = () => {
    segments.find((segment) => segment.tabIndex === 0)?.focus();
  };

  element.addEventListener('keydown', (event) => {
    const nextValue = nextSegmentedValue(choiceValues, current, event.key);
    if (nextValue === null) return;
    event.preventDefault();
    choose(nextValue);
    focus();
  });

  paint();
  return { element, setValue, focus };
}
