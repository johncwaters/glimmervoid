export type ChoiceType = 'checkbox' | 'radio';

type ChoiceDescriptorInput = {
  type: ChoiceType;
  checked?: boolean;
  disabled?: boolean;
  value?: string;
  name?: string;
  accessibleName?: string;
  hint?: string;
  hintId?: string;
};

type ChoiceDescriptor = {
  className: 'ui-checkbox';
  inputClassName: 'ui-checkbox-input';
  textClassName: 'ui-checkbox-text';
  hintClassName: 'ui-checkbox-hint';
  type: ChoiceType;
  checked: boolean;
  disabled: boolean;
  value?: string;
  name?: string;
  ariaLabel?: string;
  hintText?: string;
  hintId?: string;
  ariaDescribedBy?: string;
};

export function choiceDescriptor(input: ChoiceDescriptorInput): ChoiceDescriptor {
  const hasHint = Boolean(input.hint);
  return {
    className: 'ui-checkbox',
    inputClassName: 'ui-checkbox-input',
    textClassName: 'ui-checkbox-text',
    hintClassName: 'ui-checkbox-hint',
    type: input.type,
    checked: input.checked ?? false,
    disabled: input.disabled ?? false,
    value: input.value,
    name: input.name,
    ariaLabel: input.accessibleName || undefined,
    hintText: hasHint ? input.hint : undefined,
    hintId: hasHint ? input.hintId : undefined,
    ariaDescribedBy: hasHint ? input.hintId : undefined,
  };
}
