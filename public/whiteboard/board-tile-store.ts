import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { AgentChange } from '#shared/contracts/control/whiteboard-messages.ts';
import type { Board, BoardHead } from '#shared/contracts/whiteboard.ts';
import type { BoardChrome, PaintedElement, TileKey, TileLod } from '#shared/contracts/whiteboard-tiles.ts';
import type { BoardLayout, Rect } from '#shared/whiteboard-layout-core.ts';
import { lodForScale, paintedBoundsOf, tileIdOf, tileKeysFor, tileRectOf } from '#shared/whiteboard-tile-core.ts';
import { sendControlMsg } from '../control-ws.ts';
import { elementTableOf } from '#shared/whiteboard-element-table.ts';

const VIEW_SEND_DELAY_MS = 100;
const AGENT_RING_MS = 8000;

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
  board: Board;
  elementCount: number;
}

interface TileState {
  boardId: string;
  version: number | null;
  head: BoardHead | null;
  elementCount: number;
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

interface AgentRing {
  boardId: string;
  boxIds: ReadonlySet<string>;
}

interface AgentChip {
  boardId: string;
  at: number;
  change: AgentChange;
}

let agentRing: AgentRing | null = null;
let agentChip: AgentChip | null = null;
let agentRingTimer: ReturnType<typeof setTimeout> | null = null;
const agentChangeListeners: ((sessionId: string, boardChange: AgentChip) => void)[] = [];
const unshownAgentChangeBySessionId = new Map<string, AgentChip>();

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
  if (evictUnsentTiles(current, (tile) => tile.key.lod === current.lod && !rectsTouch(tile.rect, current.view))) notifyTilesChanged();
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

function isViewRequested(current: TileState): boolean {
  return tileKeysFor(current.view, current.lod).every((key) => current.tiles.has(tileIdOf(key)) || current.sentTileIds.has(tileIdOf(key)));
}

function freshState(boardId: string, view: Rect, lod: TileLod): TileState {
  return { boardId, version: null, head: null, elementCount: 0, chrome: null, lod, view, sentTileIds: new Set(), tiles: new Map(), elementById: new Map(), assembled: null };
}

function showTilesFor(boardId: string, view: Rect, scale: number): void {
  const lod = lodForScale(scale);
  const isNewBoard = state?.boardId !== boardId;
  if (isNewBoard) forgetAgentChange();
  const current = isNewBoard || !state ? freshState(boardId, view, lod) : state;
  const isLodChanged = current.lod !== lod;
  state = current;
  current.view = view;
  current.lod = lod;
  if (isNewBoard || isLodChanged || current.version === null || !isViewRequested(current)) {
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
  current.head = message.head;
  current.elementCount = message.elementCount;
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
  followAgentChip(message.diff.removedIds, message.diff.changed);
  for (const tile of message.diff.rasters) {
    const held = current.tiles.get(tileIdOf(tile.key));
    if (held) held.raster = tile.raster ? bytesOf(tile.raster) : null;
  }
  if (message.diff.chrome) current.chrome = message.diff.chrome;
  current.head = message.head;
  current.elementCount = message.elementCount;
  current.version = message.toVersion;
  current.assembled = null;
  notifyTilesChanged();
}

function followAgentChip(removedIds: readonly string[], changed: readonly PaintedElement[]): void {
  if (!agentChip) return;
  const removed = new Set(removedIds);
  const changedById = new Map(changed.map(({ element }) => [element.id, element]));
  const boxes = agentChip.change.boxes.flatMap((box) => {
    if (removed.has(box.id)) return [];
    const changedBox = changedById.get(box.id);
    if (changedBox?.kind !== 'box') return [box];
    return [{ ...box, rect: { x: changedBox.x, y: changedBox.y, width: changedBox.width, height: changedBox.height } }];
  });
  agentChip = boxes.length === 0 ? null : { ...agentChip, change: { ...agentChip.change, boxes } };
}

function forgetAgentChange(): void {
  if (agentRingTimer !== null) clearTimeout(agentRingTimer);
  agentRingTimer = null;
  agentRing = null;
  agentChip = null;
}

function applyAgentChange(message: ServerMessageOf<'whiteboard-agent-change'>): void {
  const boardChange: AgentChip = { boardId: message.boardId, at: message.at, change: message.change };
  unshownAgentChangeBySessionId.set(message.change.author.id, boardChange);
  for (const listener of agentChangeListeners) listener(message.change.author.id, boardChange);
  if (state?.boardId !== message.boardId) return;
  agentChip = boardChange;
  ringAgentChange(message.boardId, message.change);
}

function ringAgentChange(boardId: string, change: AgentChange): void {
  if (agentRingTimer !== null) clearTimeout(agentRingTimer);
  agentRing = { boardId, boxIds: new Set(change.boxes.map((box) => box.id)) };
  agentRingTimer = setTimeout(endAgentRing, AGENT_RING_MS);
  notifyTilesChanged();
}

function onAgentChange(listener: (sessionId: string, boardChange: AgentChip) => void): void {
  agentChangeListeners.push(listener);
}

function unshownAgentChangeOf(sessionId: string): AgentChip | null {
  return unshownAgentChangeBySessionId.get(sessionId) ?? null;
}

function markAgentChangeShown(sessionId: string, shownChange: AgentChange): void {
  if (unshownAgentChangeBySessionId.get(sessionId)?.change !== shownChange) return;
  unshownAgentChangeBySessionId.delete(sessionId);
}

function changedCardsOf(change: AgentChange): string {
  const [onlyBox] = change.boxes;
  return change.boxes.length === 1 && onlyBox ? onlyBox.title : `${change.boxes.length} cards`;
}

function agentChangeSentence(change: AgentChange): string {
  return `${change.author.name} changed ${changedCardsOf(change)}`;
}

function endAgentRing(): void {
  agentRingTimer = null;
  if (!agentRing) return;
  agentRing = null;
  notifyTilesChanged();
}

function ringedAgentBoxIdsOf(boardId: string): ReadonlySet<string> {
  return agentRing?.boardId === boardId ? agentRing.boxIds : new Set();
}

function offViewAgentChangeOf(boardId: string): AgentChange | null {
  const current = state;
  if (!current || current.boardId !== boardId || agentChip?.boardId !== boardId) return null;
  const { change } = agentChip;
  return change.boxes.every((box) => rectsTouch(box.rect, current.view)) ? null : change;
}

function dismissAgentChange(): void {
  if (!agentChip) return;
  agentChip = null;
  notifyTilesChanged();
}

function tiledBoardOf(boardId: string): TiledBoard | null {
  const current = state;
  if (!current || current.boardId !== boardId || current.version === null || !current.chrome || !current.head) return null;
  if (current.assembled) return current.assembled;
  const painted = [...current.elementById.values()].sort((left, right) => left.paintOrder - right.paintOrder);
  const records = elementTableOf(painted.flatMap(({ record }) => record ?? []));
  const blocks = [...current.tiles].flatMap(([id, tile]) => (tile.raster ? [{ id, rect: tile.rect, raster: tile.raster }] : []));
  const layout = { ...current.chrome, elements: painted.map(({ element }) => element), warnings: [] };
  current.assembled = { version: current.version, lod: current.lod, layout, blocks, board: { ...current.head, elements: records }, elementCount: current.elementCount };
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

function resendTilesView(): void {
  if (!state) return;
  state.version = null;
  sendView(state);
}

function forgetTilesOf(boardId: string): void {
  if (state?.boardId !== boardId) return;
  if (sendTimer !== null) clearTimeout(sendTimer);
  sendTimer = null;
  state = null;
  forgetAgentChange();
  notifyTilesChanged();
}

function onTilesChanged(listener: () => void): void {
  listeners.push(listener);
}

export { agentChangeSentence, applyAgentChange, changedCardsOf, markAgentChangeShown, unshownAgentChangeOf, applyBoardTileDiff, applyBoardTiles, dismissAgentChange, forgetTilesOf, offViewAgentChangeOf, onAgentChange, onTilesChanged, resendTilesView, resyncTilesIfBehind, ringAgentChange, ringedAgentBoxIdsOf, showTilesFor, tiledBoardOf };
export type { AgentChip, BlockTile };
