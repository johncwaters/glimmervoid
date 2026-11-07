import type { Board } from '../../shared/contracts/whiteboard.ts';
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
const PICTURE_MAX_WIDTH_PX = 1600;
const PICTURE_MAX_HEIGHT_PX = 4800;
const PICTURE_MAX_PIXELS = PICTURE_MAX_WIDTH_PX * PICTURE_MAX_HEIGHT_PX;

type BoardPicture =
  | { ok: true; svgDocument: string; svgDensity: number; maxPixels: number; reading: BoardReading }
  | { ok: false; error: string };

interface PictureImage {
  media: LaidOutMedia;
  width: number;
  height: number;
}

function pictureImagesOf(layout: BoardLayout): PictureImage[] {
  const scale = pictureScaleOf(layout.bounds);
  return layout.elements.flatMap((element) => (element.kind === 'box' && element.media ? [{ media: element.media, width: element.media.width * scale, height: element.media.height * scale }] : []));
}

function pictureScaleOf(bounds: Rect): number {
  return Math.min(1, PICTURE_MAX_WIDTH_PX / bounds.width, PICTURE_MAX_HEIGHT_PX / bounds.height);
}

function pictureRefusalOf(bounds: Rect): string | null {
  if (SVG_POINTS_PER_INCH * pictureScaleOf(bounds) >= MIN_SVG_DENSITY) return null;
  return `the board spans ${Math.round(bounds.width)} by ${Math.round(bounds.height)} units, too large to picture; move far-off elements closer`;
}

function boardPicture(board: Board, layout: BoardLayout, assetHref?: AssetHref): BoardPicture {
  const refusal = pictureRefusalOf(layout.bounds);
  if (refusal) return { ok: false, error: refusal };
  const svgDensity = SVG_POINTS_PER_INCH * pictureScaleOf(layout.bounds);
  return { ok: true, svgDocument: boardSvgDocument(layout, assetHref), svgDensity, maxPixels: PICTURE_MAX_PIXELS, reading: boardReading(board, layout.warnings) };
}

export { boardPicture, boardReading, pictureImagesOf, pictureRefusalOf };
export type { BoardPicture, BoardReading };
