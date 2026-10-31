export type ZoomView = { scale: number; offsetX: number; offsetY: number };
export type ZoomPoint = { x: number; y: number };
type ZoomExtent = { width: number; height: number };
export type ZoomBounds = { media: ZoomExtent; stage: ZoomExtent };

export const FIT_VIEW: ZoomView = { scale: 1, offsetX: 0, offsetY: 0 };
const MIN_ZOOM_SCALE = 1;
export const MAX_ZOOM_SCALE = 8;
export const BUTTON_ZOOM_FACTOR = 1.5;
const DOUBLE_TAP_ZOOM_SCALE = 2;
const WHEEL_ZOOM_SENSITIVITY = 0.01;
const MAX_WHEEL_DELTA_PER_EVENT = 25;

function clampZoomScale(scale: number): number {
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale));
}

function clampAxisOffset(offset: number, scaledLength: number, stageLength: number): number {
  const maxOffset = Math.max(0, (scaledLength - stageLength) / 2);
  return Math.min(maxOffset, Math.max(-maxOffset, offset));
}

function clampZoomView(view: ZoomView, bounds: ZoomBounds): ZoomView {
  const scale = clampZoomScale(view.scale);
  return {
    scale,
    offsetX: clampAxisOffset(view.offsetX, bounds.media.width * scale, bounds.stage.width),
    offsetY: clampAxisOffset(view.offsetY, bounds.media.height * scale, bounds.stage.height),
  };
}

export function zoomViewAround(view: ZoomView, targetScale: number, focalFromCenter: ZoomPoint, bounds: ZoomBounds): ZoomView {
  const scale = clampZoomScale(targetScale);
  const mediaPointX = (focalFromCenter.x - view.offsetX) / view.scale;
  const mediaPointY = (focalFromCenter.y - view.offsetY) / view.scale;
  return clampZoomView({ scale, offsetX: focalFromCenter.x - mediaPointX * scale, offsetY: focalFromCenter.y - mediaPointY * scale }, bounds);
}

export function panZoomView(view: ZoomView, deltaX: number, deltaY: number, bounds: ZoomBounds): ZoomView {
  return clampZoomView({ scale: view.scale, offsetX: view.offsetX + deltaX, offsetY: view.offsetY + deltaY }, bounds);
}

export function pinchZoomView({ startView, startMidpoint, startDistance, midpoint, distance, bounds }: {
  startView: ZoomView;
  startMidpoint: ZoomPoint;
  startDistance: number;
  midpoint: ZoomPoint;
  distance: number;
  bounds: ZoomBounds;
}): ZoomView {
  if (startDistance <= 0 || distance <= 0) return startView;
  const zoomed = zoomViewAround(startView, startView.scale * (distance / startDistance), startMidpoint, bounds);
  return panZoomView(zoomed, midpoint.x - startMidpoint.x, midpoint.y - startMidpoint.y, bounds);
}

export function wheelZoomScale(scale: number, wheelDeltaY: number): number {
  const boundedDelta = Math.min(MAX_WHEEL_DELTA_PER_EVENT, Math.max(-MAX_WHEEL_DELTA_PER_EVENT, wheelDeltaY));
  return clampZoomScale(scale * Math.exp(-boundedDelta * WHEEL_ZOOM_SENSITIVITY));
}

export function toggledZoomView(view: ZoomView, focalFromCenter: ZoomPoint, bounds: ZoomBounds): ZoomView {
  if (view.scale > MIN_ZOOM_SCALE) return FIT_VIEW;
  return zoomViewAround(view, DOUBLE_TAP_ZOOM_SCALE, focalFromCenter, bounds);
}

export function isZoomedIn(scale: number): boolean {
  return scale > MIN_ZOOM_SCALE;
}

export function zoomPercentText(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
