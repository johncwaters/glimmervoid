import { BLOCK_RASTER_PX } from './contracts/whiteboard-tiles.ts';
import { pointOfBox, sparseElement, WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, BoardOutline, Element, ReadElement } from './contracts/whiteboard.ts';
import type { BoardChrome, LaidOutElement, PaintedElement, PlacedElement, PlacedPaint, Tile, TileDiff, TileKey, TileLod } from './contracts/whiteboard-tiles.ts';
import { dressedElement, laidOutStrokeOf } from './whiteboard-layout-core.ts';
import { boardIndexOf, elementsOfKind } from './whiteboard-board-index.ts';
import type { ElementTable } from './whiteboard-element-table.ts';
import type { PlacedLayout, Rect } from './whiteboard-layout-core.ts';
import { createSpatialGrid, forEachSlotTouching, placeSlot, removeSlot } from './spatial-grid-core.ts';
import type { SpatialGrid } from './spatial-grid-core.ts';
import { labelWidthOf, pointsOfPath } from './whiteboard-route-core.ts';

const CHUNK_SIZE = 2048;
const FULL_MIN_SCALE = 0.3;
const TITLES_MIN_SCALE = 0.12;
const VIEW_MARGIN = 0.5;
const MAX_BLOCK_TILES_ACROSS = 6;
const MAX_TILES_PER_VIEW = 256;
const MAX_TILE_LEVEL = 30;
const WIRE_PAD = 12;
const FRAME_TITLE_PAD = 28;
const PAINT_RANK_STRIDE = 2 ** 32;

interface TileIndex {
  version: number;
  chrome: BoardChrome;
  records: ElementTable;
  painted: (PlacedPaint | null)[];
  bounds: (Rect | null)[];
  slotById: Map<string, number>;
  grid: SpatialGrid;
}

interface TileChanges {
  changedSlots: ChangedSlot[];
  removedIds: string[];
  touchedRects: Rect[];
  isChromeChanged: boolean;
}

interface TilePatch {
  version: number;
  chrome: BoardChrome;
  changed: readonly PlacedElement[];
  removedIds: readonly string[];
  recordChangedIds: readonly string[];
}

function lodForScale(scale: number): TileLod {
  if (scale >= FULL_MIN_SCALE) return 'full';
  if (scale >= TITLES_MIN_SCALE) return 'titles';
  return 'blocks';
}

function tileIdOf(key: TileKey): string {
  return `${key.lod}:${key.level}:${key.chunkX}:${key.chunkY}`;
}

function tileSizeOf(key: Pick<TileKey, 'level'>): number {
  return CHUNK_SIZE * 2 ** key.level;
}

function tileRectOf(key: TileKey): Rect {
  const size = tileSizeOf(key);
  return { x: key.chunkX * size, y: key.chunkY * size, width: size, height: size };
}

interface ChunkSpan {
  firstX: number;
  lastX: number;
  firstY: number;
  lastY: number;
}

function chunkSpanOf(area: Rect, level: number): ChunkSpan {
  const size = tileSizeOf({ level });
  return {
    firstX: Math.floor(area.x / size),
    lastX: Math.floor((area.x + area.width) / size),
    firstY: Math.floor(area.y / size),
    lastY: Math.floor((area.y + area.height) / size),
  };
}

function tileCountOf(span: ChunkSpan): number {
  return (span.lastX - span.firstX + 1) * (span.lastY - span.firstY + 1);
}

function firstLevelFor(view: Rect, lod: TileLod): number {
  if (lod !== 'blocks') return 0;
  const span = Math.max(view.width, view.height);
  let level = 0;
  while (CHUNK_SIZE * 2 ** level * MAX_BLOCK_TILES_ACROSS < span && level < MAX_TILE_LEVEL) level += 1;
  return level;
}

function tileKeysFor(view: Rect, lod: TileLod): TileKey[] {
  const area = { x: view.x - view.width * VIEW_MARGIN, y: view.y - view.height * VIEW_MARGIN, width: view.width * (1 + VIEW_MARGIN * 2), height: view.height * (1 + VIEW_MARGIN * 2) };
  let level = firstLevelFor(view, lod);
  while (tileCountOf(chunkSpanOf(area, level)) > MAX_TILES_PER_VIEW && level < MAX_TILE_LEVEL) level += 1;
  const span = chunkSpanOf(area, level);
  if (tileCountOf(span) > MAX_TILES_PER_VIEW) return [];
  const keys: TileKey[] = [];
  for (let chunkY = span.firstY; chunkY <= span.lastY; chunkY += 1) {
    for (let chunkX = span.firstX; chunkX <= span.lastX; chunkX += 1) keys.push({ chunkX, chunkY, lod, level });
  }
  return keys;
}

function boundsOfPoints(points: readonly { x: number; y: number }[], pad: number): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

function paintedBoundsOf(element: PlacedElement): Rect {
  if (element.kind === 'wire') {
    const points = [...pointsOfPath(element.path), element.start, element.end];
    if (element.label) {
      const halfLabel = labelWidthOf(element.label) / 2 + WIRE_PAD;
      points.push({ x: element.labelAt.x - halfLabel, y: element.labelAt.y - WIRE_PAD * 2 }, { x: element.labelAt.x + halfLabel, y: element.labelAt.y + WIRE_PAD });
    }
    return boundsOfPoints(points, WIRE_PAD);
  }
  if (element.kind === 'frame') return { ...rectOf(element), width: Math.max(element.width, FRAME_TITLE_PAD + labelWidthOf(element.title)) };
  return rectOf(element);
}

function rectOf(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function chromeOf(layout: PlacedLayout): BoardChrome {
  return { legend: layout.legend, caption: layout.caption, plan: layout.plan, pinnedOffsetY: layout.pinnedOffsetY, bounds: layout.bounds };
}

function paintRankOf(element: PlacedElement, stored: Element | undefined): number {
  switch (element.kind) {
    case 'frame': return 0;
    case 'wire': return 1;
    case 'box': return stored?.kind === 'box' && pointOfBox(stored) ? 2 : 3;
    default: return 4;
  }
}

function paintedAt(board: Board, element: PlacedElement, slot: number): PlacedPaint {
  return { paintOrder: paintRankOf(element, board.elements.get(element.id)) * PAINT_RANK_STRIDE + slot, element };
}

function tileIndexOf(layout: PlacedLayout, version: number, board: Board): TileIndex {
  return tileIndexOfPainted(version, chromeOf(layout), board.elements, layout.elements.map((element, slot) => paintedAt(board, element, slot)));
}

function tileIndexOfPainted(version: number, chrome: BoardChrome, records: ElementTable, painted: (PlacedPaint | null)[]): TileIndex {
  const bounds = painted.map((entry) => (entry ? paintedBoundsOf(entry.element) : null));
  const slotById = new Map<string, number>();
  const grid = createSpatialGrid(CHUNK_SIZE, painted.length);
  for (const [slot, entry] of painted.entries()) {
    const entryBounds = bounds[slot];
    if (!entry || !entryBounds) continue;
    slotById.set(entry.element.id, slot);
    placeSlot(grid, slot, entryBounds);
  }
  return { version, chrome, records, painted, bounds, slotById, grid };
}

function slotsTouching(index: TileIndex, rect: Rect): number[] {
  const slots: number[] = [];
  forEachSlotTouching(index.grid, rect, (slot) => {
    slots.push(slot);
  });
  return slots.sort((left, right) => left - right);
}

function elementIdsTouching(index: TileIndex, rect: Rect): string[] {
  return slotsTouching(index, rect).flatMap((slot) => index.painted[slot]?.element.id ?? []);
}

interface ElementCluster {
  rect: Rect;
  elementCount: number;
  titles: string[];
}

function titleOf(index: TileIndex, { element }: PlacedPaint): string | null {
  if (element.kind === 'frame') return element.title || null;
  if (element.kind !== 'box') return null;
  const dressed = dressedElement(element, index.records.get(element.id));
  return dressed.kind === 'box' ? dressed.titleLines.join(' ') || null : null;
}

function clustersOutside(index: TileIndex, focus: Rect, { maxClusters, titlesPerCluster }: { maxClusters: number; titlesPerCluster: number }): ElementCluster[] {
  const clusterByCell = new Map<string, ElementCluster>();
  index.bounds.forEach((bounds, slot) => {
    if (!bounds || rectsTouch(bounds, focus)) return;
    const cellKey = `${Math.floor(bounds.x / CHUNK_SIZE)},${Math.floor(bounds.y / CHUNK_SIZE)}`;
    const cluster = clusterByCell.get(cellKey) ?? { rect: rectOf(bounds), elementCount: 0, titles: [] };
    const right = Math.max(cluster.rect.x + cluster.rect.width, bounds.x + bounds.width);
    const bottom = Math.max(cluster.rect.y + cluster.rect.height, bounds.y + bounds.height);
    cluster.rect.x = Math.min(cluster.rect.x, bounds.x);
    cluster.rect.y = Math.min(cluster.rect.y, bounds.y);
    cluster.rect.width = right - cluster.rect.x;
    cluster.rect.height = bottom - cluster.rect.y;
    cluster.elementCount += 1;
    const painted = index.painted[slot];
    const title = painted && cluster.titles.length < titlesPerCluster ? titleOf(index, painted) : null;
    if (title) cluster.titles.push(title);
    clusterByCell.set(cellKey, cluster);
  });
  return [...clusterByCell.values()].sort((left, right) => right.elementCount - left.elementCount).slice(0, maxClusters);
}

const DEFAULT_FOCUS_WIDTH = 1440;
const DEFAULT_FOCUS_HEIGHT = 900;
const CLUSTER_TITLES = 3;

function defaultFocusOf(index: TileIndex): Rect {
  const { bounds } = index.chrome;
  return { x: bounds.x, y: bounds.y, width: DEFAULT_FOCUS_WIDTH, height: DEFAULT_FOCUS_HEIGHT };
}

function readElementOf(element: Element): ReadElement {
  if (element.kind !== 'stroke') return element;
  const { x, y, width, height } = laidOutStrokeOf(element, 0);
  return { kind: 'stroke', id: element.id, bounds: { x, y, width, height }, pointCount: element.points.length / 2, width: element.width, tone: element.tone };
}

function elementPageOf(board: Board, elementIds: readonly string[], offset: number): { elements: ReadElement[]; nextOffset: number | null } {
  const elements: ReadElement[] = [];
  let pageChars = 0;
  let nextIndex = offset;
  for (; nextIndex < elementIds.length && elements.length < WHITEBOARD_LIMITS.readPage; nextIndex += 1) {
    const element = board.elements.get(elementIds[nextIndex] ?? '');
    if (!element) continue;
    const readElement = readElementOf(element);
    const elementChars = JSON.stringify(element.kind === 'stroke' ? readElement : sparseElement(element)).length;
    if (elements.length > 0 && pageChars + elementChars > WHITEBOARD_LIMITS.readPageChars) break;
    elements.push(readElement);
    pageChars += elementChars;
  }
  return { elements, nextOffset: nextIndex < elementIds.length ? nextIndex : null };
}

function fitsOnePage(board: Board): boolean {
  if (board.elements.size > WHITEBOARD_LIMITS.readPage || boardIndexOf(board.elements).strokeCount > 0) return false;
  let pageChars = 0;
  for (const id of board.elements.keys()) pageChars += board.elements.sparseLengthOf(id);
  return pageChars <= WHITEBOARD_LIMITS.readPageChars;
}

function elementCountsByKind(board: Board): Record<string, number> {
  return Object.fromEntries(board.elements.countsByKind());
}

function boardOutlineOf(board: Board, index: TileIndex, focus: Rect): BoardOutline {
  const countsByKind = elementCountsByKind(board);
  const frames = elementsOfKind(board, 'frame').flatMap((frame) => {
    const slot = index.slotById.get(frame.id);
    const rect = slot === undefined ? null : index.bounds[slot];
    return rect ? [{ id: frame.id, title: frame.title, rect }] : [];
  }).slice(0, WHITEBOARD_LIMITS.readPage);
  return {
    elementCount: board.elements.size,
    countsByKind,
    bounds: index.chrome.bounds,
    frames,
    clustersOutsideFocus: clustersOutside(index, focus, { maxClusters: WHITEBOARD_LIMITS.outlineClusters, titlesPerCluster: CLUSTER_TITLES }),
  };
}

function withTitlesOnly(element: LaidOutElement): LaidOutElement {
  switch (element.kind) {
    case 'box': return { ...element, bodyLines: [] };
    default: return element;
  }
}

function forLod(index: TileIndex, painted: PlacedPaint, lod: TileLod): PaintedElement {
  const record = index.records.get(painted.element.id);
  const dressed = dressedElement(painted.element, record);
  return { paintOrder: painted.paintOrder, element: lod === 'titles' ? withTitlesOnly(dressed) : dressed, record };
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

function rasterOf(index: TileIndex, key: TileKey): string | null {
  const tileRect = tileRectOf(key);
  const unitsPerPixel = tileRect.width / BLOCK_RASTER_PX;
  const pixels = new Uint8Array(BLOCK_RASTER_PX * BLOCK_RASTER_PX * 4);
  let isEmpty = true;
  for (const slot of slotsTouching(index, tileRect)) {
    const element = index.painted[slot]?.element;
    if (!element || element.kind === 'wire' || element.kind === 'frame') continue;
    const left = Math.max(0, Math.floor((element.x - tileRect.x) / unitsPerPixel));
    const top = Math.max(0, Math.floor((element.y - tileRect.y) / unitsPerPixel));
    const right = Math.min(BLOCK_RASTER_PX - 1, Math.floor((element.x + element.width - tileRect.x) / unitsPerPixel));
    const bottom = Math.min(BLOCK_RASTER_PX - 1, Math.floor((element.y + element.height - tileRect.y) / unitsPerPixel));
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const offset = (row * BLOCK_RASTER_PX + column) * 4;
        pixels[offset + 3] = 255;
        isEmpty = false;
      }
    }
  }
  return isEmpty ? null : base64Of(pixels);
}

function tileOf(index: TileIndex, key: TileKey): Tile {
  if (key.lod === 'blocks') return { key, elements: [], raster: rasterOf(index, key) };
  const elements = slotsTouching(index, tileRectOf(key)).flatMap((slot) => {
    const painted = index.painted[slot];
    return painted ? [forLod(index, painted, key.lod)] : [];
  });
  return { key, elements, raster: null };
}

function rectsTouch(left: Rect, right: Rect): boolean {
  return left.x <= right.x + right.width && right.x <= left.x + left.width && left.y <= right.y + right.height && right.y <= left.y + left.height;
}

interface ChangedSlot {
  slot: number;
  rects: Rect[];
}

function patchTileIndex(index: TileIndex, board: Board, patch: TilePatch): TileChanges {
  const changedSlots: ChangedSlot[] = [];
  const touchedRects: Rect[] = [];
  const removedIds: string[] = [];
  index.records = board.elements;
  for (const id of patch.removedIds) {
    const slot = index.slotById.get(id);
    if (slot === undefined) continue;
    const previousBounds = index.bounds[slot];
    if (previousBounds) touchedRects.push(previousBounds);
    index.slotById.delete(id);
    index.painted[slot] = null;
    index.bounds[slot] = null;
    removeSlot(index.grid, slot);
    removedIds.push(id);
  }
  for (const element of patch.changed) {
    const knownSlot = index.slotById.get(element.id);
    const slot = knownSlot ?? index.painted.length;
    const previousBounds = knownSlot === undefined ? null : index.bounds[knownSlot];
    const bounds = paintedBoundsOf(element);
    const rects = previousBounds ? [bounds, previousBounds] : [bounds];
    index.slotById.set(element.id, slot);
    index.painted[slot] = paintedAt(board, element, slot);
    index.bounds[slot] = bounds;
    placeSlot(index.grid, slot, bounds);
    changedSlots.push({ slot, rects });
    touchedRects.push(...rects);
  }
  const layoutChangedIds = new Set(patch.changed.map((element) => element.id));
  for (const id of patch.recordChangedIds) {
    const slot = index.slotById.get(id);
    const painted = slot === undefined ? null : index.painted[slot];
    const bounds = slot === undefined ? null : index.bounds[slot];
    if (slot === undefined || !painted || !bounds || layoutChangedIds.has(id)) continue;
    index.painted[slot] = paintedAt(board, painted.element, slot);
    changedSlots.push({ slot, rects: [bounds] });
  }
  const isChromeChanged = JSON.stringify(index.chrome) !== JSON.stringify(patch.chrome);
  index.chrome = patch.chrome;
  index.version = patch.version;
  return { changedSlots, removedIds, touchedRects, isChromeChanged };
}

function tileDiffOf(next: TileIndex, { changedSlots, removedIds, touchedRects, isChromeChanged }: TileChanges, heldKeys: readonly TileKey[]): TileDiff {
  const heldRects = heldKeys.map((key) => ({ key, rect: tileRectOf(key) }));
  const elementLods = new Set(heldKeys.filter((key) => key.lod !== 'blocks').map((key) => key.lod));
  const lod: TileLod = elementLods.has('titles') && !elementLods.has('full') ? 'titles' : 'full';
  const elementRects = heldRects.filter(({ key }) => key.lod !== 'blocks').map(({ rect }) => rect);
  const changed = changedSlots.flatMap(({ slot, rects }) => {
    const painted = next.painted[slot];
    if (!painted) return [];
    return elementRects.some((held) => rects.some((rect) => rectsTouch(held, rect))) ? [forLod(next, painted, lod)] : [];
  });
  const rasters = heldRects.filter(({ key, rect }) => key.lod === 'blocks' && touchedRects.some((touched) => rectsTouch(rect, touched))).map(({ key }) => tileOf(next, key));
  return { changed, removedIds, rasters, chrome: isChromeChanged ? next.chrome : null };
}

export { boardOutlineOf, defaultFocusOf, elementIdsTouching, elementPageOf, fitsOnePage, lodForScale, paintedBoundsOf, patchTileIndex, tileDiffOf, tileIdOf, tileIndexOf, tileIndexOfPainted, tileKeysFor, tileOf, tileRectOf };
export type { TileIndex };
