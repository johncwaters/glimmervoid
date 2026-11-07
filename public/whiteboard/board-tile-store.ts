import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { BoardChrome, PaintedElement, TileKey, TileLod } from '#shared/contracts/whiteboard-tiles.ts';
import type { BoardLayout, Rect } from '#shared/whiteboard-layout-core.ts';
import { lodForScale, paintedBoundsOf, tileIdOf, tileKeysFor, tileRectOf } from '#shared/whiteboard-tile-core.ts';
import { sendControlMsg } from '../control-ws.ts';

const VIEW_SEND_DELAY_MS = 100;

interface HeldTile {
  key: TileKey;
  rect: Rect;
  elementIds: Set<string>;
  raster: Uint8Array | null;
}

interface BlockTile {
  id: string;
  rect: Rect;
  raster: Uint8Array;
}

interface TiledBoard {
  version: number;
  lod: TileLod;
  layout: BoardLayout;
  blocks: BlockTile[];
}

interface TileState {
  boardId: string;
  version: number | null;
  chrome: BoardChrome | null;
  lod: TileLod;
  view: Rect;
  sentTileIds: Set<string>;
  tiles: Map<string, HeldTile>;
  elementById: Map<string, PaintedElement>;
  assembled: TiledBoard | null;
}

const listeners: (() => void)[] = [];
let state: TileState | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;

function notifyTilesChanged(): void {
  for (const listener of listeners) listener();
}

function rectsTouch(left: Rect, right: Rect): boolean {
  return left.x <= right.x + right.width && right.x <= left.x + left.width && left.y <= right.y + right.height && right.y <= left.y + left.height;
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sendView(current: TileState): void {
  if (sendTimer !== null) clearTimeout(sendTimer);
  sendTimer = null;
  current.sentTileIds = new Set(tileKeysFor(current.view, current.lod).map(tileIdOf));
  if (evictUnsentTiles(current, (tile) => tile.key.lod === current.lod)) notifyTilesChanged();
  sendControlMsg({ type: 'whiteboard-view', boardId: current.boardId, view: current.view, lod: current.lod, knownVersion: current.version });
}

function scheduleViewSend(current: TileState): void {
  if (sendTimer !== null) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    if (state === current) sendView(current);
  }, VIEW_SEND_DELAY_MS);
}

function dropElementFromTiles(current: TileState, elementId: string): void {
  for (const tile of current.tiles.values()) tile.elementIds.delete(elementId);
}

function forgetUnheldElements(current: TileState): void {
  const heldIds = new Set<string>();
  for (const tile of current.tiles.values()) {
    for (const elementId of tile.elementIds) heldIds.add(elementId);
  }
  for (const elementId of [...current.elementById.keys()]) {
    if (!heldIds.has(elementId)) current.elementById.delete(elementId);
  }
}

function freshState(boardId: string, view: Rect, lod: TileLod): TileState {
  return { boardId, version: null, chrome: null, lod, view, sentTileIds: new Set(), tiles: new Map(), elementById: new Map(), assembled: null };
}

function showTilesFor(boardId: string, view: Rect, scale: number): void {
  const lod = lodForScale(scale);
  const isNewBoard = state?.boardId !== boardId;
  const current = isNewBoard || !state ? freshState(boardId, view, lod) : state;
  const isLodChanged = current.lod !== lod;
  state = current;
  current.view = view;
  current.lod = lod;
  if (isNewBoard || isLodChanged || current.version === null) {
    sendView(current);
    return;
  }
  scheduleViewSend(current);
}

function evictUnsentTiles(current: TileState, isEvictable: (tile: HeldTile) => boolean): boolean {
  let isEvicted = false;
  for (const [tileId, tile] of [...current.tiles]) {
    if (current.sentTileIds.has(tileId) || !isEvictable(tile)) continue;
    current.tiles.delete(tileId);
    isEvicted = true;
  }
  if (!isEvicted) return false;
  forgetUnheldElements(current);
  current.assembled = null;
  return true;
}

function holdTile(current: TileState, tile: ServerMessageOf<'whiteboard-tiles'>['tiles'][number]): void {
  const elementIds = new Set<string>();
  for (const painted of tile.elements) {
    current.elementById.set(painted.element.id, painted);
    elementIds.add(painted.element.id);
  }
  current.tiles.set(tileIdOf(tile.key), { key: tile.key, rect: tileRectOf(tile.key), elementIds, raster: tile.raster ? bytesOf(tile.raster) : null });
}

function applyBoardTiles(message: ServerMessageOf<'whiteboard-tiles'>): void {
  const current = state;
  if (!current || current.boardId !== message.boardId) return;
  if (message.chrome) {
    current.tiles.clear();
    current.elementById.clear();
    current.chrome = message.chrome;
  }
  if (!current.chrome) return;
  current.version = message.version;
  for (const tile of message.tiles) holdTile(current, tile);
  evictUnsentTiles(current, () => true);
  current.assembled = null;
  notifyTilesChanged();
}

function placeChangedElement(current: TileState, painted: PaintedElement): void {
  dropElementFromTiles(current, painted.element.id);
  const bounds = paintedBoundsOf(painted.element);
  let isHeld = false;
  for (const tile of current.tiles.values()) {
    if (tile.key.lod === 'blocks' || !rectsTouch(tile.rect, bounds)) continue;
    tile.elementIds.add(painted.element.id);
    isHeld = true;
  }
  if (isHeld) {
    current.elementById.set(painted.element.id, painted);
    return;
  }
  current.elementById.delete(painted.element.id);
}

function applyBoardTileDiff(message: ServerMessageOf<'whiteboard-tile-diff'>): void {
  const current = state;
  if (!current || current.boardId !== message.boardId) return;
  if (current.version !== message.fromVersion) {
    current.version = null;
    sendView(current);
    return;
  }
  for (const removedId of message.diff.removedIds) {
    dropElementFromTiles(current, removedId);
    current.elementById.delete(removedId);
  }
  for (const painted of message.diff.changed) placeChangedElement(current, painted);
  for (const tile of message.diff.rasters) {
    const held = current.tiles.get(tileIdOf(tile.key));
    if (held) held.raster = tile.raster ? bytesOf(tile.raster) : null;
  }
  if (message.diff.chrome) current.chrome = message.diff.chrome;
  current.version = message.toVersion;
  current.assembled = null;
  notifyTilesChanged();
}

function tiledBoardOf(boardId: string): TiledBoard | null {
  const current = state;
  if (!current || current.boardId !== boardId || current.version === null || !current.chrome) return null;
  if (current.assembled) return current.assembled;
  const elements = [...current.elementById.values()].sort((left, right) => left.paintOrder - right.paintOrder).map((painted) => painted.element);
  const blocks = [...current.tiles].flatMap(([id, tile]) => (tile.raster ? [{ id, rect: tile.rect, raster: tile.raster }] : []));
  current.assembled = { version: current.version, lod: current.lod, layout: { ...current.chrome, elements, warnings: [] }, blocks };
  return current.assembled;
}

function resyncTilesIfBehind(versionByBoardId: ReadonlyMap<string, number>): void {
  if (!state || state.version === null) return;
  const boardVersion = versionByBoardId.get(state.boardId);
  if (boardVersion === undefined) {
    forgetTilesOf(state.boardId);
    return;
  }
  if (boardVersion === state.version) return;
  state.version = null;
  sendView(state);
}

function forgetTilesOf(boardId: string): void {
  if (state?.boardId !== boardId) return;
  if (sendTimer !== null) clearTimeout(sendTimer);
  sendTimer = null;
  state = null;
  notifyTilesChanged();
}

function onTilesChanged(listener: () => void): void {
  listeners.push(listener);
}

export { applyBoardTileDiff, applyBoardTiles, forgetTilesOf, onTilesChanged, resyncTilesIfBehind, showTilesFor, tiledBoardOf };
export type { BlockTile };
