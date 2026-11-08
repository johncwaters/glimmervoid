import { WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, Box, Element } from './contracts/whiteboard.ts';
import type { PlacedBox, PlacedElement, LaidOutFrame, PlacedNote, LaidOutWire, PlanColumn } from './contracts/whiteboard-tiles.ts';
import { boardIndexOf } from './whiteboard-board-index.ts';
import {
  boxOverlapWarning, chromeAround, contentBoundsOf, coveredTitleWarning, elementSignature, frameTitleStripOf, headerRectOf, isInStepBand, laidOutBox, laidOutFrameOf,
  laidOutNearBox, placeBoardWithMemory, legendEntriesFrom, noteStackOn, stepBandOf, wireCeilingOf,
} from './whiteboard-layout-core.ts';
import type { PlacedLayout, Rect } from './whiteboard-layout-core.ts';
import type { PlanStep } from './whiteboard-plan-core.ts';
import { cappedWarningLists, inflated, obstacleRectsByKey, pointsOfPath, rectsOverlap, routeWires, unionOf, wireExtentOf } from './whiteboard-route-core.ts';
import type { AreaObstacles, Point, RememberedRoute, RouteInput, RouteMemory, WarningList } from './whiteboard-route-core.ts';
import { createSpatialGrid, forEachSlotTouching, placeSlot, removeSlot } from './spatial-grid-core.ts';
import type { SpatialGrid } from './spatial-grid-core.ts';
import { CLEARANCE } from './whiteboard-visibility-core.ts';

const INCREMENTAL_MIN_ELEMENTS = 2000;
const SOLID_CELL_SIZE = 1024;
const WIRE_CELL_SIZE = 1024;
const MAX_CONTEXT_ROUNDS = 4;
const MENTIONED_ID = /\b(?:box|wire|frame|note) ([a-z0-9][a-z0-9-]*)/g;
const PAIR_WARNING = /^(box|wire) ([a-z0-9][a-z0-9-]*) (overlaps|crosses) \1 ([a-z0-9][a-z0-9-]*)$/;
const NO_PLAN_STEPS: ReadonlyMap<string, PlanStep> = new Map();

interface IdGrid {
  grid: SpatialGrid;
  slotById: Map<string, number>;
  idBySlot: string[];
  freeSlots: number[];
}

interface WarningBook {
  idsByText: Map<string, string[]>;
  textsById: Map<string, Set<string>>;
  presenceByChangedText: Map<string, boolean>;
}

interface WarningChange {
  book: 'route' | 'placement';
  text: string;
  isPresent: boolean;
}

interface WorldChanges {
  routeIds: string[];
  warnings: WarningChange[];
}

interface SavedWorldParts {
  routeById: ReadonlyMap<string, RememberedRoute>;
  routeWarnings: readonly string[];
  placementWarnings: readonly string[];
}

interface SavedWorld extends SavedWorldParts {
  laidOut: readonly PlacedElement[];
  chrome: Omit<PlacedLayout, 'elements' | 'warnings'>;
}

interface WireStyleCount {
  style: { tone: LaidOutWire['tone']; dashed: boolean; back: boolean };
  count: number;
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
  loopFrameIds: Set<string>;
  routeMemory: RouteMemory;
  changedRouteIds: Set<string>;
  noteOrderById: Map<string, number>;
  nextNoteOrder: number;
  routeWarnings: WarningBook;
  placementWarnings: WarningBook;
  wireStyleByKey: Map<string, WireStyleCount>;
  boxCountByChange: Map<Box['change'], number>;
  floatingBoxCount: number;
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

function unionOfStored(idGrid: IdGrid, around: Rect | null): Rect | null {
  const { grid } = idGrid;
  let union = around;
  for (const slot of idGrid.slotById.values()) {
    const minX = grid.minX[slot] ?? 0;
    const minY = grid.minY[slot] ?? 0;
    union = unionOf([...(union ? [union] : []), { x: minX, y: minY, width: (grid.maxX[slot] ?? 0) - minX, height: (grid.maxY[slot] ?? 0) - minY }]);
  }
  return union;
}

function createWarningBook(): WarningBook {
  return { idsByText: new Map(), textsById: new Map(), presenceByChangedText: new Map() };
}

function swappedPairOf(text: string): string | null {
  const pair = PAIR_WARNING.exec(text);
  return pair ? `${pair[1]} ${pair[4]} ${pair[3]} ${pair[1]} ${pair[2]}` : null;
}

function isPairWithOutsider(text: string, id: string, insiders: ReadonlyMap<string, unknown>): boolean {
  const pair = PAIR_WARNING.exec(text);
  if (!pair) return false;
  const otherId = pair[2] === id ? pair[4] : pair[2];
  return otherId !== undefined && !insiders.has(otherId);
}

function noteWarningChange(book: WarningBook, text: string, isPresent: boolean): void {
  book.presenceByChangedText.delete(text);
  book.presenceByChangedText.set(text, isPresent);
}

function addWarning(book: WarningBook, text: string): void {
  if (book.idsByText.has(text)) return;
  const swapped = swappedPairOf(text);
  if (swapped !== null && book.idsByText.has(swapped)) return;
  const ids = [...text.matchAll(MENTIONED_ID)].flatMap((match) => match[1] ?? []);
  book.idsByText.set(text, ids);
  noteWarningChange(book, text, true);
  for (const id of ids) {
    const texts = book.textsById.get(id) ?? new Set<string>();
    texts.add(text);
    book.textsById.set(id, texts);
  }
}

function dropWarning(book: WarningBook, text: string): void {
  const ids = book.idsByText.get(text);
  if (!ids) return;
  book.idsByText.delete(text);
  noteWarningChange(book, text, false);
  for (const id of ids) {
    const texts = book.textsById.get(id);
    texts?.delete(text);
    if (texts?.size === 0) book.textsById.delete(id);
  }
}

function dropWarningsMentioning(book: WarningBook, id: string, accepts: (text: string) => boolean = () => true): void {
  for (const text of [...book.textsById.get(id) ?? []]) {
    if (accepts(text)) dropWarning(book, text);
  }
}

function addWarningLists(book: WarningBook, lists: readonly WarningList[]): void {
  for (const list of lists) {
    for (let index = 0; index < list.count; index += 1) addWarning(book, list.messageAt(index));
  }
}

function firstTextsOf(book: WarningBook, count: number): string[] {
  const texts: string[] = [];
  for (const text of book.idsByText.keys()) {
    if (texts.length >= count) break;
    texts.push(text);
  }
  return texts;
}

function warningsOf(world: LayoutWorld): string[] {
  const books = [world.routeWarnings, world.placementWarnings];
  return cappedWarningLists(books.map((book) => {
    const shown = firstTextsOf(book, WHITEBOARD_LIMITS.layoutWarnings);
    return { count: book.idsByText.size, messageAt: (index: number) => shown[index] ?? '' };
  }));
}

function wireStyleKeyOf(wire: { tone: LaidOutWire['tone']; dashed: boolean; back: boolean }): string {
  return `${wire.tone}|${wire.dashed}|${wire.back}`;
}

function countElement(world: LayoutWorld, element: Element | null | undefined, step: number): void {
  if (element?.kind === 'wire') {
    const key = wireStyleKeyOf(element);
    const known = world.wireStyleByKey.get(key) ?? { style: { tone: element.tone, dashed: element.dashed, back: element.back }, count: 0 };
    known.count += step;
    if (known.count > 0) world.wireStyleByKey.set(key, known);
    if (known.count <= 0) world.wireStyleByKey.delete(key);
    return;
  }
  if (element?.kind !== 'box') return;
  const count = (world.boxCountByChange.get(element.change) ?? 0) + step;
  if (count > 0) world.boxCountByChange.set(element.change, count);
  if (count <= 0) world.boxCountByChange.delete(element.change);
}

function isFloatingShaped(box: Box): boolean {
  return box.at === null && box.near === null && !isInStepBand(box);
}

function isFloating(box: Box, board: Board): boolean {
  if (box.at !== null || isInStepBand(box)) return false;
  return box.near === null || board.elements.get(box.near.of)?.kind !== 'box';
}

function obstacleRectOf(element: PlacedElement): Rect | null {
  if (element.kind === 'wire') return null;
  if (element.kind === 'frame') return frameTitleStripOf(element);
  return element;
}

function extentOf(element: PlacedElement): Rect | null {
  return element.kind === 'wire' ? wireExtentOf(element) : element;
}

function isOnEdge(rect: Rect, around: Rect): boolean {
  return rect.x <= around.x || rect.y <= around.y || rect.x + rect.width >= around.x + around.width || rect.y + rect.height >= around.y + around.height;
}

function storeLaidOut(world: LayoutWorld, element: PlacedElement): void {
  world.laidOutById.set(element.id, element);
  if (element.kind === 'box') placeId(world.boxGrid, element.id, element);
  if (element.kind === 'note') placeId(world.softGrid, element.id, element);
  if (element.kind === 'frame') {
    placeId(world.softGrid, element.id, frameTitleStripOf(element));
    placeId(world.frameGrid, element.id, element);
    if (element.isLoop) world.loopFrameIds.add(element.id);
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
  world.loopFrameIds.delete(id);
}

function recomputedAround(world: LayoutWorld): Rect | null {
  const header = headerRectOf(world.boxesTop);
  return [world.boxGrid, world.softGrid, world.frameGrid, world.wireGrid].reduce<Rect | null>((around, idGrid) => unionOfStored(idGrid, around), header);
}

function chromeOfWorld(world: LayoutWorld, board: Board): Omit<PlacedLayout, 'elements' | 'warnings'> {
  const usedStyles = [...world.wireStyleByKey.values()].map((entry) => entry.style);
  const legend = legendEntriesFrom(board.legend, usedStyles, new Set(world.boxCountByChange.keys()), boardIndexOf(board.elements).stepBoxIds.size > 0);
  return chromeAround(board.caption, contentBoundsOf(world.around), legend, world.planColumns, world.pinnedOffsetY);
}

let lastLineage = 0;

function emptyWorld(board: Board, minIncrementalElements: number): LayoutWorld {
  lastLineage += 1;
  return {
    lineage: lastLineage, version: board.version, board, minIncrementalElements, laidOutById: new Map(),
    boxGrid: createIdGrid(SOLID_CELL_SIZE), softGrid: createIdGrid(SOLID_CELL_SIZE), frameGrid: createIdGrid(SOLID_CELL_SIZE), wireGrid: createIdGrid(WIRE_CELL_SIZE),
    loopFrameIds: new Set(), routeMemory: { contentTop: 0, rectByKey: new Map(), routeById: new Map(), warningPairs: null }, changedRouteIds: new Set(),
    noteOrderById: new Map(), nextNoteOrder: 0, routeWarnings: createWarningBook(), placementWarnings: createWarningBook(),
    wireStyleByKey: new Map(), boxCountByChange: new Map(), floatingBoxCount: 0, pinnedOffsetY: 0, contentTop: 0, boxesTop: 0, planColumns: [], around: null,
    chrome: { legend: [], caption: null, plan: null, pinnedOffsetY: 0, bounds: { x: 0, y: 0, width: 0, height: 0 } }, layout: null,
  };
}

const ARRAY_INDEX_LIMIT = 2 ** 32 - 1;
const ARRAY_INDEX_KEY = /^(0|[1-9][0-9]*)$/;

function nextNoteOrderOf(world: LayoutWorld, id: string): number {
  const arrayIndex = ARRAY_INDEX_KEY.test(id) ? Number(id) : ARRAY_INDEX_LIMIT;
  if (arrayIndex < ARRAY_INDEX_LIMIT) return arrayIndex - ARRAY_INDEX_LIMIT;
  world.nextNoteOrder += 1;
  return world.nextNoteOrder;
}

interface WorldParts {
  laidOut: readonly PlacedElement[];
  chrome: Omit<PlacedLayout, 'elements' | 'warnings'>;
  routeMemory: RouteMemory;
  warningLists: readonly WarningList[];
}

function worldFromParts(board: Board, { laidOut, chrome, routeMemory, warningLists }: WorldParts, minIncrementalElements: number): LayoutWorld {
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
    return world;
  }
  for (const element of laidOut) storeLaidOut(world, element);
  for (const element of board.elements.values()) {
    countElement(world, element, 1);
    if (element.kind === 'note') world.noteOrderById.set(element.id, nextNoteOrderOf(world, element.id));
    if (element.kind === 'box' && isFloating(element, board)) world.floatingBoxCount += 1;
  }
  addWarningLists(world.routeWarnings, warningLists.slice(0, -1));
  addWarningLists(world.placementWarnings, warningLists.slice(-1));
  world.around = recomputedAround(world);
  return world;
}

function rebuiltWorld(board: Board, previous: LayoutWorld | null, minIncrementalElements: number): LayoutWorld {
  const { layout, memory, warningLists } = placeBoardWithMemory(board, previous ? { route: previous.routeMemory } : null);
  const chrome = { legend: layout.legend, caption: layout.caption, plan: layout.plan, pinnedOffsetY: layout.pinnedOffsetY, bounds: layout.bounds };
  const world = worldFromParts(board, { laidOut: layout.elements, chrome, routeMemory: memory.route, warningLists }, minIncrementalElements);
  world.layout = layout;
  return world;
}

function warningListOfTexts(texts: readonly string[]): WarningList {
  return { count: texts.length, messageAt: (index) => texts[index] ?? '' };
}

function resumeLayoutWorld(board: Board, saved: SavedWorld, minIncrementalElements = INCREMENTAL_MIN_ELEMENTS): LayoutWorld {
  const contentTop = wireCeilingOf(stepBandOf(board).bottom);
  const routeMemory: RouteMemory = { contentTop, rectByKey: obstacleRectsByKey(obstacleInputOf(contentTop, saved.laidOut)), routeById: new Map(saved.routeById), warningPairs: null };
  const warningLists = [warningListOfTexts(saved.routeWarnings), warningListOfTexts(saved.placementWarnings)];
  return worldFromParts(board, { laidOut: saved.laidOut, chrome: saved.chrome, routeMemory, warningLists }, minIncrementalElements);
}

function savedWorldOf(world: LayoutWorld): SavedWorldParts {
  return { routeById: world.routeMemory.routeById, routeWarnings: [...world.routeWarnings.idsByText.keys()], placementWarnings: [...world.placementWarnings.idsByText.keys()] };
}

function createLayoutWorld(board: Board, previous: LayoutWorld | null = null, minIncrementalElements = INCREMENTAL_MIN_ELEMENTS): LayoutWorld {
  return rebuiltWorld(board, previous, minIncrementalElements);
}

function touchesStepBox(element: Element | null | undefined, stepBoxIds: ReadonlySet<string>): boolean {
  if (element?.kind === 'box') return element.step !== null || isFloatingShaped(element);
  if (element?.kind === 'wire') return stepBoxIds.has(element.from) || stepBoxIds.has(element.to);
  return false;
}

function needsRebuild(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>): boolean {
  const index = boardIndexOf(board.elements);
  if (world.version !== board.version - 1 || index.elementCount < world.minIncrementalElements || world.laidOutById.size === 0) return true;
  for (const change of changes.values()) {
    if (touchesStepBox(change.before, index.stepBoxIds) || touchesStepBox(change.after, index.stepBoxIds)) return true;
    const isSolidChange = change.before?.kind === 'box' || change.after?.kind === 'box' || change.before?.kind === 'note' || change.after?.kind === 'note';
    if (isSolidChange && world.floatingBoxCount > 0) return true;
  }
  return false;
}

function dirtyBoxIdsOf(board: Board, changes: ReadonlyMap<string, ElementChange>): Set<string> {
  const index = boardIndexOf(board.elements);
  const dirtyIds = new Set<string>();
  for (const [id, change] of changes) {
    if (change.before?.kind === 'box' || change.after?.kind === 'box') dirtyIds.add(id);
  }
  const pending = [...dirtyIds];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const dependentId of index.dependentIdsByBoxId.get(id) ?? []) {
      const dependent = board.elements.get(dependentId);
      if (dependent?.kind !== 'box' || dependent.near?.of !== id || dirtyIds.has(dependentId)) continue;
      dirtyIds.add(dependentId);
      pending.push(dependentId);
    }
  }
  return dirtyIds;
}

function placedDirtyBoxes(world: LayoutWorld, board: Board, dirtyIds: ReadonlySet<string>): Map<string, PlacedBox | null> | null {
  const placedById = new Map<string, PlacedBox | null>();
  const visitingIds = new Set<string>();
  const boxNow = (id: string): PlacedBox | null | undefined => {
    const placed = placedById.get(id);
    if (placed !== undefined || placedById.has(id)) return placed;
    if (!dirtyIds.has(id)) {
      const known = world.laidOutById.get(id);
      return known?.kind === 'box' ? known : null;
    }
    if (visitingIds.has(id)) return undefined;
    const box = board.elements.get(id);
    if (box?.kind !== 'box') {
      placedById.set(id, null);
      return null;
    }
    visitingIds.add(id);
    const laidOut = placedBoxOf(box);
    visitingIds.delete(id);
    if (laidOut) placedById.set(id, laidOut);
    return laidOut;
  };
  const placedBoxOf = (box: Box): PlacedBox | undefined => {
    if (box.at) return laidOutBox(NO_PLAN_STEPS, box, { x: box.at.x, y: box.at.y + world.pinnedOffsetY });
    if (!box.near) return undefined;
    const target = boxNow(box.near.of);
    return target ? laidOutNearBox(NO_PLAN_STEPS, box, box.near, target) : undefined;
  };
  for (const id of dirtyIds) {
    if (boxNow(id) === undefined) return null;
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
  const dirtyBoxIds = dirtyBoxIdsOf(board, changes);
  const placedBoxes = placedDirtyBoxes(world, board, dirtyBoxIds);
  if (!placedBoxes) return null;
  const nextById = new Map<string, PlacedElement | null>(placedBoxes);
  const boxNow = (id: string): PlacedBox | null => {
    if (placedBoxes.has(id)) return placedBoxes.get(id) ?? null;
    const known = world.laidOutById.get(id);
    return known?.kind === 'box' ? known : null;
  };
  const stackBoxIds = new Set(dirtyBoxIds);
  const dirtyFrameIds = new Set<string>();
  for (const [id, change] of changes) {
    if (change.before?.kind === 'note') stackBoxIds.add(change.before.on);
    if (change.after?.kind === 'note') stackBoxIds.add(change.after.on);
    if (change.before?.kind === 'note' || change.after?.kind === 'note') nextById.set(id, null);
    if (change.before?.kind === 'frame' || change.after?.kind === 'frame') dirtyFrameIds.add(id);
    if (change.after?.kind === 'note' && (change.isAppended || !world.noteOrderById.has(id))) world.noteOrderById.set(id, nextNoteOrderOf(world, id));
    if (change.after?.kind !== 'note' && change.before?.kind === 'note') world.noteOrderById.delete(id);
  }
  for (const boxId of stackBoxIds) {
    const notes = dependentsOfKind(board, boxId, 'note').filter((note) => note.on === boxId).sort((left, right) => (world.noteOrderById.get(left.id) ?? 0) - (world.noteOrderById.get(right.id) ?? 0));
    const target = boxNow(boxId);
    for (const note of notes) nextById.set(note.id, null);
    if (target) for (const laidOut of noteStackOn(notes, target)) nextById.set(laidOut.id, laidOut);
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
    nextById.set(frameId, laidOutFrameOf(frame, containedById));
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
    commit.previousById.set(id, previous);
    forgetLaidOut(world, id);
    const previousExtent = extentOf(previous);
    if (previousExtent && world.around && isOnEdge(previousExtent, world.around)) commit.isAroundStale = true;
  }
  const previousObstacle = previous ? obstacleRectOf(previous) : null;
  const nextObstacle = next ? obstacleRectOf(next) : null;
  const isLoopChange = (previous?.kind === 'frame' && previous.isLoop) || (next?.kind === 'frame' && next.isLoop);
  if (!isSameGeometry(previousObstacle, nextObstacle) || isLoopChange) {
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
    endpointIds.add(wire.from);
    endpointIds.add(wire.to);
  }
  return endpointIds;
}

function isSamePoint(first: Point, second: Point): boolean {
  return first.x === second.x && first.y === second.y;
}

interface SubRoute {
  routedWires: Map<string, LaidOutWire>;
  result: ReturnType<typeof routeWires>;
  completeBoxIds: Set<string>;
}

function routeInputOver(world: LayoutWorld, board: Board, rerouteIds: ReadonlySet<string>, contextIds: ReadonlySet<string>): RouteInput {
  const boxesById = new Map<string, PlacedBox>();
  const softById = new Map<string, Rect>();
  const addBox = (id: string) => {
    const box = world.laidOutById.get(id);
    if (box?.kind === 'box') boxesById.set(id, box);
  };
  for (const id of endpointIdsOf(board, [...rerouteIds, ...contextIds])) addBox(id);
  const areas = [...rerouteIds].flatMap((id) => {
    const laidOut = world.laidOutById.get(id);
    return laidOut?.kind === 'wire' ? segmentRectsOf(laidOut).map((rect) => inflated(rect, CLEARANCE)) : [];
  });
  areas.push(...[...boxesById.values()].map((box) => inflated(box, CLEARANCE)));
  for (const area of areas) {
    for (const box of boxesTouching(world, area)) boxesById.set(box.id, box);
    forEachIdTouching(world.softGrid, area, (id) => {
      const soft = world.laidOutById.get(id);
      const obstacle = soft ? obstacleRectOf(soft) : null;
      if (obstacle) softById.set(id, obstacle);
    });
  }
  const loopFrames = [...world.loopFrameIds].flatMap((id) => {
    const frame = world.laidOutById.get(id);
    return frame?.kind === 'frame' && areas.some((area) => rectsOverlap(area, frame)) ? [frame] : [];
  });
  const wiresOf = (ids: ReadonlySet<string>) => [...ids].flatMap((id) => {
    const wire = board.elements.get(id);
    return wire?.kind === 'wire' ? [wire] : [];
  });
  return {
    wires: wiresOf(rerouteIds), contextWires: wiresOf(contextIds), boxesById, softObstacles: [...softById.values()], loopFrames, contentTop: world.contentTop,
    obstaclesIn: (area): AreaObstacles => ({ hardRects: boxesTouching(world, area), softRects: softRectsTouching(world, area) }),
    storedWireKeyOf: (wire) => board.elements.bodyOf(wire.id),
  };
}

function rectKeyOf(rect: Rect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

function softRectsOf(elements: readonly PlacedElement[]): Rect[] {
  return elements.flatMap((element) => (element.kind === 'note' || element.kind === 'frame' ? obstacleRectOf(element) ?? [] : []));
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
  const loopsOf = (elements: readonly SolidElement[]) => elements.flatMap((element) => (element.kind === 'frame' && element.isLoop ? [element] : []));
  const newLoopKeys = new Set(loopsOf(commit.newObstacles).map(rectKeyOf));
  return { ...input, boxesById, softObstacles, loopFrames: [...input.loopFrames.filter((frame) => !newLoopKeys.has(rectKeyOf(frame))), ...loopsOf(commit.oldObstacles)] };
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

function routedSubBoard(world: LayoutWorld, board: Board, seedIds: ReadonlySet<string>, commit: Commit): SubRoute | null {
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
    const result = routeWires(input, memory);
    const reroutedBusKeys = new Set([...rerouteIds].flatMap((id) => result.portEndsById.get(id)?.busKey ?? []));
    const promotedIds = [...contextIds].filter((id) => {
      const ends = result.portEndsById.get(id);
      const remembered = world.routeMemory.routeById.get(id);
      const wire = board.elements.get(id);
      if (!ends || !remembered || wire?.kind !== 'wire') return true;
      if (ends.busKey !== null && reroutedBusKeys.has(ends.busKey)) return true;
      return (completeBoxIds.has(wire.from) && !isSamePoint(ends.start, remembered.start)) || (completeBoxIds.has(wire.to) && !isSamePoint(ends.end, remembered.end));
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
    boxesById: new Map(elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : []))),
    softObstacles: softRectsOf(elements),
    loopFrames: elements.flatMap((element) => (element.kind === 'frame' && element.isLoop ? [element] : [])),
  };
}

function rememberObstacles(world: LayoutWorld, commit: Commit): void {
  for (const key of obstacleRectsByKey(obstacleInputOf(world.contentTop, commit.oldObstacles)).keys()) world.routeMemory.rectByKey.delete(key);
  for (const [key, rect] of obstacleRectsByKey(obstacleInputOf(world.contentTop, commit.newObstacles))) world.routeMemory.rectByKey.set(key, rect);
  world.routeMemory.warningPairs = null;
}

function rerouteWires(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>, solids: SolidOutcome, commit: Commit): void {
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
    const rect = obstacle.kind === 'frame' && !obstacle.isLoop ? frameTitleStripOf(obstacle) : obstacle;
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
  const routed = routedSubBoard(world, board, seedIds, commit);
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
    dropWarningsMentioning(world.routeWarnings, id, (text) => isMoved || !isPairWithOutsider(text, id, routed.routedWires));
  }
  for (const boxId of routed.completeBoxIds) dropWarningsMentioning(world.routeWarnings, boxId, (text) => text.startsWith(`box ${boxId} has `));
  for (const [id, wire] of routed.routedWires) commitElement(world, commit, id, wire);
  for (const id of seedIds) {
    if (!routed.routedWires.has(id)) commitElement(world, commit, id, null);
  }
  addWarningLists(world.routeWarnings, routed.result.collectWarnings());
}

function worldChangesOf(world: LayoutWorld): WorldChanges {
  const changesIn = (book: WarningBook, name: WarningChange['book']) => [...book.presenceByChangedText].map(([text, isPresent]) => ({ book: name, text, isPresent }));
  return { routeIds: [...world.changedRouteIds], warnings: [...changesIn(world.routeWarnings, 'route'), ...changesIn(world.placementWarnings, 'placement')] };
}

function forgetWorldChanges(world: LayoutWorld): void {
  world.changedRouteIds.clear();
  world.routeWarnings.presenceByChangedText.clear();
  world.placementWarnings.presenceByChangedText.clear();
}

function applyIncrementally(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>): LayoutDelta | null {
  const solids = laidOutSolids(world, board, changes);
  if (!solids) return null;
  forgetWorldChanges(world);
  const commit: Commit = { previousById: new Map(), changed: [], removedIds: [], oldObstacles: [], newObstacles: [], isAroundStale: false };
  for (const [id, next] of solids.nextById) commitElement(world, commit, id, next);
  for (const change of changes.values()) {
    countElement(world, change.before, -1);
    countElement(world, change.after, 1);
  }
  updatePlacementWarnings(world, board, solids);
  rerouteWires(world, board, changes, solids, commit);
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

function applyLayoutDelta(world: LayoutWorld, board: Board, changes: ReadonlyMap<string, ElementChange>): { world: LayoutWorld; delta: LayoutDelta } {
  const incremental = needsRebuild(world, board, changes) ? null : applyIncrementally(world, board, changes);
  if (incremental) return { world, delta: incremental };
  const rebuilt = rebuiltWorld(board, world, world.minIncrementalElements);
  return { world: rebuilt, delta: { changed: [], previousById: new Map(), removedIds: [], isChromeChanged: true, isRebuilt: true, worldChanges: { routeIds: [], warnings: [] } } };
}

function layoutOf(world: LayoutWorld): PlacedLayout {
  if (world.layout) return world.layout;
  const frames: LaidOutFrame[] = [];
  const wires: LaidOutWire[] = [];
  const pinnedBoxes: PlacedBox[] = [];
  const nearBoxes: PlacedBox[] = [];
  const notes: PlacedNote[] = [];
  for (const element of world.board.elements.values()) {
    const laidOut = world.laidOutById.get(element.id);
    if (laidOut?.kind === 'frame') frames.push(laidOut);
    if (laidOut?.kind === 'wire') wires.push(laidOut);
    if (laidOut?.kind === 'box' && element.kind === 'box' && element.at) pinnedBoxes.push(laidOut);
    if (laidOut?.kind === 'box' && element.kind === 'box' && !element.at) nearBoxes.push(laidOut);
    if (laidOut?.kind === 'note') notes.push(laidOut);
  }
  const layout: PlacedLayout = { elements: [...frames, ...wires, ...pinnedBoxes, ...nearBoxes, ...notes], ...world.chrome, warnings: warningsOf(world) };
  world.layout = layout;
  return layout;
}

function warningsOfWorld(world: LayoutWorld): string[] {
  return world.layout ? world.layout.warnings : warningsOf(world);
}

export { INCREMENTAL_MIN_ELEMENTS, applyLayoutDelta, createLayoutWorld, layoutOf, resumeLayoutWorld, savedWorldOf, warningsOfWorld };
export type { ElementChange, LayoutDelta, LayoutWorld, SavedWorld, SavedWorldParts, WarningChange };
