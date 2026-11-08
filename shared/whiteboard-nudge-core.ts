import type { Rect } from './whiteboard-layout-core.ts';
import { distinctSorted } from './whiteboard-sweep-core.ts';

const TRACK_SPACING = 10;
const BOX_MARGIN = 4;
const CHANNEL_REACH = 14;
const MIN_TRACK_SPACING = 2;
const MAX_GAP_REACH = 160;

interface NudgePoint {
  x: number;
  y: number;
}

interface PortSlack {
  low: number;
  high: number;
}

interface NudgeWire {
  points: readonly NudgePoint[];
  exitKey: string;
  busKey: string | null;
  startSlack: PortSlack;
  endSlack: PortSlack;
}

interface LineSegment {
  wire: number;
  index: number;
  line: number;
  low: number;
  high: number;
  isFixed: boolean;
}

interface Bundle {
  members: LineSegment[];
  low: number;
  high: number;
  isPinned: boolean;
  offset: number;
}

interface SharedLine {
  line: number;
  low: number;
  high: number;
  bundles: Bundle[];
}

interface Channel {
  low: number;
  high: number;
  isBetweenObstacles: boolean;
}

function lineOf(point: NudgePoint, isHorizontal: boolean): number {
  return isHorizontal ? point.y : point.x;
}

function alongOf(point: NudgePoint, isHorizontal: boolean): number {
  return isHorizontal ? point.x : point.y;
}

function lineSegmentsOf(points: readonly NudgePoint[][], isHorizontal: boolean): LineSegment[] {
  const segments: LineSegment[] = [];
  points.forEach((wirePoints, wire) => {
    for (let index = 0; index + 1 < wirePoints.length; index += 1) {
      const from = wirePoints[index];
      const to = wirePoints[index + 1];
      if (!from || !to || lineOf(from, isHorizontal) !== lineOf(to, isHorizontal) || alongOf(from, isHorizontal) === alongOf(to, isHorizontal)) continue;
      const isFixed = index === 0 || index + 2 === wirePoints.length;
      segments.push({ wire, index, line: lineOf(from, isHorizontal), low: Math.min(alongOf(from, isHorizontal), alongOf(to, isHorizontal)), high: Math.max(alongOf(from, isHorizontal), alongOf(to, isHorizontal)), isFixed });
    }
  });
  return segments.sort((first, second) => first.line - second.line || first.low - second.low);
}

function bundlesOf(members: readonly LineSegment[], wires: readonly NudgeWire[]): Bundle[] {
  const bundles: Bundle[] = [];
  const bundleByWire = new Map<number, Bundle>();
  const bundleByExitKey = new Map<string, Bundle>();
  const bundleByBusKey = new Map<string, Bundle>();
  for (const member of members) {
    const wire = wires[member.wire];
    if (!wire) continue;
    const found = bundleByWire.get(member.wire) ?? bundleByExitKey.get(wire.exitKey) ?? (wire.busKey === null ? undefined : bundleByBusKey.get(wire.busKey));
    const bundle = found ?? { members: [], low: member.low, high: member.high, isPinned: false, offset: 0 };
    if (!found) bundles.push(bundle);
    bundle.members.push(member);
    bundle.low = Math.min(bundle.low, member.low);
    bundle.high = Math.max(bundle.high, member.high);
    bundle.isPinned ||= member.isFixed;
    bundleByWire.set(member.wire, bundle);
    if (!bundleByExitKey.has(wire.exitKey)) bundleByExitKey.set(wire.exitKey, bundle);
    if (wire.busKey !== null && !bundleByBusKey.has(wire.busKey)) bundleByBusKey.set(wire.busKey, bundle);
  }
  return bundles;
}

function sharedLinesOf(segments: readonly LineSegment[], wires: readonly NudgeWire[]): SharedLine[] {
  const sharedLines: SharedLine[] = [];
  let groupStart = 0;
  while (groupStart < segments.length) {
    const first = segments[groupStart];
    if (!first) break;
    let groupEnd = groupStart + 1;
    let high = first.high;
    for (; groupEnd < segments.length; groupEnd += 1) {
      const next = segments[groupEnd];
      if (!next || next.line !== first.line || next.low > high) break;
      high = Math.max(high, next.high);
    }
    const members = segments.slice(groupStart, groupEnd);
    groupStart = groupEnd;
    if (members.length < 2) continue;
    const bundles = bundlesOf(members, wires);
    if (bundles.length > 1) sharedLines.push({ line: first.line, low: first.low, high, bundles });
  }
  return sharedLines;
}

function turnAt(points: readonly NudgePoint[], segment: LineSegment, isLowEnd: boolean, isHorizontal: boolean): number {
  const from = points[segment.index];
  const to = points[segment.index + 1];
  if (!from || !to) return 0;
  const isFromLow = alongOf(from, isHorizontal) < alongOf(to, isHorizontal);
  const neighbor = isFromLow === isLowEnd ? points[segment.index - 1] : points[segment.index + 2];
  if (!neighbor) return 0;
  return Math.sign(lineOf(neighbor, isHorizontal) - segment.line);
}

function compareSegments(first: LineSegment, second: LineSegment, points: readonly NudgePoint[][], isHorizontal: boolean): number {
  const firstPoints = points[first.wire] ?? [];
  const secondPoints = points[second.wire] ?? [];
  const firstLowTurn = turnAt(firstPoints, first, true, isHorizontal);
  const secondLowTurn = turnAt(secondPoints, second, true, isHorizontal);
  if (firstLowTurn !== 0 && secondLowTurn !== 0 && firstLowTurn !== secondLowTurn) return firstLowTurn;
  if (firstLowTurn !== 0 && firstLowTurn === secondLowTurn && first.low !== second.low) return firstLowTurn < 0 ? second.low - first.low : first.low - second.low;
  const firstHighTurn = turnAt(firstPoints, first, false, isHorizontal);
  const secondHighTurn = turnAt(secondPoints, second, false, isHorizontal);
  if (firstHighTurn !== 0 && secondHighTurn !== 0 && firstHighTurn !== secondHighTurn) return firstHighTurn;
  if (firstHighTurn !== 0 && firstHighTurn === secondHighTurn && first.high !== second.high) return firstHighTurn < 0 ? first.high - second.high : second.high - first.high;
  return first.wire - second.wire;
}

interface RangeMaxTree {
  maxima: Int32Array;
  pending: Int32Array;
}

function pushPending(tree: RangeMaxTree, node: number): void {
  const value = tree.pending[node] ?? -1;
  if (value < 0) return;
  for (const child of [node * 2, node * 2 + 1]) {
    tree.maxima[child] = value;
    tree.pending[child] = value;
  }
  tree.pending[node] = -1;
}

function rangeMax(tree: RangeMaxTree, node: number, nodeLow: number, nodeHigh: number, low: number, high: number): number {
  if (high < nodeLow || nodeHigh < low) return -1;
  if (low <= nodeLow && nodeHigh <= high) return tree.maxima[node] ?? -1;
  pushPending(tree, node);
  const middle = (nodeLow + nodeHigh) >> 1;
  return Math.max(rangeMax(tree, node * 2, nodeLow, middle, low, high), rangeMax(tree, node * 2 + 1, middle + 1, nodeHigh, low, high));
}

function raiseRange(tree: RangeMaxTree, node: number, nodeLow: number, nodeHigh: number, low: number, high: number, value: number): void {
  if (high < nodeLow || nodeHigh < low) return;
  if (low <= nodeLow && nodeHigh <= high) {
    tree.maxima[node] = value;
    tree.pending[node] = value;
    return;
  }
  pushPending(tree, node);
  const middle = (nodeLow + nodeHigh) >> 1;
  raiseRange(tree, node * 2, nodeLow, middle, low, high, value);
  raiseRange(tree, node * 2 + 1, middle + 1, nodeHigh, low, high, value);
  tree.maxima[node] = Math.max(tree.maxima[node * 2] ?? -1, tree.maxima[node * 2 + 1] ?? -1);
}

function indexIn(sortedValues: Float64Array, value: number): number {
  let low = 0;
  let high = sortedValues.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sortedValues[middle] ?? 0) < value) low = middle + 1;
    if ((sortedValues[middle] ?? 0) >= value) high = middle;
  }
  return low;
}

function assignOffsets(orderedBundles: readonly Bundle[]): number {
  const ends = distinctSorted(Float64Array.from(orderedBundles.flatMap((bundle) => [bundle.low, bundle.high])));
  const size = ends.length;
  const tree = { maxima: new Int32Array(size * 4).fill(-1), pending: new Int32Array(size * 4).fill(-1) };
  let offsetCount = 0;
  for (const bundle of orderedBundles) {
    const low = indexIn(ends, bundle.low);
    const high = indexIn(ends, bundle.high);
    bundle.offset = rangeMax(tree, 1, 0, size - 1, low, high) + 1;
    raiseRange(tree, 1, 0, size - 1, low, high, bundle.offset);
    offsetCount = Math.max(offsetCount, bundle.offset + 1);
  }
  return offsetCount;
}

function pinnedOffsetOf(bundles: readonly Bundle[]): number | null | undefined {
  const pinnedOffsets = new Set(bundles.flatMap((bundle) => (bundle.isPinned ? [bundle.offset] : [])));
  if (pinnedOffsets.size > 1) return undefined;
  const [pinnedOffset] = pinnedOffsets;
  return pinnedOffset ?? null;
}

function channelOf(sharedLine: SharedLine, offsetCount: number, hardRectsIn: (area: Rect) => readonly Rect[], isHorizontal: boolean): Channel {
  const reach = offsetCount * TRACK_SPACING + BOX_MARGIN + CHANNEL_REACH;
  const area = isHorizontal
    ? { x: sharedLine.low, y: sharedLine.line - MAX_GAP_REACH, width: sharedLine.high - sharedLine.low, height: MAX_GAP_REACH * 2 }
    : { x: sharedLine.line - MAX_GAP_REACH, y: sharedLine.low, width: MAX_GAP_REACH * 2, height: sharedLine.high - sharedLine.low };
  let gapLow = sharedLine.line - MAX_GAP_REACH;
  let gapHigh = sharedLine.line + MAX_GAP_REACH;
  let isLowBounded = false;
  let isHighBounded = false;
  for (const rect of hardRectsIn(area)) {
    const alongLow = isHorizontal ? rect.x : rect.y;
    const alongHigh = alongLow + (isHorizontal ? rect.width : rect.height);
    if (alongLow >= sharedLine.high || alongHigh <= sharedLine.low) continue;
    const acrossLow = isHorizontal ? rect.y : rect.x;
    const acrossHigh = acrossLow + (isHorizontal ? rect.height : rect.width);
    if (acrossHigh <= sharedLine.line && acrossHigh + BOX_MARGIN > gapLow) {
      gapLow = acrossHigh + BOX_MARGIN;
      isLowBounded = true;
    }
    if (acrossLow >= sharedLine.line && acrossLow - BOX_MARGIN < gapHigh) {
      gapHigh = acrossLow - BOX_MARGIN;
      isHighBounded = true;
    }
  }
  const isBetweenObstacles = isLowBounded && isHighBounded;
  if (isBetweenObstacles) return { low: gapLow, high: gapHigh, isBetweenObstacles };
  return { low: Math.max(gapLow, sharedLine.line - reach), high: Math.min(gapHigh, sharedLine.line + reach), isBetweenObstacles };
}

function firstTrackAndSpacing(line: number, offsetCount: number, pinnedOffset: number | null, channel: Channel): { firstTrack: number; spacing: number } | null {
  if (pinnedOffset !== null) {
    const roomBelow = pinnedOffset > 0 ? (line - channel.low) / pinnedOffset : Infinity;
    const roomAbove = offsetCount - 1 - pinnedOffset > 0 ? (channel.high - line) / (offsetCount - 1 - pinnedOffset) : Infinity;
    const spacing = Math.min(TRACK_SPACING, roomBelow, roomAbove);
    return spacing < MIN_TRACK_SPACING ? null : { firstTrack: line - pinnedOffset * spacing, spacing };
  }
  const spacing = Math.min(TRACK_SPACING, (channel.high - channel.low) / (offsetCount - 1));
  if (spacing < MIN_TRACK_SPACING) return null;
  const span = (offsetCount - 1) * spacing;
  const centre = channel.isBetweenObstacles ? (channel.low + channel.high) / 2 : line;
  return { firstTrack: Math.max(channel.low, Math.min(centre - span / 2, channel.high - span)), spacing };
}

function moveBundle(bundle: Bundle, position: number, points: NudgePoint[][], isHorizontal: boolean): void {
  for (const member of bundle.members) {
    const wirePoints = points[member.wire] ?? [];
    for (const pointIndex of [member.index, member.index + 1]) {
      const point = wirePoints[pointIndex];
      if (point) wirePoints[pointIndex] = isHorizontal ? { x: point.x, y: position } : { x: position, y: point.y };
    }
  }
}

function isWithinPortSlack(bundle: Bundle, track: number, wires: readonly NudgeWire[], points: readonly NudgePoint[][]): boolean {
  return bundle.members.every((member) => {
    const wire = wires[member.wire];
    if (!wire || !member.isFixed) return true;
    const isStart = member.index === 0;
    const isEnd = member.index + 2 === (points[member.wire]?.length ?? 0);
    const isInStart = !isStart || (track >= wire.startSlack.low && track <= wire.startSlack.high);
    const isInEnd = !isEnd || (track >= wire.endSlack.low && track <= wire.endSlack.high);
    return isInStart && isInEnd;
  });
}

function nudgeAxis(wires: readonly NudgeWire[], points: NudgePoint[][], hardRectsIn: (area: Rect) => readonly Rect[], isHorizontal: boolean): void {
  const sharedLines = sharedLinesOf(lineSegmentsOf(points, isHorizontal), wires);
  const offsetCounts = sharedLines.map((sharedLine) => {
    sharedLine.bundles.sort((first, second) => {
      const [firstMember] = first.members;
      const [secondMember] = second.members;
      return firstMember && secondMember ? compareSegments(firstMember, secondMember, points, isHorizontal) : 0;
    });
    return assignOffsets(sharedLine.bundles);
  });
  sharedLines.forEach((sharedLine, lineIndex) => {
    const offsetCount = offsetCounts[lineIndex] ?? 1;
    if (offsetCount < 2) return;
    const pinnedOffset = pinnedOffsetOf(sharedLine.bundles);
    const channel = channelOf(sharedLine, offsetCount, hardRectsIn, isHorizontal);
    const tracks = firstTrackAndSpacing(sharedLine.line, offsetCount, pinnedOffset ?? null, channel);
    if (!tracks) return;
    const trackOf = (bundle: Bundle) => Math.round(tracks.firstTrack + bundle.offset * tracks.spacing);
    if (pinnedOffset === undefined && !sharedLine.bundles.every((bundle) => isWithinPortSlack(bundle, trackOf(bundle), wires, points))) return;
    for (const bundle of sharedLine.bundles) moveBundle(bundle, trackOf(bundle), points, isHorizontal);
  });
}

function nudgeSharedLines(wires: readonly NudgeWire[], hardRectsIn: (area: Rect) => readonly Rect[]): NudgePoint[][] {
  const points = wires.map((wire) => wire.points.map((point) => ({ x: point.x, y: point.y })));
  nudgeAxis(wires, points, hardRectsIn, true);
  nudgeAxis(wires, points, hardRectsIn, false);
  return points;
}

export { nudgeSharedLines };
export type { PortSlack };
