import { clampColumnWidth, keyboardWidthDelta } from './column-width-core.ts';
import type { ColumnWidthBounds } from './column-width-core.ts';

export interface ColumnResizerOptions {
  resizer: HTMLElement;
  column: HTMLElement;
  widthHost: HTMLElement;
  widthProperty: string;
  bounds: ColumnWidthBounds;
  keyStepPx: number;
  getStoredWidth: () => number | null;
  setStoredWidth: (px: number | null) => void;
}

export function wireColumnResizer({ resizer, column, widthHost, widthProperty, bounds, keyStepPx, getStoredWidth, setStoredWidth }: ColumnResizerOptions): void {
  resizer.setAttribute('aria-valuemin', String(bounds.minPx));
  resizer.setAttribute('aria-valuemax', String(bounds.maxPx));

  const applyWidth = (px: number) => {
    const width = clampColumnWidth(px, bounds);
    if (width === null) return null;
    widthHost.style.setProperty(widthProperty, `${width}px`);
    resizer.setAttribute('aria-valuenow', String(width));
    return width;
  };

  const storedWidth = getStoredWidth();
  if (storedWidth !== null) applyWidth(storedWidth);

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
    applyWidth(dragStartWidth + (event.clientX - dragStartX));
  });
  const releaseDrag = (event: PointerEvent) => {
    resizer.releasePointerCapture(event.pointerId);
    delete resizer.dataset.dragging;
  };
  resizer.addEventListener('pointerup', (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    releaseDrag(event);
    setStoredWidth(applyWidth(dragStartWidth + (event.clientX - dragStartX)));
  });
  resizer.addEventListener('pointercancel', (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    releaseDrag(event);
    applyWidth(dragStartWidth);
  });
  resizer.addEventListener('dblclick', () => {
    widthHost.style.removeProperty(widthProperty);
    resizer.setAttribute('aria-valuenow', String(Math.round(column.getBoundingClientRect().width)));
    setStoredWidth(null);
  });
  resizer.addEventListener('keydown', (event) => {
    const delta = keyboardWidthDelta(event.key, keyStepPx);
    if (delta === null) return;
    event.preventDefault();
    const width = applyWidth(column.getBoundingClientRect().width + delta);
    if (width !== null) setStoredWidth(width);
  });
}
