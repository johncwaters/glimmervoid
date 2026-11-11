import { z } from 'zod';
import { Board, BOARD_DOC_CAP_BYTES, BoardHead, BoardReview, BoardSummary, BoxMedia, Element, Op, WHITEBOARD_LIMITS } from '../whiteboard.ts';
import { BoardChrome, LayoutRect, Tile, TileDiff, TILE_LODS } from '../whiteboard-tiles.ts';
import { requestId, loose, optionalError } from './control-fields.ts';

export const ElementChange = z.union([
  z.tuple([z.literal('put'), Element]),
  z.tuple([z.literal('patch'), z.record(z.string(), z.unknown())]),
  z.tuple([z.literal('remove')]),
]);

export const BoardDiff = z.object({
  fields: z.object({
    title: Board.shape.title.optional(),
    caption: Board.shape.caption.optional(),
    legend: Board.shape.legend.unwrap().optional(),
    codeSessionId: Board.shape.codeSessionId.unwrap().optional(),
  }).strict(),
  elements: z.record(z.string(), ElementChange),
}).strict();

export const DiffBefore = z.object({ fields: BoardDiff.shape.fields, elements: z.record(z.string(), Element.nullable()) }).strict();

export const WhiteboardPatch = z.object({
  boardId: z.string(),
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  author: z.object({ id: z.string(), name: z.string() }),
  updatedAt: z.number(),
  diff: BoardDiff,
  before: DiffBefore,
});

export type ElementChange = z.infer<typeof ElementChange>;
export type BoardDiff = z.infer<typeof BoardDiff>;
export type DiffBefore = z.infer<typeof DiffBefore>;
export type WhiteboardPatch = z.infer<typeof WhiteboardPatch>;

export const whiteboardClientVariants = [
  loose('whiteboard-create', { title: Board.shape.title, requestId }),
  loose('whiteboard-op', { boardId: Board.shape.id, ops: z.array(Op).min(1).max(WHITEBOARD_LIMITS.opsPerPut), requestId }),
  loose('whiteboard-delete', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-get', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-review', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-connect', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
  loose('whiteboard-disconnect', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
  loose('whiteboard-detach', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
  loose('whiteboard-linked-doc-save', { boardId: Board.shape.id, boxId: z.string().min(1), text: z.string().max(BOARD_DOC_CAP_BYTES), baseAsset: BoxMedia.shape.asset, requestId }),
  loose('whiteboard-view', { boardId: Board.shape.id, view: LayoutRect, lod: z.enum(TILE_LODS), knownVersion: z.number().int().nullable(), requestId }),
] as const;

export const whiteboardServerVariants = [
  loose('whiteboards-snapshot', { boards: z.array(BoardSummary) }),
  loose('whiteboard-removed', { boardId: z.string() }),
  loose('whiteboard-tiles', { boardId: z.string(), version: z.number().int(), head: BoardHead, elementCount: z.number().int().nonnegative(), chrome: BoardChrome.nullable(), tiles: z.array(Tile) }),
  loose('whiteboard-tile-diff', { boardId: z.string(), fromVersion: z.number().int(), toVersion: z.number().int(), head: BoardHead, elementCount: z.number().int().nonnegative(), diff: TileDiff }),
  loose('whiteboard-result', { requestId, ok: z.boolean(), error: optionalError, board: Board.optional(), summary: BoardSummary.optional(), review: BoardReview.optional(), patch: WhiteboardPatch.optional(), isConflict: z.boolean().optional(), savedMedia: BoxMedia.optional() }),
] as const;
