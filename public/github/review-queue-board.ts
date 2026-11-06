import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { boardColumns } from './review-queue-core.ts';
import type { QueueGroup, QueueItem } from './review-queue-core.ts';

interface ReviewBoardOptions {
  createCard(item: QueueItem, group: QueueGroup): HTMLElement;
  createHeadingExtras(group: QueueGroup): HTMLElement[];
  isParkedOpen: boolean;
  onToggleParked(): void;
}

const PARKED_COLUMN_ID = 'review-board-parked';

function createParkedToggle(group: QueueGroup, isParkedOpen: boolean, onToggleParked: () => void): HTMLElement {
  const toggle = createPressable('review-board-parked-toggle');
  toggle.append(el('span', 'review-board-column-title', group.title), el('span', 'review-group-count', String(group.items.length)));
  toggle.setAttribute('aria-expanded', String(isParkedOpen));
  toggle.setAttribute('aria-controls', PARKED_COLUMN_ID);
  toggle.addEventListener('click', onToggleParked);
  return toggle;
}

function createColumnHeading(group: QueueGroup, options: ReviewBoardOptions, isCollapsed: boolean): HTMLElement {
  const heading = el('h3', 'pr-section-heading review-board-column-heading');
  if (group.id === 'parked' && group.items.length > 0) {
    heading.append(createParkedToggle(group, options.isParkedOpen, options.onToggleParked));
    return heading;
  }
  heading.append(el('span', 'review-board-column-title', group.title), el('span', 'review-group-count', String(group.items.length)));
  if (!isCollapsed) heading.append(...options.createHeadingExtras(group));
  return heading;
}

function createColumn(group: QueueGroup, options: ReviewBoardOptions): HTMLElement {
  const column = el('section', 'review-board-column');
  column.dataset.group = group.id;
  if (group.id === 'parked') column.id = PARKED_COLUMN_ID;
  const isCollapsed = group.items.length === 0 || (group.id === 'parked' && !options.isParkedOpen);
  column.append(createColumnHeading(group, options, isCollapsed));
  if (isCollapsed) {
    column.dataset.collapsed = 'true';
    return column;
  }
  const cards = el('div', 'review-board-cards');
  for (const item of group.items) cards.append(options.createCard(item, group));
  column.append(cards);
  return column;
}

export function createReviewBoard(groups: readonly QueueGroup[], options: ReviewBoardOptions): HTMLElement {
  const board = el('div', 'review-board');
  board.append(...boardColumns(groups).map((group) => createColumn(group, options)));
  return board;
}
