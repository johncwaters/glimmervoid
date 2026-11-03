import { installHoverTips } from '../hover-tip.ts';
import { createPressable } from './pressable.ts';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet' | 'icon';
type ButtonSize = 'default' | 'small';

type LabelledButtonOptions = { variant: Exclude<ButtonVariant, 'icon'>; label: string; icon?: SVGElement };
type IconButtonOptions = { variant: 'icon'; label: string; icon: SVGElement };

type ButtonOptions = (LabelledButtonOptions | IconButtonOptions) & {
  size?: ButtonSize;
  action?: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  hidden?: boolean;
};

export function button(options: ButtonOptions): HTMLButtonElement {
  const element = createPressable('ui-button');
  element.dataset.variant = options.variant;
  element.dataset.size = options.size ?? 'default';
  if (options.action) element.dataset.action = options.action;
  if (options.icon) element.append(options.icon);
  if (options.variant === 'icon') {
    element.setAttribute('aria-label', options.label);
    element.dataset.tipLabel = options.label;
    installHoverTips();
  }
  if (options.variant !== 'icon') element.append(options.label);
  element.disabled = options.disabled ?? false;
  element.hidden = options.hidden ?? false;
  if (options.onClick) element.addEventListener('click', options.onClick);
  return element;
}
