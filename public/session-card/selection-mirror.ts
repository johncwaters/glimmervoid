import type { IBufferLine, IDisposable, Terminal } from '@xterm/xterm';
import { el } from '../dom-helpers.ts';

const MIRROR_CLASS = 'terminal-select-mirror';
const WIDTH_PROBE_CHARACTERS = 'M'.repeat(20);

interface ShownMirror {
  dismiss: () => void;
  hasSelection: () => boolean;
}

const shownMirrorByWrap = new WeakMap<HTMLElement, ShownMirror>();

function measureCharacterWidth(layer: HTMLElement) {
  const probe = el('span');
  probe.textContent = WIDTH_PROBE_CHARACTERS;
  layer.append(probe);
  const width = probe.getBoundingClientRect().width / WIDTH_PROBE_CHARACTERS.length;
  probe.remove();
  return width;
}

function fillRow(rowElement: HTMLElement, line: IBufferLine | undefined, cols: number, cellWidthPx: number) {
  if (!line) return;
  let narrowRun = '';
  for (let column = 0; column < cols; column++) {
    const cell = line.getCell(column);
    const cellWidth = cell?.getWidth() ?? 1;
    if (cellWidth === 0) continue;
    const characters = cell?.getChars() || ' ';
    if (cellWidth === 1) {
      narrowRun += characters;
      continue;
    }
    rowElement.append(narrowRun);
    narrowRun = '';
    const wideCell = el('span', 'terminal-select-mirror-wide');
    wideCell.style.width = `${cellWidth * cellWidthPx}px`;
    wideCell.textContent = characters;
    rowElement.append(wideCell);
  }
  rowElement.append(narrowRun);
}

export function isSelectionMirrorShown(termWrap: HTMLElement) {
  return shownMirrorByWrap.has(termWrap);
}

function hideSelectionMirror(termWrap: HTMLElement) {
  shownMirrorByWrap.get(termWrap)?.dismiss();
}

export function hideSelectionMirrorUnlessSelected(termWrap: HTMLElement) {
  const shownMirror = shownMirrorByWrap.get(termWrap);
  if (!shownMirror) return false;
  if (shownMirror.hasSelection()) return true;
  shownMirror.dismiss();
  return false;
}

export function showSelectionMirror(term: Terminal, termWrap: HTMLElement, onDismiss: () => void) {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return;
  hideSelectionMirror(termWrap);

  const screenBox = screen.getBoundingClientRect();
  const wrapBox = termWrap.getBoundingClientRect();
  const cellWidthPx = screenBox.width / term.cols;
  const cellHeightPx = screenBox.height / term.rows;
  const layer = el('div', MIRROR_CLASS);
  layer.style.left = `${screenBox.left - wrapBox.left}px`;
  layer.style.top = `${screenBox.top - wrapBox.top}px`;
  layer.style.width = `${screenBox.width}px`;
  layer.style.height = `${screenBox.height}px`;
  layer.style.fontFamily = term.options.fontFamily ?? 'monospace';
  layer.style.fontSize = `${term.options.fontSize ?? 14}px`;
  layer.style.lineHeight = `${cellHeightPx}px`;
  termWrap.append(layer);
  layer.style.letterSpacing = `${cellWidthPx - measureCharacterWidth(layer)}px`;

  const rowElements = Array.from({ length: term.rows }, () => el('div', 'terminal-select-mirror-row'));
  layer.append(...rowElements);
  const fillRowsFromViewport = () => {
    const buffer = term.buffer.active;
    rowElements.forEach((rowElement, row) => {
      rowElement.replaceChildren();
      fillRow(rowElement, buffer.getLine(buffer.viewportY + row), term.cols, cellWidthPx);
    });
  };
  fillRowsFromViewport();
  let scrollSubscription: IDisposable | null = null;
  let hasSelectedInLayer = false;
  const isSelectingInLayer = () => {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed && layer.contains(selection.anchorNode);
  };
  const dismiss = () => {
    shownMirrorByWrap.delete(termWrap);
    document.removeEventListener('selectionchange', onSelectionChange);
    scrollSubscription?.dispose();
    layer.remove();
    onDismiss();
  };
  const onSelectionChange = () => {
    if (isSelectingInLayer()) {
      hasSelectedInLayer = true;
      return;
    }
    if (hasSelectedInLayer) dismiss();
  };
  document.addEventListener('selectionchange', onSelectionChange);
  scrollSubscription = term.onScroll(() => {
    if (hasSelectedInLayer || isSelectingInLayer()) {
      dismiss();
      return;
    }
    fillRowsFromViewport();
  });
  shownMirrorByWrap.set(termWrap, { dismiss, hasSelection: isSelectingInLayer });
}
