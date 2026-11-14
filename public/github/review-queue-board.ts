import { canAnimate, eased, prefersReducedMotion } from '../attention-banner.ts';
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
  isSlotDrop(item: QueueItem, group: DisplayGroup, targetGroupId: DisplayGroupId): boolean;
  onDropCard(queueKey: string, groupId: DisplayGroupId, beforeQueueKey: string | null, dropPoint: DropPoint): void;
  onReorderCard(queueKey: string, groupId: DisplayGroupId, beforeQueueKey: string | null, dropPoint: DropPoint): void;
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

const SLOT_OPEN_MS = 220;
const SLOT_CLOSE_MS = 160;

export interface DropPoint { clientX: number; clientY: number }

interface CardDrag {
  queueKey: string;
  slotLaneIds: ReadonlySet<DisplayGroupId>;
  litLaneIds: ReadonlySet<DisplayGroupId>;
  reorderGroupId: DisplayGroupId | null;
}

interface ActiveDrag extends CardDrag {
  source: HTMLElement;
  slotHeightPx: number;
  slot: HTMLElement | null;
  slotBeforeKey: string | null;
}

let activeDrag: ActiveDrag | null = null;

function isSlotMotionOn(element: HTMLElement): boolean {
  return !prefersReducedMotion() && canAnimate(element);
}

function rowGapPx(cards: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(cards).rowGap) || 0;
}

function closeSlot(slot: HTMLElement): void {
  slot.dataset.closing = 'true';
  const cards = slot.parentElement;
  if (!cards || !isSlotMotionOn(slot)) {
    slot.remove();
    return;
  }
  const close = slot.animate(eased([{ height: `${slot.offsetHeight}px`, marginBottom: '0px' }, { height: '0px', marginBottom: `-${rowGapPx(cards)}px` }]), { duration: SLOT_CLOSE_MS, fill: 'forwards' });
  close.addEventListener('finish', () => slot.remove());
  close.addEventListener('cancel', () => slot.remove());
}

function openSlot(cards: HTMLElement, beforeCard: Element | null, heightPx: number, isAnimated: boolean): HTMLElement {
  const slot = el('div', 'review-board-slot');
  slot.setAttribute('aria-hidden', 'true');
  slot.style.height = `${heightPx}px`;
  cards.insertBefore(slot, beforeCard);
  if (isAnimated && isSlotMotionOn(slot)) slot.animate(eased([{ height: '0px', marginBottom: `-${rowGapPx(cards)}px` }, { height: `${heightPx}px`, marginBottom: '0px' }]), { duration: SLOT_OPEN_MS });
  return slot;
}

function placedCardsOf(cards: HTMLElement, drag: ActiveDrag): HTMLElement[] {
  return [...cards.querySelectorAll<HTMLElement>(':scope > [data-card-key]')].filter((card) => card.dataset.cardKey !== drag.queueKey);
}

function cardBelowPointer(cards: HTMLElement, drag: ActiveDrag, pointerY: number): HTMLElement | null {
  return placedCardsOf(cards, drag).find((card) => {
    const rect = card.getBoundingClientRect();
    return rect.top + rect.height / 2 > pointerY;
  }) ?? null;
}

function moveSlot(drag: ActiveDrag, cards: HTMLElement, pointerY: number): void {
  const beforeCard = cardBelowPointer(cards, drag, pointerY);
  const beforeKey = beforeCard?.dataset.cardKey ?? null;
  if (drag.slot?.parentElement === cards && drag.slotBeforeKey === beforeKey) return;
  if (drag.slot) closeSlot(drag.slot);
  const hint = cards.querySelector(':scope > .review-board-drop-hint');
  drag.slot = openSlot(cards, beforeCard ?? hint, drag.slotHeightPx, true);
  drag.slotBeforeKey = beforeKey;
}

function dropSlot(drag: ActiveDrag): void {
  if (drag.slot) closeSlot(drag.slot);
  drag.slot = null;
}

function liftSource(drag: ActiveDrag): void {
  const cards = drag.source.parentElement;
  if (!cards?.classList.contains('review-board-cards')) {
    drag.source.dataset.lifted = 'true';
    return;
  }
  drag.slot = openSlot(cards, drag.source.nextElementSibling, drag.slotHeightPx, false);
  drag.slotBeforeKey = drag.source.nextElementSibling instanceof HTMLElement ? drag.source.nextElementSibling.dataset.cardKey ?? null : null;
  drag.source.dataset.lifted = 'true';
}

function endDrag(drag: ActiveDrag): void {
  if (activeDrag?.queueKey === drag.queueKey) activeDrag = null;
  if (drag.slot) drag.slot.remove();
  drag.slot = null;
  delete drag.source.dataset.lifted;
}

function makeDraggable(card: HTMLElement, drag: CardDrag): HTMLElement {
  if (drag.slotLaneIds.size === 0 && drag.litLaneIds.size === 0 && drag.reorderGroupId === null) return card;
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData(QUEUE_KEY_MIME, drag.queueKey);
    const started: ActiveDrag = { ...drag, source: card, slotHeightPx: card.offsetHeight, slot: null, slotBeforeKey: null };
    activeDrag = started;
    requestAnimationFrame(() => {
      if (activeDrag === started) liftSource(started);
    });
  });
  card.addEventListener('dragend', () => {
    if (activeDrag?.queueKey === drag.queueKey) endDrag(activeDrag);
  });
  return card;
}

function laneRoleOf(drag: ActiveDrag, groupId: DisplayGroupId): 'slot' | 'lit' | null {
  if (drag.reorderGroupId === groupId || drag.slotLaneIds.has(groupId)) return 'slot';
  if (drag.litLaneIds.has(groupId)) return 'lit';
  return null;
}

function acceptDrops(column: HTMLElement, groupId: DisplayGroupId, options: ReviewBoardOptions): void {
  const cardsOf = () => column.querySelector<HTMLElement>(':scope > .review-board-cards');
  column.addEventListener('dragover', (event) => {
    if (!activeDrag || event.dataTransfer?.types.includes(QUEUE_KEY_MIME) !== true) return;
    const role = laneRoleOf(activeDrag, groupId);
    if (!role) return;
    event.preventDefault();
    const cards = cardsOf();
    if (role === 'lit' || !cards) {
      dropSlot(activeDrag);
      column.dataset.dropTarget = 'true';
      return;
    }
    moveSlot(activeDrag, cards, event.clientY);
  });
  column.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && column.contains(event.relatedTarget)) return;
    delete column.dataset.dropTarget;
    if (activeDrag?.slot && column.contains(activeDrag.slot)) dropSlot(activeDrag);
  });
  column.addEventListener('drop', (event) => {
    delete column.dataset.dropTarget;
    const drag = activeDrag;
    const role = drag ? laneRoleOf(drag, groupId) : null;
    if (!drag || !role || event.dataTransfer?.getData(QUEUE_KEY_MIME) !== drag.queueKey) return;
    event.preventDefault();
    activeDrag = null;
    const isSlotHere = drag.slot !== null && column.contains(drag.slot);
    const beforeKey = isSlotHere ? drag.slotBeforeKey : null;
    const dropPoint: DropPoint = { clientX: event.clientX, clientY: event.clientY };
    if (drag.reorderGroupId === groupId) options.onReorderCard(drag.queueKey, groupId, beforeKey, dropPoint);
    if (drag.reorderGroupId !== groupId) options.onDropCard(drag.queueKey, groupId, beforeKey, dropPoint);
    if (column.isConnected) endDrag(drag);
  });
}

function dropLanesOf(item: QueueItem, group: DisplayGroup, options: ReviewBoardOptions): Pick<CardDrag, 'slotLaneIds' | 'litLaneIds'> {
  const dropLaneIds = options.dropLaneIdsOf(item, group);
  return {
    slotLaneIds: new Set(dropLaneIds.filter((laneId) => options.isSlotDrop(item, group, laneId))),
    litLaneIds: new Set(dropLaneIds.filter((laneId) => !options.isSlotDrop(item, group, laneId))),
  };
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
    tiles.append(...group.items.map((item) => makeDraggable(options.createTile(item, group), { queueKey: item.key, ...dropLanesOf(item, group, options), reorderGroupId: null })));
    column.append(tiles);
    return column;
  }
  const cards = el('div', 'review-board-cards');
  const reorderGroupId = group.items.length > 1 ? group.id : null;
  for (const item of group.items) {
    const card = options.createCard(item, group);
    card.dataset.cardKey = item.key;
    makeDraggable(card, { queueKey: item.key, ...dropLanesOf(item, group, options), reorderGroupId });
    cards.append(card);
  }
  if (group.items.length === 0 && dropHint) cards.append(el('p', 'review-board-drop-hint', dropHint));
  column.append(cards);
  return column;
}

const HIDDEN_EDGE_MIN_PX = 1;

let boardEdgeObserver: ResizeObserver | null = null;

function setBoardFlag(board: HTMLElement, flag: 'overflowStart' | 'overflowEnd', isOn: boolean): void {
  if (isOn) {
    board.dataset[flag] = 'true';
    return;
  }
  delete board.dataset[flag];
}

function flagOverflowingEdges(board: HTMLElement): void {
  const hiddenEndPx = board.scrollWidth - board.clientWidth - board.scrollLeft;
  setBoardFlag(board, 'overflowStart', board.scrollLeft >= HIDDEN_EDGE_MIN_PX);
  setBoardFlag(board, 'overflowEnd', hiddenEndPx >= HIDDEN_EDGE_MIN_PX);
}

function watchBoardEdges(board: HTMLElement): void {
  boardEdgeObserver?.disconnect();
  boardEdgeObserver = new ResizeObserver(() => flagOverflowingEdges(board));
  boardEdgeObserver.observe(board);
  board.addEventListener('scroll', () => flagOverflowingEdges(board), { passive: true });
}

export function createReviewBoard(groups: readonly DisplayGroup[], options: ReviewBoardOptions): HTMLElement {
  const board = el('div', 'review-board');
  if (activeDrag) activeDrag.slot = null;
  board.append(...boardColumns(groups).map((group) => createColumn(group, options)));
  watchBoardEdges(board);
  return board;
}
