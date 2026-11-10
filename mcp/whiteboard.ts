import { BoardRegion } from '../shared/contracts/whiteboard.ts';
import { PICTURE_FORMATS, RENDER_SCALES, boardPictureFile, forgetBoardRenders, renderKindOf, writeBoardRender } from '../server/whiteboard/board-picture.ts';
import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { VIEW_PICTURE_LIMITS, filePictureLimitsOf } from './core/board-reading.ts';
import type { ToolImageResult } from './core/tool-result.ts';
import type { WhiteboardAssetStore } from '../server/whiteboard/whiteboard-assets.ts';
import type { WhiteboardLayouts } from '../server/whiteboard/whiteboard-wiring.ts';

type AgentReply = { status: number; body: Record<string, unknown> };

const UNREADABLE_LAYOUT_REPLY: AgentReply = { status: 503, body: { ok: false, error: 'the board layout could not be read, so it was not pictured; try again' } };
const UNREAD_BOARD_TEXT = 'the board could not be read back for its plan steps and layout warnings';

async function boardIdFor(layouts: WhiteboardLayouts | null, boardRef: unknown, callerProject: string): Promise<string | null> {
  if (typeof boardRef !== 'string' || !layouts) return null;
  const found = await layouts.findBoardId(boardRef, callerProject);
  return found.ok ? found.boardId : null;
}

async function boardReplyWithReading(session: Session, agentApi: AgentApiPort, layouts: WhiteboardLayouts | null, payload: Record<string, unknown>): Promise<AgentReply> {
  const boardId = await boardIdFor(layouts, payload.board, session.path);
  const reply = await agentApi.handle(session, 'whiteboard', { ...payload, board: boardId ?? payload.board });
  if (reply.body.ok !== true) return reply;
  const reading = boardId ? await layouts?.readingOf(boardId).catch(() => null) : null;
  if (!reading) return { status: reply.status, body: { ...reply.body, readingError: UNREAD_BOARD_TEXT } };
  return { status: reply.status, body: { ...reply.body, readingVersion: reading.version, plan: reading.plan, layoutWarnings: reading.layoutWarnings } };
}

async function boardPictureResult(session: Session, agentApi: AgentApiPort, assets: WhiteboardAssetStore | null, layouts: WhiteboardLayouts | null, payload: Record<string, unknown>): Promise<AgentReply | ToolImageResult> {
  if (!layouts) return UNREADABLE_LAYOUT_REPLY;
  if (typeof payload.board !== 'string') return agentApi.handle(session, 'whiteboard', { sub: 'get', board: payload.board, peek: true });
  const region = BoardRegion.nullable().safeParse(payload.region ?? null);
  if (!region.success) return { status: 400, body: { ok: false, error: 'a region is {x, y, width, height} in board units, with a width and a height above 0' } };
  const found = await layouts.findBoardId(payload.board, session.path);
  if (!found.ok) return found.reply;
  const reading = await layouts.readingOf(found.boardId).catch(() => null);
  if (!reading) return UNREADABLE_LAYOUT_REPLY;
  const picture = await boardPictureFile(layouts, assets, found.boardId, { format: 'png', region: region.data, limits: VIEW_PICTURE_LIMITS });
  if (!picture.ok) return { status: picture.status, body: { ok: false, error: picture.error } };
  return {
    content: [
      { type: 'image', data: picture.bytes.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ title: reading.title, version: reading.version, plan: reading.plan, layoutWarnings: reading.layoutWarnings }) },
    ],
  };
}

const DEFAULT_RENDER_SCALE = 2;

async function boardRenderResult(session: Session, assets: WhiteboardAssetStore | null, layouts: WhiteboardLayouts | null, payload: Record<string, unknown>): Promise<AgentReply> {
  if (!layouts) return UNREADABLE_LAYOUT_REPLY;
  const format = PICTURE_FORMATS.find((known) => known === (payload.format ?? 'png'));
  const scale = RENDER_SCALES.find((known) => known === (payload.scale ?? DEFAULT_RENDER_SCALE));
  if (typeof payload.board !== 'string' || !format || !scale) return { status: 400, body: { ok: false, error: 'render needs a board, a format of png or svg when it gives one, and a scale of 1, 2 or 3 when it gives one' } };
  const found = await layouts.findBoardId(payload.board, session.path);
  if (!found.ok) return found.reply;
  const picture = await boardPictureFile(layouts, assets, found.boardId, { format, region: null, limits: filePictureLimitsOf(scale) });
  if (!picture.ok) return { status: picture.status, body: { ok: false, error: picture.error } };
  const written = await writeBoardRender(layouts.rendersRoot, found.boardId, renderKindOf(format, scale), picture.bytes);
  if (!written.ok) return { status: 500, body: written };
  if (layouts.isBoardDeleted(found.boardId)) {
    await forgetBoardRenders(layouts.rendersRoot, found.boardId);
    return { status: 404, body: { ok: false, error: 'the board was deleted while it was being rendered, so no picture was kept' } };
  }
  return { status: 200, body: { ok: true, wrote: written.wrote, format, width: picture.width, height: picture.height } };
}

export { boardPictureResult, boardRenderResult, boardReplyWithReading };
