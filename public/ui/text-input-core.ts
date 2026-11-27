export type TextInputType = 'text' | 'search' | 'number' | 'url' | 'password';
export type TextInputSize = 'default' | 'small';

export type TextFieldCoreOptions = {
  id?: string;
  value?: string;
  placeholder?: string;
  label?: string;
  labelledBy?: string;
  spellcheck?: boolean;
  disabled?: boolean;
};

type TextInputCoreOptions = TextFieldCoreOptions & {
  type?: TextInputType;
  size?: TextInputSize;
};

type TextAreaCoreOptions = TextFieldCoreOptions & {
  rows?: number;
};

type TextInputDescriptor = {
  readonly className: 'ui-input';
  readonly type: TextInputType;
  readonly size: TextInputSize;
  readonly autocomplete: 'off';
  readonly isCredentialOptOut: boolean;
  readonly spellcheck: boolean;
  readonly id?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly ariaLabelledBy?: string;
  readonly disabled: boolean;
};

type TextAreaDescriptor = {
  readonly className: 'ui-input';
  readonly size: 'default';
  readonly rows: number;
  readonly autocomplete: 'off';
  readonly spellcheck?: boolean;
  readonly id?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly ariaLabelledBy?: string;
  readonly disabled: boolean;
};

export const CREDENTIAL_OPT_OUT_ATTRIBUTES = Object.freeze({
  'data-bwignore': '',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-form-type': 'other',
});

export function textInputDescriptor(options: TextInputCoreOptions = {}): TextInputDescriptor {
  const type = options.type ?? 'text';
  return {
    className: 'ui-input',
    type,
    size: options.size ?? 'default',
    autocomplete: 'off',
    isCredentialOptOut: type !== 'password',
    spellcheck: options.spellcheck ?? false,
    ...(options.id ? { id: options.id } : {}),
    ...(options.value !== undefined ? { value: options.value } : {}),
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
    ...(options.label ? { ariaLabel: options.label } : {}),
    ...(options.labelledBy ? { ariaLabelledBy: options.labelledBy } : {}),
    disabled: options.disabled ?? false,
  };
}

export function textAreaDescriptor(options: TextAreaCoreOptions = {}): TextAreaDescriptor {
  return {
    className: 'ui-input',
    size: 'default',
    rows: options.rows ?? 3,
    autocomplete: 'off',
    ...(options.spellcheck !== undefined ? { spellcheck: options.spellcheck } : {}),
    ...(options.id ? { id: options.id } : {}),
    ...(options.value !== undefined ? { value: options.value } : {}),
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
    ...(options.label ? { ariaLabel: options.label } : {}),
    ...(options.labelledBy ? { ariaLabelledBy: options.labelledBy } : {}),
    disabled: options.disabled ?? false,
  };
}
