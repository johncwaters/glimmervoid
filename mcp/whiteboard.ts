import { BoardRegion, sparseBoardReply } from '../shared/contracts/whiteboard.ts';
import { PICTURE_FORMATS, RENDER_SCALES, boardPictureFile, forgetBoardRenders, renderKindOf, writeBoardRender } from '../server/whiteboard/board-picture.ts';
import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { VIEW_PICTURE_LIMITS, boxIdsInBoardReply, filePictureLimitsOf, withDrawnBoxRects } from './core/board-reading.ts';
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

const putsSinceViewBySession = new WeakMap<Session, Map<string, number>>();

function countPutSinceView(session: Session, boardId: string): number {
  const putsSinceViewByBoardId = putsSinceViewBySession.get(session) ?? new Map<string, number>();
  putsSinceViewBySession.set(session, putsSinceViewByBoardId);
  const putsSinceView = (putsSinceViewByBoardId.get(boardId) ?? 0) + 1;
  putsSinceViewByBoardId.set(boardId, putsSinceView);
  return putsSinceView;
}

function bodyWithUnviewedPutWarning(session: Session, boardId: string | null, payload: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  if (payload.sub !== 'put' || !boardId) return body;
  const putsSinceView = countPutSinceView(session, boardId);
  const putCount = putsSinceView === 1 ? '1 put' : `${putsSinceView} puts`;
  const earlierWarnings = Array.isArray(body.warnings) ? body.warnings : [];
  return { ...body, warnings: [...earlierWarnings, `${putCount} by this session since it last viewed this board; view it to see what you drew before calling the work done`] };
}

async function replyWithDrawnRects(layouts: WhiteboardLayouts, boardId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sparse = sparseBoardReply(body);
  const boxIds = boxIdsInBoardReply(sparse);
  if (boxIds.length === 0) return sparse;
  const rectsByBoxId = await layouts.boxRectsOf(boardId, boxIds).catch(() => null);
  return rectsByBoxId ? withDrawnBoxRects(sparse, rectsByBoxId) : sparse;
}

async function boardReplyWithReading(session: Session, agentApi: AgentApiPort, layouts: WhiteboardLayouts | null, payload: Record<string, unknown>): Promise<AgentReply> {
  const { shouldIncludePlan, ...agentPayload } = payload;
  const boardId = await boardIdFor(layouts, agentPayload.board, session.path);
  const reply = await agentApi.handle(session, 'whiteboard', { ...agentPayload, board: boardId ?? agentPayload.board });
  if (reply.body.ok !== true) return reply;
  const bodyWithWarnings = bodyWithUnviewedPutWarning(session, boardId, agentPayload, reply.body);
  const body = agentPayload.sub === 'get' && boardId && layouts ? await replyWithDrawnRects(layouts, boardId, bodyWithWarnings) : bodyWithWarnings;
  if (shouldIncludePlan === true) {
    const reading = boardId ? await layouts?.readingOf(boardId).catch(() => null) : null;
    if (!reading) return { status: reply.status, body: { ...body, readingError: UNREAD_BOARD_TEXT } };
    return { status: reply.status, body: { ...body, readingVersion: reading.version, plan: reading.plan, layoutWarnings: reading.layoutWarnings } };
  }
  const summary = boardId ? await layouts?.summaryOf(boardId).catch(() => null) : null;
  if (!summary) return { status: reply.status, body: { ...body, readingError: UNREAD_BOARD_TEXT } };
  return { status: reply.status, body: { ...body, readingVersion: summary.version, layoutWarnings: summary.warnings } };
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
  putsSinceViewBySession.get(session)?.delete(found.boardId);
  const metadata = payload.shouldIncludePlan === true
    ? { title: reading.title, version: reading.version, plan: reading.plan, layoutWarnings: reading.layoutWarnings }
    : { title: reading.title, version: reading.version, layoutWarnings: reading.layoutWarnings };
  return {
    content: [
      { type: 'image', data: picture.bytes.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify(metadata) },
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
