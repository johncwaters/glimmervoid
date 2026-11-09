import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { boardColumns } from './review-queue-core.ts';
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
}

const TILE_GROUP_IDS: ReadonlySet<DisplayGroupId> = new Set(['queued', 'working', 'parked']);
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

function makeDraggable(card: HTMLElement, queueKey: string, dropLaneIds: readonly DisplayGroupId[]): HTMLElement {
  if (dropLaneIds.length === 0) return card;
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    draggedCardDropLaneIds = new Set(dropLaneIds);
    event.dataTransfer?.setData(QUEUE_KEY_MIME, queueKey);
  });
  card.addEventListener('dragend', () => {
    draggedCardDropLaneIds = new Set();
  });
  return card;
}

function acceptDrops(column: HTMLElement, groupId: DisplayGroupId, onDropCard: ReviewBoardOptions['onDropCard']): void {
  const isQueueKeyDrag = (event: DragEvent) => event.dataTransfer?.types.includes(QUEUE_KEY_MIME) === true;
  column.addEventListener('dragover', (event) => {
    if (!isQueueKeyDrag(event) || !draggedCardDropLaneIds.has(groupId)) return;
    event.preventDefault();
    column.dataset.dropTarget = 'true';
  });
  column.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && column.contains(event.relatedTarget)) return;
    delete column.dataset.dropTarget;
  });
  column.addEventListener('drop', (event) => {
    delete column.dataset.dropTarget;
    const queueKey = event.dataTransfer?.getData(QUEUE_KEY_MIME);
    const isLegalDrop = draggedCardDropLaneIds.has(groupId);
    draggedCardDropLaneIds = new Set();
    if (!queueKey || !isLegalDrop) return;
    event.preventDefault();
    onDropCard(queueKey, groupId);
  });
}

function createColumn(group: DisplayGroup, options: ReviewBoardOptions): HTMLElement {
  const column = el('section', 'review-board-column');
  column.dataset.group = group.id;
  if (group.id === 'parked') column.id = PARKED_COLUMN_ID;
  acceptDrops(column, group.id, options.onDropCard);
  const dropHint = options.dropHintOf(group);
  const isCollapsed = (group.items.length === 0 && dropHint === null) || (group.id === 'parked' && !options.isParkedOpen);
  column.append(createColumnHeading(group, options, isCollapsed));
  if (isCollapsed) {
    column.dataset.collapsed = 'true';
    return column;
  }
  if (TILE_GROUP_IDS.has(group.id)) {
    column.dataset.slim = 'true';
    const tiles = el('div', 'review-board-tiles');
    tiles.append(...group.items.map((item) => makeDraggable(options.createTile(item, group), item.key, options.dropLaneIdsOf(item, group))));
    column.append(tiles);
    return column;
  }
  const cards = el('div', 'review-board-cards');
  for (const item of group.items) cards.append(makeDraggable(options.createCard(item, group), item.key, options.dropLaneIdsOf(item, group)));
  if (group.items.length === 0 && dropHint) cards.append(el('p', 'review-board-drop-hint', dropHint));
  column.append(cards);
  return column;
}

export function createReviewBoard(groups: readonly DisplayGroup[], options: ReviewBoardOptions): HTMLElement {
  const board = el('div', 'review-board');
  board.append(...boardColumns(groups).map((group) => createColumn(group, options)));
  return board;
}
