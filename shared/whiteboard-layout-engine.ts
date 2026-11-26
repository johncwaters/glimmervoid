import { boxIdOfEnd, boxIdsOfWire, pointOfBox, WHITEBOARD_LIMITS } from './whiteboard-constants.ts';
import type { Board, Element } from './contracts/whiteboard.ts';
import type { LayoutWarning, PlacedBox, PlacedElement, LaidOutFrame, LaidOutStroke, LaidOutWire, PlanColumn } from './contracts/whiteboard-tiles.ts';
import { boardIndexOf, usedBoxChangesOf, usedWireStylesOf } from './whiteboard-board-index.ts';
import {
  boxOverlapWarning, chromeAround, contentBoundsOf, coveredTitleWarning, elementSignature, frameTitleStripOf, headerRectOf, innerWireExtentsOf, isAsideBox, laidOutBox, laidOutFrameOf, laidOutStrokeOf, wireEndingAtCard, wireShiftedBy,
  placingBoardWithMemory, legendEntriesFrom, stepBandOf, titleCutWarningOf, titleObstacleOf, wireCeilingOf,
} from './whiteboard-layout-core.ts';
import type { PlacedLayout, Rect } from './whiteboard-layout-core.ts';
import type { PlanStep } from './whiteboard-plan-core.ts';
import { cappedWarningLists, inflated, warningListOf, warningOf, obstacleRectsByKey, pointsOfPath, rectsOverlap, rotatedBoundsOf, routingWires, unionOf, wireExtentOf } from './whiteboard-route-core.ts';
import type { AreaObstacles, Point, RememberedRoute, RouteInput, RouteMemory, RouteResult, SoftObstacle, WarningList } from './whiteboard-route-core.ts';
import { createSpatialGrid, forEachSlotTouching, placeSlot, removeSlot } from './spatial-grid-core.ts';
import type { SpatialGrid } from './spatial-grid-core.ts';
import { CLEARANCE } from './whiteboard-visibility-core.ts';
import { drained } from './generator-steps.ts';

const INCREMENTAL_MIN_ELEMENTS = 2000;
const SOLID_CELL_SIZE = 1024;
const WIRE_CELL_SIZE = 1024;
const MAX_CONTEXT_ROUNDS = 4;
const NO_PLAN_STEPS: ReadonlyMap<string, PlanStep> = new Map();

interface IdGrid {
  grid: SpatialGrid;
  slotById: Map<string, number>;
  idBySlot: string[];
  freeSlots: number[];
}

interface WarningBook {
  warningByText: Map<string, LayoutWarning>;
  textsById: Map<string, Set<string>>;
  changeByText: Map<string, { warning: LayoutWarning; isPresent: boolean }>;
}

interface WarningChange {
  book: 'route' | 'placement';
  warning: LayoutWarning;
  isPresent: boolean;
}

interface WorldChanges {
  routeIds: string[];
  warnings: WarningChange[];
}

interface SavedWorldParts {
  routeById: ReadonlyMap<string, RememberedRoute>;
  routeWarnings: readonly LayoutWarning[];
  placementWarnings: readonly LayoutWarning[];
}

interface SavedWorld extends SavedWorldParts {
  laidOut: readonly PlacedElement[];
  chrome: Omit<PlacedLayout, 'elements' | 'warnings'>;
}

interface ElementChange {
  before: Element | undefined;
  after: Element | null;
  isAppended: boolean;
}

interface LayoutDelta {
  changed: PlacedElement[];
  previousById: Map<string, PlacedElement>;
  removedIds: string[];
  isChromeChanged: boolean;
  isRebuilt: boolean;
  worldChanges: WorldChanges;
}

interface LayoutWorld {
  lineage: number;
  version: number;
  board: Board;
  minIncrementalElements: number;
  laidOutById: Map<string, PlacedElement>;
  boxGrid: IdGrid;
  softGrid: IdGrid;
  frameGrid: IdGrid;
  wireGrid: IdGrid;
  inkGrid: IdGrid;
  routeMemory: RouteMemory;
  changedRouteIds: Set<string>;
  routeWarnings: WarningBook;
  placementWarnings: WarningBook;
  unbookedWarningLists: { route: readonly WarningList[]; placement: readonly WarningList[] } | null;
  isBuiltWithoutGrids: boolean;
  pinnedOffsetY: number;
  contentTop: number;
  boxesTop: number;
  planColumns: PlanColumn[];
  around: Rect | null;
  chrome: Omit<PlacedLayout, 'elements' | 'warnings'>;
  layout: PlacedLayout | null;
}

function createIdGrid(cellSize: number): IdGrid {
  return { grid: createSpatialGrid(cellSize), slotById: new Map(), idBySlot: [], freeSlots: [] };
}

function placeId(idGrid: IdGrid, id: string, rect: Rect): void {
  const knownSlot = idGrid.slotById.get(id);
  const slot = knownSlot ?? idGrid.freeSlots.pop() ?? idGrid.idBySlot.length;
  idGrid.slotById.set(id, slot);
  idGrid.idBySlot[slot] = id;
  placeSlot(idGrid.grid, slot, rect);
}

function dropId(idGrid: IdGrid, id: string): void {
  const slot = idGrid.slotById.get(id);
  if (slot === undefined) return;
  removeSlot(idGrid.grid, slot);
  idGrid.slotById.delete(id);
  idGrid.freeSlots.push(slot);
}

function forEachIdTouching(idGrid: IdGrid, rect: Rect, visit: (id: string) => void): void {
  forEachSlotTouching(idGrid.grid, rect, (slot) => {
    const id = idGrid.idBySlot[slot];
    if (id !== undefined && idGrid.slotById.get(id) === slot) visit(id);
  });
}

function* unioningStored(idGrid: IdGrid, around: Rect | null, elementsPerSlice: number): Generator<void, Rect | null> {
  const { grid } = idGrid;
  let union = around;
  let unitedSinceYield = 0;
  for (const slot of idGrid.slotById.values()) {
    const minX = grid.minX[slot] ?? 0;
    const minY = grid.minY[slot] ?? 0;
    union = unionOf([...(union ? [union] : []), { x: minX, y: minY, width: (grid.maxX[slot] ?? 0) - minX, height: (grid.maxY[slot] ?? 0) - minY }]);
    unitedSinceYield += 1;
    if (unitedSinceYield < elementsPerSlice) continue;
    unitedSinceYield = 0;
    yield;
  }
  return union;
}

function* inSlices<Item>(items: Iterable<Item>, elementsPerSlice: number, visit: (item: Item) => void): Generator<void, void> {
  let visitedSinceYield = 0;
  for (const item of items) {
    visit(item);
    visitedSinceYield += 1;
    if (visitedSinceYield < elementsPerSlice) continue;
    visitedSinceYield = 0;
    yield;
  }
}

function createWarningBook(): WarningBook {
  return { warningByText: new Map(), textsById: new Map(), changeByText: new Map() };
}

function isPairWithOutsider(warning: LayoutWarning, id: string, insiders: ReadonlyMap<string, unknown>): boolean {
  if (warning.kind !== 'pair') return false;
  const otherId = warning.elementIds.find((elementId) => elementId !== id);
  return otherId !== undefined && !insiders.has(otherId);
}

function noteWarningChange(book: WarningBook, warning: LayoutWarning, isPresent: boolean): void {
  book.changeByText.delete(warning.text);
  book.changeByText.set(warning.text, { warning, isPresent });
}

function addWarning(book: WarningBook, warning: LayoutWarning): void {
  const { text } = warning;
  if (book.warningByText.has(text)) return;
  if (warning.mirrorText !== null && book.warningByText.has(warning.mirrorText)) return;
  book.warningByText.set(text, warning);
  noteWarningChange(book, warning, true);
  for (const id of warning.elementIds) {
    const texts = book.textsById.get(id) ?? new Set<string>();
    texts.add(text);
    book.textsById.set(id, texts);
  }
}

function dropWarning(book: WarningBook, text: string): void {
  const warning = book.warningByText.get(text);
  if (!warning) return;
  book.warningByText.delete(text);
  noteWarningChange(book, warning, false);
  for (const id of warning.elementIds) {
    const texts = book.textsById.get(id);
    texts?.delete(text);
    if (texts?.size === 0) book.textsById.delete(id);
  }
}

function dropWarningsMentioning(book: WarningBook, id: string, accepts: (warning: LayoutWarning) => boolean = () => true): void {
  for (const text of [...book.textsById.get(id) ?? []]) {
    const warning = book.warningByText.get(text);
    if (warning && accepts(warning)) dropWarning(book, text);
  }
}

function* addingWarningLists(book: WarningBook, lists: readonly WarningList[], warningsPerSlice: number): Generator<void, void> {
  let addedSinceYield = 0;
  for (const list of lists) {
    for (let index = 0; index < list.count; index += 1) {
      addWarning(book, list.warningAt(index));
      addedSinceYield += 1;
      if (addedSinceYield < warningsPerSlice) continue;
      addedSinceYield = 0;
      yield;
    }
  }
}

function addWarningLists(book: WarningBook, lists: readonly WarningList[]): void {
  drained(addingWarningLists(book, lists, Number.POSITIVE_INFINITY));
}

function firstTextsOf(book: WarningBook, count: number): string[] {
  const texts: string[] = [];
  for (const text of book.warningByText.keys()) {
    if (texts.length >= count) break;
    texts.push(text);
  }
  return texts;
}

function warningsOf(world: LayoutWorld): string[] {
  const books = [world.routeWarnings, world.placementWarnings];
  return cappedWarningLists(books.map((book) => {
    const shown = firstTextsOf(book, WHITEBOARD_LIMITS.layoutWarnings);
    return { count: book.warningByText.size, warningAt: (index: number) => book.warningByText.get(shown[index] ?? '') ?? warningOf('') };
  }));
}

function obstacleRectOf(element: PlacedElement): Rect | null {
  if (element.kind === 'wire') return null;
  if (element.kind === 'frame') return element.titleObstacle;
  return rotatedBoundsOf(element);
}

function extentOf(element: PlacedElement): Rect | null {
  return element.kind === 'wire' ? wireExtentOf(element) : rotatedBoundsOf(element);
}

function isOnEdge(rect: Rect, around: Rect): boolean {
  return rect.x <= around.x || rect.y <= around.y || rect.x + rect.width >= around.x + around.width || rect.y + rect.height >= around.y + around.height;
}

function storeLaidOut(world: LayoutWorld, element: PlacedElement): void {
  world.laidOutById.set(element.id, element);
  if (element.kind === 'box') placeId(world.boxGrid, element.id, rotatedBoundsOf(element));
  if (element.kind === 'stroke') placeId(world.inkGrid, element.id, element);
  if (element.kind === 'frame') {
    placeId(world.softGrid, element.id, element.titleObstacle);
    placeId(world.frameGrid, element.id, element);
  }
  const wireExtent = element.kind === 'wire' ? wireExtentOf(element) : null;
  if (wireExtent) placeId(world.wireGrid, element.id, wireExtent);
}

function forgetLaidOut(world: LayoutWorld, id: string): void {
  world.laidOutById.delete(id);
  dropId(world.boxGrid, id);
  dropId(world.softGrid, id);
  dropId(world.frameGrid, id);
  dropId(world.wireGrid, id);
  dropId(world.inkGrid, id);
}

function* recomputingAround(world: LayoutWorld, elementsPerSlice: number): Generator<void, Rect | null> {
  let around: Rect | null = headerRectOf(world.boxesTop);
  for (const idGrid of [world.boxGrid, world.softGrid, world.frameGrid, world.wireGrid, world.inkGrid]) around = yield* unioningStored(idGrid, around, elementsPerSlice);
  return around;
}

function recomputedAround(world: LayoutWorld): Rect | null {
  return drained(recomputingAround(world, Number.POSITIVE_INFINITY));
}

function chromeOfWorld(world: LayoutWorld, board: Board): Omit<PlacedLayout, 'elements' | 'warnings'> {
  const index = boardIndexOf(board.elements);
  const legend = legendEntriesFrom(board.legend, usedWireStylesOf(index), usedBoxChangesOf(index), index.stepBoxIds.size > 0);
  return chromeAround(board.caption, contentBoundsOf(world.around), legend, world.planColumns, world.pinnedOffsetY);
}

let lastLineage = 0;

function emptyWorld(board: Board, minIncrementalElements: number): LayoutWorld {
  lastLineage += 1;
  return {
    lineage: lastLineage, version: board.version, board, minIncrementalElements, laidOutById: new Map(),
    boxGrid: createIdGrid(SOLID_CELL_SIZE), softGrid: createIdGrid(SOLID_CELL_SIZE), frameGrid: createIdGrid(SOLID_CELL_SIZE), wireGrid: createIdGrid(WIRE_CELL_SIZE), inkGrid: createIdGrid(SOLID_CELL_SIZE),
    routeMemory: { contentTop: 0, rectByKey: new Map(), routeById: new Map(), warningPairs: null }, changedRouteIds: new Set(),
    routeWarnings: createWarningBook(), placementWarnings: createWarningBook(), unbookedWarningLists: null, isBuiltWithoutGrids: false,
    pinnedOffsetY: 0, contentTop: 0, boxesTop: 0, planColumns: [], around: null,
    chrome: { legend: [], caption: null, plan: null, pinnedOffsetY: 0, bounds: { x: 0, y: 0, width: 0, height: 0 } }, layout: null,
  };
}


interface WorldParts {
  laidOut: readonly PlacedElement[];
  chrome: Omit<PlacedLayout, 'elements' | 'warnings'>;
  routeMemory: RouteMemory;
  warningLists: readonly WarningList[];
}

function* buildingWorld(board: Board, { laidOut, chrome, routeMemory, warningLists }: WorldParts, minIncrementalElements: number, elementsPerSlice: number): Generator<void, LayoutWorld> {
  const world = emptyWorld(board, minIncrementalElements);
  const freeformTop = stepBandOf(board).bottom;
  world.routeMemory = routeMemory;
  world.chrome = chrome;
  world.pinnedOffsetY = chrome.pinnedOffsetY;
  world.boxesTop = freeformTop;
  world.contentTop = wireCeilingOf(freeformTop);
  world.planColumns = chrome.plan?.columns ?? [];
  if (boardIndexOf(board.elements).elementCount < minIncrementalElements) {
    for (const element of laidOut) world.laidOutById.set(element.id, element);
    world.unbookedWarningLists = { route: warningLists.slice(0, -1), placement: warningLists.slice(-1) };
    world.isBuiltWithoutGrids = true;
    return world;
  }
  yield* inSlices(laidOut, elementsPerSlice, (element) => storeLaidOut(world, element));
  yield* addingWarningLists(world.routeWarnings, warningLists.slice(0, -1), elementsPerSlice);
  yield* addingWarningLists(world.placementWarnings, warningLists.slice(-1), elementsPerSlice);
  world.around = yield* recomputingAround(world, elementsPerSlice);
  return world;
}

function* rebuildingWorld(board: Board, previous: LayoutWorld | null, minIncrementalElements: number, elementsPerSlice: number): Generator<void, LayoutWorld> {
  const { layout, memory, warningLists } = yield* placingBoardWithMemory(board, previous ? { route: previous.routeMemory } : null);
  const chrome = { legend: layout.legend, caption: layout.caption, plan: layout.plan, pinnedOffsetY: layout.pinnedOffsetY, bounds: layout.bounds };
  const world = yield* buildingWorld(board, { laidOut: layout.elements, chrome, routeMemory: memory.route, warningLists }, minIncrementalElements, elementsPerSlice);
  world.layout = layout;
  return world;
}

function* obstacleRectsInSlices(contentTop: number, laidOut: readonly PlacedElement[], elementsPerSlice: number): Generator<void, Map<string, Rect>> {
  const rectByKey = new Map<string, Rect>();
  for (let start = 0; start < laidOut.length; start += elementsPerSlice) {
    for (const [key, rect] of obstacleRectsByKey(obstacleInputOf(contentTop, laidOut.slice(start, start + elementsPerSlice)))) rectByKey.set(key, rect);
    yield;
  }
  return rectByKey;
}

function* resumingLayoutWorld(board: Board, saved: SavedWorld, elementsPerSlice: number, minIncrementalElements = INCREMENTAL_MIN_ELEMENTS): Generator<void, LayoutWorld> {
  const contentTop = wireCeilingOf(stepBandOf(board).bottom);
  const rectByKey = yield* obstacleRectsInSlices(contentTop, saved.laidOut, elementsPerSlice);
  const routeMemory: RouteMemory = { contentTop, rectByKey, routeById: new Map(saved.routeById), warningPairs: null };
  const warningLists = [warningListOf(saved.routeWarnings), warningListOf(saved.placementWarnings)];
  return yield* buildingWorld(board, { laidOut: saved.laidOut, chrome: saved.chrome, routeMemory, warningLists }, minIncrementalElements, elementsPerSlice);
}

function savedWorldOf(world: LayoutWorld): SavedWorldParts {
  bookUnbookedWarnings(world);
  return { routeById: world.routeMemory.routeById, routeWarnings: [...world.routeWarnings.warningByText.values()], placementWarnings: [...world.placementWarnings.warningByText.values()] };
}

function createLayoutWorld(board: Board, previous: LayoutWorld | null = null, minIncrementalElements = INCREMENTAL_MIN_ELEMENTS): LayoutWorld {
  return drained(rebuildingWorld(board, previous, minIncrementalElements, Number.POSITIVE_INFINITY));
}

function touchesStepBox(element: Element | null | undefined, stepBoxIds: ReadonlySet<string>): boolean {
  if (element?.kind === 'box') return element.step !== null || isAsideBox(element);
  if (element?.kind === 'wire') return boxIdsOfWire(element).some((boxId) => stepBoxIds.has(boxId));
  return false;
}

function isInStack(board: Board, boxId: string): boolean {
  return dependentsOfKind(board, boxId, 'frame').some((frame) => frame.collapsed);
}

function cardIdOf(board: Board, boxId: string): string {
  return dependentsOfKind(board, boxId, 'frame').find((frame) => frame.collapsed)?.contains[0] ?? boxId;
}

function touchesStack(board: Board, element: Element | null | undefined): boolean {
  if (!element) return false;
  if (element.kind === 'frame') return element.collapsed;
  if (element.kind === 'box') return isInStack(board, element.id);
  if (element.kind === 'wire') return boxIdsOfWire(element).some((boxId) => isInStack(board, boxId));
  return false;
}

function needsRebuild(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>): boolean {
  const index = boardIndexOf(board.elements);
  if (world.version !== board.version - 1 || index.elementCount < world.minIncrementalElements || world.isBuiltWithoutGrids || world.laidOutById.size === 0) return true;
  for (const change of changes.values()) {
    if (change.isAppended && change.before) return true;
    if (touchesStepBox(change.before, index.stepBoxIds) || touchesStepBox(change.after, index.stepBoxIds)) return true;
    if (touchesStack(board, change.before) || touchesStack(board, change.after)) return true;
    const isSolidChange = change.before?.kind === 'box' || change.after?.kind === 'box';
    if (isSolidChange && index.asideBoxCount > 0) return true;
  }
  return false;
}

function dirtyBoxIdsOf(changes: ReadonlyMap<string, ElementChange>): Set<string> {
  return new Set([...changes].flatMap(([id, change]) => (change.before?.kind === 'box' || change.after?.kind === 'box' ? [id] : [])));
}

function placedDirtyBoxes(world: LayoutWorld, board: Board, dirtyIds: ReadonlySet<string>): Map<string, PlacedBox | null> | null {
  const placedById = new Map<string, PlacedBox | null>();
  for (const id of dirtyIds) {
    const box = board.elements.get(id);
    if (box?.kind !== 'box') {
      placedById.set(id, null);
      continue;
    }
    const point = pointOfBox(box);
    if (!point) return null;
    placedById.set(id, laidOutBox(NO_PLAN_STEPS, box, { x: point.x, y: point.y + world.pinnedOffsetY }));
  }
  return placedById;
}

function dependentsOfKind<Kind extends Element['kind']>(board: Board, boxId: string, kind: Kind): Extract<Element, { kind: Kind }>[] {
  const found: Extract<Element, { kind: Kind }>[] = [];
  for (const id of boardIndexOf(board.elements).dependentIdsByBoxId.get(boxId) ?? []) {
    const element = board.elements.get(id);
    if (element && hasKind(element, kind)) found.push(element);
  }
  return found;
}

function hasKind<Kind extends Element['kind']>(element: Element, kind: Kind): element is Extract<Element, { kind: Kind }> {
  return element.kind === kind;
}

interface SolidOutcome {
  nextById: Map<string, PlacedElement | null>;
  dirtyBoxIds: Set<string>;
  dirtyFrameIds: Set<string>;
}

function laidOutSolids(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>): SolidOutcome | null {
  const dirtyBoxIds = dirtyBoxIdsOf(changes);
  for (const boxId of dirtyBoxIds) {
    if (isInStack(board, boxId)) return null;
  }
  const placedBoxes = placedDirtyBoxes(world, board, dirtyBoxIds);
  if (!placedBoxes) return null;
  const nextById = new Map<string, PlacedElement | null>(placedBoxes);
  const boxNow = (id: string): PlacedBox | null => {
    if (placedBoxes.has(id)) return placedBoxes.get(id) ?? null;
    const known = world.laidOutById.get(id);
    return known?.kind === 'box' ? known : null;
  };
  const dirtyFrameIds = new Set<string>();
  for (const [id, change] of changes) {
    if (change.before?.kind === 'frame' || change.after?.kind === 'frame') dirtyFrameIds.add(id);
    if (change.before?.kind === 'stroke' || change.after?.kind === 'stroke') nextById.set(id, change.after?.kind === 'stroke' ? laidOutStrokeOf(change.after, world.pinnedOffsetY) : null);
  }
  for (const boxId of dirtyBoxIds) {
    for (const frame of dependentsOfKind(board, boxId, 'frame')) dirtyFrameIds.add(frame.id);
  }
  for (const frameId of dirtyFrameIds) {
    const frame = board.elements.get(frameId);
    if (!frame || !hasKind(frame, 'frame')) {
      nextById.set(frameId, null);
      continue;
    }
    const containedById = new Map(frame.contains.flatMap((id) => {
      const box = boxNow(id);
      return box ? [[id, box] as const] : [];
    }));
    nextById.set(frameId, laidOutFrameOf(frame, containedById, []));
  }
  return { nextById, dirtyBoxIds, dirtyFrameIds };
}

type SolidElement = Exclude<PlacedElement, LaidOutWire>;

interface Commit {
  previousById: Map<string, PlacedElement>;
  changed: PlacedElement[];
  removedIds: string[];
  oldObstacles: SolidElement[];
  newObstacles: SolidElement[];
  isAroundStale: boolean;
}

function isSameGeometry(first: Rect | null, second: Rect | null): boolean {
  if (!first || !second) return first === second;
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

function commitElement(world: LayoutWorld, commit: Commit, id: string, next: PlacedElement | null): void {
  const previous = world.laidOutById.get(id);
  if (!previous && !next) return;
  if (previous && next && elementSignature(previous) === elementSignature(next)) return;
  if (previous) {
    if (!commit.previousById.has(id)) commit.previousById.set(id, previous);
    forgetLaidOut(world, id);
    const previousExtent = extentOf(previous);
    if (previousExtent && world.around && isOnEdge(previousExtent, world.around)) commit.isAroundStale = true;
  }
  const previousObstacle = previous ? obstacleRectOf(previous) : null;
  const nextObstacle = next ? obstacleRectOf(next) : null;
  if (!isSameGeometry(previousObstacle, nextObstacle)) {
    if (previous && previous.kind !== 'wire') commit.oldObstacles.push(previous);
    if (next && next.kind !== 'wire') commit.newObstacles.push(next);
  }
  if (!next) {
    commit.removedIds.push(id);
    return;
  }
  storeLaidOut(world, next);
  commit.changed.push(next);
  const nextExtent = extentOf(next);
  if (nextExtent && !commit.isAroundStale) world.around = unionOf([...(world.around ? [world.around] : []), nextExtent]);
}

function boxesTouching(world: LayoutWorld, rect: Rect): PlacedBox[] {
  const boxes: PlacedBox[] = [];
  forEachIdTouching(world.boxGrid, rect, (id) => {
    const box = world.laidOutById.get(id);
    if (box?.kind === 'box') boxes.push(box);
  });
  return boxes;
}

function softRectsTouching(world: LayoutWorld, rect: Rect): Rect[] {
  const softRects: Rect[] = [];
  forEachIdTouching(world.softGrid, rect, (id) => {
    const soft = world.laidOutById.get(id);
    const obstacle = soft ? obstacleRectOf(soft) : null;
    if (obstacle) softRects.push(obstacle);
  });
  return softRects;
}

function updatePlacementWarnings(world: LayoutWorld, board: Board, solids: SolidOutcome): void {
  const book = world.placementWarnings;
  for (const id of [...solids.dirtyBoxIds, ...solids.dirtyFrameIds]) dropWarningsMentioning(book, id);
  const checkedBoxIds = new Set<string>();
  for (const boxId of solids.dirtyBoxIds) {
    const box = world.laidOutById.get(boxId);
    if (box?.kind !== 'box') continue;
    checkedBoxIds.add(boxId);
    for (const other of boxesTouching(world, box)) {
      if (other.id !== boxId && !checkedBoxIds.has(other.id) && rectsOverlap(box, other)) addWarning(book, boxOverlapWarning(boxId, other.id));
    }
    forEachIdTouching(world.frameGrid, box, (frameId) => solids.dirtyFrameIds.add(frameId));
    const stored = board.elements.get(boxId);
    const titleCutWarning = stored?.kind === 'box' ? titleCutWarningOf(stored) : null;
    if (titleCutWarning) addWarning(book, titleCutWarning);
  }
  for (const frameId of solids.dirtyFrameIds) {
    const frame = world.laidOutById.get(frameId);
    const stored = board.elements.get(frameId);
    if (frame?.kind !== 'frame' || stored?.kind !== 'frame') continue;
    const containedIds = new Set(stored.contains);
    const strip = frameTitleStripOf(frame);
    for (const box of boxesTouching(world, strip)) {
      if (!containedIds.has(box.id) && rectsOverlap(box, strip)) addWarning(book, coveredTitleWarning(box.id, frameId));
    }
  }
}

function segmentRectsOf(wire: LaidOutWire): Rect[] {
  const points = pointsOfPath(wire.path);
  return points.slice(1).flatMap((point, index) => {
    const previous = points[index];
    if (!previous) return [];
    return [{ x: Math.min(previous.x, point.x), y: Math.min(previous.y, point.y), width: Math.abs(previous.x - point.x), height: Math.abs(previous.y - point.y) }];
  });
}

function wireIdsOn(board: Board, boxId: string): string[] {
  return dependentsOfKind(board, boxId, 'wire').map((wire) => wire.id);
}

function endpointIdsOf(board: Board, wireIds: Iterable<string>): Set<string> {
  const endpointIds = new Set<string>();
  for (const id of wireIds) {
    const wire = board.elements.get(id);
    if (wire?.kind !== 'wire') continue;
    for (const boxId of boxIdsOfWire(wire)) endpointIds.add(boxId);
  }
  return endpointIds;
}

function isSamePoint(first: Point, second: Point): boolean {
  return first.x === second.x && first.y === second.y;
}

interface SubRoute {
  routedWires: Map<string, LaidOutWire>;
  result: RouteResult;
  completeBoxIds: Set<string>;
}

function routeInputOver(world: LayoutWorld, board: Board, rerouteIds: ReadonlySet<string>, contextIds: ReadonlySet<string>): RouteInput {
  const boxesById = new Map<string, PlacedBox>();
  const softById = new Map<string, SoftObstacle>();
  const addBox = (id: string) => {
    const box = world.laidOutById.get(id);
    if (box?.kind === 'box') boxesById.set(id, box);
  };
  for (const id of endpointIdsOf(board, [...rerouteIds, ...contextIds])) addBox(cardIdOf(board, id));
  const areas = [...rerouteIds].flatMap((id) => {
    const laidOut = world.laidOutById.get(id);
    return laidOut?.kind === 'wire' ? segmentRectsOf(laidOut).map((rect) => inflated(rect, CLEARANCE)) : [];
  });
  areas.push(...[...boxesById.values()].map((box) => inflated(box, CLEARANCE)));
  for (const area of areas) {
    for (const box of boxesTouching(world, area)) boxesById.set(box.id, box);
    forEachIdTouching(world.softGrid, area, (id) => {
      const soft = world.laidOutById.get(id);
      if (soft?.kind === 'frame') softById.set(id, titleObstacleOf(soft, board.elements.get(id)));
    });
  }
  const wiresOf = (ids: ReadonlySet<string>) => [...ids].flatMap((id) => {
    const wire = board.elements.get(id);
    if (wire?.kind !== 'wire') return [];
    return wireEndingAtCard(wireShiftedBy(wire, world.pinnedOffsetY), (boxId) => cardIdOf(board, boxId)) ?? [];
  });
  return {
    wires: wiresOf(rerouteIds), contextWires: wiresOf(contextIds), boxesById, softObstacles: [...softById.values()], contentTop: world.contentTop,
    obstaclesIn: (area): AreaObstacles => ({ hardRects: boxesTouching(world, area), softRects: softRectsTouching(world, area) }),
    storedWireKeyOf: (wire) => board.elements.bodyOf(wire.id),
  };
}

function rectKeyOf(rect: Rect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

function softRectsOf(elements: readonly PlacedElement[]): SoftObstacle[] {
  return elements.flatMap((element) => (element.kind === 'frame' ? [titleObstacleOf(element, undefined)] : []));
}

function previousInputOf(input: RouteInput, commit: Commit): RouteInput {
  const movedIds = new Set([...commit.oldObstacles, ...commit.newObstacles].map((element) => element.id));
  const boxesById = new Map<string, PlacedBox>();
  for (const [id, box] of input.boxesById) {
    if (!movedIds.has(id)) boxesById.set(id, box);
  }
  for (const element of commit.oldObstacles) {
    if (element.kind === 'box') boxesById.set(element.id, element);
  }
  const newSoftKeys = new Set(softRectsOf(commit.newObstacles).map(rectKeyOf));
  const softObstacles = [...input.softObstacles.filter((rect) => !newSoftKeys.has(rectKeyOf(rect))), ...softRectsOf(commit.oldObstacles)];
  return { ...input, boxesById, softObstacles };
}

function changedSegmentRectsOf(world: LayoutWorld, rerouteIds: ReadonlySet<string>, routedWires: ReadonlyMap<string, LaidOutWire>): Rect[] {
  return [...rerouteIds].flatMap((id) => {
    const previous = world.laidOutById.get(id);
    const next = routedWires.get(id);
    if (previous && next && elementSignature(previous) === elementSignature(next)) return [];
    return [...(previous?.kind === 'wire' ? segmentRectsOf(previous) : []), ...(next ? segmentRectsOf(next) : [])];
  });
}

function pathNeighborIdsOf(world: LayoutWorld, rerouteIds: ReadonlySet<string>, routedWires: ReadonlyMap<string, LaidOutWire>): string[] {
  const neighborIds = new Set<string>();
  for (const changedRect of changedSegmentRectsOf(world, rerouteIds, routedWires)) {
    const touchArea = inflated(changedRect, 14);
    forEachIdTouching(world.wireGrid, touchArea, (id) => {
      if (rerouteIds.has(id) || neighborIds.has(id)) return;
      const wire = world.laidOutById.get(id);
      if (wire?.kind === 'wire' && segmentRectsOf(wire).some((rect) => rectsOverlap(rect, touchArea))) neighborIds.add(id);
    });
  }
  return [...neighborIds];
}

function* routingSubBoard(world: LayoutWorld, board: Board, seedIds: ReadonlySet<string>, commit: Commit): Generator<void, SubRoute | null> {
  const rerouteIds = new Set(seedIds);
  for (const boxId of endpointIdsOf(board, seedIds)) {
    for (const wireId of wireIdsOn(board, boxId)) rerouteIds.add(wireId);
  }
  let previousRound: RouteMemory | null = null;
  for (let round = 0; round < MAX_CONTEXT_ROUNDS; round += 1) {
    const completeBoxIds = endpointIdsOf(board, rerouteIds);
    const contextIds = new Set([...completeBoxIds].flatMap((boxId) => wireIdsOn(board, boxId)).filter((wireId) => !rerouteIds.has(wireId)));
    const input = routeInputOver(world, board, rerouteIds, contextIds);
    const memory: RouteMemory = previousRound
      ? { contentTop: world.contentTop, rectByKey: obstacleRectsByKey(input), routeById: new Map([...world.routeMemory.routeById, ...previousRound.routeById]), warningPairs: null }
      : { contentTop: world.contentTop, rectByKey: obstacleRectsByKey(previousInputOf(input, commit)), routeById: world.routeMemory.routeById, warningPairs: null };
    const result = yield* routingWires(input, memory);
    const reroutedBusKeys = new Set([...rerouteIds].flatMap((id) => result.portEndsById.get(id)?.busKey ?? []));
    const promotedIds = [...contextIds].filter((id) => {
      const ends = result.portEndsById.get(id);
      const remembered = world.routeMemory.routeById.get(id);
      const wire = board.elements.get(id);
      if (!ends || !remembered || wire?.kind !== 'wire') return true;
      if (ends.busKey !== null && reroutedBusKeys.has(ends.busKey)) return true;
      const isCompleteEnd = (end: typeof wire.from) => completeBoxIds.has(boxIdOfEnd(end) ?? '');
      return (isCompleteEnd(wire.from) && !isSamePoint(ends.start, remembered.start)) || (isCompleteEnd(wire.to) && !isSamePoint(ends.end, remembered.end));
    });
    const routedWires = new Map(result.wires.map((wire) => [wire.id, wire]));
    const neighborIds = pathNeighborIdsOf(world, rerouteIds, routedWires);
    if ((promotedIds.length === 0 && neighborIds.length === 0) || round === MAX_CONTEXT_ROUNDS - 1) return { routedWires, result, completeBoxIds };
    for (const id of [...promotedIds, ...neighborIds]) rerouteIds.add(id);
    previousRound = result.memory;
  }
  return null;
}

function obstacleInputOf(contentTop: number, elements: readonly PlacedElement[]): RouteInput {
  return {
    wires: [], contentTop,
    boxesById: new Map(elements.flatMap((element) => (element.kind === 'box' ? [[element.id, rotatedBoundsOf(element)] as const] : []))),
    softObstacles: softRectsOf(elements),
  };
}

function rememberObstacles(world: LayoutWorld, commit: Commit): void {
  for (const key of obstacleRectsByKey(obstacleInputOf(world.contentTop, commit.oldObstacles)).keys()) world.routeMemory.rectByKey.delete(key);
  for (const [key, rect] of obstacleRectsByKey(obstacleInputOf(world.contentTop, commit.newObstacles))) world.routeMemory.rectByKey.set(key, rect);
  world.routeMemory.warningPairs = null;
}

function* reroutingWires(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>, solids: SolidOutcome, commit: Commit): Generator<void, void> {
  const seedIds = new Set<string>();
  const removedWireIds: string[] = [];
  for (const [id, change] of changes) {
    if (change.after?.kind === 'wire') seedIds.add(id);
    if (change.after?.kind !== 'wire' && change.before?.kind === 'wire') removedWireIds.push(id);
  }
  for (const boxId of solids.dirtyBoxIds) {
    for (const wireId of wireIdsOn(board, boxId)) seedIds.add(wireId);
  }
  for (const obstacle of [...commit.oldObstacles, ...commit.newObstacles]) {
    const rect = obstacleRectOf(obstacle);
    if (!rect) continue;
    forEachIdTouching(world.wireGrid, inflated(rect, CLEARANCE), (wireId) => seedIds.add(wireId));
  }
  for (const id of removedWireIds) {
    commitElement(world, commit, id, null);
    world.routeMemory.routeById.delete(id);
    world.changedRouteIds.add(id);
    dropWarningsMentioning(world.routeWarnings, id);
  }
  for (const id of [...solids.dirtyBoxIds, ...solids.dirtyFrameIds]) {
    if (!world.laidOutById.has(id)) dropWarningsMentioning(world.routeWarnings, id);
  }
  for (const element of [...commit.oldObstacles, ...commit.newObstacles]) dropWarningsMentioning(world.routeWarnings, element.id);
  if (seedIds.size === 0) return;
  const routed = yield* routingSubBoard(world, board, seedIds, commit);
  if (!routed) return;
  for (const [id, remembered] of routed.result.memory.routeById) {
    world.routeMemory.routeById.set(id, remembered);
    world.changedRouteIds.add(id);
  }
  for (const id of seedIds) {
    if (routed.routedWires.has(id)) continue;
    world.routeMemory.routeById.delete(id);
    world.changedRouteIds.add(id);
    dropWarningsMentioning(world.routeWarnings, id);
  }
  for (const [id, wire] of routed.routedWires) {
    const previous = world.laidOutById.get(id);
    const isMoved = !previous || elementSignature(previous) !== elementSignature(wire);
    dropWarningsMentioning(world.routeWarnings, id, (warning) => isMoved || !isPairWithOutsider(warning, id, routed.routedWires));
  }
  for (const boxId of routed.completeBoxIds) dropWarningsMentioning(world.routeWarnings, boxId, (warning) => warning.kind === 'crowded-side');
  for (const [id, wire] of routed.routedWires) commitElement(world, commit, id, wire);
  for (const id of seedIds) {
    if (!routed.routedWires.has(id)) commitElement(world, commit, id, null);
  }
  addWarningLists(world.routeWarnings, routed.result.collectWarnings());
}

function framesToRefit(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>, solids: SolidOutcome): Extract<Element, { kind: 'frame' }>[] {
  const frameIds = new Set(solids.dirtyFrameIds);
  for (const wireId of world.changedRouteIds) {
    for (const wire of [board.elements.get(wireId), changes.get(wireId)?.before]) {
      if (wire?.kind !== 'wire') continue;
      for (const boxId of boxIdsOfWire(wire)) {
        for (const frame of dependentsOfKind(board, boxId, 'frame')) frameIds.add(frame.id);
      }
    }
  }
  return [...frameIds].flatMap((frameId) => {
    const frame = board.elements.get(frameId);
    return frame?.kind === 'frame' && !frame.collapsed ? [frame] : [];
  });
}

function refitFramesAroundInnerWires(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>, solids: SolidOutcome, commit: Commit): void {
  const frames = framesToRefit(world, board, changes, solids);
  const wiresOnFrameBoxes = new Map<string, LaidOutWire>();
  for (const frame of frames) {
    for (const boxId of frame.contains) {
      for (const wireId of wireIdsOn(board, boxId)) {
        const laidOut = world.laidOutById.get(wireId);
        if (laidOut?.kind === 'wire') wiresOnFrameBoxes.set(wireId, laidOut);
      }
    }
  }
  const extentsByFrameId = innerWireExtentsOf(frames, board, [...wiresOnFrameBoxes.values()]);
  for (const frame of frames) {
    const containedById = new Map(frame.contains.flatMap((boxId) => {
      const box = world.laidOutById.get(boxId);
      return box?.kind === 'box' ? [[boxId, box] as const] : [];
    }));
    commitElement(world, commit, frame.id, laidOutFrameOf(frame, containedById, extentsByFrameId.get(frame.id) ?? []));
    solids.dirtyFrameIds.add(frame.id);
  }
}

function worldChangesOf(world: LayoutWorld): WorldChanges {
  const changesIn = (book: WarningBook, name: WarningChange['book']) => [...book.changeByText.values()].map(({ warning, isPresent }) => ({ book: name, warning, isPresent }));
  return { routeIds: [...world.changedRouteIds], warnings: [...changesIn(world.routeWarnings, 'route'), ...changesIn(world.placementWarnings, 'placement')] };
}

function forgetWorldChanges(world: LayoutWorld): void {
  world.changedRouteIds.clear();
  world.routeWarnings.changeByText.clear();
  world.placementWarnings.changeByText.clear();
}

function* applyingIncrementally(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>): Generator<void, LayoutDelta | null> {
  const solids = laidOutSolids(world, board, changes);
  if (!solids) return null;
  forgetWorldChanges(world);
  const commit: Commit = { previousById: new Map(), changed: [], removedIds: [], oldObstacles: [], newObstacles: [], isAroundStale: false };
  for (const [id, next] of solids.nextById) commitElement(world, commit, id, next);
  yield* reroutingWires(world, board, changes, solids, commit);
  refitFramesAroundInnerWires(world, board, changes, solids, commit);
  updatePlacementWarnings(world, board, solids);
  rememberObstacles(world, commit);
  if (commit.isAroundStale) world.around = recomputedAround(world);
  const previousChrome = JSON.stringify(world.chrome);
  world.chrome = chromeOfWorld(world, board);
  world.version = board.version;
  world.board = board;
  world.layout = null;
  const removedIds = commit.removedIds.filter((id) => !world.laidOutById.has(id));
  return { changed: commit.changed.filter((element) => world.laidOutById.get(element.id) === element), previousById: commit.previousById, removedIds, isChromeChanged: JSON.stringify(world.chrome) !== previousChrome, isRebuilt: false, worldChanges: worldChangesOf(world) };
}

function* applyingLayoutDelta(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>, elementsPerSlice: number): Generator<void, { world: LayoutWorld; delta: LayoutDelta }> {
  const incremental = needsRebuild(world, board, changes) ? null : yield* applyingIncrementally(world, board, changes);
  if (incremental) return { world, delta: incremental };
  const rebuilt = yield* rebuildingWorld(board, world, world.minIncrementalElements, elementsPerSlice);
  return { world: rebuilt, delta: { changed: [], previousById: new Map(), removedIds: [], isChromeChanged: true, isRebuilt: true, worldChanges: { routeIds: [], warnings: [] } } };
}

function layoutOf(world: LayoutWorld): PlacedLayout {
  if (world.layout) return world.layout;
  const frames: LaidOutFrame[] = [];
  const wires: LaidOutWire[] = [];
  const pinnedBoxes: PlacedBox[] = [];
  const nearBoxes: PlacedBox[] = [];
  const strokes: LaidOutStroke[] = [];
  for (const element of world.board.elements.values()) {
    const laidOut = world.laidOutById.get(element.id);
    if (laidOut?.kind === 'frame') frames.push(laidOut);
    if (laidOut?.kind === 'wire') wires.push(laidOut);
    if (laidOut?.kind === 'box' && element.kind === 'box' && pointOfBox(element)) pinnedBoxes.push(laidOut);
    if (laidOut?.kind === 'box' && element.kind === 'box' && !pointOfBox(element)) nearBoxes.push(laidOut);
    if (laidOut?.kind === 'stroke') strokes.push(laidOut);
  }
  const layout: PlacedLayout = { elements: [...frames, ...wires, ...pinnedBoxes, ...nearBoxes, ...strokes], ...world.chrome, warnings: warningsOf(world) };
  world.layout = layout;
  return layout;
}

function bookUnbookedWarnings(world: LayoutWorld): void {
  if (!world.unbookedWarningLists) return;
  addWarningLists(world.routeWarnings, world.unbookedWarningLists.route);
  addWarningLists(world.placementWarnings, world.unbookedWarningLists.placement);
  world.unbookedWarningLists = null;
}

function askElementIdsOf(board: Board): Set<string> {
  const askBoxIds = new Set<string>();
  for (const box of board.elements.valuesOfKind('box')) {
    if (box.ask !== null) askBoxIds.add(box.id);
  }
  if (askBoxIds.size === 0) return askBoxIds;
  const askIds = new Set(askBoxIds);
  for (const wire of board.elements.valuesOfKind('wire')) {
    if ((typeof wire.from === 'string' && askBoxIds.has(wire.from)) || (typeof wire.to === 'string' && askBoxIds.has(wire.to))) askIds.add(wire.id);
  }
  return askIds;
}

function warningsNamingOfWorld(world: LayoutWorld, elementIds: readonly string[]): string[] {
  bookUnbookedWarnings(world);
  const askIds = askElementIdsOf(world.board);
  const books = [world.routeWarnings, world.placementWarnings];
  return [...new Set(elementIds.flatMap((elementId) => books.flatMap((book) =>
    [...book.textsById.get(elementId) ?? []].filter((text) => {
      if (askIds.size === 0) return true;
      const warning = book.warningByText.get(text);
      return !warning || !warning.elementIds.some((id) => askIds.has(id));
    }),
  )))];
}

function warningsOfWorld(world: LayoutWorld): string[] {
  return world.layout ? world.layout.warnings : warningsOf(world);
}

export { INCREMENTAL_MIN_ELEMENTS, applyingLayoutDelta, createLayoutWorld, layoutOf, rebuildingWorld, resumingLayoutWorld, savedWorldOf, warningsNamingOfWorld, warningsOfWorld };
export type { ElementChange, LayoutDelta, LayoutWorld, SavedWorld, SavedWorldParts, WarningChange };
