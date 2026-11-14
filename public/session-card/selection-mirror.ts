import type { IBufferLine, IDisposable, Terminal } from '@xterm/xterm';
import { el } from '../dom-helpers.ts';

const MIRROR_CLASS = 'terminal-select-mirror';
const WIDTH_PROBE_CHARACTERS = 'M'.repeat(20);

const dismissByWrap = new WeakMap<HTMLElement, () => void>();

function caretRangeAt(clientX: number, clientY: number): Range | null {
  const position = 'caretPositionFromPoint' in document ? document.caretPositionFromPoint(clientX, clientY) : null;
  if (position) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    return range;
  }
  if (!('caretRangeFromPoint' in document)) return null;
  return document.caretRangeFromPoint(clientX, clientY);
}

function measureCharacterWidth(layer: HTMLElement) {
  const probe = el('span');
  probe.textContent = WIDTH_PROBE_CHARACTERS;
  layer.append(probe);
  const width = probe.getBoundingClientRect().width / WIDTH_PROBE_CHARACTERS.length;
  probe.remove();
  return width;
}

function selectWordAt(layer: HTMLElement, clientX: number, clientY: number) {
  const selection = document.getSelection();
  const caret = caretRangeAt(clientX, clientY);
  if (!selection || !caret || !layer.contains(caret.startContainer)) return false;
  selection.removeAllRanges();
  selection.addRange(caret);
  selection.modify('move', 'backward', 'word');
  selection.modify('extend', 'forward', 'word');
  return !selection.isCollapsed;
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
  return dismissByWrap.has(termWrap);
}

function hideSelectionMirror(termWrap: HTMLElement) {
  dismissByWrap.get(termWrap)?.();
}

export function showSelectionMirror(term: Terminal, termWrap: HTMLElement, clientX: number, clientY: number, onDismiss: () => void) {
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

  const buffer = term.buffer.active;
  for (let row = 0; row < term.rows; row++) {
    const rowElement = el('div', 'terminal-select-mirror-row');
    fillRow(rowElement, buffer.getLine(buffer.viewportY + row), term.cols, cellWidthPx);
    layer.append(rowElement);
  }
  if (!selectWordAt(layer, clientX, clientY)) {
    layer.remove();
    return;
  }

  let scrollSubscription: IDisposable | null = null;
  const dismiss = () => {
    dismissByWrap.delete(termWrap);
    document.removeEventListener('selectionchange', onSelectionChange);
    scrollSubscription?.dispose();
    layer.remove();
    onDismiss();
  };
  const onSelectionChange = () => {
    const selection = document.getSelection();
    const isSelectingInLayer = !!selection && !selection.isCollapsed && layer.contains(selection.anchorNode);
    if (!isSelectingInLayer) dismiss();
  };
  document.addEventListener('selectionchange', onSelectionChange);
  scrollSubscription = term.onScroll(dismiss);
  dismissByWrap.set(termWrap, dismiss);
}
