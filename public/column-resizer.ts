import { clampColumnWidth, fitColumnBounds, keyboardWidthDelta } from './column-width-core.ts';
import type { ColumnWidthBounds } from './column-width-core.ts';

interface ColumnResizerOptions {
  resizer: HTMLElement;
  column: HTMLElement;
  widthHost: HTMLElement;
  widthProperty: string;
  bounds: ColumnWidthBounds;
  keyStepPx: number;
  getStoredWidth: () => number | null;
  setStoredWidth: (px: number | null) => void;
  growsLeftward?: boolean;
  reservePx?: number;
}

export function wireColumnResizer({ resizer, column, widthHost, widthProperty, bounds, keyStepPx, getStoredWidth, setStoredWidth, growsLeftward = false, reservePx }: ColumnResizerOptions): void {
  const growthDirection = growsLeftward ? -1 : 1;
  resizer.setAttribute('aria-valuemin', String(bounds.minPx));
  resizer.setAttribute('aria-valuemax', String(bounds.maxPx));

  const currentBounds = () => (reservePx === undefined ? bounds : fitColumnBounds(bounds, widthHost.getBoundingClientRect().width, reservePx));

  let appliedWidthPx: number | null = null;

  const applyWidth = (px: number) => {
    const fittedBounds = currentBounds();
    resizer.setAttribute('aria-valuemax', String(fittedBounds.maxPx));
    const width = clampColumnWidth(px, fittedBounds);
    if (width === null) return null;
    appliedWidthPx = width;
    widthHost.style.setProperty(widthProperty, `${width}px`);
    resizer.setAttribute('aria-valuenow', String(width));
    return width;
  };

  const applyStoredWidth = () => {
    const storedWidth = getStoredWidth();
    if (storedWidth !== null) {
      applyWidth(storedWidth);
      return;
    }
    const shownWidth = Math.round(column.getBoundingClientRect().width);
    if (shownWidth > 0) resizer.setAttribute('aria-valuenow', String(shownWidth));
  };
  applyStoredWidth();
  if (reservePx !== undefined) {
    const sizeObserver = new ResizeObserver(() => {
      if (resizer.dataset.dragging === 'true') return;
      applyStoredWidth();
    });
    sizeObserver.observe(widthHost);
    sizeObserver.observe(column);
  }

  let dragStartX = 0;
  let dragStartWidth = 0;
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragStartX = event.clientX;
    dragStartWidth = column.getBoundingClientRect().width;
    resizer.setPointerCapture(event.pointerId);
    resizer.dataset.dragging = 'true';
    event.preventDefault();
  });
  resizer.addEventListener('pointermove', (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    applyWidth(dragStartWidth + growthDirection * (event.clientX - dragStartX));
  });
  const releaseDrag = (event: PointerEvent) => {
    resizer.releasePointerCapture(event.pointerId);
    delete resizer.dataset.dragging;
  };
  resizer.addEventListener('pointerup', (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    releaseDrag(event);
    setStoredWidth(applyWidth(dragStartWidth + growthDirection * (event.clientX - dragStartX)));
  });
  resizer.addEventListener('pointercancel', (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    releaseDrag(event);
    applyWidth(dragStartWidth);
  });
  resizer.addEventListener('dblclick', () => {
    widthHost.style.removeProperty(widthProperty);
    appliedWidthPx = null;
    resizer.setAttribute('aria-valuenow', String(Math.round(column.getBoundingClientRect().width)));
    setStoredWidth(null);
  });
  resizer.addEventListener('keydown', (event) => {
    const delta = keyboardWidthDelta(event.key, keyStepPx);
    if (delta === null) return;
    event.preventDefault();
    const width = applyWidth((appliedWidthPx ?? column.getBoundingClientRect().width) + growthDirection * delta);
    if (width !== null) setStoredWidth(width);
  });
}
