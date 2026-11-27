import { el } from '../dom-helpers.ts';
import { switchDescriptor } from './switch-core.ts';

type SwitchName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

type SwitchOptions = SwitchName & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

export function switchInput(options: SwitchOptions): HTMLInputElement {
  const descriptor = switchDescriptor({
    label: options.label,
    labelledBy: options.labelledBy,
    checked: options.checked,
    disabled: options.disabled,
  });
  const element = el('input', descriptor.className);
  element.type = descriptor.type;
  element.setAttribute('role', descriptor.role);
  if (descriptor.ariaLabel !== undefined) element.setAttribute('aria-label', descriptor.ariaLabel);
  if (descriptor.ariaLabelledBy !== undefined) element.setAttribute('aria-labelledby', descriptor.ariaLabelledBy);
  element.checked = descriptor.checked;
  element.disabled = descriptor.disabled;
  element.addEventListener('change', () => options.onChange(element.checked));
  return element;
}
