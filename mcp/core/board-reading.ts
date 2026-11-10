import type { Board, BoardRegion } from '../../shared/contracts/whiteboard.ts';
import type { BoardLayout, LaidOutMedia, Rect } from '../../shared/whiteboard-layout-core.ts';
import { planSteps } from '../../shared/whiteboard-plan-core.ts';
import { boardSvgDocument } from '../../shared/whiteboard-svg-core.ts';
import type { AssetHref } from '../../shared/whiteboard-svg-core.ts';

interface BoardReading {
  plan: ReturnType<typeof planSteps>;
  layoutWarnings: string[];
}

function boardReading(board: Board, layoutWarnings: string[]): BoardReading {
  return { plan: planSteps(board), layoutWarnings };
}

const SVG_POINTS_PER_INCH = 72;
const MIN_SVG_DENSITY = 1;
const FILE_PICTURE_SIDE_MAX_PX = 8192;

interface PictureLimits {
  maxScale: number;
  maxWidthPx: number;
  maxHeightPx: number;
}

interface PictureOptions {
  region: BoardRegion | null;
  limits: PictureLimits;
}

const VIEW_PICTURE_LIMITS: PictureLimits = { maxScale: 2, maxWidthPx: 1600, maxHeightPx: 4800 };
const WHOLE_BOARD_VIEW: PictureOptions = { region: null, limits: VIEW_PICTURE_LIMITS };

function filePictureLimitsOf(scale: number): PictureLimits {
  return { maxScale: scale, maxWidthPx: FILE_PICTURE_SIDE_MAX_PX, maxHeightPx: FILE_PICTURE_SIDE_MAX_PX };
}

type PictureFrame = { ok: true; frame: Rect; scale: number } | { ok: false; error: string };

type BoardPicture =
  | { ok: true; svgDocument: string; svgDensity: number; maxPixels: number; frame: Rect; reading: BoardReading }
  | { ok: false; error: string };

interface PictureImage {
  media: LaidOutMedia;
  width: number;
  height: number;
}

function overlapOf(first: Rect, second: Rect): Rect | null {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const width = Math.min(first.x + first.width, second.x + second.width) - x;
  const height = Math.min(first.y + first.height, second.y + second.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function spanTextOf(rect: Rect): string {
  return `x ${Math.round(rect.x)} to ${Math.round(rect.x + rect.width)} and y ${Math.round(rect.y)} to ${Math.round(rect.y + rect.height)}`;
}

function pictureFrameOf(bounds: Rect, { region, limits }: PictureOptions): PictureFrame {
  const frame = region ? overlapOf(region, bounds) : bounds;
  if (!frame) return { ok: false, error: `the region lies outside the board, which spans ${spanTextOf(bounds)}` };
  const scale = Math.min(limits.maxScale, limits.maxWidthPx / frame.width, limits.maxHeightPx / frame.height);
  if (frame.width * scale < 1 || frame.height * scale < 1) return { ok: false, error: `the ${region ? 'region covers' : 'board spans'} ${frame.width} by ${frame.height} units, under one pixel of picture; name a larger region` };
  if (SVG_POINTS_PER_INCH * scale >= MIN_SVG_DENSITY) return { ok: true, frame, scale };
  if (region) return { ok: false, error: `the region spans ${Math.round(frame.width)} by ${Math.round(frame.height)} units, too large to picture; name a smaller region` };
  return { ok: false, error: `the board spans ${Math.round(bounds.width)} by ${Math.round(bounds.height)} units, too large to picture; move far-off elements closer, or picture a region of it` };
}

function pictureImagesOf(layout: BoardLayout, options: PictureOptions = WHOLE_BOARD_VIEW): PictureImage[] {
  const framed = pictureFrameOf(layout.bounds, options);
  if (!framed.ok) return [];
  const { frame, scale } = framed;
  return layout.elements.flatMap((element) => (element.kind === 'box' && element.media && overlapOf(element, frame) ? [{ media: element.media, width: element.media.width * scale, height: element.media.height * scale }] : []));
}

function boardPicture(board: Board, layout: BoardLayout, assetHref?: AssetHref, options: PictureOptions = WHOLE_BOARD_VIEW): BoardPicture {
  const framed = pictureFrameOf(layout.bounds, options);
  if (!framed.ok) return framed;
  const { frame, scale } = framed;
  const { maxWidthPx, maxHeightPx } = options.limits;
  return { ok: true, svgDocument: boardSvgDocument(layout, assetHref, frame), svgDensity: SVG_POINTS_PER_INCH * scale, maxPixels: maxWidthPx * maxHeightPx, frame, reading: boardReading(board, layout.warnings) };
}

export { VIEW_PICTURE_LIMITS, boardPicture, boardReading, filePictureLimitsOf, pictureFrameOf, pictureImagesOf };
export type { BoardPicture, BoardReading, PictureLimits, PictureOptions };
