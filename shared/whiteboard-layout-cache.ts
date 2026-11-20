import type { Board } from './contracts/whiteboard.ts';
import type { BoardChrome } from './contracts/whiteboard-tiles.ts';
import { dressedLayout } from './whiteboard-layout-core.ts';
import type { BoardLayout, PlacedLayout } from './whiteboard-layout-core.ts';
import type { PinPositions } from './whiteboard-ops-core.ts';
import { indexBoardInSlices } from './whiteboard-board-index.ts';
import { INCREMENTAL_MIN_ELEMENTS, applyingLayoutDelta, layoutOf, rebuildingWorld, resumingLayoutWorld, savedWorldOf, warningsOfWorld } from './whiteboard-layout-engine.ts';
import { drained } from './generator-steps.ts';
import type { ElementChange, LayoutDelta, LayoutWorld, SavedWorld, SavedWorldParts, WarningChange } from './whiteboard-layout-engine.ts';
import type { RememberedRoute } from './contracts/whiteboard-tiles.ts';

const REMEMBERED_BOARD_COUNT = 8;
const WORLD_ELEMENTS_PER_SLICE = 5000;

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

interface PendingResume {
  board: Board;
  steps: Generator<void, LayoutWorld>;
  adopt: (lineage: number) => void;
}

const worldByBoardId = new Map<string, LayoutWorld>();
const warmingBoardByBoardId = new Map<string, Board>();
const pendingResumeByBoardId = new Map<string, PendingResume>();
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

function adoptedWorld(boardId: string, world: LayoutWorld, adopt: (lineage: number) => void): LayoutWorld {
  remember(boardId, world);
  adopt(world.lineage);
  return world;
}

function forgetBoardWarm(boardId: string): void {
  warmingBoardByBoardId.delete(boardId);
  pendingResumeByBoardId.delete(boardId);
}

function* resumingWorldOf(board: Board): Generator<void, LayoutWorld | null> {
  const pending = pendingResumeByBoardId.get(board.id);
  forgetBoardWarm(board.id);
  if (pending?.board === board) return adoptedWorld(board.id, yield* pending.steps, pending.adopt);
  const offer = savedWorldSource?.(board) ?? null;
  if (!offer) return null;
  return adoptedWorld(board.id, yield* resumingLayoutWorld(board, offer.saved, WORLD_ELEMENTS_PER_SLICE), offer.adopt);
}

function isStillWarming(board: Board): boolean {
  return warmingBoardByBoardId.get(board.id) === board && !worldByBoardId.has(board.id);
}

function stopWarming(board: Board): void {
  if (warmingBoardByBoardId.get(board.id) === board) forgetBoardWarm(board.id);
}

async function resumeInSlices(board: Board, elementsPerSlice: number, yieldBetweenSlices: () => Promise<unknown>): Promise<void> {
  await indexBoardInSlices(board.elements, elementsPerSlice, yieldBetweenSlices);
  if (!isStillWarming(board)) return;
  const offer = savedWorldSource?.(board) ?? null;
  if (!offer) return;
  const pending = { board, steps: resumingLayoutWorld(board, offer.saved, elementsPerSlice), adopt: offer.adopt };
  pendingResumeByBoardId.set(board.id, pending);
  for (;;) {
    await yieldBetweenSlices();
    if (pendingResumeByBoardId.get(board.id) !== pending) return;
    const step = pending.steps.next();
    if (!step.done) continue;
    forgetBoardWarm(board.id);
    adoptedWorld(board.id, step.value, pending.adopt);
    return;
  }
}

async function warmBoardLayout(board: Board, elementsPerSlice: number, yieldBetweenSlices: () => Promise<unknown>): Promise<void> {
  if (warmingBoardByBoardId.has(board.id) || worldByBoardId.has(board.id)) return;
  warmingBoardByBoardId.set(board.id, board);
  await resumeInSlices(board, elementsPerSlice, yieldBetweenSlices).finally(() => stopWarming(board));
}

function* resumingBoardLayout(board: Board): Generator<void, void> {
  if (!worldByBoardId.has(board.id)) yield* resumingWorldOf(board);
}

function* worldSteps(board: Board): Generator<void, LayoutWorld> {
  const remembered = worldByBoardId.get(board.id);
  if (remembered && remembered.version === board.version && remembered.board.elements === board.elements) return remembered;
  const resumed = remembered ? null : yield* resumingWorldOf(board);
  if (resumed) return resumed;
  const world = yield* rebuildingWorld(board, remembered ?? null, INCREMENTAL_MIN_ELEMENTS, WORLD_ELEMENTS_PER_SLICE);
  remember(board.id, world);
  return world;
}

function worldFor(board: Board): LayoutWorld {
  return drained(worldSteps(board));
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

function* advancingBoardLayout(board: Board, changes: ReadonlyMap<string, ElementChange>): Generator<void, LayoutAdvance | null> {
  const remembered = worldByBoardId.get(board.id);
  if (!remembered) return null;
  const { world, delta } = yield* applyingLayoutDelta(remembered, board, changes, WORLD_ELEMENTS_PER_SLICE);
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

function rememberedWorldSaverOf(board: Board): (() => SavedWorldParts) | null {
  const remembered = worldByBoardId.get(board.id);
  if (!remembered || remembered.version !== board.version || remembered.board.elements !== board.elements) return null;
  return () => savedWorldOf(remembered);
}

export { advancingBoardLayout, chromeOfBoard, forgetBoardWarm, layoutBoardRemembered, lineageLayoutOf, pinPositionsOfBoard, rememberedWorldSaverOf, resumingBoardLayout, setSavedWorldSource, warmBoardLayout, warningsOfBoard, worldSteps };
export type { SavedWorldOffer };
