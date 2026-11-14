import { el } from '../dom-helpers.ts';
import { buildMenuItem } from '../menu.ts';
import { nextRovingIndex } from '../roving-keys-core.ts';

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

export interface ArrangedRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ContextMenuItem {
  label: string;
  shortcut: string | null;
  run: () => void;
}

export type ContextMenuGroup = readonly ContextMenuItem[];

export interface BoardContextMenu {
  openAt(clientX: number, clientY: number, groups: readonly ContextMenuGroup[]): void;
  close(): void;
  isOpen(): boolean;
}

const MENU_EDGE_GAP_PX = 8;

function alignedXOf(rect: ArrangedRect, edge: AlignEdge, area: ArrangedRect): number {
  if (edge === 'left') return area.x;
  if (edge === 'center') return area.x + (area.width - rect.width) / 2;
  if (edge === 'right') return area.x + area.width - rect.width;
  return rect.x;
}

function alignedYOf(rect: ArrangedRect, edge: AlignEdge, area: ArrangedRect): number {
  if (edge === 'top') return area.y;
  if (edge === 'middle') return area.y + (area.height - rect.height) / 2;
  if (edge === 'bottom') return area.y + area.height - rect.height;
  return rect.y;
}

function areaOf(rects: readonly ArrangedRect[]): ArrangedRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { id: '', x: left, y: top, width: right - left, height: bottom - top };
}

export function alignedRectsOf(rects: readonly ArrangedRect[], edge: AlignEdge): ArrangedRect[] {
  if (rects.length < 2) return [...rects];
  const area = areaOf(rects);
  return rects.map((rect) => ({ ...rect, x: Math.round(alignedXOf(rect, edge, area)), y: Math.round(alignedYOf(rect, edge, area)) }));
}

export function distributedRectsOf(rects: readonly ArrangedRect[], axis: DistributeAxis): ArrangedRect[] {
  if (rects.length < 3) return [...rects];
  const isHorizontal = axis === 'horizontal';
  const startOf = (rect: ArrangedRect) => (isHorizontal ? rect.x : rect.y);
  const sizeOf = (rect: ArrangedRect) => (isHorizontal ? rect.width : rect.height);
  const ordered = [...rects].sort((first, second) => startOf(first) + sizeOf(first) / 2 - (startOf(second) + sizeOf(second) / 2));
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) return [...rects];
  const span = startOf(last) + sizeOf(last) - startOf(first);
  const gap = (span - ordered.reduce((total, rect) => total + sizeOf(rect), 0)) / (ordered.length - 1);
  const startById = new Map<string, number>();
  ordered.reduce((nextStart, rect) => {
    startById.set(rect.id, Math.round(nextStart));
    return nextStart + sizeOf(rect) + gap;
  }, startOf(first));
  return rects.map((rect) => {
    const start = startById.get(rect.id) ?? startOf(rect);
    return isHorizontal ? { ...rect, x: start } : { ...rect, y: start };
  });
}

function menuItemOf(item: ContextMenuItem, choose: (item: ContextMenuItem) => void): HTMLElement {
  const menuItem = buildMenuItem(item.label, 'wb-context-item');
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
