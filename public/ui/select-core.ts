export type SelectSize = 'default' | 'small';

export type SelectMissingValue = 'first' | 'blank';

export type SelectChoice<V extends string> = {
  readonly value: V;
  readonly label: string;
};

export type SelectSelection<V extends string> =
  | { readonly kind: 'value'; readonly value: V }
  | { readonly kind: 'blank' }
  | { readonly kind: 'default' };

type SelectDescriptorInput<V extends string> = {
  options: readonly SelectChoice<V>[];
  value?: V | null;
  missingValue?: SelectMissingValue;
  label?: string;
  labelledBy?: string;
  id?: string;
  size?: SelectSize;
  disabled?: boolean;
};

type SelectDescriptor<V extends string> = {
  className: 'ui-select';
  size: SelectSize;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  disabled: boolean;
  selection: SelectSelection<V>;
};

export function resolveSelectSelection<V extends string>(
  choices: readonly SelectChoice<V>[],
  value: V | null | undefined,
  missingValue?: SelectMissingValue,
): SelectSelection<V> {
  if (value == null) return { kind: 'default' };
  if (choices.some((choice) => choice.value === value)) return { kind: 'value', value };
  if (missingValue === 'blank') return { kind: 'blank' };
  return { kind: 'default' };
}

export function selectDescriptor<V extends string>(input: SelectDescriptorInput<V>): SelectDescriptor<V> {
  return {
    className: 'ui-select',
    size: input.size ?? 'default',
    id: input.id || undefined,
    ariaLabel: input.label || undefined,
    ariaLabelledBy: input.labelledBy || undefined,
    disabled: input.disabled ?? false,
    selection: resolveSelectSelection(input.options, input.value, input.missingValue),
  };
}

export function findSelectChoice<V extends string>(
  choices: readonly SelectChoice<V>[],
  rawValue: string,
): SelectChoice<V> | undefined {
  return choices.find((choice) => choice.value === rawValue);
}
