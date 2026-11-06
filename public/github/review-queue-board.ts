import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { boardColumns } from './review-queue-core.ts';
import type { DisplayGroup, DisplayGroupId, QueueItem } from './review-queue-core.ts';

interface ReviewBoardOptions {
  createCard(item: QueueItem, group: DisplayGroup): HTMLElement;
  createCount(group: DisplayGroup): HTMLElement;
  createHeadingExtras(group: DisplayGroup): HTMLElement[];
  dropHintOf(group: DisplayGroup): string | null;
  isParkedOpen: boolean;
  onToggleParked(): void;
  onDropCard(queueKey: string, groupId: DisplayGroupId): void;
}

const DRAG_GROUP_IDS: ReadonlySet<DisplayGroupId> = new Set(['turn', 'now']);
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

function makeDraggable(card: HTMLElement, queueKey: string): HTMLElement {
  card.draggable = true;
  card.addEventListener('dragstart', (event) => event.dataTransfer?.setData(QUEUE_KEY_MIME, queueKey));
  return card;
}

function acceptDrops(column: HTMLElement, groupId: DisplayGroupId, onDropCard: ReviewBoardOptions['onDropCard']): void {
  const isQueueKeyDrag = (event: DragEvent) => event.dataTransfer?.types.includes(QUEUE_KEY_MIME) === true;
  column.addEventListener('dragover', (event) => {
    if (!isQueueKeyDrag(event)) return;
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
    if (!queueKey) return;
    event.preventDefault();
    onDropCard(queueKey, groupId);
  });
}

function createColumn(group: DisplayGroup, options: ReviewBoardOptions): HTMLElement {
  const column = el('section', 'review-board-column');
  column.dataset.group = group.id;
  if (group.id === 'parked') column.id = PARKED_COLUMN_ID;
  const isDragGroup = DRAG_GROUP_IDS.has(group.id);
  if (isDragGroup) acceptDrops(column, group.id, options.onDropCard);
  const dropHint = options.dropHintOf(group);
  const isCollapsed = (group.items.length === 0 && dropHint === null) || (group.id === 'parked' && !options.isParkedOpen);
  column.append(createColumnHeading(group, options, isCollapsed));
  if (isCollapsed) {
    column.dataset.collapsed = 'true';
    return column;
  }
  const cards = el('div', 'review-board-cards');
  for (const item of group.items) {
    const card = options.createCard(item, group);
    cards.append(isDragGroup ? makeDraggable(card, item.key) : card);
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
