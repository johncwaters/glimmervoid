import type { Terminal } from '@xterm/xterm';
import type { SessionUi } from './card-registry.ts';
import { copyTextToClipboard } from './terminal-notices.ts';
import { joinWrappedRows, lastOutputText } from './touch-select-core.ts';
import type { BufferRow } from './touch-select-core.ts';

function readRows(term: Terminal, firstRow: number, rowCount: number): BufferRow[] {
  const buffer = term.buffer.active;
  const rows: BufferRow[] = [];
  for (let row = firstRow; row < firstRow + rowCount; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    rows.push({ text: line.translateToString(true), isWrapped: line.isWrapped });
  }
  return rows;
}

export function readAllLines(term: Terminal): string[] {
  return joinWrappedRows(readRows(term, 0, term.buffer.active.length));
}

function readScreenLines(term: Terminal): string[] {
  return joinWrappedRows(readRows(term, term.buffer.active.viewportY, term.rows));
}

export function copyScreen(ui: SessionUi) {
  if (!ui.term) return;
  copyTextToClipboard(ui, readScreenLines(ui.term).join('\n').trimEnd(), 'copy screen', 'Copied the screen.');
}

export function copyLastOutput(ui: SessionUi) {
  if (!ui.term) return;
  copyTextToClipboard(ui, lastOutputText(readAllLines(ui.term)), 'copy output', 'Copied the last output.');
}
