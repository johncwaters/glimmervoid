import { el } from '../dom-helpers.ts';
import { setHoverTip } from '../hover-tip.ts';
import { fitTipLabel } from '../hover-tip-core.ts';
import type { TipLabel } from '../hover-tip-core.ts';
import { createLineIcon, MENU_ICON_PATH } from '../svg-dom.ts';
import { createPressable } from './pressable.ts';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet' | 'icon';
type ButtonSize = 'default' | 'small';

type OutlineState = 'idle' | 'pressed' | 'off' | 'attention';
type ToggledOutlineState = Extract<OutlineState, 'pressed' | 'off'>;

type LabelledButtonOptions = { variant: Exclude<ButtonVariant, 'icon'>; label: string; icon?: SVGElement };
type IconButtonOptions<Label extends string> = { variant: 'icon'; label: TipLabel<Label>; icon: SVGElement };
type OutlineIconOptions<Label extends string> = { variant: 'outline-icon'; label: TipLabel<Label>; icon: SVGElement };
type BuildButtonOptions = { variant: ButtonVariant | 'outline-icon'; label: string; icon?: SVGElement; hasHoverTip?: boolean } & CommonButtonOptions;

type CommonButtonOptions = {
  size?: ButtonSize;
  action?: string;
  shortcutKey?: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  hidden?: boolean;
};

type OutlineIconButtonOptions<Label extends string, State extends Exclude<OutlineState, 'idle'>> = Omit<OutlineIconOptions<Label>, 'variant'> & Omit<CommonButtonOptions, 'shortcutKey'> & {
  states: readonly ['idle', ...State[]];
};

export type OutlineIconButton<State extends Exclude<OutlineState, 'idle'>> = {
  readonly element: HTMLButtonElement;
  setState(state: 'idle' | State): void;
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

export function button(options: LabelledButtonOptions & CommonButtonOptions): HTMLButtonElement;
export function button<const Label extends string>(options: IconButtonOptions<Label> & CommonButtonOptions): HTMLButtonElement;
export function button(options: BuildButtonOptions): HTMLButtonElement {
  return buildButton(options);
}

export function menuButton(options: { label: string; action: string; onClick?: (event: MouseEvent) => void }): HTMLButtonElement {
  return buildButton({ variant: 'icon', size: 'small', label: options.label, icon: createLineIcon(MENU_ICON_PATH, '1.5'), action: options.action, onClick: options.onClick, hasHoverTip: false });
}

export function outlineIconButton<const Label extends string, const State extends Exclude<OutlineState, 'idle'>>(options: OutlineIconButtonOptions<Label, State>): OutlineIconButton<State> {
  const element = buildButton({ ...options, variant: 'outline-icon' });
  const declaredStates: readonly OutlineState[] = options.states;
  const isToggle = declaredStates.some((state) => isToggledState(state));
  const setState = (state: 'idle' | State) => {
    if (!declaredStates.includes(state)) return;
    element.dataset.outlineState = state;
    if (isToggle) element.setAttribute('aria-pressed', String(isToggledState(state)));
  };
  setState('idle');
  return { element, setState };
}

function isToggledState(state: OutlineState): state is ToggledOutlineState {
  return state === 'pressed' || state === 'off';
}

function buildButton(options: BuildButtonOptions): HTMLButtonElement {
  const element = createPressable('ui-button');
  element.dataset.variant = options.variant;
  element.dataset.size = options.size ?? 'default';
  if (options.action) element.dataset.action = options.action;
  if (options.icon) element.append(options.icon);
  if (options.variant === 'icon' || options.variant === 'outline-icon') {
    element.setAttribute('aria-label', options.label);
    if (options.hasHoverTip !== false) setHoverTip(element, fitTipLabel(options.label));
  }
  if (options.variant !== 'icon' && options.variant !== 'outline-icon') element.append(options.label);
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
