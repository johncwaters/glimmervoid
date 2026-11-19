interface SnapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SnapLine {
  at: number;
  rect: SnapRect;
}

interface GapLine {
  at: number;
  edge: 'start' | 'end';
  neighbor: SnapRect;
  pairGuide: SnapGuide;
}

export interface SnapTargets {
  xLines: readonly SnapLine[];
  yLines: readonly SnapLine[];
  xGaps: readonly GapLine[];
  yGaps: readonly GapLine[];
}

export interface SnapGuide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

interface SnapResult {
  correction: { x: number; y: number };
  guides: SnapGuide[];
}

interface SnapEdges {
  xs: readonly number[];
  ys: readonly number[];
}

export function rectAround(rects: readonly SnapRect[]): SnapRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const NO_SNAP: SnapResult = { correction: { x: 0, y: 0 }, guides: [] };
const MAX_GAP_RECTS = 400;

function linesOf(rects: readonly SnapRect[], axis: 'x' | 'y'): SnapLine[] {
  return rects.flatMap((rect) => {
    const start = axis === 'x' ? rect.x : rect.y;
    const size = axis === 'x' ? rect.width : rect.height;
    return [start, start + size / 2, start + size].map((at) => ({ at, rect }));
  }).sort((first, second) => first.at - second.at);
}

interface AxisSpan {
  start: number;
  end: number;
}

function spanOf(rect: SnapRect, axis: 'x' | 'y'): AxisSpan {
  return axis === 'x' ? { start: rect.x, end: rect.x + rect.width } : { start: rect.y, end: rect.y + rect.height };
}

function crossAxisOf(axis: 'x' | 'y'): 'x' | 'y' {
  return axis === 'x' ? 'y' : 'x';
}

function sharedCrossSpanOf(first: SnapRect, second: SnapRect, axis: 'x' | 'y'): AxisSpan | null {
  const firstSpan = spanOf(first, crossAxisOf(axis));
  const secondSpan = spanOf(second, crossAxisOf(axis));
  const shared = { start: Math.max(firstSpan.start, secondSpan.start), end: Math.min(firstSpan.end, secondSpan.end) };
  return shared.end > shared.start ? shared : null;
}

function nextNeighborOf(rect: SnapRect, rects: readonly SnapRect[], axis: 'x' | 'y'): SnapRect | null {
  const rectEnd = spanOf(rect, axis).end;
  const following = rects.filter((other) => other !== rect && spanOf(other, axis).start >= rectEnd && sharedCrossSpanOf(rect, other, axis) !== null);
  return following.reduce<SnapRect | null>((nearest, other) => (nearest && spanOf(nearest, axis).start <= spanOf(other, axis).start ? nearest : other), null);
}

function gapLinesOf(pairStarts: readonly SnapRect[], rects: readonly SnapRect[], axis: 'x' | 'y'): GapLine[] {
  return pairStarts.flatMap((before) => {
    const after = nextNeighborOf(before, rects, axis);
    const shared = after ? sharedCrossSpanOf(before, after, axis) : null;
    if (!after || !shared) return [];
    const gapStart = spanOf(before, axis).end;
    const gapEnd = spanOf(after, axis).start;
    const gap = gapEnd - gapStart;
    if (gap <= 0) return [];
    const pairGuide: SnapGuide = { axis: crossAxisOf(axis), at: (shared.start + shared.end) / 2, from: gapStart, to: gapEnd };
    return [
      { at: spanOf(after, axis).end + gap, edge: 'start' as const, neighbor: after, pairGuide },
      { at: spanOf(before, axis).start - gap, edge: 'end' as const, neighbor: before, pairGuide },
    ];
  });
}

export function snapTargetsOf(visibleRects: readonly SnapRect[]): SnapTargets {
  const gapRects = visibleRects.slice(0, MAX_GAP_RECTS);
  return { xLines: linesOf(visibleRects, 'x'), yLines: linesOf(visibleRects, 'y'), xGaps: gapLinesOf(gapRects, visibleRects, 'x'), yGaps: gapLinesOf(gapRects, visibleRects, 'y') };
}

function firstIndexAtOrAbove(lines: readonly SnapLine[], value: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const isBelowValue = (lines[middle]?.at ?? Infinity) < value;
    low = isBelowValue ? middle + 1 : low;
    high = isBelowValue ? high : middle;
  }
  return low;
}

function nearestLine(lines: readonly SnapLine[], value: number): SnapLine | null {
  const index = firstIndexAtOrAbove(lines, value);
  const neighbors = [lines[index - 1], lines[index]].filter((line): line is SnapLine => line !== undefined);
  return neighbors.reduce<SnapLine | null>((best, line) => (best && Math.abs(best.at - value) <= Math.abs(line.at - value) ? best : line), null);
}

interface AxisSnap {
  delta: number;
  line: SnapLine;
}

function axisSnapOf(lines: readonly SnapLine[], edges: readonly number[], thresholdUnits: number): AxisSnap | null {
  return edges.reduce<AxisSnap | null>((best, edge) => {
    const line = nearestLine(lines, edge);
    if (!line || Math.abs(line.at - edge) > thresholdUnits) return best;
    const delta = line.at - edge;
    return best && Math.abs(best.delta) <= Math.abs(delta) ? best : { delta, line };
  }, null);
}

function guideOf(axis: 'x' | 'y', snap: AxisSnap, moved: SnapRect): SnapGuide {
  const crossStart = axis === 'x' ? Math.min(moved.y, snap.line.rect.y) : Math.min(moved.x, snap.line.rect.x);
  const crossEnd = axis === 'x'
    ? Math.max(moved.y + moved.height, snap.line.rect.y + snap.line.rect.height)
    : Math.max(moved.x + moved.width, snap.line.rect.x + snap.line.rect.width);
  return { axis, at: snap.line.at, from: crossStart, to: crossEnd };
}

export function snappedCorrectionOf(targets: SnapTargets, edges: SnapEdges, moved: SnapRect, thresholdUnits: number): SnapResult {
  const xSnap = axisSnapOf(targets.xLines, edges.xs, thresholdUnits);
  const ySnap = axisSnapOf(targets.yLines, edges.ys, thresholdUnits);
  if (!xSnap && !ySnap) return NO_SNAP;
  const correction = { x: xSnap?.delta ?? 0, y: ySnap?.delta ?? 0 };
  const snappedRect = { ...moved, x: moved.x + correction.x, y: moved.y + correction.y };
  const guides = [...(xSnap ? [guideOf('x', xSnap, snappedRect)] : []), ...(ySnap ? [guideOf('y', ySnap, snappedRect)] : [])];
  return { correction, guides };
}

interface GapSnap {
  delta: number;
  gapLine: GapLine;
}

function gapSnapOf(gaps: readonly GapLine[], moved: SnapRect, axis: 'x' | 'y', thresholdUnits: number): GapSnap | null {
  const movedSpan = spanOf(moved, axis);
  return gaps.reduce<GapSnap | null>((best, gapLine) => {
    const delta = gapLine.at - (gapLine.edge === 'start' ? movedSpan.start : movedSpan.end);
    if (Math.abs(delta) > thresholdUnits || !sharedCrossSpanOf(moved, gapLine.neighbor, axis)) return best;
    return best && Math.abs(best.delta) <= Math.abs(delta) ? best : { delta, gapLine };
  }, null);
}

function gapGuidesOf(axis: 'x' | 'y', { gapLine }: GapSnap, snappedRect: SnapRect): SnapGuide[] {
  const shared = sharedCrossSpanOf(snappedRect, gapLine.neighbor, axis);
  if (!shared) return [gapLine.pairGuide];
  const neighborSpan = spanOf(gapLine.neighbor, axis);
  const snappedSpan = spanOf(snappedRect, axis);
  const newGap = gapLine.edge === 'start' ? { from: neighborSpan.end, to: snappedSpan.start } : { from: snappedSpan.end, to: neighborSpan.start };
  return [gapLine.pairGuide, { axis: crossAxisOf(axis), at: (shared.start + shared.end) / 2, ...newGap }];
}

type ChosenSnap = { kind: 'align'; snap: AxisSnap } | { kind: 'gap'; snap: GapSnap };

function closerAxisSnap(alignSnap: AxisSnap | null, gapSnap: GapSnap | null): ChosenSnap | null {
  if (gapSnap && (!alignSnap || Math.abs(gapSnap.delta) < Math.abs(alignSnap.delta))) return { kind: 'gap', snap: gapSnap };
  return alignSnap ? { kind: 'align', snap: alignSnap } : null;
}

function keepsGapNeighbor(chosen: ChosenSnap | null, snappedRect: SnapRect, axis: 'x' | 'y'): boolean {
  return chosen?.kind !== 'gap' || sharedCrossSpanOf(snappedRect, chosen.snap.gapLine.neighbor, axis) !== null;
}

function alignedFallbackOf(alignSnap: AxisSnap | null): ChosenSnap | null {
  return alignSnap ? { kind: 'align', snap: alignSnap } : null;
}

function shiftedBy(moved: SnapRect, xSnap: ChosenSnap | null, ySnap: ChosenSnap | null): SnapRect {
  return { ...moved, x: moved.x + (xSnap?.snap.delta ?? 0), y: moved.y + (ySnap?.snap.delta ?? 0) };
}

function guidesOfChosen(axis: 'x' | 'y', chosen: ChosenSnap | null, snappedRect: SnapRect): SnapGuide[] {
  if (!chosen) return [];
  return chosen.kind === 'gap' ? gapGuidesOf(axis, chosen.snap, snappedRect) : [guideOf(axis, chosen.snap, snappedRect)];
}

export function movedSnapOf(targets: SnapTargets, moved: SnapRect, thresholdUnits: number): SnapResult {
  const xEdges = [moved.x, moved.x + moved.width / 2, moved.x + moved.width];
  const yEdges = [moved.y, moved.y + moved.height / 2, moved.y + moved.height];
  const xAlignSnap = axisSnapOf(targets.xLines, xEdges, thresholdUnits);
  const yAlignSnap = axisSnapOf(targets.yLines, yEdges, thresholdUnits);
  let xSnap = closerAxisSnap(xAlignSnap, gapSnapOf(targets.xGaps, moved, 'x', thresholdUnits));
  let ySnap = closerAxisSnap(yAlignSnap, gapSnapOf(targets.yGaps, moved, 'y', thresholdUnits));
  for (const axis of ['x', 'y', 'x'] as const) {
    const snappedRect = shiftedBy(moved, xSnap, ySnap);
    if (axis === 'x' && !keepsGapNeighbor(xSnap, snappedRect, 'x')) xSnap = alignedFallbackOf(xAlignSnap);
    if (axis === 'y' && !keepsGapNeighbor(ySnap, snappedRect, 'y')) ySnap = alignedFallbackOf(yAlignSnap);
  }
  if (!xSnap && !ySnap) return NO_SNAP;
  const snappedRect = shiftedBy(moved, xSnap, ySnap);
  const correction = { x: snappedRect.x - moved.x, y: snappedRect.y - moved.y };
  return { correction, guides: [...guidesOfChosen('x', xSnap, snappedRect), ...guidesOfChosen('y', ySnap, snappedRect)] };
}
