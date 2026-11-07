import type { Rect } from './whiteboard-layout-core.ts';
import { distinctSorted, emptyFlatRects, flatRectsOf, forEachTouchingPairAcross, setFlatRect } from './whiteboard-sweep-core.ts';

const TRACK_SPACING = 10;
const BOX_MARGIN = 4;
const CHANNEL_REACH = 14;
const MIN_TRACK_SPACING = 2;

interface NudgePoint {
  x: number;
  y: number;
}

interface NudgeWire {
  points: readonly NudgePoint[];
  exitKey: string;
  busKey: string | null;
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

function channelsOf(sharedLines: readonly SharedLine[], offsetCounts: readonly number[], hardRects: readonly Rect[], isHorizontal: boolean): Channel[] {
  const reachOf = (index: number) => (offsetCounts[index] ?? 1) * TRACK_SPACING + BOX_MARGIN + CHANNEL_REACH;
  const channels = sharedLines.map((sharedLine, index) => ({ low: sharedLine.line - reachOf(index), high: sharedLine.line + reachOf(index) }));
  const bands = emptyFlatRects(sharedLines.length);
  sharedLines.forEach((sharedLine, index) => {
    const reach = reachOf(index);
    if (isHorizontal) setFlatRect(bands, index, sharedLine.low, sharedLine.line - reach, sharedLine.high, sharedLine.line + reach);
    if (!isHorizontal) setFlatRect(bands, index, sharedLine.line - reach, sharedLine.low, sharedLine.line + reach, sharedLine.high);
  });
  const solids = flatRectsOf(hardRects);
  forEachTouchingPairAcross(bands, solids, (band, solid) => {
    const sharedLine = sharedLines[band];
    const channel = channels[band];
    if (!sharedLine || !channel) return;
    const alongLow = (isHorizontal ? solids.lefts[solid] : solids.tops[solid]) ?? 0;
    const alongHigh = (isHorizontal ? solids.rights[solid] : solids.bottoms[solid]) ?? 0;
    if (alongLow >= sharedLine.high || alongHigh <= sharedLine.low) return;
    const acrossLow = (isHorizontal ? solids.tops[solid] : solids.lefts[solid]) ?? 0;
    const acrossHigh = (isHorizontal ? solids.bottoms[solid] : solids.rights[solid]) ?? 0;
    if (acrossHigh <= sharedLine.line) channel.low = Math.max(channel.low, acrossHigh + BOX_MARGIN);
    if (acrossLow >= sharedLine.line) channel.high = Math.min(channel.high, acrossLow - BOX_MARGIN);
  });
  return channels;
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
  return { firstTrack: Math.max(channel.low, Math.min(line - span / 2, channel.high - span)), spacing };
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

function nudgeAxis(wires: readonly NudgeWire[], points: NudgePoint[][], hardRects: readonly Rect[], isHorizontal: boolean): void {
  const sharedLines = sharedLinesOf(lineSegmentsOf(points, isHorizontal), wires);
  const offsetCounts = sharedLines.map((sharedLine) => {
    sharedLine.bundles.sort((first, second) => {
      const [firstMember] = first.members;
      const [secondMember] = second.members;
      return firstMember && secondMember ? compareSegments(firstMember, secondMember, points, isHorizontal) : 0;
    });
    return assignOffsets(sharedLine.bundles);
  });
  const channels = channelsOf(sharedLines, offsetCounts, hardRects, isHorizontal);
  sharedLines.forEach((sharedLine, lineIndex) => {
    const channel = channels[lineIndex];
    const offsetCount = offsetCounts[lineIndex] ?? 1;
    const pinnedOffset = pinnedOffsetOf(sharedLine.bundles);
    if (!channel || offsetCount < 2 || pinnedOffset === undefined) return;
    const tracks = firstTrackAndSpacing(sharedLine.line, offsetCount, pinnedOffset, channel);
    if (!tracks) return;
    for (const bundle of sharedLine.bundles) moveBundle(bundle, Math.round(tracks.firstTrack + bundle.offset * tracks.spacing), points, isHorizontal);
  });
}

function nudgeSharedLines(wires: readonly NudgeWire[], hardRects: readonly Rect[]): NudgePoint[][] {
  const points = wires.map((wire) => wire.points.map((point) => ({ x: point.x, y: point.y })));
  nudgeAxis(wires, points, hardRects, true);
  nudgeAxis(wires, points, hardRects, false);
  return points;
}

export { nudgeSharedLines };
