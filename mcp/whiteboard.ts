import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { Board } from '../shared/contracts/whiteboard.ts';
import { boardPicture, boardReading, pictureImagesOf } from './core/board-reading.ts';
import type { ToolImageResult } from './core/tool-result.ts';
import type { WhiteboardAssetStore } from '../server/whiteboard/whiteboard-assets.ts';

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

async function boardReplyWithReading(session: Session, agentApi: AgentApiPort, payload: Record<string, unknown>): Promise<AgentReply> {
  const boardId = await boardIdFor(session, agentApi, payload.board);
  const reply = await agentApi.handle(session, 'whiteboard', { ...payload, board: boardId });
  if (reply.body.ok !== true) return reply;
  const board = boardOf(reply) ?? boardOf(await peekBoard(session, agentApi, boardId));
  if (!board) return { status: reply.status, body: { ...reply.body, readingError: 'the board could not be read back for its plan steps and layout warnings' } };
  return { status: reply.status, body: { ...reply.body, readingVersion: board.version, ...boardReading(board) } };
}

async function embeddedImagesOf(board: Board, assets: WhiteboardAssetStore | null): Promise<Map<string, string>> {
  const dataUriByAssetId = new Map<string, string>();
  if (!assets) return dataUriByAssetId;
  for (const image of pictureImagesOf(board)) {
    if (dataUriByAssetId.has(image.media.asset)) continue;
    const dataUri = await assets.dataUriOf(image.media, image.width, image.height);
    if (dataUri) dataUriByAssetId.set(image.media.asset, dataUri);
  }
  return dataUriByAssetId;
}

async function boardPictureResult(session: Session, agentApi: AgentApiPort, assets: WhiteboardAssetStore | null, payload: Record<string, unknown>): Promise<AgentReply | ToolImageResult> {
  const reply = await peekBoard(session, agentApi, payload.board);
  const board = boardOf(reply);
  if (!board) return reply;
  const dataUriByAssetId = await embeddedImagesOf(board, assets);
  const picture = boardPicture(board, (media) => dataUriByAssetId.get(media.asset) ?? null);
  if (!picture.ok) return { status: 413, body: picture };
  const { svgDocument, svgDensity, maxPixels, reading } = picture;
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
