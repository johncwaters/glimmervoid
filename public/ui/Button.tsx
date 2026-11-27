import { Show, createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createLineIcon, MENU_ICON_PATH } from '../svg-dom.ts';
import {
  buttonDescriptor,
  linkButtonDescriptor,
  outlineIconStateAttributes,
} from './button-core.ts';
import type {
  ButtonSize,
  ButtonTextCase,
  ButtonVariant,
  IconVariant,
  OutlineState,
} from './button-core.ts';
import { Pressable } from './Pressable.tsx';

type CommonButtonProps = {
  size?: ButtonSize;
  textCase?: ButtonTextCase;
  action?: string;
  shortcutKey?: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  hidden?: boolean;
  class?: string;
  ariaLabel?: string;
  ref?: (element: HTMLButtonElement) => void;
};

type LabelledButtonProps = {
  variant: Exclude<ButtonVariant, IconVariant>;
  label: string;
  icon?: JSX.Element;
};

type IconButtonProps = {
  variant: Exclude<IconVariant, 'outline-icon'>;
  label: string;
  icon: JSX.Element;
};

type ButtonProps = (LabelledButtonProps | IconButtonProps) & CommonButtonProps;

type LinkButtonProps = {
  variant: Exclude<ButtonVariant, IconVariant>;
  label: string;
  href: string;
  size?: ButtonSize;
};

type MenuButtonProps = {
  label: string;
  action: string;
  onClick?: (event: MouseEvent) => void;
};

type OutlineIconButtonProps<State extends Exclude<OutlineState, 'idle'>> = Omit<CommonButtonProps, 'shortcutKey'> & {
  label: string;
  icon: JSX.Element;
  states: readonly ['idle', ...State[]];
  state?: 'idle' | State;
};

export function Button(props: ButtonProps): JSX.Element {
  const descriptor = createMemo(() => buttonDescriptor({
    variant: props.variant,
    label: props.label,
    size: props.size,
    textCase: props.textCase,
    action: props.action,
    shortcutKey: props.shortcutKey,
    disabled: props.disabled,
    hidden: props.hidden,
  }));

  const className = createMemo(() => (props.class ? `${descriptor().className} ${props.class}` : descriptor().className));

  return (
    <Pressable
      ref={props.ref}
      class={className()}
      data-variant={descriptor().variant}
      data-size={descriptor().size}
      data-text-case={descriptor().textCase}
      data-action={descriptor().action}
      aria-label={props.ariaLabel ?? descriptor().ariaLabel}
      aria-keyshortcuts={descriptor().ariaKeyShortcuts}
      disabled={descriptor().disabled}
      hidden={descriptor().hidden}
      onClick={(event) => props.onClick?.(event)}
    >
      {props.icon}
      {descriptor().visibleLabel}
      <Show when={descriptor().shortcutKey}>
        {(shortcutKey) => (
          <kbd
            class="ui-button-shortcut"
            ref={(element) => element.setAttribute('aria-hidden', 'true')}
          >
            {shortcutKey()}
          </kbd>
        )}
      </Show>
    </Pressable>
  );
}

export function LinkButton(props: LinkButtonProps): JSX.Element {
  const descriptor = createMemo(() => linkButtonDescriptor({
    variant: props.variant,
    label: props.label,
    href: props.href,
    size: props.size,
  }));

  return (
    <a
      class={descriptor().className}
      data-variant={descriptor().variant}
      data-size={descriptor().size}
      href={descriptor().href}
      target={descriptor().target}
      rel={descriptor().rel}
    >
      {descriptor().label}
    </a>
  );
}

export function MenuButton(props: MenuButtonProps): JSX.Element {
  return (
    <Button
      variant="icon"
      size="small"
      label={props.label}
      icon={createLineIcon(MENU_ICON_PATH, '1.5')}
      action={props.action}
      onClick={(event) => props.onClick?.(event)}
    />
  );
}

export function OutlineIconButton<const State extends Exclude<OutlineState, 'idle'>>(
  props: OutlineIconButtonProps<State>,
): JSX.Element {
  const descriptor = createMemo(() => buttonDescriptor({
    variant: 'outline-icon',
    label: props.label,
    size: props.size,
    textCase: props.textCase,
    action: props.action,
    disabled: props.disabled,
    hidden: props.hidden,
  }));

  const stateAttributes = createMemo(() => outlineIconStateAttributes(props.states, props.state ?? 'idle'));
  const className = createMemo(() => (props.class ? `${descriptor().className} ${props.class}` : descriptor().className));

  return (
    <Pressable
      ref={props.ref}
      class={className()}
      data-variant={descriptor().variant}
      data-size={descriptor().size}
      data-text-case={descriptor().textCase}
      data-action={descriptor().action}
      data-outline-state={stateAttributes()?.outlineState}
      aria-label={props.ariaLabel ?? descriptor().ariaLabel}
      aria-pressed={stateAttributes()?.ariaPressed}
      disabled={descriptor().disabled}
      hidden={descriptor().hidden}
      onClick={(event) => props.onClick?.(event)}
    >
      {props.icon}
    </Pressable>
  );
}
