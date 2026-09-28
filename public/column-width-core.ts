export interface ColumnWidthBounds {
  minPx: number;
  maxPx: number;
}

export function clampColumnWidth(px: number, bounds: ColumnWidthBounds): number | null {
  if (!Number.isFinite(px)) return null;
  return Math.round(Math.min(bounds.maxPx, Math.max(bounds.minPx, px)));
}

export function keyboardWidthDelta(key: string, stepPx: number): number | null {
  if (key === 'ArrowRight') return stepPx;
  if (key === 'ArrowLeft') return -stepPx;
  return null;
}
