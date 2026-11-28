import { isModalOpen } from './modal-state.ts';
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
import { createPressable } from './pressable.ts';

export function buildMenuItem(
  label: string,
  className: string,
  { tone = 'neutral', role, checked }: { tone?: MenuItemTone; role?: MenuItemRole; checked?: boolean } = {},
) {
  const descriptor = menuItemDescriptor({ label, className, tone, role, checked });
  const menuItem = createPressable(descriptor.className, descriptor.label);
  menuItem.setAttribute('role', descriptor.role);
  if (descriptor.ariaChecked !== undefined) menuItem.setAttribute('aria-checked', descriptor.ariaChecked);
  if (descriptor.tone !== null) menuItem.dataset.tone = descriptor.tone;
  return menuItem;
}

function focusAdjacentMenuItem(menuItems: readonly HTMLElement[], event: KeyboardEvent) {
  const focusedElement = document.activeElement;
  const focusedIndex = focusedElement instanceof HTMLElement ? menuItems.indexOf(focusedElement) : -1;
  const nextIndex = nextMenuItemIndex(event.key, focusedIndex, menuItems.length);
  if (nextIndex === null) return;
  menuItems[nextIndex].focus();
}

function hasShortcutModifier(event: KeyboardEvent) {
  return event.metaKey || event.altKey || event.ctrlKey;
}

function isFocusLeaving(event: FocusEvent, menu: HTMLElement, trigger: HTMLElement) {
  const nextFocused = event.relatedTarget;
  if (!(nextFocused instanceof Node)) return false;
  return !menu.contains(nextFocused) && !trigger.contains(nextFocused);
}

function wirePopupMenuKeys({ trigger, menu, menuItems, isOpen, open, close, resetTypeahead, onTypeahead, signal }: {
  trigger: HTMLElement;
  menu: HTMLElement;
  menuItems: () => HTMLElement[];
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  resetTypeahead: () => void;
  onTypeahead: (event: KeyboardEvent, items: readonly HTMLElement[]) => void;
  signal?: AbortSignal;
}) {
  function moveMenuFocus(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    resetTypeahead();
    if (!isOpen()) open();
    focusAdjacentMenuItem(menuItems(), event);
  }
  trigger.addEventListener('keydown', (event) => {
    const hasModifier = hasShortcutModifier(event);
    if (hasModifier) return;
    if (isMenuArrowKey(event.key)) {
      moveMenuFocus(event);
      return;
    }
    if (!isOpen()) return;
    if (isMenuJumpKey(event.key)) {
      moveMenuFocus(event);
      return;
    }
    if (!isTypeaheadKey(event.key, hasModifier)) return;
    onTypeahead(event, menuItems());
  }, { signal });
  menu.addEventListener('keydown', (event) => {
    const hasModifier = hasShortcutModifier(event);
    if (hasModifier) return;
    if (isMenuArrowKey(event.key) || isMenuJumpKey(event.key)) {
      moveMenuFocus(event);
      return;
    }
    if (!isTypeaheadKey(event.key, hasModifier)) return;
    onTypeahead(event, menuItems());
  }, { signal });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !isOpen() || isModalOpen()) return;
    event.preventDefault();
    close();
    trigger.focus();
  }, { signal });
  for (const scope of [trigger, menu]) {
    scope.addEventListener('focusout', (event) => {
      if (!isOpen() || !isFocusLeaving(event, menu, trigger)) return;
      close();
    }, { signal });
  }
}

type PopupMenuOptions = {
  trigger: HTMLElement;
  menu: HTMLElement;
  onOpen?: () => void;
  onClose?: () => void;
  signal?: AbortSignal;
};

export type PopupMenu = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
};

function shownMenuItems(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((item) => {
    if (item instanceof HTMLButtonElement && item.disabled) return false;
    if (item.getAttribute('aria-disabled') === 'true') return false;
    return item.checkVisibility();
  });
}

function isMenuItemClick(event: MouseEvent) {
  return event.target instanceof Element && event.target.closest('[role^="menuitem"]') !== null;
}

export function popupMenu({ trigger, menu, onOpen, onClose, signal }: PopupMenuOptions): PopupMenu {
  let typeaheadQuery = '';
  let lastTypeaheadAt = 0;
  const resetTypeahead = () => {
    typeaheadQuery = '';
    lastTypeaheadAt = 0;
  };
  const isOpen = () => !menu.hidden;
  const setOpen = (shouldOpen: boolean) => {
    const state = popupMenuStateAttributes(shouldOpen);
    menu.hidden = state.hidden;
    menu.dataset.state = state.dataState;
    trigger.setAttribute('aria-expanded', state.ariaExpanded);
  };
  const open = () => {
    if (isOpen()) return;
    resetTypeahead();
    onOpen?.();
    setOpen(true);
  };
  const close = () => {
    if (!isOpen()) return;
    resetTypeahead();
    setOpen(false);
    onClose?.();
  };
  const toggle = () => (isOpen() ? close() : open());
  const onTypeahead = (event: KeyboardEvent, items: readonly HTMLElement[]) => {
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
  menu.classList.add('popup-menu');
  menu.setAttribute('role', 'menu');
  setOpen(false);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.addEventListener('click', toggle, { signal });
  menu.addEventListener('click', (event) => {
    if (isMenuItemClick(event)) close();
  }, { signal });
  document.addEventListener('click', (event) => {
    if (!isOpen() || !(event.target instanceof Node)) return;
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    close();
  }, { signal });
  wirePopupMenuKeys({ trigger, menu, menuItems: () => shownMenuItems(menu), isOpen, open, close, resetTypeahead, onTypeahead, signal });
  return { open, close, toggle, isOpen };
}
