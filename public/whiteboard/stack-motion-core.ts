import { FRAME_TITLE_HEIGHT, movedBox } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutFrame, Rect } from '#shared/whiteboard-layout-core.ts';

interface StackMove {
  box: LaidOutBox;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

const STACK_MOTION_MS = 220;
const STACK_FAN_MS = 120;
const TOP_CARD_MATCH_TOLERANCE = 0.5;
const FANNED_STACK_SPREAD = 14;

function isStacked(frame: LaidOutFrame): boolean {
  return frame.stackedBoxCount !== null;
}

function centerIsInside(box: LaidOutBox, area: Rect): boolean {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return centerX >= area.x && centerX <= area.x + area.width && centerY >= area.y && centerY <= area.y + area.height;
}

function boxesOnlyIn(layoutElements: Iterable<LaidOutElement>, isElsewhere: (boxId: string) => boolean): LaidOutBox[] {
  return [...layoutElements].flatMap((element) => (element.kind === 'box' && !isElsewhere(element.id) ? [element] : []));
}

interface FlippedStack {
  isClosing: boolean;
  stackFrame: LaidOutFrame;
  openFrame: LaidOutFrame;
}

function flippedStacksBetween(previousById: ReadonlyMap<string, LaidOutElement>, next: BoardLayout): FlippedStack[] {
  return next.elements.flatMap((frame) => {
    if (frame.kind !== 'frame') return [];
    const previous = previousById.get(frame.id);
    if (previous?.kind !== 'frame' || isStacked(previous) === isStacked(frame)) return [];
    const isClosing = isStacked(frame);
    return [{ isClosing, stackFrame: isClosing ? frame : previous, openFrame: isClosing ? previous : frame }];
  });
}

function smallestStackHolding(box: LaidOutBox, stacks: readonly FlippedStack[]): FlippedStack | undefined {
  const holdingStacks = stacks.filter((stack) => centerIsInside(box, stack.openFrame));
  return holdingStacks.sort((first, second) => first.openFrame.width * first.openFrame.height - second.openFrame.width * second.openFrame.height)[0];
}

function stackMovesBetween(previousById: ReadonlyMap<string, LaidOutElement>, next: BoardLayout): StackMove[] {
  const nextIds = new Set(next.elements.map((element) => element.id));
  const flippedStacks = flippedStacksBetween(previousById, next);
  const closingStacks = flippedStacks.filter((stack) => stack.isClosing);
  const openingStacks = flippedStacks.filter((stack) => !stack.isClosing);
  const leavingBoxes = closingStacks.length === 0 ? [] : boxesOnlyIn(previousById.values(), (boxId) => nextIds.has(boxId));
  const arrivingBoxes = openingStacks.length === 0 ? [] : boxesOnlyIn(next.elements, (boxId) => previousById.has(boxId));
  const moves: StackMove[] = [];
  for (const box of leavingBoxes) {
    const stack = smallestStackHolding(box, closingStacks);
    if (stack) moves.push({ box, fromX: 0, fromY: 0, toX: stack.stackFrame.x - box.x, toY: stack.stackFrame.y + FRAME_TITLE_HEIGHT - box.y });
  }
  for (const box of arrivingBoxes) {
    const stack = smallestStackHolding(box, openingStacks);
    if (stack) moves.push({ box, fromX: stack.stackFrame.x - box.x, fromY: stack.stackFrame.y + FRAME_TITLE_HEIGHT - box.y, toX: 0, toY: 0 });
  }
  return moves;
}

function easedProgress(elapsedMs: number, durationMs: number): number {
  const linear = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return 1 - (1 - linear) ** 3;
}

function movedBoxesAt(moves: readonly StackMove[], progress: number): LaidOutBox[] {
  return moves.map((move) => movedBox(move.box, move.fromX + (move.toX - move.fromX) * progress, move.fromY + (move.toY - move.fromY) * progress));
}

function stackFrameOfTopCard(layout: BoardLayout, topCard: LaidOutBox): LaidOutFrame | null {
  const frame = layout.elements.find((element) => element.kind === 'frame' && isStacked(element) && Math.abs(element.x - topCard.x) < TOP_CARD_MATCH_TOLERANCE && Math.abs(element.y + FRAME_TITLE_HEIGHT - topCard.y) < TOP_CARD_MATCH_TOLERANCE);
  return frame?.kind === 'frame' ? frame : null;
}

export { FANNED_STACK_SPREAD, STACK_FAN_MS, STACK_MOTION_MS, easedProgress, movedBoxesAt, stackFrameOfTopCard, stackMovesBetween };
export type { StackMove };
