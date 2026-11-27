import { createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { switchDescriptor } from './switch-core.ts';

type SwitchName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

type SwitchProps = SwitchName & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

export function Switch(props: SwitchProps): JSX.Element {
  const descriptor = createMemo(() => switchDescriptor({
    label: props.label,
    labelledBy: props.labelledBy,
    checked: props.checked,
    disabled: props.disabled,
  }));

  return (
    <input
      class={descriptor().className}
      type={descriptor().type}
      role={descriptor().role}
      aria-label={descriptor().ariaLabel}
      aria-labelledby={descriptor().ariaLabelledBy}
      checked={descriptor().checked}
      disabled={descriptor().disabled}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}
