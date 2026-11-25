export interface MapViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const MAX_ZOOM_OVER_FIT = 4;
const FIT_TOLERANCE = 1.001;

function clampedScale(view: MapViewBox, fit: MapViewBox, factor: number): number {
  const currentZoom = fit.width / view.width;
  const nextZoom = Math.min(MAX_ZOOM_OVER_FIT, Math.max(1, currentZoom * factor));
  return nextZoom;
}

function clampedOrigin(origin: number, size: number, fitOrigin: number, fitSize: number): number {
  const minOrigin = fitOrigin;
  const maxOrigin = fitOrigin + fitSize - size;
  return Math.min(maxOrigin, Math.max(minOrigin, origin));
}

export function isZoomed(view: MapViewBox, fit: MapViewBox): boolean {
  return fit.width / view.width > FIT_TOLERANCE;
}

export function zoomViewBoxAt(view: MapViewBox, fit: MapViewBox, factor: number, focusX: number, focusY: number): MapViewBox {
  const nextZoom = clampedScale(view, fit, factor);
  if (nextZoom <= FIT_TOLERANCE) return fit;
  const width = fit.width / nextZoom;
  const height = fit.height / nextZoom;
  const focusShareX = (focusX - view.x) / view.width;
  const focusShareY = (focusY - view.y) / view.height;
  return {
    x: clampedOrigin(focusX - focusShareX * width, width, fit.x, fit.width),
    y: clampedOrigin(focusY - focusShareY * height, height, fit.y, fit.height),
    width,
    height,
  };
}

export function panViewBox(view: MapViewBox, fit: MapViewBox, deltaX: number, deltaY: number): MapViewBox {
  if (!isZoomed(view, fit)) return fit;
  return {
    ...view,
    x: clampedOrigin(view.x + deltaX, view.width, fit.x, fit.width),
    y: clampedOrigin(view.y + deltaY, view.height, fit.y, fit.height),
  };
}

export function viewBoxAttributeOf(view: MapViewBox): string {
  return `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.width.toFixed(1)} ${view.height.toFixed(1)}`;
}
