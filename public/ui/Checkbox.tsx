import { Show, createEffect, createMemo, createSignal, createUniqueId } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { choiceDescriptor } from './checkbox-core.ts';

type CommonChoiceProps = {
  label: JSX.Element;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
  value?: string;
  accessibleName?: string;
};

type CheckboxProps = CommonChoiceProps & {
  onChange?: (checked: boolean) => void;
};

type RadioProps = CommonChoiceProps & {
  name: string;
  value: string;
  onSelect?: () => void;
};

export function Checkbox(props: CheckboxProps): JSX.Element {
  const hintId = `ui-checkbox-hint-${createUniqueId()}`;
  const [inputElement, setInputElement] = createSignal<HTMLInputElement | null>(null);
  const descriptor = createMemo(() => choiceDescriptor({
    type: 'checkbox',
    checked: props.checked,
    disabled: props.disabled,
    value: props.value,
    accessibleName: props.accessibleName,
    hint: props.hint,
    hintId,
  }));

  createEffect(
    () => ({ input: inputElement(), value: descriptor().value }),
    ({ input, value }) => {
      if (!input || value === undefined) return;
      input.value = value;
    },
  );

  return (
    <label class={descriptor().className} data-type={descriptor().type}>
      <input
        ref={(element) => {
          setInputElement(element);
          if (descriptor().value !== undefined) element.value = descriptor().value ?? '';
        }}
        class={descriptor().inputClassName}
        type={descriptor().type}
        checked={descriptor().checked}
        disabled={descriptor().disabled}
        aria-label={descriptor().ariaLabel}
        aria-describedby={descriptor().ariaDescribedBy}
        onChange={(event) => props.onChange?.(event.currentTarget.checked)}
      />
      <span class={descriptor().textClassName}>{props.label}</span>
      <Show when={descriptor().hintText}>
        {(hintText) => (
          <span class={descriptor().hintClassName} id={descriptor().hintId}>
            {hintText()}
          </span>
        )}
      </Show>
    </label>
  );
}

export function Radio(props: RadioProps): JSX.Element {
  const hintId = `ui-checkbox-hint-${createUniqueId()}`;
  const [inputElement, setInputElement] = createSignal<HTMLInputElement | null>(null);
  const descriptor = createMemo(() => choiceDescriptor({
    type: 'radio',
    checked: props.checked,
    disabled: props.disabled,
    value: props.value,
    name: props.name,
    accessibleName: props.accessibleName,
    hint: props.hint,
    hintId,
  }));

  createEffect(
    () => ({ input: inputElement(), value: descriptor().value }),
    ({ input, value }) => {
      if (!input || value === undefined) return;
      input.value = value;
    },
  );

  return (
    <label class={descriptor().className} data-type={descriptor().type}>
      <input
        ref={(element) => {
          setInputElement(element);
          if (descriptor().value !== undefined) element.value = descriptor().value ?? '';
        }}
        class={descriptor().inputClassName}
        type={descriptor().type}
        name={descriptor().name}
        checked={descriptor().checked}
        disabled={descriptor().disabled}
        aria-label={descriptor().ariaLabel}
        aria-describedby={descriptor().ariaDescribedBy}
        onChange={(event) => {
          if (event.currentTarget.checked) props.onSelect?.();
        }}
      />
      <span class={descriptor().textClassName}>{props.label}</span>
      <Show when={descriptor().hintText}>
        {(hintText) => (
          <span class={descriptor().hintClassName} id={descriptor().hintId}>
            {hintText()}
          </span>
        )}
      </Show>
    </label>
  );
}
