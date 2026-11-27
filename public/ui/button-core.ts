export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet' | 'icon' | 'primary-icon' | 'floating-icon';
export type ButtonSize = 'default' | 'small' | 'large';
export type ButtonTextCase = 'upper' | 'sentence' | 'inline';
export type OutlineState = 'idle' | 'pressed' | 'off' | 'attention';
type ToggledOutlineState = Extract<OutlineState, 'pressed' | 'off'>;
export type IconVariant = 'icon' | 'primary-icon' | 'outline-icon' | 'floating-icon';

type ButtonCoreOptions = {
  variant: ButtonVariant | 'outline-icon';
  label: string;
  size?: ButtonSize;
  textCase?: ButtonTextCase;
  action?: string;
  shortcutKey?: string;
  disabled?: boolean;
  hidden?: boolean;
};

type ButtonDescriptor = {
  readonly className: 'ui-button';
  readonly variant: ButtonVariant | 'outline-icon';
  readonly size: ButtonSize;
  readonly textCase?: Exclude<ButtonTextCase, 'upper'>;
  readonly action?: string;
  readonly ariaLabel?: string;
  readonly visibleLabel?: string;
  readonly shortcutKey?: string;
  readonly ariaKeyShortcuts?: string;
  readonly disabled: boolean;
  readonly hidden: boolean;
};

type LinkButtonCoreOptions = {
  variant: Exclude<ButtonVariant, IconVariant>;
  label: string;
  href: string;
  size?: ButtonSize;
};

type LinkButtonDescriptor = {
  readonly className: 'ui-button';
  readonly variant: Exclude<ButtonVariant, IconVariant>;
  readonly size: ButtonSize;
  readonly label: string;
  readonly href: string;
  readonly target: '_blank';
  readonly rel: 'noopener';
};

type OutlineIconStateAttributes = {
  readonly outlineState: OutlineState;
  readonly ariaPressed?: 'true' | 'false';
};

export function isToggledOutlineState(state: OutlineState): state is ToggledOutlineState {
  return state === 'pressed' || state === 'off';
}

export function isIconButtonVariant(variant: ButtonVariant | 'outline-icon'): variant is IconVariant {
  return variant === 'icon' || variant === 'primary-icon' || variant === 'outline-icon' || variant === 'floating-icon';
}

export function buttonDescriptor(options: ButtonCoreOptions): ButtonDescriptor {
  const iconOnly = isIconButtonVariant(options.variant);
  return {
    className: 'ui-button',
    variant: options.variant,
    size: options.size ?? 'default',
    ...(options.textCase !== undefined && options.textCase !== 'upper' ? { textCase: options.textCase } : {}),
    ...(options.action ? { action: options.action } : {}),
    ...(iconOnly ? { ariaLabel: options.label } : { visibleLabel: options.label }),
    ...(options.shortcutKey ? { shortcutKey: options.shortcutKey, ariaKeyShortcuts: options.shortcutKey } : {}),
    disabled: options.disabled ?? false,
    hidden: options.hidden ?? false,
  };
}

export function linkButtonDescriptor(options: LinkButtonCoreOptions): LinkButtonDescriptor {
  return {
    className: 'ui-button',
    variant: options.variant,
    size: options.size ?? 'default',
    label: options.label,
    href: options.href,
    target: '_blank',
    rel: 'noopener',
  };
}

export function outlineIconStateAttributes(
  declaredStates: readonly OutlineState[],
  state: OutlineState,
): OutlineIconStateAttributes | null {
  if (!declaredStates.includes(state)) return null;
  const isToggle = declaredStates.some((declared) => isToggledOutlineState(declared));
  if (!isToggle) return { outlineState: state };
  return { outlineState: state, ariaPressed: isToggledOutlineState(state) ? 'true' : 'false' };
}
