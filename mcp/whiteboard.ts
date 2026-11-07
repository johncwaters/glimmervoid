import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { Board } from '../shared/contracts/whiteboard.ts';
import { boardReading, pictureRefusalOf } from './core/board-reading.ts';
import type { ToolImageResult } from './core/tool-result.ts';
import type { WhiteboardAssetStore } from '../server/whiteboard/whiteboard-assets.ts';
import type { WhiteboardLayouts } from '../server/whiteboard/whiteboard-wiring.ts';

type AgentReply = { status: number; body: Record<string, unknown> };

function boardOf(reply: AgentReply): Board | null {
  if (reply.body.ok !== true) return null;
  const parsed = Board.safeParse(reply.body.board);
  return parsed.success ? parsed.data : null;
}

async function peekBoard(session: Session, agentApi: AgentApiPort, boardRef: unknown): Promise<AgentReply> {
  return agentApi.handle(session, 'whiteboard', { sub: 'get', board: boardRef, peek: true, whole: true });
}

async function boardIdFor(session: Session, agentApi: AgentApiPort, boardRef: unknown): Promise<unknown> {
  if (boardRef === undefined) return boardRef;
  return boardOf(await peekBoard(session, agentApi, boardRef))?.id ?? boardRef;
}

async function boardReplyWithReading(session: Session, agentApi: AgentApiPort, layouts: WhiteboardLayouts | null, payload: Record<string, unknown>): Promise<AgentReply> {
  const boardId = await boardIdFor(session, agentApi, payload.board);
  const reply = await agentApi.handle(session, 'whiteboard', { ...payload, board: boardId });
  if (reply.body.ok !== true) return reply;
  const board = boardOf(reply) ?? boardOf(await peekBoard(session, agentApi, boardId));
  const summary = board ? await layouts?.summaryOf(board.id).catch(() => null) : null;
  if (!board || !summary) return { status: reply.status, body: { ...reply.body, readingError: 'the board could not be read back for its plan steps and layout warnings' } };
  return { status: reply.status, body: { ...reply.body, readingVersion: board.version, ...boardReading(board, summary.warnings) } };
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
  const reply = await peekBoard(session, agentApi, payload.board);
  const board = boardOf(reply);
  if (!board) return reply;
  if (!layouts) return UNREADABLE_LAYOUT_REPLY;
  const summary = await layouts.summaryOf(board.id).catch(() => null);
  if (!summary) return UNREADABLE_LAYOUT_REPLY;
  const refusal = pictureRefusalOf(summary.chrome.bounds);
  if (refusal) return { status: 413, body: { ok: false, error: refusal } };
  const dataUriByAssetId = await embeddedImagesOf(board.id, layouts, assets);
  if (!dataUriByAssetId) return UNREADABLE_LAYOUT_REPLY;
  const picture = await layouts.pictureOf(board.id, dataUriByAssetId).catch(() => null);
  if (!picture) return UNREADABLE_LAYOUT_REPLY;
  if (!picture.ok) return { status: 413, body: picture };
  const { svgDocument, svgDensity, maxPixels } = picture;
  const reading = boardReading(board, summary.warnings);
  const { default: sharp } = await import('sharp');
  const png = await sharp(Buffer.from(svgDocument), { density: svgDensity, limitInputPixels: maxPixels }).png().toBuffer();
  return {
    content: [
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ title: board.title, version: board.version, ...reading }) },
    ],
  };
}

export { boardPictureResult, boardReplyWithReading };
