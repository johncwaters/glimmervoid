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

export interface SnapTargets {
  xLines: readonly SnapLine[];
  yLines: readonly SnapLine[];
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

function linesOf(rects: readonly SnapRect[], axis: 'x' | 'y'): SnapLine[] {
  return rects.flatMap((rect) => {
    const start = axis === 'x' ? rect.x : rect.y;
    const size = axis === 'x' ? rect.width : rect.height;
    return [start, start + size / 2, start + size].map((at) => ({ at, rect }));
  }).sort((first, second) => first.at - second.at);
}

export function snapTargetsOf(visibleRects: readonly SnapRect[]): SnapTargets {
  return { xLines: linesOf(visibleRects, 'x'), yLines: linesOf(visibleRects, 'y') };
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
