import type { Board } from './contracts/whiteboard.ts';
import type { BoardChrome } from './contracts/whiteboard-tiles.ts';
import { dressedLayout } from './whiteboard-layout-core.ts';
import type { BoardLayout, PlacedLayout } from './whiteboard-layout-core.ts';
import type { PinPositions } from './whiteboard-ops-core.ts';
import { applyLayoutDelta, createLayoutWorld, layoutOf, resumeLayoutWorld, savedWorldOf, warningsOfWorld } from './whiteboard-layout-engine.ts';
import type { ElementChange, LayoutDelta, LayoutWorld, SavedWorld, SavedWorldParts, WarningChange } from './whiteboard-layout-engine.ts';
import type { RememberedRoute } from './contracts/whiteboard-tiles.ts';

const REMEMBERED_BOARD_COUNT = 8;

interface LayoutAdvance {
  lineage: number;
  delta: LayoutDelta;
  chrome: BoardChrome;
  warnings: string[];
  changedRoutes: [string, RememberedRoute | null][];
  warningChanges: WarningChange[];
}

interface SavedWorldOffer {
  saved: SavedWorld;
  adopt: (lineage: number) => void;
}

type SavedWorldSource = (board: Board) => SavedWorldOffer | null;

const worldByBoardId = new Map<string, LayoutWorld>();
let savedWorldSource: SavedWorldSource | null = null;

function setSavedWorldSource(source: SavedWorldSource | null): void {
  savedWorldSource = source;
}

function remember(boardId: string, world: LayoutWorld): void {
  worldByBoardId.delete(boardId);
  worldByBoardId.set(boardId, world);
  for (const oldestBoardId of worldByBoardId.keys()) {
    if (worldByBoardId.size <= REMEMBERED_BOARD_COUNT) break;
    worldByBoardId.delete(oldestBoardId);
  }
}

function resumedWorldOf(board: Board): LayoutWorld | null {
  const offer = savedWorldSource?.(board) ?? null;
  if (!offer) return null;
  const world = resumeLayoutWorld(board, offer.saved);
  remember(board.id, world);
  offer.adopt(world.lineage);
  return world;
}

function resumeBoardLayout(board: Board): void {
  if (!worldByBoardId.has(board.id)) resumedWorldOf(board);
}

function worldFor(board: Board): LayoutWorld {
  const remembered = worldByBoardId.get(board.id);
  if (remembered && remembered.version === board.version && remembered.board.elements === board.elements) return remembered;
  const resumed = remembered ? null : resumedWorldOf(board);
  if (resumed) return resumed;
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
  const changedRoutes = delta.worldChanges.routeIds.map((id): [string, RememberedRoute | null] => [id, world.routeMemory.routeById.get(id) ?? null]);
  return { lineage: world.lineage, delta, chrome: world.chrome, warnings: warningsOfWorld(world), changedRoutes, warningChanges: delta.worldChanges.warnings };
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

function savedWorldOfBoard(board: Board): SavedWorldParts {
  return savedWorldOf(worldFor(board));
}

export { advanceBoardLayout, chromeOfBoard, layoutBoardRemembered, lineageLayoutOf, pinPositionsOfBoard, resumeBoardLayout, savedWorldOfBoard, setSavedWorldSource, warningsOfBoard };
export type { SavedWorldOffer };
