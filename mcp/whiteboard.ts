import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { pictureRefusalOf } from './core/board-reading.ts';
import type { ToolImageResult } from './core/tool-result.ts';
import type { WhiteboardAssetStore } from '../server/whiteboard/whiteboard-assets.ts';
import type { WhiteboardLayouts } from '../server/whiteboard/whiteboard-wiring.ts';

type AgentReply = { status: number; body: Record<string, unknown> };

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

async function embeddedImagesOf(boardId: string, layouts: WhiteboardLayouts, assets: WhiteboardAssetStore | null): Promise<Record<string, string> | null> {
  const dataUriByAssetId: Record<string, string> = {};
  if (!assets) return dataUriByAssetId;
  const images = await layouts.pictureImagesOf(boardId).catch(() => null);
  if (!images) return null;
  for (const image of images) {
    if (Object.hasOwn(dataUriByAssetId, image.media.asset)) continue;
    const dataUri = await assets.dataUriOf(image.media, image.width, image.height);
    if (dataUri) dataUriByAssetId[image.media.asset] = dataUri;
  }
  return dataUriByAssetId;
}

const UNREADABLE_LAYOUT_REPLY: AgentReply = { status: 503, body: { ok: false, error: 'the board layout could not be read, so it was not pictured; try again' } };

async function boardPictureResult(session: Session, agentApi: AgentApiPort, assets: WhiteboardAssetStore | null, layouts: WhiteboardLayouts | null, payload: Record<string, unknown>): Promise<AgentReply | ToolImageResult> {
  if (!layouts) return UNREADABLE_LAYOUT_REPLY;
  if (typeof payload.board !== 'string') return agentApi.handle(session, 'whiteboard', { sub: 'get', board: payload.board, peek: true });
  const found = await layouts.findBoardId(payload.board, session.path);
  if (!found.ok) return found.reply;
  const { boardId } = found;
  const reading = await layouts.readingOf(boardId).catch(() => null);
  const summary = await layouts.summaryOf(boardId).catch(() => null);
  if (!reading || !summary) return UNREADABLE_LAYOUT_REPLY;
  const refusal = pictureRefusalOf(summary.chrome.bounds);
  if (refusal) return { status: 413, body: { ok: false, error: refusal } };
  const dataUriByAssetId = await embeddedImagesOf(boardId, layouts, assets);
  if (!dataUriByAssetId) return UNREADABLE_LAYOUT_REPLY;
  const picture = await layouts.pictureOf(boardId, dataUriByAssetId).catch(() => null);
  if (!picture) return UNREADABLE_LAYOUT_REPLY;
  if (!picture.ok) return { status: 413, body: picture };
  const { svgDocument, svgDensity, maxPixels } = picture;
  const { default: sharp } = await import('sharp');
  const png = await sharp(Buffer.from(svgDocument), { density: svgDensity, limitInputPixels: maxPixels }).png().toBuffer();
  return {
    content: [
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ title: reading.title, version: reading.version, plan: reading.plan, layoutWarnings: reading.layoutWarnings }) },
    ],
  };
}

export { boardPictureResult, boardReplyWithReading };
