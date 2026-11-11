import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { ControlContext, RequestWithId } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

const NO_REVIEWS_ERROR = 'Review comments are not available on this server.';

function createReviewHandlers(_context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { reviews = null } = deps;

  async function answer(ws: ControlSocket, msg: RequestWithId, run: (port: NonNullable<typeof reviews>) => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    if (!reviews) return replyTo(ws, msg, 'review-result', { ok: false, error: NO_REVIEWS_ERROR });
    const outcome = await run(reviews).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    replyTo(ws, msg, 'review-result', { ok: outcome.ok, error: outcome.ok ? null : outcome.error ?? null });
  }

  const handlers = {
    'request-review-state': async (msg: ClientMessageOf<'request-review-state'>, ws: ControlSocket) => {
      if (!reviews) return;
      const state = await reviews.read(msg.id);
      if (state) ws.send(JSON.stringify({ type: 'review-state', id: msg.id, state }));
    },
    'review-mark-viewed': (msg: ClientMessageOf<'review-mark-viewed'>, ws: ControlSocket) => answer(ws, msg, (port) => port.markViewed(msg.id, msg.path, msg.contentHash, msg.isViewed)),
    'review-send-comment': (msg: ClientMessageOf<'review-send-comment'>, ws: ControlSocket) => answer(ws, msg, (port) => port.sendComment(msg.id, {
      path: msg.path,
      side: msg.side,
      line: msg.line,
      lineText: msg.lineText,
      text: msg.text,
    })),
    'review-resolve-comment': (msg: ClientMessageOf<'review-resolve-comment'>, ws: ControlSocket) => answer(ws, msg, (port) => port.resolve(msg.id, msg.commentId, 'operator')),
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'review-mark-viewed': (_msg, requestId, message) => ({ type: 'review-result', requestId, ok: false, error: message }),
    'review-send-comment': (_msg, requestId, message) => ({ type: 'review-result', requestId, ok: false, error: message }),
    'review-resolve-comment': (_msg, requestId, message) => ({ type: 'review-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies };
}

export { createReviewHandlers };
