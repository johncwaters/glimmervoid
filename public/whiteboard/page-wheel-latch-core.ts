export const WHEEL_GESTURE_GAP_MS = 150;
export const PAGE_REPLY_TIMEOUT_MS = 100;

export type WheelLatch =
  | { state: 'idle' }
  | { state: 'pending'; boxId: string; sentAtMs: number; lastWheelAtMs: number; heldDeltaX: number; heldDeltaY: number }
  | { state: 'page'; boxId: string; lastWheelAtMs: number }
  | { state: 'board'; lastWheelAtMs: number };

export interface WheelInput {
  atMs: number;
  pageBoxIdUnderPointer: string | null;
  deltaX: number;
  deltaY: number;
}

export type WheelRoute = { to: 'page'; boxId: string } | { to: 'board' };

export interface BoardPan {
  deltaX: number;
  deltaY: number;
}

const IDLE: WheelLatch = { state: 'idle' };

function liveLatchAt(latch: WheelLatch, atMs: number): WheelLatch {
  if (latch.state === 'idle') return latch;
  return atMs - latch.lastWheelAtMs > WHEEL_GESTURE_GAP_MS ? IDLE : latch;
}

export function routeWheel(latch: WheelLatch, input: WheelInput): { route: WheelRoute; latch: WheelLatch; heldBoardPan: BoardPan | null } {
  const live = liveLatchAt(latch, input.atMs);
  switch (live.state) {
    case 'idle':
      if (input.pageBoxIdUnderPointer === null) return { route: { to: 'board' }, latch: { state: 'board', lastWheelAtMs: input.atMs }, heldBoardPan: null };
      return {
        route: { to: 'page', boxId: input.pageBoxIdUnderPointer },
        latch: { state: 'pending', boxId: input.pageBoxIdUnderPointer, sentAtMs: input.atMs, lastWheelAtMs: input.atMs, heldDeltaX: input.deltaX, heldDeltaY: input.deltaY },
        heldBoardPan: null,
      };
    case 'pending':
      if (input.atMs - live.sentAtMs > PAGE_REPLY_TIMEOUT_MS) {
        return { route: { to: 'board' }, latch: { state: 'board', lastWheelAtMs: input.atMs }, heldBoardPan: { deltaX: live.heldDeltaX, deltaY: live.heldDeltaY } };
      }
      return {
        route: { to: 'page', boxId: live.boxId },
        latch: { ...live, lastWheelAtMs: input.atMs, heldDeltaX: live.heldDeltaX + input.deltaX, heldDeltaY: live.heldDeltaY + input.deltaY },
        heldBoardPan: null,
      };
    case 'page':
      return { route: { to: 'page', boxId: live.boxId }, latch: { ...live, lastWheelAtMs: input.atMs }, heldBoardPan: null };
    case 'board':
      return { route: { to: 'board' }, latch: { ...live, lastWheelAtMs: input.atMs }, heldBoardPan: null };
  }
}

export function settleReply(latch: WheelLatch, boxId: string, hasScrolled: boolean): { latch: WheelLatch; boardPan: BoardPan | null } {
  if (latch.state !== 'pending' || latch.boxId !== boxId) return { latch, boardPan: null };
  if (hasScrolled) return { latch: { state: 'page', boxId, lastWheelAtMs: latch.lastWheelAtMs }, boardPan: null };
  return { latch: { state: 'board', lastWheelAtMs: latch.lastWheelAtMs }, boardPan: { deltaX: latch.heldDeltaX, deltaY: latch.heldDeltaY } };
}
