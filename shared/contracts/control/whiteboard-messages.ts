import { z } from 'zod';
import { Board, BoardReview, BoardSummary, Element, Op, WHITEBOARD_LIMITS } from '../whiteboard.ts';
import { LaidOutBoard } from '../whiteboard-layout.ts';
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
    columns: Board.shape.columns.optional(),
    lanes: Board.shape.lanes.optional(),
    codeSessionId: Board.shape.codeSessionId.unwrap().optional(),
  }).strict(),
  elements: z.record(z.string(), ElementChange),
}).strict();

const whiteboardPatchFields = {
  boardId: z.string(),
  fromVersion: z.number().int(),
  toVersion: z.number().int(),
  author: z.object({ id: z.string(), name: z.string() }),
  updatedAt: z.number(),
  diff: BoardDiff,
};

export type ElementChange = z.infer<typeof ElementChange>;
export type BoardDiff = z.infer<typeof BoardDiff>;

export const whiteboardClientVariants = [
  loose('whiteboard-create', { title: Board.shape.title, requestId }),
  loose('whiteboard-op', { boardId: Board.shape.id, ops: z.array(Op).min(1).max(WHITEBOARD_LIMITS.opsPerPut), requestId }),
  loose('whiteboard-delete', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-get', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-review', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-layout', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-connect', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
  loose('whiteboard-disconnect', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
  loose('whiteboard-nudge', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
] as const;

export const whiteboardServerVariants = [
  loose('whiteboards-snapshot', { boards: z.array(BoardSummary) }),
  loose('whiteboard-patch', whiteboardPatchFields),
  loose('whiteboard-removed', { boardId: z.string() }),
  loose('whiteboard-result', { requestId, ok: z.boolean(), error: optionalError, board: Board.optional(), summary: BoardSummary.optional(), review: BoardReview.optional(), patch: z.object(whiteboardPatchFields).optional(), laidOut: z.object({ version: z.number().int(), layout: LaidOutBoard }).optional() }),
] as const;
