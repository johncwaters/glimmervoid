type SwitchDescriptorInput = {
  label?: string;
  labelledBy?: string;
  checked: boolean;
  disabled?: boolean;
};

type SwitchDescriptor = {
  className: 'ui-switch';
  type: 'checkbox';
  role: 'switch';
  ariaLabel?: string;
  ariaLabelledBy?: string;
  checked: boolean;
  disabled: boolean;
};

export function switchDescriptor(input: SwitchDescriptorInput): SwitchDescriptor {
  return {
    className: 'ui-switch',
    type: 'checkbox',
    role: 'switch',
    ariaLabel: input.label,
    ariaLabelledBy: input.labelledBy,
    checked: input.checked,
    disabled: input.disabled ?? false,
  };
}
