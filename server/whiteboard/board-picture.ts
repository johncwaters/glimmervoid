import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { errorMessage } from '../../shared/text.ts';
import type { BoardRegion } from '../../shared/contracts/whiteboard.ts';
import { pictureFrameOf } from '../../mcp/core/board-reading.ts';
import type { PictureLimits, PictureOptions } from '../../mcp/core/board-reading.ts';
import type { WhiteboardAssetStore } from './whiteboard-assets.ts';
import type { WhiteboardLayouts } from './whiteboard-wiring.ts';

const PICTURE_FORMATS = ['svg', 'png'] as const;
type PictureFormat = typeof PICTURE_FORMATS[number];
const RENDER_NAME_LENGTH = 32;
const RENDER_SCALES = [1, 2, 3] as const;
type RenderScale = typeof RENDER_SCALES[number];
const RENDER_KINDS = ['.svg', '-1x.png', '-2x.png', '-3x.png'] as const;
const RENDERS_FOLDER_MODE = 0o700;
const RENDER_FILE_MODE = 0o600;

interface BoardPictureRequest {
  format: PictureFormat;
  region: BoardRegion | null;
  limits: PictureLimits;
}

type BoardPictureFile =
  | { ok: true; bytes: Buffer; width: number; height: number }
  | { ok: false; status: number; error: string };

const UNREADABLE_LAYOUT: BoardPictureFile = { ok: false, status: 503, error: 'the board layout could not be read, so it was not pictured; try again' };
const TOO_LARGE_STATUS = 413;

async function embeddedImagesOf(boardId: string, layouts: WhiteboardLayouts, assets: WhiteboardAssetStore | null, options: PictureOptions): Promise<Record<string, string> | null> {
  const dataUriByAssetId: Record<string, string> = {};
  if (!assets) return dataUriByAssetId;
  const images = await layouts.pictureImagesOf(boardId, options).catch(() => null);
  if (!images) return null;
  for (const image of images) {
    if (Object.hasOwn(dataUriByAssetId, image.media.asset)) continue;
    const dataUri = await assets.dataUriOf(image.media, image.width, image.height);
    if (dataUri) dataUriByAssetId[image.media.asset] = dataUri;
  }
  return dataUriByAssetId;
}

async function boardPictureFile(layouts: WhiteboardLayouts, assets: WhiteboardAssetStore | null, boardId: string, { format, region, limits }: BoardPictureRequest): Promise<BoardPictureFile> {
  const options: PictureOptions = { region, limits };
  const summary = await layouts.summaryOf(boardId).catch(() => null);
  if (!summary) return UNREADABLE_LAYOUT;
  const framed = pictureFrameOf(summary.chrome.bounds, options);
  if (!framed.ok) return { ok: false, status: TOO_LARGE_STATUS, error: framed.error };
  const dataUriByAssetId = await embeddedImagesOf(boardId, layouts, assets, options);
  if (!dataUriByAssetId) return UNREADABLE_LAYOUT;
  const picture = await layouts.pictureOf(boardId, dataUriByAssetId, options).catch(() => null);
  if (!picture) return UNREADABLE_LAYOUT;
  if (!picture.ok) return { ok: false, status: TOO_LARGE_STATUS, error: picture.error };
  const { svgDocument, svgDensity, maxPixels, frame } = picture;
  if (format === 'svg') return { ok: true, bytes: Buffer.from(svgDocument), width: frame.width, height: frame.height };
  const { default: sharp } = await import('sharp');
  const drawn = await sharp(Buffer.from(svgDocument), { density: svgDensity, limitInputPixels: maxPixels }).png().toBuffer({ resolveWithObject: true }).catch((error: unknown) => errorMessage(error));
  if (typeof drawn === 'string') return { ok: false, status: 500, error: `the board could not be drawn as a PNG: ${drawn}` };
  return { ok: true, bytes: drawn.data, width: drawn.info.width, height: drawn.info.height };
}

type RenderKind = typeof RENDER_KINDS[number];

function renderKindOf(format: PictureFormat, scale: RenderScale): RenderKind {
  return format === 'svg' ? '.svg' : `-${scale}x.png`;
}

function boardRenderPathOf(rendersRoot: string, boardId: string, kind: RenderKind): string {
  return path.join(rendersRoot, `${createHash('sha256').update(boardId).digest('hex').slice(0, RENDER_NAME_LENGTH)}${kind}`);
}

async function writeBoardRender(rendersRoot: string, boardId: string, kind: RenderKind, bytes: Buffer): Promise<{ ok: true; wrote: string } | { ok: false; error: string }> {
  const renderPath = boardRenderPathOf(rendersRoot, boardId, kind);
  const draftPath = `${renderPath}.${randomUUID()}.tmp`;
  const writeError = await fs.promises.mkdir(rendersRoot, { recursive: true, mode: RENDERS_FOLDER_MODE })
    .then(() => fs.promises.writeFile(draftPath, bytes, { flag: 'wx', mode: RENDER_FILE_MODE }))
    .then(() => fs.promises.rename(draftPath, renderPath))
    .then(() => null, (error: unknown) => errorMessage(error));
  if (writeError === null) return { ok: true, wrote: renderPath };
  await fs.promises.rm(draftPath, { force: true }).catch(() => {});
  return { ok: false, error: `the picture could not be written: ${writeError}` };
}

async function forgetBoardRenders(rendersRoot: string, boardId: string): Promise<void> {
  for (const kind of RENDER_KINDS) await fs.promises.rm(boardRenderPathOf(rendersRoot, boardId, kind), { force: true }).catch(() => {});
}

export { PICTURE_FORMATS, RENDER_SCALES, boardPictureFile, forgetBoardRenders, renderKindOf, writeBoardRender };
export type { BoardPictureFile, PictureFormat, RenderScale };
