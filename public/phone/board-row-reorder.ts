import type { SessionRow } from '../focus-view/attention-core.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { canDropRow, dropAnchorId, sessionOrderAfterDrop, sessionOrderOf } from '../focus-view/attention-core.ts';
import { saveSessionOrder } from '../focus-view/focus-view.ts';
import { settingsPayloadSnapshot } from '../settings/settings-store.ts';

const LONG_PRESS_MS = 450;
const PRESS_SLOP_PX = 8;

type DropSide = 'before' | 'after';
type BoardDrop = { targetId: string; side: DropSide };
type ReorderGesture =
  | { phase: 'idle' }
  | { phase: 'pressing'; pointerId: number; sessionId: string; startX: number; startY: number; holdTimer: number }
  | { phase: 'dragging'; pointerId: number; sessionId: string; drop: BoardDrop | null };

type BoardRow = SessionRow<SessionUi>;

interface BoardReorderDeps {
  rowsInBoardOrder: () => readonly BoardRow[];
  groupKeyOf: (row: BoardRow) => string;
  itemFor: (sessionId: string) => HTMLElement | undefined;
  repaint: () => void;
}

function sessionIdOfRowAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('.session-row[data-id]')?.dataset.id ?? null;
}

export function wireBoardRowReorder(listEl: HTMLElement, deps: BoardReorderDeps) {
  let gesture: ReorderGesture = { phase: 'idle' };
  let isClickAfterDragPending = false;

  function dropAt(draggedId: string, clientX: number, clientY: number): BoardDrop | null {
    const item = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.session-row-item');
    const targetId = item?.querySelector<HTMLElement>('.session-row[data-id]')?.dataset.id;
    if (!item || !targetId) return null;
    const rows = deps.rowsInBoardOrder();
    const draggedRow = rows.find(({ id }) => id === draggedId);
    const targetRow = rows.find(({ id }) => id === targetId);
    if (!draggedRow || !targetRow) return null;
    if (!canDropRow(draggedRow, targetRow, deps.groupKeyOf, new Set(rows.map(({ id }) => id)))) return null;
    const rect = item.getBoundingClientRect();
    return { targetId, side: clientY < rect.top + rect.height / 2 ? 'before' : 'after' };
  }

  function clearDropMarker() {
    for (const marked of listEl.querySelectorAll<HTMLElement>('.session-row-item[data-drop-target]')) delete marked.dataset.dropTarget;
  }

  function markDrop(drop: BoardDrop | null) {
    clearDropMarker();
    if (!drop) return;
    const anchorItem = deps.itemFor(dropAnchorId(deps.rowsInBoardOrder(), drop.targetId, drop.side));
    if (anchorItem) anchorItem.dataset.dropTarget = drop.side;
  }

  function endGesture() {
    if (gesture.phase === 'pressing') window.clearTimeout(gesture.holdTimer);
    if (gesture.phase === 'dragging') delete deps.itemFor(gesture.sessionId)?.dataset.reordering;
    clearDropMarker();
    gesture = { phase: 'idle' };
  }

  function startDragging() {
    if (gesture.phase !== 'pressing') return;
    gesture = { phase: 'dragging', pointerId: gesture.pointerId, sessionId: gesture.sessionId, drop: null };
    const draggedItem = deps.itemFor(gesture.sessionId);
    if (draggedItem) draggedItem.dataset.reordering = '';
  }

  listEl.addEventListener('pointerdown', (event) => {
    isClickAfterDragPending = false;
    if (gesture.phase !== 'idle' || !event.isPrimary || event.button !== 0) return;
    const sessionId = sessionIdOfRowAt(event.target);
    if (!sessionId) return;
    gesture = { phase: 'pressing', pointerId: event.pointerId, sessionId, startX: event.clientX, startY: event.clientY, holdTimer: window.setTimeout(startDragging, LONG_PRESS_MS) };
  });

  listEl.addEventListener('pointermove', (event) => {
    if (gesture.phase === 'idle' || event.pointerId !== gesture.pointerId) return;
    if (gesture.phase === 'pressing') {
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > PRESS_SLOP_PX) endGesture();
      return;
    }
    gesture.drop = dropAt(gesture.sessionId, event.clientX, event.clientY);
    markDrop(gesture.drop);
  });

  listEl.addEventListener('pointerup', (event) => {
    if (gesture.phase === 'idle' || event.pointerId !== gesture.pointerId) return;
    if (gesture.phase === 'pressing') {
      endGesture();
      return;
    }
    const { sessionId, drop } = gesture;
    isClickAfterDragPending = true;
    endGesture();
    if (!drop) return;
    saveSessionOrder(sessionOrderAfterDrop(deps.rowsInBoardOrder(), sessionOrderOf(settingsPayloadSnapshot()), sessionId, drop.targetId, drop.side), deps.repaint);
  });

  listEl.addEventListener('pointercancel', (event) => {
    if (gesture.phase === 'idle' || event.pointerId !== gesture.pointerId) return;
    endGesture();
  });

  listEl.addEventListener('click', (event) => {
    if (!isClickAfterDragPending) return;
    isClickAfterDragPending = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);

  listEl.addEventListener('contextmenu', (event) => {
    if (gesture.phase !== 'idle') event.preventDefault();
  });

  listEl.addEventListener('touchmove', (event) => {
    if (gesture.phase === 'dragging') event.preventDefault();
  }, { passive: false });
}
