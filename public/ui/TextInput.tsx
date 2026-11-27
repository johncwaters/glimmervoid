import { createEffect, createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  CREDENTIAL_OPT_OUT_ATTRIBUTES,
  textAreaDescriptor,
  textInputDescriptor,
} from './text-input-core.ts';
import type { TextFieldCoreOptions, TextInputSize, TextInputType } from './text-input-core.ts';

type TextFieldEventProps = TextFieldCoreOptions & {
  onInput?: (value: string) => void;
  onChange?: (value: string) => void;
};

type TextInputProps = TextFieldEventProps & {
  type?: TextInputType;
  size?: TextInputSize;
  ref?: (element: HTMLInputElement) => void;
};

type TextAreaProps = TextFieldEventProps & {
  rows?: number;
  ref?: (element: HTMLTextAreaElement) => void;
};

export function TextInput(props: TextInputProps): JSX.Element {
  const [inputElement, setInputElement] = createSignal<HTMLInputElement | null>(null);
  const descriptor = createMemo(() => textInputDescriptor({
    id: props.id,
    placeholder: props.placeholder,
    label: props.label,
    labelledBy: props.labelledBy,
    spellcheck: props.spellcheck,
    disabled: props.disabled,
    type: props.type,
    size: props.size,
  }));

  createEffect(
    () => ({ element: inputElement(), spellcheck: descriptor().spellcheck }),
    ({ element, spellcheck }) => {
      if (!element) return;
      element.spellcheck = spellcheck;
    },
  );

  createEffect(
    () => ({ element: inputElement(), value: props.value }),
    ({ element, value }) => {
      if (!element || value === undefined) return;
      if (element.value !== value) element.value = value;
    },
  );

  return (
    <input
      ref={(element) => {
        setInputElement(element);
        element.spellcheck = descriptor().spellcheck;
        if (props.value !== undefined) element.value = props.value;
        props.ref?.(element);
      }}
      class={descriptor().className}
      type={descriptor().type}
      data-size={descriptor().size}
      autocomplete={descriptor().autocomplete}
      data-bwignore={descriptor().isCredentialOptOut ? CREDENTIAL_OPT_OUT_ATTRIBUTES['data-bwignore'] : undefined}
      data-1p-ignore={descriptor().isCredentialOptOut ? CREDENTIAL_OPT_OUT_ATTRIBUTES['data-1p-ignore'] : undefined}
      data-lpignore={descriptor().isCredentialOptOut ? CREDENTIAL_OPT_OUT_ATTRIBUTES['data-lpignore'] : undefined}
      data-form-type={descriptor().isCredentialOptOut ? CREDENTIAL_OPT_OUT_ATTRIBUTES['data-form-type'] : undefined}
      id={descriptor().id}
      placeholder={descriptor().placeholder}
      aria-label={descriptor().ariaLabel}
      aria-labelledby={descriptor().ariaLabelledBy}
      disabled={descriptor().disabled}
      onInput={(event) => props.onInput?.(event.currentTarget.value)}
      onChange={(event) => props.onChange?.(event.currentTarget.value)}
    />
  );
}

export function TextArea(props: TextAreaProps): JSX.Element {
  const [areaElement, setAreaElement] = createSignal<HTMLTextAreaElement | null>(null);
  const descriptor = createMemo(() => textAreaDescriptor({
    id: props.id,
    placeholder: props.placeholder,
    label: props.label,
    labelledBy: props.labelledBy,
    spellcheck: props.spellcheck,
    disabled: props.disabled,
    rows: props.rows,
  }));

  createEffect(
    () => ({ element: areaElement(), spellcheck: descriptor().spellcheck }),
    ({ element, spellcheck }) => {
      if (!element) return;
      if (spellcheck === undefined) {
        element.removeAttribute('spellcheck');
        return;
      }
      element.spellcheck = spellcheck;
    },
  );

  createEffect(
    () => ({ element: areaElement(), value: props.value }),
    ({ element, value }) => {
      if (!element || value === undefined) return;
      if (element.value !== value) element.value = value;
    },
  );

  return (
    <textarea
      ref={(element) => {
        setAreaElement(element);
        const spellcheck = descriptor().spellcheck;
        if (spellcheck !== undefined) element.spellcheck = spellcheck;
        if (props.value !== undefined) element.value = props.value;
        props.ref?.(element);
      }}
      class={descriptor().className}
      data-size={descriptor().size}
      rows={descriptor().rows}
      autocomplete={descriptor().autocomplete}
      id={descriptor().id}
      placeholder={descriptor().placeholder}
      aria-label={descriptor().ariaLabel}
      aria-labelledby={descriptor().ariaLabelledBy}
      disabled={descriptor().disabled}
      onInput={(event) => props.onInput?.(event.currentTarget.value)}
      onChange={(event) => props.onChange?.(event.currentTarget.value)}
    />
  );
}
