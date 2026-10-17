const SCREEN_RESET = '\x1bc\x1b[2J\x1b[3J\x1b[H';

const SCREEN_KEEPER_SCROLLBACK = 5000;

const SCREEN_KEEPER_ATTACH_SCROLLBACK = 500;

const SCREEN_KEEPER_SLICE_ROWS = 1000;

const SCREEN_KEEPER_SLICE_JOINER = '\x1b[0m\r\n';

const SCREEN_KEEPER_PENDING_CAP = 4 * 1024 * 1024;

const SCREEN_KEEPER_SEED_LIMIT = 1024 * 1024;

function isKeeperOverrun(pushedOffset: number, parsedOffset: number, pendingCap: number = SCREEN_KEEPER_PENDING_CAP): boolean {
  return pushedOffset - parsedOffset > pendingCap;
}

interface ResizeMarker {
  cols: number;
  rows: number;
  atOffset: number;
}

interface PendingResizeSplit {
  due: ResizeMarker[];
  rest: ResizeMarker[];
}

function pendingResizes(queue: readonly ResizeMarker[], parsedOffset: number): PendingResizeSplit {
  let cut = 0;
  while (cut < queue.length) {
    const marker = queue[cut];
    if (marker === undefined || marker.atOffset > parsedOffset) break;
    cut += 1;
  }
  return { due: queue.slice(0, cut), rest: queue.slice(cut) };
}

interface LineRange {
  start: number;
  end: number;
}

interface DeepSlicePlan {
  ranges: LineRange[];
  finalScrollback: number;
}

interface DeepSlicePlanInput {
  lineCount: number;
  rows: number;
  sliceRows: number;
  isWrapped: (line: number) => boolean;
}

function unwrappedLineAtOrBefore(line: number, isWrapped: (line: number) => boolean): number {
  let candidate = line;
  while (candidate > 0 && isWrapped(candidate)) candidate -= 1;
  return candidate;
}

function sliceEndLine(start: number, limit: number, sliceRows: number, isWrapped: (line: number) => boolean): number {
  const target = Math.min(start + sliceRows, limit);
  const unwrappedBefore = unwrappedLineAtOrBefore(target, isWrapped);
  if (unwrappedBefore > start) return unwrappedBefore;
  let unwrappedAfter = target;
  while (unwrappedAfter < limit && isWrapped(unwrappedAfter)) unwrappedAfter += 1;
  return unwrappedAfter;
}

function planDeepSlices({ lineCount, rows, sliceRows, isWrapped }: DeepSlicePlanInput): DeepSlicePlan {
  const finalStart = unwrappedLineAtOrBefore(Math.max(0, lineCount - rows - sliceRows), isWrapped);
  const ranges: LineRange[] = [];
  let start = 0;
  while (start < finalStart) {
    const end = sliceEndLine(start, finalStart, sliceRows, isWrapped);
    ranges.push({ start, end: end - 1 });
    start = end;
  }
  return { ranges, finalScrollback: Math.max(0, lineCount - rows - finalStart) };
}

export {
  SCREEN_RESET,
  SCREEN_KEEPER_SCROLLBACK,
  SCREEN_KEEPER_ATTACH_SCROLLBACK,
  SCREEN_KEEPER_SLICE_ROWS,
  SCREEN_KEEPER_SLICE_JOINER,
  SCREEN_KEEPER_PENDING_CAP,
  SCREEN_KEEPER_SEED_LIMIT,
  isKeeperOverrun,
  pendingResizes,
  planDeepSlices,
};
export type { ResizeMarker };
