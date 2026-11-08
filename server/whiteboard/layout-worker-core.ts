import { z } from 'zod';

import { BoardHead, BoardOutline, Element } from '../../shared/contracts/whiteboard.ts';
import type { Board } from '../../shared/contracts/whiteboard.ts';
import { BoardChrome, LaidOutMedia, LayoutRect, PlacedBox, Tile, TileDiff, TileKey } from '../../shared/contracts/whiteboard-tiles.ts';
import type { PlacedPaint } from '../../shared/contracts/whiteboard-tiles.ts';
import { appendElement, boardIndexOf, dropElement, storeElement } from '../../shared/whiteboard-board-index.ts';
import { boardPicture, pictureImagesOf } from '../../mcp/core/board-reading.ts';
import { advanceBoardLayout, chromeOfBoard, layoutBoardRemembered, lineageLayoutOf, pinPositionsOfBoard, resumeBoardLayout, savedWorldOfBoard, setSavedWorldSource, warningsOfBoard } from '../../shared/whiteboard-layout-cache.ts';
import type { SavedWorldOffer } from '../../shared/whiteboard-layout-cache.ts';
import { INCREMENTAL_MIN_ELEMENTS } from '../../shared/whiteboard-layout-engine.ts';
import type { ElementChange } from '../../shared/whiteboard-layout-engine.ts';
import { boardOutlineOf, defaultFocusOf, elementIdsTouching, patchTileIndex, tileDiffOf, tileIndexOf, tileIndexOfPainted, tileOf } from '../../shared/whiteboard-tile-core.ts';
import type { TileIndex } from '../../shared/whiteboard-tile-core.ts';
import type { LayoutCache, LayoutStamp, SavedPaint } from './layout-cache.ts';
import { elementTableOf, isElementTable } from '../../shared/whiteboard-element-table.ts';

const RequestId = z.number().int();
const ViewerTiles = z.strictObject({ viewerId: z.number().int(), version: z.number().int().nullable(), heldKeys: z.array(TileKey) });
const ChangedElement = z.strictObject({ id: z.string(), after: Element.nullable(), isAppended: z.boolean() });

const LayoutRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sync-start'), requestId: RequestId, syncId: z.number().int(), head: BoardHead, elementCount: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('sync-elements'), requestId: RequestId, syncId: z.number().int(), boardId: z.string(), elements: z.array(Element) }),
  z.strictObject({ kind: z.literal('advance'), requestId: RequestId, head: BoardHead, changes: z.array(ChangedElement), viewers: z.array(ViewerTiles) }),
  z.strictObject({ kind: z.literal('refresh'), requestId: RequestId, boardId: z.string(), viewers: z.array(ViewerTiles) }),
  z.strictObject({ kind: z.literal('picture-images'), requestId: RequestId, boardId: z.string() }),
  z.strictObject({ kind: z.literal('picture'), requestId: RequestId, boardId: z.string(), dataUriByAssetId: z.record(z.string(), z.string()) }),
  z.strictObject({ kind: z.literal('tiles'), requestId: RequestId, boardId: z.string(), keys: z.array(TileKey), withChrome: z.boolean() }),
  z.strictObject({ kind: z.literal('cached-tiles'), requestId: RequestId, boardId: z.string(), version: z.number().int(), updatedAt: z.number(), keys: z.array(TileKey), withChrome: z.boolean() }),
  z.strictObject({ kind: z.literal('pins'), requestId: RequestId, boardId: z.string(), ids: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('region'), requestId: RequestId, boardId: z.string(), focus: LayoutRect.nullable(), withOutline: z.boolean() }),
  z.strictObject({ kind: z.literal('summary'), requestId: RequestId, boardId: z.string() }),
  z.strictObject({ kind: z.literal('forget'), requestId: RequestId, boardId: z.string() }),
]);

const ViewerMessage = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('diff'), viewerId: z.number().int(), fromVersion: z.number().int(), diff: TileDiff }),
  z.strictObject({ kind: z.literal('tiles'), viewerId: z.number().int(), chrome: BoardChrome, tiles: z.array(Tile) }),
]);

const OpenStep = z.strictObject({ step: z.string(), elapsedMs: z.number(), heapBytes: z.number() });

const LayoutAnswer = z.strictObject({
  requestId: RequestId,
  ok: z.literal(true),
  version: z.number().int().optional(),
  warnings: z.array(z.string()).optional(),
  chrome: BoardChrome.optional(),
  viewerMessages: z.array(ViewerMessage).optional(),
  tiles: z.array(Tile).optional(),
  elementCount: z.number().int().nonnegative().optional(),
  isCacheMiss: z.boolean().optional(),
  pinnedBoxes: z.array(PlacedBox).optional(),
  pinnedOffsetY: z.number().optional(),
  focus: LayoutRect.optional(),
  elementIds: z.array(z.string()).optional(),
  outline: BoardOutline.optional(),
  pictureImages: z.array(z.strictObject({ media: LaidOutMedia, width: z.number(), height: z.number() })).optional(),
  openSteps: z.array(OpenStep).optional(),
  picture: z.union([
    z.strictObject({ ok: z.literal(true), svgDocument: z.string(), svgDensity: z.number(), maxPixels: z.number() }),
    z.strictObject({ ok: z.literal(false), error: z.string() }),
  ]).optional(),
});

const SavedLayoutWritten = z.strictObject({ savedLayoutWritten: z.strictObject({ boardId: z.string(), elapsedMs: z.number(), heapBytes: z.number() }) });
const LayoutReply = z.union([LayoutAnswer, z.strictObject({ requestId: RequestId, ok: z.literal(false), error: z.string() })]);

type LayoutRequest = z.infer<typeof LayoutRequest>;
type LayoutAnswer = z.infer<typeof LayoutAnswer>;
type OpenStep = z.infer<typeof OpenStep>;
type SavedLayoutWrite = z.infer<typeof SavedLayoutWritten>['savedLayoutWritten'];
type ViewerMessage = z.infer<typeof ViewerMessage>;
type ViewerTiles = z.infer<typeof ViewerTiles>;
type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;
type LayoutRequestBody = DistributiveOmit<LayoutRequest, 'requestId'>;
type AnswerFields = Omit<LayoutAnswer, 'requestId' | 'ok'>;

interface HeldTiles {
  index: TileIndex;
  lineage: number;
  updatedAt: number;
}

const CACHED_LINEAGE = -1;

interface LayoutHost {
  handle(request: LayoutRequestBody): AnswerFields;
}

function savedPaintOf(index: TileIndex, slot: number, painted: PlacedPaint | null | undefined): SavedPaint[] {
  if (!painted) return [];
  const { id } = painted.element;
  const kind = index.records.kindOf(id);
  const body = index.records.bodyOf(id);
  return kind && body !== undefined ? [{ slot, painted, record: { id, kind, body } }] : [];
}

function createLayoutHost(cache: LayoutCache, markStep: (step: string) => void): LayoutHost {
  const boardById = new Map<string, Board>();
  const tilesByBoardId = new Map<string, HeldTiles>();
  const syncIdByBoardId = new Map<string, number>();

  function boardNamed(boardId: string): Board {
    const board = boardById.get(boardId);
    if (!board) throw new Error(`the layout worker holds no board ${boardId}`);
    return board;
  }

  function cachedTilesOf(boardId: string, stamp: LayoutStamp): HeldTiles | null {
    const held = tilesByBoardId.get(boardId);
    if (held?.index.version === stamp.version && held.updatedAt === stamp.updatedAt) return held;
    const cached = cache.layoutOf(boardId, stamp);
    if (!cached) {
      markStep('saved layout missed');
      return null;
    }
    markStep('saved layout read');
    const fromCache = { index: tileIndexOfPainted(stamp.version, cached.chrome, cached.records, cached.painted), lineage: CACHED_LINEAGE, updatedAt: stamp.updatedAt };
    markStep('tiles built from saved layout');
    tilesByBoardId.set(boardId, fromCache);
    return fromCache;
  }

  function heldTilesOf(board: Board): HeldTiles {
    const held = cachedTilesOf(board.id, board);
    if (held) return held;
    const { lineage, layout } = lineageLayoutOf(board);
    markStep('layout world built');
    const fresh = { index: tileIndexOf(layout, board.version, board), lineage, updatedAt: board.updatedAt };
    markStep('tile index built');
    tilesByBoardId.set(board.id, fresh);
    cache.saveWhole(board.id, board, fresh.index.chrome, fresh.index.painted.flatMap((painted, slot) => savedPaintOf(fresh.index, slot, painted)), savedWorldOfBoard(board));
    markStep('saved layout queued');
    return fresh;
  }

  function savedWorldOfferFor(board: Board): SavedWorldOffer | null {
    if (boardIndexOf(board.elements).elementCount < INCREMENTAL_MIN_ELEMENTS) return null;
    const tiles = cachedTilesOf(board.id, board);
    const savedParts = tiles ? cache.worldOf(board.id, board) : null;
    if (!tiles || !savedParts) return null;
    markStep('saved routes and warnings read');
    const laidOut = tiles.index.painted.flatMap((painted) => painted?.element ?? []);
    return { saved: { laidOut, chrome: tiles.index.chrome, ...savedParts }, adopt: (lineage) => { tiles.lineage = lineage; } };
  }

  setSavedWorldSource(savedWorldOfferFor);

  function countOf(index: TileIndex): number {
    return index.slotById.size;
  }

  function wholeTilesOf(viewer: ViewerTiles, index: TileIndex): ViewerMessage {
    return { kind: 'tiles', viewerId: viewer.viewerId, chrome: index.chrome, tiles: viewer.heldKeys.map((key) => tileOf(index, key)) };
  }

  function refreshed(board: Board, viewers: readonly ViewerTiles[], warnings: string[]): AnswerFields {
    tilesByBoardId.delete(board.id);
    if (viewers.length === 0) return { version: board.version, warnings, chrome: chromeOfBoard(board) };
    const next = heldTilesOf(board).index;
    return { version: board.version, warnings, chrome: next.chrome, viewerMessages: viewers.map((viewer) => wholeTilesOf(viewer, next)) };
  }

  function advance(head: z.infer<typeof BoardHead>, changed: readonly z.infer<typeof ChangedElement>[], viewers: readonly ViewerTiles[]): AnswerFields {
    const held = boardNamed(head.id);
    if (held.version !== head.version - 1) throw new Error(`the layout worker holds board ${head.id} at version ${held.version}, not ${head.version - 1}`);
    resumeBoardLayout(held);
    const changes = new Map<string, ElementChange>();
    for (const { id, after, isAppended } of changed) {
      changes.set(id, { before: held.elements.get(id), after, isAppended });
      if (!after) dropElement(held.elements, id);
      if (after && isAppended) appendElement(held.elements, after);
      if (after && !isAppended) storeElement(held.elements, after);
    }
    const board: Board = { ...head, elements: held.elements };
    boardById.set(board.id, board);
    const layoutAdvance = advanceBoardLayout(board, changes);
    const tiles = tilesByBoardId.get(board.id) ?? null;
    if (!tiles || !layoutAdvance || tiles.lineage !== layoutAdvance.lineage || layoutAdvance.delta.isRebuilt || tiles.index.version !== board.version - 1) {
      return refreshed(board, viewers, layoutAdvance?.warnings ?? warningsOfBoard(board));
    }
    const fromVersion = tiles.index.version;
    const fromStamp = { version: fromVersion, updatedAt: tiles.updatedAt };
    tiles.updatedAt = board.updatedAt;
    const tileChanges = patchTileIndex(tiles.index, board, { version: board.version, chrome: layoutAdvance.chrome, changed: layoutAdvance.delta.changed, removedIds: layoutAdvance.delta.removedIds, recordChangedIds: [...changes.keys()] });
    const changedPaints = tileChanges.changedSlots.flatMap(({ slot }) => savedPaintOf(tiles.index, slot, tiles.index.painted[slot]));
    cache.save(board.id, fromStamp, board, tiles.index.chrome, changedPaints, tileChanges.removedIds, { routes: layoutAdvance.changedRoutes, warnings: layoutAdvance.warningChanges });
    const viewerMessages = viewers.map((viewer): ViewerMessage => (viewer.version === fromVersion
      ? { kind: 'diff', viewerId: viewer.viewerId, fromVersion, diff: tileDiffOf(tiles.index, tileChanges, viewer.heldKeys) }
      : wholeTilesOf(viewer, tiles.index)));
    return { version: board.version, warnings: layoutAdvance.warnings, chrome: layoutAdvance.chrome, viewerMessages };
  }

  function pinsFor(board: Board, ids: readonly string[]): AnswerFields {
    chromeOfBoard(board);
    const pinPositions = pinPositionsOfBoard(board);
    if (!pinPositions) throw new Error(`the layout worker could not place board ${board.id}`);
    const wantedIds = new Set(ids);
    const { dependentIdsByBoxId } = boardIndexOf(board.elements);
    for (const id of ids) {
      for (const dependentId of dependentIdsByBoxId.get(id) ?? []) {
        if (board.elements.get(dependentId)?.kind === 'box') wantedIds.add(dependentId);
      }
    }
    const pinnedBoxes = [...wantedIds].flatMap((id) => pinPositions.laidOutBoxOf(id) ?? []);
    return { pinnedBoxes, pinnedOffsetY: pinPositions.pinnedOffsetY };
  }

  function regionOf(board: Board, focus: z.infer<typeof LayoutRect> | null, withOutline: boolean): AnswerFields {
    const { index } = heldTilesOf(board);
    const chosen = focus ?? defaultFocusOf(index);
    return { version: board.version, focus: chosen, elementIds: elementIdsTouching(index, chosen), ...(withOutline ? { outline: boardOutlineOf(board, index, chosen) } : {}) };
  }

  function handle(request: LayoutRequestBody): AnswerFields {
    switch (request.kind) {
      case 'sync-start': {
        syncIdByBoardId.set(request.head.id, request.syncId);
        const records = cachedTilesOf(request.head.id, request.head)?.index.records;
        if (isElementTable(records) && records.size === request.elementCount) {
          boardById.set(request.head.id, { ...request.head, elements: records });
          return {};
        }
        tilesByBoardId.delete(request.head.id);
        boardById.set(request.head.id, { ...request.head, elements: elementTableOf() });
        return { isCacheMiss: true };
      }
      case 'sync-elements': {
        if (syncIdByBoardId.get(request.boardId) !== request.syncId) throw new Error(`the layout worker is not syncing board ${request.boardId} under sync ${request.syncId}`);
        const board = boardNamed(request.boardId);
        for (const element of request.elements) appendElement(board.elements, element);
        return {};
      }
      case 'advance': return advance(request.head, request.changes, request.viewers);
      case 'refresh': {
        const board = boardNamed(request.boardId);
        const current = tilesByBoardId.get(board.id) ?? null;
        if (current?.index.version !== board.version) return refreshed(board, request.viewers, warningsOfBoard(board));
        const viewerMessages = request.viewers.filter((viewer) => viewer.version !== board.version).map((viewer) => wholeTilesOf(viewer, current.index));
        return { version: board.version, warnings: warningsOfBoard(board), chrome: current.index.chrome, viewerMessages };
      }
      case 'picture-images': return { pictureImages: pictureImagesOf(layoutBoardRemembered(boardNamed(request.boardId))) };
      case 'picture': {
        const board = boardNamed(request.boardId);
        const picture = boardPicture(board, layoutBoardRemembered(board), (media) => request.dataUriByAssetId[media.asset] ?? null);
        if (!picture.ok) return { picture };
        return { picture: { ok: true, svgDocument: picture.svgDocument, svgDensity: picture.svgDensity, maxPixels: picture.maxPixels } };
      }
      case 'tiles': {
        const { index } = heldTilesOf(boardNamed(request.boardId));
        return { version: index.version, tiles: request.keys.map((key) => tileOf(index, key)), ...(request.withChrome ? { chrome: index.chrome } : {}) };
      }
      case 'cached-tiles': {
        const held = cachedTilesOf(request.boardId, request);
        if (!held) return { isCacheMiss: true };
        const { index } = held;
        return { version: index.version, elementCount: countOf(index), tiles: request.keys.map((key) => tileOf(index, key)), ...(request.withChrome ? { chrome: index.chrome } : {}) };
      }
      case 'pins': return pinsFor(boardNamed(request.boardId), request.ids);
      case 'region': return regionOf(boardNamed(request.boardId), request.focus, request.withOutline);
      case 'summary': {
        const board = boardNamed(request.boardId);
        return { version: board.version, chrome: chromeOfBoard(board), warnings: warningsOfBoard(board) };
      }
      case 'forget':
        cache.forget(request.boardId);
        boardById.delete(request.boardId);
        tilesByBoardId.delete(request.boardId);
        syncIdByBoardId.delete(request.boardId);
        return {};
    }
  }

  return { handle };
}

export { LayoutReply, LayoutRequest, SavedLayoutWritten, createLayoutHost };
export type { LayoutAnswer, LayoutRequestBody, OpenStep, SavedLayoutWrite, ViewerMessage, ViewerTiles };
