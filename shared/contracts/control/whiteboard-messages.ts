import { z } from 'zod';
import { Board, BoardReview, BoardSummary, Op, WHITEBOARD_LIMITS } from '../whiteboard.ts';
import { requestId, loose, optionalError } from './control-fields.ts';

export const whiteboardClientVariants = [
  loose('whiteboard-create', { title: Board.shape.title, requestId }),
  loose('whiteboard-op', { boardId: Board.shape.id, ops: z.array(Op).min(1).max(WHITEBOARD_LIMITS.opsPerPut), requestId }),
  loose('whiteboard-delete', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-get', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-review', { boardId: Board.shape.id, requestId }),
  loose('whiteboard-connect', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
  loose('whiteboard-disconnect', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
  loose('whiteboard-nudge', { boardId: Board.shape.id, sessionId: z.string().min(1), requestId }),
] as const;

export const whiteboardServerVariants = [
  loose('whiteboards-snapshot', { boards: z.array(BoardSummary) }),
  loose('whiteboard-patch', {
    boardId: z.string(),
    fromVersion: z.number().int(),
    toVersion: z.number().int(),
    author: z.object({ id: z.string(), name: z.string() }),
    updatedAt: z.number(),
    ops: z.array(Op),
  }),
  loose('whiteboard-removed', { boardId: z.string() }),
  loose('whiteboard-result', { requestId, ok: z.boolean(), error: optionalError, board: Board.optional(), summary: BoardSummary.optional(), review: BoardReview.optional() }),
] as const;
