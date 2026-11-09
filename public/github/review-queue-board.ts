import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { SLIM_GROUP_IDS, boardColumns } from './review-queue-core.ts';
import type { DisplayGroup, DisplayGroupId, QueueItem } from './review-queue-core.ts';

interface ReviewBoardOptions {
  createCard(item: QueueItem, group: DisplayGroup): HTMLElement;
  createTile(item: QueueItem, group: DisplayGroup): HTMLElement;
  createCount(group: DisplayGroup): HTMLElement;
  createHeadingExtras(group: DisplayGroup): HTMLElement[];
  dropHintOf(group: DisplayGroup): string | null;
  isParkedOpen: boolean;
  onToggleParked(): void;
  dropLaneIdsOf(item: QueueItem, group: DisplayGroup): readonly DisplayGroupId[];
  onDropCard(queueKey: string, groupId: DisplayGroupId): void;
  onReorderCard(queueKey: string, groupId: DisplayGroupId, beforeQueueKey: string | null): void;
}

const QUEUE_KEY_MIME = 'application/x-glimmervoid-queue-key';

const PARKED_COLUMN_ID = 'review-board-parked';

function createParkedToggle(group: DisplayGroup, isParkedOpen: boolean, onToggleParked: () => void): HTMLElement {
  const toggle = createPressable('review-board-parked-toggle');
  toggle.append(el('span', 'review-board-column-title', group.title), el('span', 'review-group-count', String(group.items.length)));
  toggle.setAttribute('aria-expanded', String(isParkedOpen));
  toggle.setAttribute('aria-controls', PARKED_COLUMN_ID);
  toggle.addEventListener('click', onToggleParked);
  return toggle;
}

function createColumnHeading(group: DisplayGroup, options: ReviewBoardOptions, isCollapsed: boolean): HTMLElement {
  const heading = el('h3', 'pr-section-heading review-board-column-heading');
  if (group.id === 'parked' && group.items.length > 0) {
    heading.append(createParkedToggle(group, options.isParkedOpen, options.onToggleParked));
    return heading;
  }
  heading.append(el('span', 'review-board-column-title', group.title), options.createCount(group));
  if (!isCollapsed) heading.append(...options.createHeadingExtras(group));
  return heading;
}

let draggedCardDropLaneIds: ReadonlySet<DisplayGroupId> = new Set();
let draggedCardReorderGroupId: DisplayGroupId | null = null;

interface CardDrag {
  queueKey: string;
  dropLaneIds: readonly DisplayGroupId[];
  reorderGroupId: DisplayGroupId | null;
}

function forgetDraggedCard(): void {
  draggedCardDropLaneIds = new Set();
  draggedCardReorderGroupId = null;
}

function makeDraggable(card: HTMLElement, drag: CardDrag): HTMLElement {
  if (drag.dropLaneIds.length === 0 && drag.reorderGroupId === null) return card;
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    draggedCardDropLaneIds = new Set(drag.dropLaneIds);
    draggedCardReorderGroupId = drag.reorderGroupId;
    event.dataTransfer?.setData(QUEUE_KEY_MIME, drag.queueKey);
  });
  card.addEventListener('dragend', forgetDraggedCard);
  return card;
}

function clearDropMarks(column: HTMLElement): void {
  delete column.dataset.dropTarget;
  for (const card of column.querySelectorAll<HTMLElement>('[data-drop-before]')) delete card.dataset.dropBefore;
}

function cardUnder(event: DragEvent, column: HTMLElement): HTMLElement | null {
  if (!(event.target instanceof Element)) return null;
  const card = event.target.closest<HTMLElement>('[data-card-key]');
  return card && column.contains(card) ? card : null;
}

function acceptDrops(column: HTMLElement, groupId: DisplayGroupId, options: ReviewBoardOptions): void {
  const isQueueKeyDrag = (event: DragEvent) => event.dataTransfer?.types.includes(QUEUE_KEY_MIME) === true;
  column.addEventListener('dragover', (event) => {
    if (!isQueueKeyDrag(event)) return;
    const isReorder = draggedCardReorderGroupId === groupId;
    if (!isReorder && !draggedCardDropLaneIds.has(groupId)) return;
    event.preventDefault();
    clearDropMarks(column);
    const cardBelow = isReorder ? cardUnder(event, column) : null;
    if (cardBelow) {
      cardBelow.dataset.dropBefore = 'true';
      return;
    }
    column.dataset.dropTarget = 'true';
  });
  column.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && column.contains(event.relatedTarget)) return;
    clearDropMarks(column);
  });
  column.addEventListener('drop', (event) => {
    clearDropMarks(column);
    const queueKey = event.dataTransfer?.getData(QUEUE_KEY_MIME);
    const isReorder = draggedCardReorderGroupId === groupId;
    const isLegalDrop = draggedCardDropLaneIds.has(groupId);
    forgetDraggedCard();
    if (!queueKey || (!isReorder && !isLegalDrop)) return;
    event.preventDefault();
    if (isReorder) {
      options.onReorderCard(queueKey, groupId, cardUnder(event, column)?.dataset.cardKey ?? null);
      return;
    }
    options.onDropCard(queueKey, groupId);
  });
}

function createColumn(group: DisplayGroup, options: ReviewBoardOptions): HTMLElement {
  const column = el('section', 'review-board-column');
  column.dataset.group = group.id;
  if (group.id === 'parked') column.id = PARKED_COLUMN_ID;
  acceptDrops(column, group.id, options);
  const dropHint = options.dropHintOf(group);
  const isCollapsed = (group.items.length === 0 && dropHint === null) || (group.id === 'parked' && !options.isParkedOpen);
  column.append(createColumnHeading(group, options, isCollapsed));
  if (isCollapsed) {
    column.dataset.collapsed = 'true';
    return column;
  }
  if (SLIM_GROUP_IDS.has(group.id)) {
    column.dataset.slim = 'true';
    const tiles = el('div', 'review-board-tiles');
    tiles.append(...group.items.map((item) => makeDraggable(options.createTile(item, group), { queueKey: item.key, dropLaneIds: options.dropLaneIdsOf(item, group), reorderGroupId: null })));
    column.append(tiles);
    return column;
  }
  const cards = el('div', 'review-board-cards');
  const reorderGroupId = group.items.length > 1 ? group.id : null;
  for (const item of group.items) {
    const card = makeDraggable(options.createCard(item, group), { queueKey: item.key, dropLaneIds: options.dropLaneIdsOf(item, group), reorderGroupId });
    card.dataset.cardKey = item.key;
    cards.append(card);
  }
  if (group.items.length === 0 && dropHint) cards.append(el('p', 'review-board-drop-hint', dropHint));
  column.append(cards);
  return column;
}

export function createReviewBoard(groups: readonly DisplayGroup[], options: ReviewBoardOptions): HTMLElement {
  const board = el('div', 'review-board');
  board.append(...boardColumns(groups).map((group) => createColumn(group, options)));
  return board;
}
