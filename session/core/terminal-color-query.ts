export interface TerminalColors {
  background: string;
  foreground: string;
}

export interface ColorQueryScan {
  replies: string[];
  pending: string;
}

export const DEFAULT_TERMINAL_COLORS: TerminalColors = { background: '#100e18', foreground: '#c8c0e0' };

const OSC_START = '\x1b]';
const BEL = '\x07';
const ST = '\x1b\\';
const MAX_PENDING_QUERY = 64;
const FOREGROUND_SLOT = 10;
const BACKGROUND_SLOT = 11;

function toXtermRgb(hexColor: string): string {
  const channels = [1, 3, 5].map((offset) => hexColor.slice(offset, offset + 2).toLowerCase());
  return `rgb:${channels.map((channel) => channel + channel).join('/')}`;
}

function colorForSlot(slot: number, colors: TerminalColors): string | null {
  if (slot === FOREGROUND_SLOT) return colors.foreground;
  if (slot === BACKGROUND_SLOT) return colors.background;
  return null;
}

function repliesForQuery(body: string, terminator: string, colors: TerminalColors): string[] {
  const [slotText, ...parameters] = body.split(';');
  const firstSlot = Number(slotText);
  if (colorForSlot(firstSlot, colors) === null || parameters.length === 0) return [];
  if (!parameters.every((parameter) => parameter === '?')) return [];
  const replies: string[] = [];
  for (const [offset] of parameters.entries()) {
    const slot = firstSlot + offset;
    const color = colorForSlot(slot, colors);
    if (color === null) return replies;
    replies.push(`${OSC_START}${slot};${toXtermRgb(color)}${terminator}`);
  }
  return replies;
}

function pendingTail(buffer: string, fromIndex: number): string {
  const openStart = buffer.indexOf(OSC_START, fromIndex);
  if (openStart !== -1) return buffer.length - openStart > MAX_PENDING_QUERY ? '' : buffer.slice(openStart);
  return buffer.endsWith('\x1b') ? '\x1b' : '';
}

export function scanTerminalColorQueries(pending: string, chunk: string, colors: TerminalColors): ColorQueryScan {
  const buffer = pending + chunk;
  const replies: string[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(OSC_START, cursor);
    if (start === -1) return { replies, pending: pendingTail(buffer, cursor) };
    const bodyStart = start + OSC_START.length;
    const belIndex = buffer.indexOf(BEL, bodyStart);
    const stIndex = buffer.indexOf(ST, bodyStart);
    const hasBel = belIndex !== -1 && (stIndex === -1 || belIndex < stIndex);
    const end = hasBel ? belIndex : stIndex;
    if (end === -1) return { replies, pending: pendingTail(buffer, start) };
    const terminator = hasBel ? BEL : ST;
    replies.push(...repliesForQuery(buffer.slice(bodyStart, end), terminator, colors));
    cursor = end + terminator.length;
  }
  return { replies, pending: '' };
}
