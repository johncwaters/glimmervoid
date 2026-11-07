import { z } from 'zod';

import { BoardHead, BoardOutline, Element } from '../../shared/contracts/whiteboard.ts';
import type { Board } from '../../shared/contracts/whiteboard.ts';
import { BoardChrome, LaidOutBox, LaidOutMedia, LayoutRect, Tile, TileDiff, TileKey } from '../../shared/contracts/whiteboard-tiles.ts';
import { appendElement, boardIndexOf, dropElement, storeElement } from '../../shared/whiteboard-board-index.ts';
import { boardPicture, pictureImagesOf } from '../../mcp/core/board-reading.ts';
import { advanceBoardLayout, chromeOfBoard, layoutBoardRemembered, lineageLayoutOf, pinPositionsOfBoard, warningsOfBoard } from '../../shared/whiteboard-layout-cache.ts';
import type { ElementChange } from '../../shared/whiteboard-layout-engine.ts';
import { boardOutlineOf, defaultFocusOf, elementIdsTouching, patchTileIndex, tileDiffOf, tileIndexOf, tileOf } from '../../shared/whiteboard-tile-core.ts';
import type { TileIndex } from '../../shared/whiteboard-tile-core.ts';

const RequestId = z.number().int();
const ViewerTiles = z.strictObject({ viewerId: z.number().int(), version: z.number().int().nullable(), heldKeys: z.array(TileKey) });
const ChangedElement = z.strictObject({ id: z.string(), after: Element.nullable(), isAppended: z.boolean() });

const LayoutRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sync-start'), requestId: RequestId, syncId: z.number().int(), head: BoardHead }),
  z.strictObject({ kind: z.literal('sync-elements'), requestId: RequestId, syncId: z.number().int(), boardId: z.string(), elements: z.array(Element) }),
  z.strictObject({ kind: z.literal('advance'), requestId: RequestId, head: BoardHead, changes: z.array(ChangedElement), viewers: z.array(ViewerTiles) }),
  z.strictObject({ kind: z.literal('refresh'), requestId: RequestId, boardId: z.string(), viewers: z.array(ViewerTiles) }),
  z.strictObject({ kind: z.literal('picture-images'), requestId: RequestId, boardId: z.string() }),
  z.strictObject({ kind: z.literal('picture'), requestId: RequestId, boardId: z.string(), dataUriByAssetId: z.record(z.string(), z.string()) }),
  z.strictObject({ kind: z.literal('tiles'), requestId: RequestId, boardId: z.string(), keys: z.array(TileKey), withChrome: z.boolean() }),
  z.strictObject({ kind: z.literal('pins'), requestId: RequestId, boardId: z.string(), ids: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('region'), requestId: RequestId, boardId: z.string(), focus: LayoutRect.nullable(), withOutline: z.boolean() }),
  z.strictObject({ kind: z.literal('summary'), requestId: RequestId, boardId: z.string() }),
  z.strictObject({ kind: z.literal('forget'), requestId: RequestId, boardId: z.string() }),
]);

const ViewerMessage = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('diff'), viewerId: z.number().int(), fromVersion: z.number().int(), diff: TileDiff }),
  z.strictObject({ kind: z.literal('tiles'), viewerId: z.number().int(), chrome: BoardChrome, tiles: z.array(Tile) }),
]);

const LayoutAnswer = z.strictObject({
  requestId: RequestId,
  ok: z.literal(true),
  version: z.number().int().optional(),
  warnings: z.array(z.string()).optional(),
  chrome: BoardChrome.optional(),
  viewerMessages: z.array(ViewerMessage).optional(),
  tiles: z.array(Tile).optional(),
  pinnedBoxes: z.array(LaidOutBox).optional(),
  pinnedOffsetY: z.number().optional(),
  focus: LayoutRect.optional(),
  elementIds: z.array(z.string()).optional(),
  outline: BoardOutline.optional(),
  pictureImages: z.array(z.strictObject({ media: LaidOutMedia, width: z.number(), height: z.number() })).optional(),
  picture: z.union([
    z.strictObject({ ok: z.literal(true), svgDocument: z.string(), svgDensity: z.number(), maxPixels: z.number() }),
    z.strictObject({ ok: z.literal(false), error: z.string() }),
  ]).optional(),
});

const LayoutReply = z.union([LayoutAnswer, z.strictObject({ requestId: RequestId, ok: z.literal(false), error: z.string() })]);

type LayoutRequest = z.infer<typeof LayoutRequest>;
type LayoutAnswer = z.infer<typeof LayoutAnswer>;
type ViewerMessage = z.infer<typeof ViewerMessage>;
type ViewerTiles = z.infer<typeof ViewerTiles>;
type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;
type LayoutRequestBody = DistributiveOmit<LayoutRequest, 'requestId'>;
type AnswerFields = Omit<LayoutAnswer, 'requestId' | 'ok'>;

interface HeldTiles {
  index: TileIndex;
  lineage: number;
}

interface LayoutHost {
  handle(request: LayoutRequestBody): AnswerFields;
}

function createLayoutHost(): LayoutHost {
  const boardById = new Map<string, Board>();
  const tilesByBoardId = new Map<string, HeldTiles>();
  const syncIdByBoardId = new Map<string, number>();

  function boardNamed(boardId: string): Board {
    const board = boardById.get(boardId);
    if (!board) throw new Error(`the layout worker holds no board ${boardId}`);
    return board;
  }

  function heldTilesOf(board: Board): HeldTiles {
    const held = tilesByBoardId.get(board.id);
    if (held?.index.version === board.version) return held;
    const { lineage, layout } = lineageLayoutOf(board);
    const fresh = { index: tileIndexOf(layout, board.version, board), lineage };
    tilesByBoardId.set(board.id, fresh);
    return fresh;
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
    const changes = new Map<string, ElementChange>();
    for (const { id, after, isAppended } of changed) {
      changes.set(id, { before: held.elements[id], after, isAppended });
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
    const tileChanges = patchTileIndex(tiles.index, board, { version: board.version, chrome: layoutAdvance.chrome, changed: layoutAdvance.delta.changed, removedIds: layoutAdvance.delta.removedIds, recordChangedIds: [...changes.keys()] });
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
        if (board.elements[dependentId]?.kind === 'box') wantedIds.add(dependentId);
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
        tilesByBoardId.delete(request.head.id);
        syncIdByBoardId.set(request.head.id, request.syncId);
        boardById.set(request.head.id, { ...request.head, elements: {} });
        return {};
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
      case 'pins': return pinsFor(boardNamed(request.boardId), request.ids);
      case 'region': return regionOf(boardNamed(request.boardId), request.focus, request.withOutline);
      case 'summary': {
        const board = boardNamed(request.boardId);
        return { version: board.version, chrome: chromeOfBoard(board), warnings: warningsOfBoard(board) };
      }
      case 'forget':
        boardById.delete(request.boardId);
        tilesByBoardId.delete(request.boardId);
        syncIdByBoardId.delete(request.boardId);
        return {};
    }
  }

  return { handle };
}

export { LayoutReply, LayoutRequest, createLayoutHost };
export type { LayoutAnswer, LayoutRequestBody, ViewerMessage, ViewerTiles };
