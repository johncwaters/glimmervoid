import { nextRovingIndex } from '../roving-keys-core.ts';
import { isModalOpen } from './modal-state.ts';
import { createPressable } from './pressable.ts';

type MenuItemTone = 'neutral' | 'warning' | 'danger';

export function buildMenuItem(label: string, className: string, { tone = 'neutral' }: { tone?: MenuItemTone } = {}) {
  const menuItem = createPressable(`popup-menu-item ${className}`, label);
  menuItem.setAttribute('role', 'menuitem');
  if (tone !== 'neutral') menuItem.dataset.tone = tone;
  return menuItem;
}

function isMenuArrowKey(event: KeyboardEvent) {
  return event.key === 'ArrowDown' || event.key === 'ArrowUp';
}

function focusAdjacentMenuItem(menuItems: readonly HTMLElement[], event: KeyboardEvent) {
  const focusedElement = document.activeElement;
  const focusedIndex = focusedElement instanceof HTMLElement ? menuItems.indexOf(focusedElement) : -1;
  const nextIndex = nextRovingIndex(event.key, focusedIndex, menuItems.length, 'vertical');
  if (nextIndex === null) return;
  menuItems[nextIndex].focus();
}

function isMenuJumpKey(event: KeyboardEvent) {
  return event.key === 'Home' || event.key === 'End';
}

function hasShortcutModifier(event: KeyboardEvent) {
  return event.metaKey || event.altKey || event.ctrlKey;
}

function isFocusLeaving(event: FocusEvent, menu: HTMLElement, trigger: HTMLElement) {
  const nextFocused = event.relatedTarget;
  if (!(nextFocused instanceof Node)) return false;
  return !menu.contains(nextFocused) && !trigger.contains(nextFocused);
}

function wirePopupMenuKeys({ trigger, menu, menuItems, isOpen, open, close, signal }: {
  trigger: HTMLElement;
  menu: HTMLElement;
  menuItems: () => HTMLElement[];
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  signal?: AbortSignal;
}) {
  function moveMenuFocus(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!isOpen()) open();
    focusAdjacentMenuItem(menuItems(), event);
  }
  trigger.addEventListener('keydown', (event) => {
    if (hasShortcutModifier(event) || !isMenuArrowKey(event)) return;
    moveMenuFocus(event);
  }, { signal });
  menu.addEventListener('keydown', (event) => {
    if (hasShortcutModifier(event)) return;
    if (!isMenuArrowKey(event) && !isMenuJumpKey(event)) return;
    moveMenuFocus(event);
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
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].filter((item) => item.checkVisibility());
}

function isMenuItemClick(event: MouseEvent) {
  return event.target instanceof Element && event.target.closest('[role^="menuitem"]') !== null;
}

export function popupMenu({ trigger, menu, onOpen, onClose, signal }: PopupMenuOptions): PopupMenu {
  const isOpen = () => !menu.hidden;
  const setOpen = (shouldOpen: boolean) => {
    menu.hidden = !shouldOpen;
    trigger.setAttribute('aria-expanded', String(shouldOpen));
  };
  const open = () => {
    if (isOpen()) return;
    onOpen?.();
    setOpen(true);
  };
  const close = () => {
    if (!isOpen()) return;
    setOpen(false);
    onClose?.();
  };
  const toggle = () => (isOpen() ? close() : open());
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
  wirePopupMenuKeys({ trigger, menu, menuItems: () => shownMenuItems(menu), isOpen, open, close, signal });
  return { open, close, toggle, isOpen };
}
