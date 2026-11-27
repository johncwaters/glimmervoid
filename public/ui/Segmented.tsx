import { For, createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { nextSegmentedValue, segmentedDescriptor, segmentedOptionStates } from './segmented-core.ts';
import type { SegmentedSize, SegmentedWidth } from './segmented-core.ts';
import { Pressable } from './Pressable.tsx';

type SegmentedChoice<V extends string> = {
  readonly value: V;
  readonly label: string;
  readonly icon?: SVGElement;
};

type SegmentedName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

type SegmentedProps<V extends string> = SegmentedName & {
  options: readonly SegmentedChoice<V>[];
  value: V;
  onChange: (value: V) => void;
  width?: SegmentedWidth;
  size?: SegmentedSize;
};

export function Segmented<const V extends string>(props: SegmentedProps<V>): JSX.Element {
  const segmentRefs = new Map<V, HTMLButtonElement>();
  const descriptor = createMemo(() => segmentedDescriptor({
    label: props.label,
    labelledBy: props.labelledBy,
    width: props.width,
    size: props.size,
  }));

  const stateByValue = createMemo(() => {
    const values = props.options.map((choice) => choice.value);
    const states = segmentedOptionStates(values, props.value);
    return new Map(states.map((state) => [state.value, state]));
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    const values = props.options.map((choice) => choice.value);
    const nextValue = nextSegmentedValue(values, props.value, event.key);
    if (nextValue === null) return;
    event.preventDefault();
    if (nextValue !== props.value) props.onChange(nextValue);
    segmentRefs.get(nextValue)?.focus();
  };

  const prepareIcon = (icon: SVGElement | undefined): SVGElement | undefined => {
    if (!icon) return undefined;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  };

  return (
    <div
      class={descriptor().className}
      role="radiogroup"
      aria-label={descriptor().ariaLabel}
      aria-labelledby={descriptor().ariaLabelledBy}
      data-width={descriptor().width}
      data-size={descriptor().size}
      onKeyDown={handleKeyDown}
    >
      <For each={props.options}>
        {(choice) => {
          const optionState = createMemo(() => stateByValue().get(choice.value));
          return (
            <Pressable
              ref={(element) => { segmentRefs.set(choice.value, element); }}
              class={descriptor().optionClassName}
              role={descriptor().optionRole}
              data-value={choice.value}
              aria-checked={optionState()?.ariaChecked}
              tabindex={optionState()?.tabIndex}
              onClick={() => {
                if (choice.value !== props.value) props.onChange(choice.value);
              }}
            >
              {prepareIcon(choice.icon)}
              {choice.label}
            </Pressable>
          );
        }}
      </For>
    </div>
  );
}
