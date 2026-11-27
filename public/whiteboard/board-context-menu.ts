import { el } from '../dom-helpers.ts';
import { buildMenuItem } from '../ui/popup-menu.ts';
import { nextRovingIndex } from '../roving-keys-core.ts';

interface ContextMenuItem {
  label: string;
  shortcut: string | null;
  tone?: 'danger';
  run: () => void;
}

export type ContextMenuGroup = readonly ContextMenuItem[];

export interface BoardContextMenu {
  openAt(clientX: number, clientY: number, groups: readonly ContextMenuGroup[]): void;
  close(): void;
  isOpen(): boolean;
}

const MENU_EDGE_GAP_PX = 8;

function menuItemOf(item: ContextMenuItem, choose: (item: ContextMenuItem) => void): HTMLElement {
  const menuItem = buildMenuItem(item.label, 'wb-context-item', { tone: item.tone });
  if (item.shortcut) {
    const shortcut = el('span', 'wb-context-shortcut');
    shortcut.textContent = item.shortcut;
    shortcut.setAttribute('aria-hidden', 'true');
    menuItem.append(shortcut);
    menuItem.setAttribute('aria-keyshortcuts', item.shortcut.replaceAll(' ', ''));
  }
  menuItem.addEventListener('click', () => choose(item));
  return menuItem;
}

export function createBoardContextMenu(host: HTMLElement, returnFocusTo: HTMLElement): BoardContextMenu {
  const menu = el('div', 'popup-menu wb-context-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Board actions');
  menu.hidden = true;
  host.append(menu);
  const menuItems = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const isOpen = () => !menu.hidden;
  const close = () => {
    if (!isOpen()) return;
    menu.hidden = true;
    menu.replaceChildren();
  };
  const choose = (item: ContextMenuItem) => {
    close();
    returnFocusTo.focus();
    item.run();
  };
  const openAt = (clientX: number, clientY: number, groups: readonly ContextMenuGroup[]) => {
    const filledGroups = groups.filter((group) => group.length > 0);
    if (filledGroups.length === 0) return;
    menu.replaceChildren(...filledGroups.flatMap((group, index) => {
      const items = group.map((item) => menuItemOf(item, choose));
      if (index === 0) return items;
      const separator = el('div', 'wb-context-separator');
      separator.setAttribute('role', 'separator');
      return [separator, ...items];
    }));
    menu.hidden = false;
    const hostRect = host.getBoundingClientRect();
    const left = Math.min(clientX - hostRect.left, hostRect.width - menu.offsetWidth - MENU_EDGE_GAP_PX);
    const top = Math.min(clientY - hostRect.top, hostRect.height - menu.offsetHeight - MENU_EDGE_GAP_PX);
    menu.style.left = `${Math.max(MENU_EDGE_GAP_PX, left)}px`;
    menu.style.top = `${Math.max(MENU_EDGE_GAP_PX, top)}px`;
    menuItems()[0]?.focus();
  };
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      returnFocusTo.focus();
      return;
    }
    const items = menuItems();
    const focusedIndex = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
    const nextIndex = nextRovingIndex(event.key, focusedIndex, items.length, 'vertical');
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  });
  menu.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && menu.contains(event.relatedTarget)) return;
    close();
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    close();
  }, { capture: true });
  return { openAt, close, isOpen };
}
