import { el } from './dom-helpers.ts';
import { nextRovingIndex } from './roving-keys-core.ts';
import { isModalOpen } from './session-card/modal.ts';

export function buildMenuItem(label: string, hint: string, className: string) {
  const button = el('button', `popup-menu-item ${className}`);
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.setAttribute('aria-label', label);
  button.append(el('span', 'popup-menu-item-label', label), el('span', 'popup-menu-item-hint', hint));
  return button;
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

export function wirePopupMenuKeys({ trigger, menu, menuItems, isOpen, open, close, signal }: {
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
