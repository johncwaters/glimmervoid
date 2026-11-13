import type { Pane } from '#shared/contracts/focus-layout.ts';
import { el } from '../dom-helpers.ts';
import { dropZoneAt } from './pane-layout-core.ts';
import type { DropZone } from './pane-layout-core.ts';

const UNEDITABLE_DRAG_TARGETS = 'input, textarea, select, button, [contenteditable="true"]';
const PANE_DRAG_MIME = 'application/x-glimmervoid-pane';

interface PaneWindowEvents {
  onDragStart: (pane: Pane) => void;
  onDragEnd: () => void;
  canAcceptDrop: (targetPane: Pane, event: DragEvent) => boolean;
  onDrop: (targetPane: Pane, zone: DropZone, event: DragEvent) => void;
}

export interface PaneWindow {
  pane: Pane;
  element: HTMLElement;
  header: HTMLElement;
  titleSlot: HTMLElement;
  trailSlot: HTMLElement;
  body: HTMLElement;
  clearDropZone: () => void;
}

export function createPaneWindow(pane: Pane, events: PaneWindowEvents): PaneWindow {
  const element = el('section', 'pane-group');
  element.dataset.pane = pane;
  const header = el('div', 'pane-header');
  const titleSlot = el('div', 'pane-title');
  const trailSlot = el('div', 'pane-trail');
  const body = el('div', 'pane-body');
  body.id = `focus-pane-${pane}`;
  header.append(titleSlot, trailSlot);
  element.append(header, body);

  header.draggable = true;
  header.addEventListener('dragstart', (event) => {
    if (event.target instanceof Element && event.target.closest(UNEDITABLE_DRAG_TARGETS)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData(PANE_DRAG_MIME, pane);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    events.onDragStart(pane);
  });
  header.addEventListener('dragend', () => events.onDragEnd());

  const clearDropZone = () => { delete element.dataset.dropZone; };
  const zoneOf = (event: DragEvent) => {
    const rect = element.getBoundingClientRect();
    return dropZoneAt(event.clientX - rect.left, event.clientY - rect.top, rect);
  };
  element.addEventListener('dragover', (event) => {
    if (!events.canAcceptDrop(pane, event)) return;
    event.preventDefault();
    element.dataset.dropZone = zoneOf(event);
  });
  element.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
    clearDropZone();
  });
  element.addEventListener('drop', (event) => {
    clearDropZone();
    if (!events.canAcceptDrop(pane, event)) return;
    event.preventDefault();
    events.onDrop(pane, zoneOf(event), event);
  });

  return { pane, element, header, titleSlot, trailSlot, body, clearDropZone };
}
