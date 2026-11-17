import { el } from '../dom-helpers.ts';

type SwitchName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

type SwitchOptions = SwitchName & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

export function switchInput(options: SwitchOptions): HTMLInputElement {
  const element = el('input', 'ui-switch');
  element.type = 'checkbox';
  element.setAttribute('role', 'switch');
  if (options.label !== undefined) element.setAttribute('aria-label', options.label);
  if (options.labelledBy !== undefined) element.setAttribute('aria-labelledby', options.labelledBy);
  element.checked = options.checked;
  element.disabled = options.disabled ?? false;
  element.addEventListener('change', () => options.onChange(element.checked));
  return element;
}
