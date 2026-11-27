export type SegmentedWidth = 'auto' | 'fill';
export type SegmentedSize = 'default' | 'small';

type SegmentedDescriptorInput = {
  label?: string;
  labelledBy?: string;
  width?: SegmentedWidth;
  size?: SegmentedSize;
};

type SegmentedDescriptor = {
  className: 'ui-segmented';
  optionClassName: 'ui-segmented-option';
  role: 'radiogroup';
  optionRole: 'radio';
  width: SegmentedWidth;
  size: SegmentedSize;
  ariaLabel?: string;
  ariaLabelledBy?: string;
};

type SegmentedOptionState<V extends string> = {
  readonly value: V;
  readonly ariaChecked: 'true' | 'false';
  readonly tabIndex: 0 | -1;
};

const STEP_BY_KEY: Readonly<Record<string, number>> = Object.freeze({
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
});

export function segmentedDescriptor(input: SegmentedDescriptorInput): SegmentedDescriptor {
  return {
    className: 'ui-segmented',
    optionClassName: 'ui-segmented-option',
    role: 'radiogroup',
    optionRole: 'radio',
    width: input.width ?? 'auto',
    size: input.size ?? 'default',
    ariaLabel: input.label,
    ariaLabelledBy: input.labelledBy,
  };
}

export function segmentedOptionStates<V extends string>(
  values: readonly V[],
  current: V,
): SegmentedOptionState<V>[] {
  const selectedIndex = values.indexOf(current);
  const focusIndex = Math.max(0, selectedIndex);
  return values.map((value, index) => ({
    value,
    ariaChecked: index === selectedIndex ? 'true' : 'false',
    tabIndex: index === focusIndex ? 0 : -1,
  }));
}

export function nextSegmentedValue<V extends string>(
  values: readonly V[],
  current: V,
  key: string,
): V | null {
  const step = STEP_BY_KEY[key];
  if (!step || values.length === 0) return null;
  const currentIndex = Math.max(0, values.indexOf(current));
  return values[(currentIndex + step + values.length) % values.length];
}
