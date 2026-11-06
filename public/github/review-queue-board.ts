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

function createParkedToggle(group: QueueGroup, isParkedOpen: boolean, onToggleParked: () => void): HTMLElement {
  const toggle = createPressable('review-board-parked-toggle');
  toggle.append(el('span', 'review-board-column-title', group.title), el('span', 'review-group-count', String(group.items.length)));
  toggle.setAttribute('aria-expanded', String(isParkedOpen));
  toggle.addEventListener('click', onToggleParked);
  return toggle;
}

function createColumnHeading(group: QueueGroup, options: ReviewBoardOptions): HTMLElement {
  const heading = el('h3', 'pr-section-heading review-board-column-heading');
  if (group.id === 'parked') {
    heading.append(createParkedToggle(group, options.isParkedOpen, options.onToggleParked));
    return heading;
  }
  heading.append(el('span', 'review-board-column-title', group.title), el('span', 'review-group-count', String(group.items.length)), ...options.createHeadingExtras(group));
  return heading;
}

function createColumn(group: QueueGroup, options: ReviewBoardOptions): HTMLElement {
  const column = el('section', 'review-board-column');
  column.dataset.group = group.id;
  column.append(createColumnHeading(group, options));
  if (group.id === 'parked' && !options.isParkedOpen) {
    column.dataset.collapsed = 'true';
    return column;
  }
  const cards = el('div', 'review-board-cards');
  if (group.items.length === 0) cards.append(el('p', 'review-board-empty', 'Nothing here.'));
  for (const item of group.items) cards.append(options.createCard(item, group));
  column.append(cards);
  return column;
}

export function createReviewBoard(groups: readonly QueueGroup[], options: ReviewBoardOptions): HTMLElement {
  const board = el('div', 'review-board');
  board.append(...boardColumns(groups).map((group) => createColumn(group, options)));
  return board;
}
