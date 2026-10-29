import { splitLines } from '../usage/core/usage-scan-core.ts';
import { coercedNumberOr } from '../../shared/coerce.ts';

interface TailStat {
  size?: number;
  mtimeMs?: number;
  ino?: number;
  birthtimeMs?: number;
}

interface TailState {
  path: string | null;
  identity: string;
  size: number;
  mtimeMs: number;
  offset: number;
  carry: string;
  head: string | null;
  vendorState: Record<string, string> | null;
}

function fileIdentity(stat: TailStat | null | undefined): string {
  return `${Math.floor(coercedNumberOr(stat?.ino, 0))}:${Math.floor(coercedNumberOr(stat?.birthtimeMs, 0))}`;
}

function createTailState(
  stat: TailStat | null | undefined,
  { path: filePath = null, head = null }: { path?: string | null; head?: string | null } = {},
): TailState {
  const size = Math.max(0, Math.floor(coercedNumberOr(stat?.size, 0)));
  return {
    path: filePath,
    identity: fileIdentity(stat),
    size,
    mtimeMs: coercedNumberOr(stat?.mtimeMs, 0),
    offset: size,
    carry: '',
    head: typeof head === 'string' ? head : null,
    vendorState: null,
  };
}

function splitKeepingEmpty(carry: string, chunkText: string): { lines: string[]; carry: string } {
  const text = `${carry || ''}${chunkText || ''}`;
  const lines = text.split(/\r?\n/);

  const nextCarry = lines.pop();
  return { lines, carry: nextCarry || '' };
}

function afterFirstBreak(text: string): string {
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return '';
  return text.slice(firstBreak + 1);
}

function applyRead(state: TailState, {
  text = '', end = 0, stat = null, head = null, reset = false, dropPartial = false, keepEmptyLines = false,
}: {
  text?: string;
  end?: number;
  stat?: TailStat | null;
  head?: string | null;
  reset?: boolean;
  dropPartial?: boolean;
  keepEmptyLines?: boolean;
} = {}): string[] {
  if (reset || dropPartial) state.carry = '';
  if (reset) {
    state.vendorState = null;
    state.head = null;
  }
  if (typeof head === 'string' && head.length > 0) state.head = head;
  const body = dropPartial ? afterFirstBreak(text) : text;
  const split = keepEmptyLines ? splitKeepingEmpty(state.carry, body) : splitLines(state.carry, body);
  state.carry = split.carry;
  state.offset = Math.max(0, Math.floor(coercedNumberOr(end, state.offset)));
  state.size = Math.max(state.offset, Math.floor(coercedNumberOr(stat?.size, state.offset)));
  state.mtimeMs = coercedNumberOr(stat?.mtimeMs, state.mtimeMs);
  if (stat) state.identity = fileIdentity(stat);
  return split.lines;
}

function isTailCurrent(state: TailState, stat: TailStat | null | undefined): boolean {
  if (!stat || fileIdentity(stat) !== state.identity) return false;
  if (coercedNumberOr(stat.size, -1) !== state.size || state.offset < state.size) return false;
  return coercedNumberOr(stat.mtimeMs, -1) === state.mtimeMs;
}

export { applyRead, createTailState, isTailCurrent };
export type { TailState };
