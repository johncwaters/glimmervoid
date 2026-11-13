import './sheet-width.css';
import { wireColumnResizer } from './column-resizer.ts';
import type { ColumnWidthBounds } from './column-width-core.ts';
import { el } from './dom-helpers.ts';

export const SHEET_WIDTH_HANDLE_PX = 8;

interface SheetWidthOptions {
  widthHost: HTMLElement;
  sheet: HTMLElement;
  handle: HTMLElement;
  widthProperty: string;
  bounds: ColumnWidthBounds;
  keyStepPx: number;
  reservePx?: number;
  getStoredWidth: () => number | null;
  setStoredWidth: (widthPx: number | null) => void;
}

export function sheetWidthHandle(label: string): HTMLElement {
  const widthHandle = el('div', 'sheet-width-handle');
  widthHandle.setAttribute('role', 'separator');
  widthHandle.setAttribute('aria-orientation', 'vertical');
  widthHandle.setAttribute('aria-label', label);
  widthHandle.tabIndex = 0;
  widthHandle.addEventListener('pointerdown', (event) => event.stopPropagation());
  widthHandle.addEventListener('dblclick', (event) => event.stopPropagation());
  return widthHandle;
}

export function wireSheetWidth({ widthHost, sheet, handle, widthProperty, bounds, keyStepPx, reservePx, getStoredWidth, setStoredWidth }: SheetWidthOptions): void {
  sheet.style.setProperty('--sheet-width-handle', `${SHEET_WIDTH_HANDLE_PX}px`);
  wireColumnResizer({ resizer: handle, column: sheet, widthHost, widthProperty, bounds, keyStepPx, reservePx, getStoredWidth, setStoredWidth });
}
