import { el } from '../dom-helpers.ts';
import { createPressable } from './pressable.ts';

type SegmentedChoice<V extends string> = { readonly value: V; readonly label: string };

type SegmentedName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

type SegmentedOptions<V extends string> = SegmentedName & {
  options: readonly SegmentedChoice<V>[];
  value: V;
  onChange: (value: V) => void;
  width?: 'auto' | 'fill';
  size?: 'default' | 'small';
};

export type Segmented<V extends string> = {
  readonly element: HTMLDivElement;
  setValue(value: V): void;
  focus(): void;
};

const STEP_BY_KEY: Readonly<Record<string, number>> = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });

export function segmented<const V extends string>(options: SegmentedOptions<V>): Segmented<V> {
  const element = el('div', 'ui-segmented');
  element.setAttribute('role', 'radiogroup');
  if (options.label !== undefined) element.setAttribute('aria-label', options.label);
  if (options.labelledBy !== undefined) element.setAttribute('aria-labelledby', options.labelledBy);
  element.dataset.width = options.width ?? 'auto';
  element.dataset.size = options.size ?? 'default';
  const choices = options.options;
  const segments = choices.map((choice) => {
    const segment = createPressable('ui-segmented-option', choice.label);
    segment.dataset.value = choice.value;
    segment.setAttribute('role', 'radio');
    segment.addEventListener('click', () => choose(choice.value));
    return segment;
  });
  element.append(...segments);
  let current = options.value;

  const paint = () => {
    const selectedIndex = choices.findIndex((choice) => choice.value === current);
    for (const [index, segment] of segments.entries()) {
      segment.setAttribute('aria-checked', String(index === selectedIndex));
      segment.tabIndex = index === Math.max(0, selectedIndex) ? 0 : -1;
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
    const step = STEP_BY_KEY[event.key];
    if (!step || choices.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, choices.findIndex((choice) => choice.value === current));
    choose(choices[(currentIndex + step + choices.length) % choices.length].value);
    focus();
  });

  paint();
  return { element, setValue, focus };
}
