import type { Board } from './contracts/whiteboard.ts';
import type { BoardChrome } from './contracts/whiteboard-tiles.ts';
import { dressedLayout } from './whiteboard-layout-core.ts';
import type { BoardLayout, PlacedLayout } from './whiteboard-layout-core.ts';
import type { PinPositions } from './whiteboard-ops-core.ts';
import { applyLayoutDelta, createLayoutWorld, layoutOf, warningsOfWorld } from './whiteboard-layout-engine.ts';
import type { ElementChange, LayoutDelta, LayoutWorld } from './whiteboard-layout-engine.ts';

const REMEMBERED_BOARD_COUNT = 8;

interface LayoutAdvance {
  lineage: number;
  delta: LayoutDelta;
  chrome: BoardChrome;
  warnings: string[];
}

const worldByBoardId = new Map<string, LayoutWorld>();

function remember(boardId: string, world: LayoutWorld): void {
  worldByBoardId.delete(boardId);
  worldByBoardId.set(boardId, world);
  for (const oldestBoardId of worldByBoardId.keys()) {
    if (worldByBoardId.size <= REMEMBERED_BOARD_COUNT) break;
    worldByBoardId.delete(oldestBoardId);
  }
}

function worldFor(board: Board): LayoutWorld {
  const remembered = worldByBoardId.get(board.id);
  if (remembered && remembered.version === board.version && remembered.board.elements === board.elements) return remembered;
  const world = createLayoutWorld(board, remembered ?? null);
  remember(board.id, world);
  return world;
}

function layoutBoardRemembered(board: Board): BoardLayout {
  return dressedLayout(layoutOf(worldFor(board)), board);
}

function lineageLayoutOf(board: Board): { lineage: number; layout: PlacedLayout } {
  const world = worldFor(board);
  return { lineage: world.lineage, layout: layoutOf(world) };
}

function chromeOfBoard(board: Board): BoardChrome {
  return worldFor(board).chrome;
}

function advanceBoardLayout(board: Board, changes: ReadonlyMap<string, ElementChange>): LayoutAdvance | null {
  const remembered = worldByBoardId.get(board.id);
  if (!remembered) return null;
  const { world, delta } = applyLayoutDelta(remembered, board, changes);
  remember(board.id, world);
  return { lineage: world.lineage, delta, chrome: world.chrome, warnings: warningsOfWorld(world) };
}

function pinPositionsOfBoard(board: Board): PinPositions | null {
  const remembered = worldByBoardId.get(board.id);
  if (!remembered || remembered.version !== board.version || remembered.board.elements !== board.elements) return null;
  return {
    laidOutBoxOf: (id) => {
      const laidOut = remembered.laidOutById.get(id);
      return laidOut?.kind === 'box' ? laidOut : undefined;
    },
    pinnedOffsetY: remembered.pinnedOffsetY,
  };
}

function warningsOfBoard(board: Board): string[] {
  return warningsOfWorld(worldFor(board));
}

export { advanceBoardLayout, chromeOfBoard, layoutBoardRemembered, lineageLayoutOf, pinPositionsOfBoard, warningsOfBoard };
