import { el } from '../dom-helpers.ts';
import { installHoverTips } from '../hover-tip.ts';
import { createPressable } from './pressable.ts';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet' | 'icon';
type ButtonSize = 'default' | 'small';

type LabelledButtonOptions = { variant: Exclude<ButtonVariant, 'icon'>; label: string; icon?: SVGElement };
type IconButtonOptions = { variant: 'icon'; label: string; icon: SVGElement };

type ButtonOptions = (LabelledButtonOptions | IconButtonOptions) & {
  size?: ButtonSize;
  action?: string;
  shortcutKey?: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  hidden?: boolean;
};

type LinkButtonOptions = { variant: Exclude<ButtonVariant, 'icon'>; label: string; href: string; size?: ButtonSize };

export function linkButton(options: LinkButtonOptions): HTMLAnchorElement {
  const element = el('a', 'ui-button', options.label);
  element.dataset.variant = options.variant;
  element.dataset.size = options.size ?? 'default';
  element.href = options.href;
  element.target = '_blank';
  element.rel = 'noopener';
  return element;
}

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
  if (options.shortcutKey) appendShortcutKey(element, options.shortcutKey);
  element.disabled = options.disabled ?? false;
  element.hidden = options.hidden ?? false;
  if (options.onClick) element.addEventListener('click', options.onClick);
  return element;
}

function appendShortcutKey(element: HTMLButtonElement, shortcutKey: string) {
  const keyCap = el('kbd', 'ui-button-shortcut', shortcutKey);
  keyCap.setAttribute('aria-hidden', 'true');
  element.append(keyCap);
  element.setAttribute('aria-keyshortcuts', shortcutKey);
}
