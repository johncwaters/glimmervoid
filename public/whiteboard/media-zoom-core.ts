export type MediaZoom = { scale: number; offsetX: number; offsetY: number };
type StageSize = { width: number; height: number };
export type StagePoint = { x: number; y: number };

export const FIT_ZOOM: MediaZoom = { scale: 1, offsetX: 0, offsetY: 0 };
const MAX_MEDIA_SCALE = 8;
const DOUBLE_TAP_SCALE = 2;

function clampToStage(zoom: MediaZoom, stage: StageSize): MediaZoom {
  const scale = Math.min(MAX_MEDIA_SCALE, Math.max(1, zoom.scale));
  const offsetX = Math.min(0, Math.max(stage.width * (1 - scale), zoom.offsetX));
  const offsetY = Math.min(0, Math.max(stage.height * (1 - scale), zoom.offsetY));
  return { scale, offsetX, offsetY };
}

export function isZoomedIn(zoom: MediaZoom): boolean {
  return zoom.scale > 1;
}

export function zoomAbout(zoom: MediaZoom, anchor: StagePoint, factor: number, stage: StageSize): MediaZoom {
  const scale = Math.min(MAX_MEDIA_SCALE, Math.max(1, zoom.scale * factor));
  const appliedFactor = scale / zoom.scale;
  return clampToStage({
    scale,
    offsetX: anchor.x - (anchor.x - zoom.offsetX) * appliedFactor,
    offsetY: anchor.y - (anchor.y - zoom.offsetY) * appliedFactor,
  }, stage);
}

export function panBy(zoom: MediaZoom, deltaX: number, deltaY: number, stage: StageSize): MediaZoom {
  return clampToStage({ ...zoom, offsetX: zoom.offsetX + deltaX, offsetY: zoom.offsetY + deltaY }, stage);
}

export function toggleFitAbout(zoom: MediaZoom, anchor: StagePoint, stage: StageSize): MediaZoom {
  if (isZoomedIn(zoom)) return FIT_ZOOM;
  return zoomAbout(zoom, anchor, DOUBLE_TAP_SCALE, stage);
}

export function stagePointOf(zoom: MediaZoom, mediaPoint: StagePoint): StagePoint {
  return { x: zoom.offsetX + mediaPoint.x * zoom.scale, y: zoom.offsetY + mediaPoint.y * zoom.scale };
}

export function wheelZoomFactor(deltaY: number, wheelZoomStep: number): number {
  return deltaY > 0 ? 1 / wheelZoomStep : wheelZoomStep;
}
