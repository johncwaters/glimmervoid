import { el } from '../dom-helpers.ts';
import { createLineIcon, MENU_ICON_PATH } from '../svg-dom.ts';
import {
  buttonDescriptor,
  linkButtonDescriptor,
  outlineIconStateAttributes,
} from './button-core.ts';
import type {
  ButtonShape,
  ButtonSize,
  ButtonVariant,
  IconVariant,
  OutlineState,
} from './button-core.ts';
import { createPressable } from './pressable.ts';

type LabelledButtonOptions = { variant: Exclude<ButtonVariant, IconVariant>; label: string; icon?: SVGElement };
type IconButtonOptions = { variant: Exclude<IconVariant, 'outline-icon'>; label: string; icon: SVGElement };
type OutlineIconOptions = { variant: 'outline-icon'; label: string; icon: SVGElement };
type BuildButtonOptions = { variant: ButtonVariant | 'outline-icon'; label: string; icon?: SVGElement } & CommonButtonOptions;

type CommonButtonOptions = {
  size?: ButtonSize;
  textCase?: 'upper' | 'sentence' | 'inline';
  shape?: ButtonShape;
  action?: string;
  shortcutKey?: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  hidden?: boolean;
};

type OutlineIconButtonOptions<State extends Exclude<OutlineState, 'idle'>> = Omit<OutlineIconOptions, 'variant'> & Omit<CommonButtonOptions, 'shortcutKey'> & {
  states: readonly ['idle', ...State[]];
};

export type OutlineIconButton<State extends Exclude<OutlineState, 'idle'>> = {
  readonly element: HTMLButtonElement;
  setState(state: 'idle' | State): void;
};

type LinkButtonOptions = { variant: Exclude<ButtonVariant, IconVariant>; label: string; href: string; size?: ButtonSize };

export function linkButton(options: LinkButtonOptions): HTMLAnchorElement {
  const descriptor = linkButtonDescriptor(options);
  const element = el('a', descriptor.className, descriptor.label);
  element.dataset.variant = descriptor.variant;
  element.dataset.size = descriptor.size;
  element.href = descriptor.href;
  element.target = descriptor.target;
  element.rel = descriptor.rel;
  return element;
}

export function button(options: (LabelledButtonOptions | IconButtonOptions) & CommonButtonOptions): HTMLButtonElement {
  return buildButton(options);
}

export function menuButton(options: { label: string; action: string; onClick?: (event: MouseEvent) => void }): HTMLButtonElement {
  return buildButton({ variant: 'icon', size: 'small', label: options.label, icon: createLineIcon(MENU_ICON_PATH, '1.5'), action: options.action, onClick: options.onClick });
}

export function outlineIconButton<const State extends Exclude<OutlineState, 'idle'>>(options: OutlineIconButtonOptions<State>): OutlineIconButton<State> {
  const element = buildButton({ ...options, variant: 'outline-icon' });
  const declaredStates: readonly OutlineState[] = options.states;
  const setState = (state: 'idle' | State) => {
    const attributes = outlineIconStateAttributes(declaredStates, state);
    if (!attributes) return;
    element.dataset.outlineState = attributes.outlineState;
    if (attributes.ariaPressed !== undefined) element.setAttribute('aria-pressed', attributes.ariaPressed);
  };
  setState('idle');
  return { element, setState };
}

function buildButton(options: BuildButtonOptions): HTMLButtonElement {
  const descriptor = buttonDescriptor(options);
  const element = createPressable(descriptor.className);
  element.dataset.variant = descriptor.variant;
  element.dataset.size = descriptor.size;
  if (descriptor.textCase !== undefined) element.dataset.textCase = descriptor.textCase;
  if (descriptor.shape !== undefined) element.dataset.shape = descriptor.shape;
  if (descriptor.action) element.dataset.action = descriptor.action;
  if (options.icon) element.append(options.icon);
  if (descriptor.ariaLabel !== undefined) element.setAttribute('aria-label', descriptor.ariaLabel);
  if (descriptor.visibleLabel !== undefined) element.append(descriptor.visibleLabel);
  if (descriptor.shortcutKey) appendShortcutKey(element, descriptor.shortcutKey, descriptor.ariaKeyShortcuts);
  element.disabled = descriptor.disabled;
  element.hidden = descriptor.hidden;
  if (options.onClick) element.addEventListener('click', options.onClick);
  return element;
}

function appendShortcutKey(element: HTMLButtonElement, shortcutKey: string, ariaKeyShortcuts = shortcutKey) {
  const keyCap = el('kbd', 'ui-button-shortcut', shortcutKey);
  keyCap.setAttribute('aria-hidden', 'true');
  element.append(keyCap);
  element.setAttribute('aria-keyshortcuts', ariaKeyShortcuts);
}
