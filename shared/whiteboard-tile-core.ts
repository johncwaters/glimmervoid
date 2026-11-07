import { BLOCK_RASTER_PX } from './contracts/whiteboard-tiles.ts';
import type { BoardChrome, LaidOutElement, PaintedElement, Tile, TileDiff, TileKey, TileLod } from './contracts/whiteboard-tiles.ts';
import type { BoardLayout, Rect } from './whiteboard-layout-core.ts';
import { elementSignature } from './whiteboard-layout-core.ts';
import { forEachSlotTouching, gridOfRects } from './spatial-grid-core.ts';
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

interface TileIndex {
  version: number;
  chrome: BoardChrome;
  painted: PaintedElement[];
  bounds: Rect[];
  signatures: string[];
  slotById: Map<string, number>;
  grid: SpatialGrid;
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

function paintedBoundsOf(element: LaidOutElement): Rect {
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

function chromeOf(layout: BoardLayout): BoardChrome {
  return { columns: layout.columns, bands: layout.bands, legend: layout.legend, caption: layout.caption, plan: layout.plan, pinnedOffsetY: layout.pinnedOffsetY, bounds: layout.bounds };
}

function tileIndexOf(layout: BoardLayout, version: number): TileIndex {
  const painted = layout.elements.map((element, paintOrder) => ({ paintOrder, element }));
  const bounds = layout.elements.map(paintedBoundsOf);
  return {
    version,
    chrome: chromeOf(layout),
    painted,
    bounds,
    signatures: layout.elements.map(elementSignature),
    slotById: new Map(layout.elements.map((element, slot) => [element.id, slot])),
    grid: gridOfRects(bounds, CHUNK_SIZE),
  };
}

function slotsTouching(index: TileIndex, rect: Rect): number[] {
  const slots: number[] = [];
  forEachSlotTouching(index.grid, rect, (slot) => {
    slots.push(slot);
  });
  return slots.sort((left, right) => left - right);
}

function withTitlesOnly(painted: PaintedElement): PaintedElement {
  const { element } = painted;
  switch (element.kind) {
    case 'box': return { ...painted, element: { ...element, bodyLines: [] } };
    case 'unit': return { ...painted, element: { ...element, bodyLines: [] } };
    case 'panel': return { ...painted, element: { ...element, bodyLines: [] } };
    case 'note': return { ...painted, element: { ...element, lines: element.lines.slice(0, 1) } };
    default: return painted;
  }
}

function forLod(painted: PaintedElement, lod: TileLod): PaintedElement {
  return lod === 'titles' ? withTitlesOnly(painted) : painted;
}

function laneRgbOf(element: LaidOutElement): readonly [number, number, number] {
  if (element.kind !== 'box' || !element.lane) return [0, 0, 0];
  const hex = element.lane.hex.replace('#', '');
  const value = Number.parseInt(hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex, 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
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
    const [red, green, blue] = laneRgbOf(element);
    const left = Math.max(0, Math.floor((element.x - tileRect.x) / unitsPerPixel));
    const top = Math.max(0, Math.floor((element.y - tileRect.y) / unitsPerPixel));
    const right = Math.min(BLOCK_RASTER_PX - 1, Math.floor((element.x + element.width - tileRect.x) / unitsPerPixel));
    const bottom = Math.min(BLOCK_RASTER_PX - 1, Math.floor((element.y + element.height - tileRect.y) / unitsPerPixel));
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const offset = (row * BLOCK_RASTER_PX + column) * 4;
        pixels[offset] = red;
        pixels[offset + 1] = green;
        pixels[offset + 2] = blue;
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
    return painted ? [forLod(painted, key.lod)] : [];
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

function changedSlotsBetween(previous: TileIndex, next: TileIndex): { changedSlots: ChangedSlot[]; removedIds: string[]; touchedRects: Rect[] } {
  const changedSlots: ChangedSlot[] = [];
  const touchedRects: Rect[] = [];
  for (const [slot, painted] of next.painted.entries()) {
    const previousSlot = previous.slotById.get(painted.element.id);
    const isSame = previousSlot !== undefined && previous.signatures[previousSlot] === next.signatures[slot];
    if (isSame) continue;
    const nextBounds = next.bounds[slot];
    const previousBounds = previousSlot === undefined ? undefined : previous.bounds[previousSlot];
    const rects = [nextBounds, previousBounds].filter((rect): rect is Rect => rect !== undefined);
    changedSlots.push({ slot, rects });
    touchedRects.push(...rects);
  }
  const removedIds: string[] = [];
  for (const [id, slot] of previous.slotById) {
    if (next.slotById.has(id)) continue;
    removedIds.push(id);
    const previousBounds = previous.bounds[slot];
    if (previousBounds) touchedRects.push(previousBounds);
  }
  return { changedSlots, removedIds, touchedRects };
}

function tileDiffFor(previous: TileIndex, next: TileIndex, heldKeys: readonly TileKey[]): TileDiff {
  const { changedSlots, removedIds, touchedRects } = changedSlotsBetween(previous, next);
  const isChromeChanged = JSON.stringify(previous.chrome) !== JSON.stringify(next.chrome);
  const heldRects = heldKeys.map((key) => ({ key, rect: tileRectOf(key) }));
  const elementLods = new Set(heldKeys.filter((key) => key.lod !== 'blocks').map((key) => key.lod));
  const lod: TileLod = elementLods.has('titles') && !elementLods.has('full') ? 'titles' : 'full';
  const elementRects = heldRects.filter(({ key }) => key.lod !== 'blocks').map(({ rect }) => rect);
  const changed = changedSlots.flatMap(({ slot, rects }) => {
    const painted = next.painted[slot];
    if (!painted) return [];
    return elementRects.some((held) => rects.some((rect) => rectsTouch(held, rect))) ? [forLod(painted, lod)] : [];
  });
  const rasters = heldRects.filter(({ key, rect }) => key.lod === 'blocks' && touchedRects.some((touched) => rectsTouch(rect, touched))).map(({ key }) => tileOf(next, key));
  return { changed, removedIds, rasters, chrome: isChromeChanged ? next.chrome : null };
}

export { lodForScale, paintedBoundsOf, tileDiffFor, tileIdOf, tileIndexOf, tileKeysFor, tileOf, tileRectOf };
export type { TileIndex };
