import type { Camera } from '../whiteboard/board-gl-renderer.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const MAX_FIT_SCALE = 2;
const NATURAL_SCALE = 1;
const FIT_MARGIN_PX = 48;
const READABLE_TITLE_PX = 9;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function readableFloorScale(titleSizePx: number): number {
  return clampScale(READABLE_TITLE_PX / titleSizePx);
}

function fittedCamera(bounds: Rect, viewWidthPx: number, viewHeightPx: number, reservedBottomPx: number, floorScale = MIN_SCALE, maxScale = MAX_FIT_SCALE): Camera | null {
  const usableHeightPx = viewHeightPx - reservedBottomPx - FIT_MARGIN_PX * 2;
  const usableWidthPx = viewWidthPx - FIT_MARGIN_PX * 2;
  if (usableWidthPx <= 0 || usableHeightPx <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  const fitScale = clampScale(Math.min(maxScale, usableWidthPx / bounds.width, usableHeightPx / bounds.height));
  if (fitScale < floorScale) return { x: bounds.x - FIT_MARGIN_PX / floorScale, y: bounds.y - FIT_MARGIN_PX / floorScale, scale: floorScale };
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return { x: centerX - viewWidthPx / 2 / fitScale, y: centerY - (FIT_MARGIN_PX + usableHeightPx / 2) / fitScale, scale: fitScale };
}

function isBelowFloor(bounds: Rect, viewWidthPx: number, viewHeightPx: number, reservedBottomPx: number, floorScale: number): boolean {
  const fitted = fittedCamera(bounds, viewWidthPx, viewHeightPx, reservedBottomPx);
  return fitted !== null && fitted.scale < floorScale;
}

export function firstViewCamera({ mapBounds, sessionArea, viewWidthPx, viewHeightPx, reservedBottomPx, floorScale }: {
  mapBounds: Rect;
  sessionArea: Rect | null;
  viewWidthPx: number;
  viewHeightPx: number;
  reservedBottomPx: number;
  floorScale: number;
}): Camera | null {
  if (!isBelowFloor(mapBounds, viewWidthPx, viewHeightPx, reservedBottomPx, floorScale)) return null;
  if (sessionArea) return fittedCamera(sessionArea, viewWidthPx, viewHeightPx, reservedBottomPx, floorScale, NATURAL_SCALE);
  return fittedCamera(mapBounds, viewWidthPx, viewHeightPx, reservedBottomPx, floorScale);
}

function shiftToFit(start: number, length: number, clearStart: number, clearLength: number): number {
  if (length > clearLength || start < clearStart) return start - clearStart;
  return Math.max(0, start + length - (clearStart + clearLength));
}

export function viewMovedToShow(area: Rect, clearArea: Rect, view: Rect): Rect | null {
  const shiftX = shiftToFit(area.x, area.width, clearArea.x, clearArea.width);
  const shiftY = shiftToFit(area.y, area.height, clearArea.y, clearArea.height);
  if (shiftX === 0 && shiftY === 0) return null;
  return { ...view, x: view.x + shiftX, y: view.y + shiftY };
}
