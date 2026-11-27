import { For, createEffect, createMemo, createSignal, createUniqueId, flush, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Pressable } from './Pressable.tsx';
import {
  findTypeaheadIndex,
  isMenuArrowKey,
  isMenuJumpKey,
  isTypeaheadKey,
  menuItemDescriptor,
  nextMenuItemIndex,
  nextTypeaheadQuery,
  popupMenuStateAttributes,
} from './popup-menu-core.ts';
import type { MenuItemRole, MenuItemTone } from './popup-menu-core.ts';

type PopupMenuItemConfig = {
  id: string;
  label: string;
  className?: string;
  tone?: MenuItemTone;
  role?: MenuItemRole;
  checked?: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  onSelect: () => void;
};

type PopupMenuProps = {
  id?: string;
  triggerLabel: string;
  triggerClass?: string;
  triggerAction?: string;
  menuLabel?: string;
  menuClass?: string;
  wrapClass?: string;
  items: readonly PopupMenuItemConfig[];
  onOpen?: () => void;
  onClose?: () => void;
};

function visibleMenuItemsIn(menuElement: HTMLElement): HTMLElement[] {
  return [...menuElement.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((item) => {
    if (item instanceof HTMLButtonElement && item.disabled) return false;
    if (item.getAttribute('aria-disabled') === 'true') return false;
    return item.checkVisibility();
  });
}

function hasShortcutModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.altKey || event.ctrlKey;
}

export function PopupMenu(props: PopupMenuProps): JSX.Element {
  const generatedId = createUniqueId();
  const menuId = createMemo(() => props.id ?? `popup-menu-${generatedId}`);
  const [isOpen, setIsOpen] = createSignal(false);
  const state = createMemo(() => popupMenuStateAttributes(isOpen()));
  const menuClassName = createMemo(() => (props.menuClass ? `popup-menu ${props.menuClass}` : 'popup-menu'));

  let triggerElement: HTMLButtonElement | undefined;
  let menuElement: HTMLDivElement | undefined;
  let typeaheadQuery = '';
  let lastTypeaheadAt = 0;
  let shouldReturnFocus = false;

  const resetTypeahead = () => {
    typeaheadQuery = '';
    lastTypeaheadAt = 0;
  };

  const openPopover = () => {
    if (!menuElement) return;
    if (menuElement.matches(':popover-open')) return;
    menuElement.hidden = false;
    menuElement.showPopover();
  };

  const closePopover = (returnFocus: boolean) => {
    if (!menuElement) return;
    if (!menuElement.matches(':popover-open')) return;
    shouldReturnFocus = returnFocus;
    menuElement.hidePopover();
  };

  const focusMenuItemByKey = (key: string) => {
    if (!menuElement) return;
    const items = visibleMenuItemsIn(menuElement);
    const focusedElement = document.activeElement;
    const focusedIndex = focusedElement instanceof HTMLElement ? items.indexOf(focusedElement) : -1;
    const nextIndex = nextMenuItemIndex(key, focusedIndex, items.length);
    if (nextIndex === null) return;
    items[nextIndex].focus();
  };

  const handleTypeaheadKeyDown = (event: KeyboardEvent) => {
    if (!menuElement) return;
    const items = visibleMenuItemsIn(menuElement);
    const elapsedMs = lastTypeaheadAt > 0 ? event.timeStamp - lastTypeaheadAt : Number.POSITIVE_INFINITY;
    typeaheadQuery = nextTypeaheadQuery(typeaheadQuery, event.key, elapsedMs);
    lastTypeaheadAt = event.timeStamp;
    const focusedElement = document.activeElement;
    const focusedIndex = focusedElement instanceof HTMLElement ? items.indexOf(focusedElement) : -1;
    const matchedIndex = findTypeaheadIndex(items.map((item) => item.textContent ?? ''), typeaheadQuery, focusedIndex);
    if (matchedIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    items[matchedIndex].focus();
  };

  const handleTriggerKeyDown = (event: KeyboardEvent) => {
    const hasModifier = hasShortcutModifier(event);
    if (hasModifier) return;
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closePopover(true);
      return;
    }
    if (isMenuArrowKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      openPopover();
      focusMenuItemByKey(event.key);
      return;
    }
    if (!isOpen()) return;
    if (isMenuJumpKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      focusMenuItemByKey(event.key);
      return;
    }
    if (!isTypeaheadKey(event.key, hasModifier)) return;
    handleTypeaheadKeyDown(event);
  };

  const handleMenuKeyDown = (event: KeyboardEvent) => {
    const hasModifier = hasShortcutModifier(event);
    if (hasModifier) return;
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closePopover(true);
      return;
    }
    if (isMenuArrowKey(event.key) || isMenuJumpKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      focusMenuItemByKey(event.key);
      return;
    }
    if (!isTypeaheadKey(event.key, hasModifier)) return;
    handleTypeaheadKeyDown(event);
  };

  const handleFocusOut = (event: FocusEvent) => {
    if (!isOpen() || !menuElement || !triggerElement) return;
    const nextFocused = event.relatedTarget;
    if (!(nextFocused instanceof Node)) return;
    if (menuElement.contains(nextFocused) || triggerElement.contains(nextFocused)) return;
    closePopover(false);
  };

  const handleItemClick = (item: PopupMenuItemConfig) => {
    if (!item.keepOpen) closePopover(true);
    item.onSelect();
  };

  const attachTrigger = (element: HTMLButtonElement) => {
    triggerElement = element;
    element.setAttribute('popovertarget', menuId());
    element.setAttribute('popovertargetaction', 'toggle');
  };

  createEffect(
    () => menuId(),
    (id) => {
      triggerElement?.setAttribute('popovertarget', id);
    },
  );

  const attachMenu = (element: HTMLDivElement) => {
    menuElement = element;
    element.setAttribute('popover', 'auto');
  };

  onSettled(() => {
    if (!menuElement) return;
    const element = menuElement;
    const controller = new AbortController();
    element.addEventListener('beforetoggle', (event) => {
      const toggleEvent = event as ToggleEvent;
      if (toggleEvent.newState === 'open') {
        shouldReturnFocus = false;
        element.hidden = false;
        resetTypeahead();
        setIsOpen(true);
        flush();
        props.onOpen?.();
        return;
      }
      if (toggleEvent.newState !== 'closed') return;
      element.hidden = true;
      resetTypeahead();
      setIsOpen(false);
      flush();
      props.onClose?.();
      if (!shouldReturnFocus) return;
      shouldReturnFocus = false;
      triggerElement?.focus();
    }, { signal: controller.signal });
    element.addEventListener('toggle', (event) => {
      const toggleEvent = event as ToggleEvent;
      if (toggleEvent.newState !== 'closed') return;
      if (!shouldReturnFocus) return;
      shouldReturnFocus = false;
      triggerElement?.focus();
    }, { signal: controller.signal });
    return () => controller.abort();
  });

  return (
    <div class={props.wrapClass ?? 'session-overflow'}>
      <Pressable
        ref={attachTrigger}
        class={props.triggerClass ?? 'ui-button'}
        text={props.triggerLabel}
        data-action={props.triggerAction}
        aria-haspopup="menu"
        aria-expanded={state().ariaExpanded}
        aria-controls={menuId()}
        onKeyDown={handleTriggerKeyDown}
        onFocusOut={handleFocusOut}
      />
      <div
        ref={attachMenu}
        id={menuId()}
        role="menu"
        aria-label={props.menuLabel}
        class={menuClassName()}
        hidden={state().hidden}
        data-state={state().dataState}
        onKeyDown={handleMenuKeyDown}
        onFocusOut={handleFocusOut}
      >
        <For each={props.items}>
          {(item) => {
            const descriptor = createMemo(() => menuItemDescriptor({
              label: item.label,
              className: item.className,
              tone: item.tone,
              role: item.role,
              checked: item.checked,
            }));
            return (
              <Pressable
                class={descriptor().className}
                text={descriptor().label}
                role={descriptor().role}
                aria-checked={descriptor().ariaChecked}
                data-tone={descriptor().tone ?? undefined}
                data-menu-item={item.id}
                disabled={item.disabled}
                onClick={() => handleItemClick(item)}
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}
