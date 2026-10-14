import type { IBuffer, IBufferCell, IDecoration, IMarker, Terminal } from '@xterm/xterm';
import { findSecretRanges } from '#shared/secret-patterns.ts';
import { isStreamerMode, onStreamerModeChanged } from '../streamer-mode.ts';

const MAX_LOGICAL_LINE_ROWS = 64;
const FALLBACK_MASK_COLOR = '#808080';

type BufferKind = IBuffer['type'];

interface MaskSegment {
  line: number;
  x: number;
  width: number;
}

interface CellPosition {
  line: number;
  x: number;
  width: number;
}

interface SecretMask {
  marker: IMarker;
  decoration: IDecoration;
  x: number;
  width: number;
}

interface BufferMaskState {
  masks: SecretMask[];
  watermark: IMarker | null;
  isFullRescanOwed: boolean;
}

const resetsByTerminal = new WeakMap<Terminal, () => void>();

function segmentKey(line: number, x: number, width: number) {
  return `${line}:${x}:${width}`;
}

function maskKey(mask: SecretMask) {
  return segmentKey(mask.marker.line, mask.x, mask.width);
}

function logicalLineStart(buffer: IBuffer, row: number) {
  let firstRow = row;
  while (firstRow > 0 && row - firstRow < MAX_LOGICAL_LINE_ROWS - 1 && buffer.getLine(firstRow)?.isWrapped) firstRow--;
  return firstRow;
}

function logicalLineEnd(buffer: IBuffer, firstRow: number) {
  let lastRow = firstRow;
  while (lastRow - firstRow < MAX_LOGICAL_LINE_ROWS - 1 && buffer.getLine(lastRow + 1)?.isWrapped) lastRow++;
  return lastRow;
}

function readRowsText(buffer: IBuffer, firstRow: number, lastRow: number) {
  let text = '';
  for (let row = firstRow; row <= lastRow; row++) text += buffer.getLine(row)?.translateToString(false) ?? '';
  return text;
}

function mapRowsToCells(buffer: IBuffer, firstRow: number, lastRow: number, reusableCell: IBufferCell) {
  let text = '';
  const cellAt: CellPosition[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, reusableCell);
      if (!cell) break;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let charIndex = 0; charIndex < chars.length; charIndex++) {
        text += chars[charIndex];
        cellAt.push({ line: row, x, width });
      }
    }
  }
  return { text, cellAt };
}

function appendRangeSegments(segments: MaskSegment[], cells: CellPosition[]) {
  let current: MaskSegment | null = null;
  for (const position of cells) {
    if (current && current.line === position.line) {
      current.width = Math.max(current.width, position.x + position.width - current.x);
      continue;
    }
    current = { line: position.line, x: position.x, width: position.width };
    segments.push(current);
  }
}

function findLogicalLineSegments(buffer: IBuffer, firstRow: number, lastRow: number, reusableCell: IBufferCell) {
  const segments: MaskSegment[] = [];
  if (findSecretRanges(readRowsText(buffer, firstRow, lastRow)).length === 0) return segments;
  const { text, cellAt } = mapRowsToCells(buffer, firstRow, lastRow, reusableCell);
  for (const range of findSecretRanges(text)) appendRangeSegments(segments, cellAt.slice(range.start, range.end));
  return segments;
}

function findMaskSegments(buffer: IBuffer, scanStart: number) {
  const reusableCell = buffer.getNullCell();
  const segments: MaskSegment[] = [];
  let firstRow = scanStart;
  while (firstRow < buffer.length) {
    const lastRow = logicalLineEnd(buffer, firstRow);
    segments.push(...findLogicalLineSegments(buffer, firstRow, lastRow, reusableCell));
    firstRow = lastRow + 1;
  }
  return segments;
}

function createBufferMaskState(): BufferMaskState {
  return { masks: [], watermark: null, isFullRescanOwed: true };
}

function disposeMask(mask: SecretMask) {
  mask.decoration.dispose();
  mask.marker.dispose();
}

function clearBufferMaskState(state: BufferMaskState) {
  for (const mask of state.masks) disposeMask(mask);
  state.masks.length = 0;
  state.watermark?.dispose();
  state.watermark = null;
  state.isFullRescanOwed = true;
}

function firstUnscannedRow(state: BufferMaskState, buffer: IBuffer) {
  const watermark = state.watermark;
  if (state.isFullRescanOwed || !watermark || watermark.isDisposed) return 0;
  return Math.min(watermark.line, buffer.baseY);
}

function pruneTrimmedMasks(state: BufferMaskState) {
  let firstLiveIndex = 0;
  while (firstLiveIndex < state.masks.length && state.masks[firstLiveIndex].marker.isDisposed) {
    state.masks[firstLiveIndex].decoration.dispose();
    firstLiveIndex++;
  }
  if (firstLiveIndex > 0) state.masks.splice(0, firstLiveIndex);
}

function takeMasksFrom(state: BufferMaskState, scanStart: number) {
  const reusableMasksByKey = new Map<string, SecretMask>();
  let lastMask = state.masks.at(-1);
  while (lastMask && (lastMask.marker.isDisposed || lastMask.marker.line >= scanStart)) {
    state.masks.pop();
    if (lastMask.marker.isDisposed) lastMask.decoration.dispose();
    if (!lastMask.marker.isDisposed) reusableMasksByKey.set(maskKey(lastMask), lastMask);
    lastMask = state.masks.at(-1);
  }
  pruneTrimmedMasks(state);
  return reusableMasksByKey;
}

export function installTerminalSecretMask(term: Terminal, signal: AbortSignal) {
  const stateByBuffer: Record<BufferKind, BufferMaskState> = {
    normal: createBufferMaskState(),
    alternate: createBufferMaskState(),
  };
  let lastCols = term.cols;

  function isActiveBuffer(kind: BufferKind) {
    return term.buffer.active.type === kind;
  }

  function isMaskShown(marker: IMarker, kind: BufferKind) {
    if (!isActiveBuffer(kind) || marker.isDisposed) return false;
    const viewportRow = marker.line - term.buffer.active.viewportY;
    return viewportRow >= 0 && viewportRow < term.rows;
  }

  function paintMask(element: HTMLElement, marker: IMarker, kind: BufferKind) {
    element.style.backgroundColor = term.options.theme?.foreground ?? FALLBACK_MASK_COLOR;
    element.style.pointerEvents = 'none';
    element.style.display = isMaskShown(marker, kind) ? 'block' : 'none';
  }

  function repaintMasks(kind: BufferKind) {
    for (const mask of stateByBuffer[kind].masks) {
      const element = mask.decoration.element;
      if (element) paintMask(element, mask.marker, kind);
    }
  }

  function createMask(segment: MaskSegment, buffer: IBuffer): SecretMask | null {
    const marker = term.registerMarker(segment.line - (buffer.baseY + buffer.cursorY));
    if (!marker) return null;
    const decoration = term.registerDecoration({ marker, x: segment.x, width: segment.width, layer: 'top' });
    if (!decoration) {
      marker.dispose();
      return null;
    }
    const kind = buffer.type;
    decoration.onRender((element) => paintMask(element, marker, kind));
    return { marker, decoration, x: segment.x, width: segment.width };
  }

  function scanActiveBuffer() {
    if (!isStreamerMode()) return;
    const buffer = term.buffer.active;
    const state = stateByBuffer[buffer.type];
    const scanStart = logicalLineStart(buffer, firstUnscannedRow(state, buffer));
    const reusableMasksByKey = takeMasksFrom(state, scanStart);
    for (const segment of findMaskSegments(buffer, scanStart)) {
      const key = segmentKey(segment.line, segment.x, segment.width);
      const reusableMask = reusableMasksByKey.get(key);
      reusableMasksByKey.delete(key);
      const mask = reusableMask ?? createMask(segment, buffer);
      if (mask) state.masks.push(mask);
    }
    for (const staleMask of reusableMasksByKey.values()) disposeMask(staleMask);
    state.watermark?.dispose();
    state.watermark = term.registerMarker(-buffer.cursorY) ?? null;
    state.isFullRescanOwed = false;
  }

  function clearAllMasks() {
    clearBufferMaskState(stateByBuffer.normal);
    clearBufferMaskState(stateByBuffer.alternate);
  }

  function rescanFromScratch() {
    clearAllMasks();
    lastCols = term.cols;
    scanActiveBuffer();
  }

  const subscriptions = [
    term.onWriteParsed(scanActiveBuffer),
    term.onResize(({ cols }) => {
      if (cols === lastCols) return;
      lastCols = cols;
      stateByBuffer.normal.isFullRescanOwed = true;
      stateByBuffer.alternate.isFullRescanOwed = true;
      scanActiveBuffer();
    }),
    term.buffer.onBufferChange((buffer) => {
      clearBufferMaskState(stateByBuffer.alternate);
      repaintMasks('normal');
      if (buffer.type === 'alternate') scanActiveBuffer();
    }),
  ];
  const unsubscribeStreamerMode = onStreamerModeChanged(rescanFromScratch);

  signal.addEventListener('abort', () => {
    unsubscribeStreamerMode();
    for (const subscription of subscriptions) subscription.dispose();
    clearAllMasks();
    resetsByTerminal.delete(term);
  }, { once: true });

  resetsByTerminal.set(term, rescanFromScratch);
}

export function resetTerminalSecretMask(term: Terminal) {
  resetsByTerminal.get(term)?.();
}
