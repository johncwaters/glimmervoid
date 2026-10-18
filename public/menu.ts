import { el } from './dom-helpers.ts';

export function buildMenuItem(label: string, hint: string, className: string) {
  const button = el('button', `popup-menu-item ${className}`);
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.setAttribute('aria-label', label);
  button.append(el('span', 'popup-menu-item-label', label), el('span', 'popup-menu-item-hint', hint));
  return button;
}

export function isMenuArrowKey(event: KeyboardEvent) {
  return event.key === 'ArrowDown' || event.key === 'ArrowUp';
}

export function focusAdjacentMenuItem(menuItems: readonly HTMLElement[], event: KeyboardEvent) {
  const focusedElement = document.activeElement;
  const focusedIndex = focusedElement instanceof HTMLElement ? menuItems.indexOf(focusedElement) : -1;
  const nextIndex = event.key === 'ArrowDown' ? focusedIndex + 1 : focusedIndex < 0 ? menuItems.length - 1 : focusedIndex - 1;
  menuItems[(nextIndex + menuItems.length) % menuItems.length]?.focus();
}
