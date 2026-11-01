import type { Board } from '../../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import type { BoardLayout } from '../../shared/whiteboard-layout-core.ts';
import { planSteps } from '../../shared/whiteboard-plan-core.ts';
import { boardSvgDocument } from '../../shared/whiteboard-svg-core.ts';

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

function boardPicture(board: Board): BoardPicture {
  const layout = layoutBoard(board);
  const { width, height } = layout.bounds;
  const svgDensity = SVG_POINTS_PER_INCH * Math.min(1, PICTURE_MAX_WIDTH_PX / width, PICTURE_MAX_HEIGHT_PX / height);
  if (svgDensity < MIN_SVG_DENSITY) {
    return { ok: false, error: `the board spans ${Math.round(width)} by ${Math.round(height)} units, too large to picture; move far-off elements closer` };
  }
  return { ok: true, svgDocument: boardSvgDocument(layout), svgDensity, maxPixels: PICTURE_MAX_PIXELS, reading: readingOf(board, layout) };
}

export { boardPicture, boardReading };
export type { BoardPicture, BoardReading };
