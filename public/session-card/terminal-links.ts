import type { IBuffer, IBufferCellPosition, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { openExternalUrl } from '../external-link.ts';
import { findUrls } from './link-detect-core.ts';

const MAX_WRAPPED_ROWS = 50;

export function osc8LinkHandler() {
  return {
    activate(_event: MouseEvent, uri: string) {
      openExternalUrl(uri);
    },
    allowNonHttpProtocols: false,
  };
}

function collectLogicalLine(buffer: IBuffer, bufferLineNumber: number) {
  let startIdx = bufferLineNumber - 1;
  while (startIdx > 0 && buffer.getLine(startIdx)?.isWrapped && bufferLineNumber - 1 - startIdx < MAX_WRAPPED_ROWS) {
    startIdx--;
  }
  let endIdx = bufferLineNumber - 1;
  while (buffer.getLine(endIdx + 1)?.isWrapped && endIdx - (bufferLineNumber - 1) < MAX_WRAPPED_ROWS) {
    endIdx++;
  }

  let text = '';
  const cellAt: IBufferCellPosition[] = [];
  for (let y = startIdx; y <= endIdx; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k++) {
        text += chars[k];
        cellAt.push({ x: x + 1, y: y + 1 });
      }
    }
  }
  return { text, cellAt };
}

export function registerUrlLinkProvider(term: Terminal) {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const buffer = term.buffer?.active;
      if (!buffer) return callback(undefined);
      const { text, cellAt } = collectLogicalLine(buffer, bufferLineNumber);
      const links: ILink[] = [];
      for (const { start, end, url } of findUrls(text)) {
        const from = cellAt[start];
        const to = cellAt[end - 1];
        if (!from || !to) continue;
        links.push({
          range: { start: from, end: to },
          text: url,
          activate(_event: MouseEvent, matched: string) {
            openExternalUrl(matched);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
  const providerRegistration = term.registerLinkProvider(provider);
  const repaintRecheck = recheckLinksUnderPointerOnRepaint(term);
  return {
    dispose() {
      repaintRecheck.dispose();
      providerRegistration.dispose();
    },
  };
}

function recheckLinksUnderPointerOnRepaint(term: Terminal) {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return { dispose() {} };
  let lastPointer: { clientX: number; clientY: number } | null = null;
  const rememberPointer = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    lastPointer = { clientX: event.clientX, clientY: event.clientY };
  };
  const forgetPointer = () => { lastPointer = null; };
  const moveLinkDetectionTo = (clientX: number, clientY: number) => {
    screen.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: false }));
  };
  screen.addEventListener('mousemove', rememberPointer);
  screen.addEventListener('mouseleave', forgetPointer);
  const renderSubscription = term.onRender(({ start, end }) => {
    if (!lastPointer) return;
    if (screen.classList.contains('xterm-cursor-pointer')) return;
    const screenBounds = screen.getBoundingClientRect();
    const rowHeight = screenBounds.height / term.rows;
    if (!(rowHeight > 0)) return;
    const pointerRow = Math.floor((lastPointer.clientY - screenBounds.top) / rowHeight);
    if (pointerRow < start || pointerRow > end) return;
    const adjacentRowOffset = pointerRow === 0 ? rowHeight : -rowHeight;
    moveLinkDetectionTo(lastPointer.clientX, lastPointer.clientY + adjacentRowOffset);
    moveLinkDetectionTo(lastPointer.clientX, lastPointer.clientY);
  });
  return {
    dispose() {
      renderSubscription.dispose();
      screen.removeEventListener('mousemove', rememberPointer);
      screen.removeEventListener('mouseleave', forgetPointer);
    },
  };
}
