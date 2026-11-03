import type { Board } from '../../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutMedia } from '../../shared/whiteboard-layout-core.ts';
import { planSteps } from '../../shared/whiteboard-plan-core.ts';
import { boardSvgDocument } from '../../shared/whiteboard-svg-core.ts';
import type { AssetHref } from '../../shared/whiteboard-svg-core.ts';

interface BoardReading {
  plan: ReturnType<typeof planSteps>;
  layoutWarnings: string[];
}

function readingOf(board: Board, layout: BoardLayout): BoardReading {
  return { plan: planSteps(board), layoutWarnings: layout.warnings };
}

function boardReading(board: Board): BoardReading {
  return readingOf(board, layoutBoard(board));
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

function pictureImagesOf(board: Board): PictureImage[] {
  const layout = layoutBoard(board);
  const scale = pictureScaleOf(layout);
  return layout.elements.flatMap((element) => (element.kind === 'box' && element.media ? [{ media: element.media, width: element.media.width * scale, height: element.media.height * scale }] : []));
}

function pictureScaleOf(layout: BoardLayout): number {
  return Math.min(1, PICTURE_MAX_WIDTH_PX / layout.bounds.width, PICTURE_MAX_HEIGHT_PX / layout.bounds.height);
}

function boardPicture(board: Board, assetHref?: AssetHref): BoardPicture {
  const layout = layoutBoard(board);
  const { width, height } = layout.bounds;
  const svgDensity = SVG_POINTS_PER_INCH * pictureScaleOf(layout);
  if (svgDensity < MIN_SVG_DENSITY) {
    return { ok: false, error: `the board spans ${Math.round(width)} by ${Math.round(height)} units, too large to picture; move far-off elements closer` };
  }
  return { ok: true, svgDocument: boardSvgDocument(layout, assetHref), svgDensity, maxPixels: PICTURE_MAX_PIXELS, reading: readingOf(board, layout) };
}

export { boardPicture, boardReading, pictureImagesOf };
export type { BoardPicture, BoardReading };
