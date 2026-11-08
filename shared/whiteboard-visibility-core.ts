import type { Rect } from './whiteboard-layout-core.ts';
import { distinctSorted, emptyFlatRects, forEachTouchingPairAcross, leafCapacityOf, leafOf, setFlatRect } from './whiteboard-sweep-core.ts';
import type { FlatRects } from './whiteboard-sweep-core.ts';

const CLEARANCE = 14;
const BLOCKING_MARGIN = 1;
const FRAME_MARGIN = CLEARANCE * 3;
const MIDLINE_GAP = CLEARANCE * 3;
const CONTENT_TOP_MARGIN = 4;

const RIGHT = 0;
const LEFT = 1;
const DOWN = 2;
const UP = 3;

const INITIAL_NODE_CAPACITY = 1024;
const CACHED_NODES_PER_PIECE = 32;
const UNKNOWN_NEIGHBOR = -2;
const CLEAR_STEP = 1;
const SOFT_STEP = 2;
const EMPTY_NODE_SLOT = -1;

interface GraphPort {
  x: number;
  y: number;
  outwardDirection: number;
}

interface ObstacleInput {
  hardRects: readonly Rect[];
  softRects: readonly Rect[];
  contentTop: number;
}

interface PreparedObstacles {
  input: ObstacleInput;
  frame: Frame;
  blockers: FlatRects;
  corners: CornerTable;
  horizontal: MergedPieces;
  vertical: MergedPieces;
  softAlongX: SoftIndex;
  softAlongY: SoftIndex;
}

interface VisibilityGraph {
  nodeCount: number;
  xs: Float64Array;
  ys: Float64Array;
  neighborOf: (node: number, direction: number) => number;
  isSoftStep: (node: number, direction: number) => boolean;
  nodeAt: (x: number, y: number) => number;
  componentOf: (node: number) => number;
  beginSearch: () => void;
  pieceExtentOf: (node: number, isAlongX: boolean) => [number, number];
}

interface LineIndex {
  acrossValues: Float64Array;
  capacity: number;
  offsets: Int32Array;
  lines: Float64Array;
  pieces: Int32Array;
}

interface SoftIndex {
  boundaries: Float64Array;
  capacity: number;
  offsets: Int32Array;
  alongLows: Float64Array;
  reachMaxima: Float64Array;
}

interface NodeStore {
  horizontalPieces: Int32Array;
  verticalPieces: Int32Array;
  neighbors: Int32Array;
  softSteps: Uint8Array;
}

interface Frame {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GrowingNumbers {
  values: Float64Array;
  length: number;
}

interface Pieces {
  lines: GrowingNumbers;
  starts: GrowingNumbers;
  ends: GrowingNumbers;
}

interface MergedPieces {
  count: number;
  lines: Float64Array;
  starts: Float64Array;
  ends: Float64Array;
}

interface Rays {
  alongs: GrowingNumbers;
  acrosses: GrowingNumbers;
}

function growingNumbers(): GrowingNumbers {
  return { values: new Float64Array(64), length: 0 };
}

function pushNumber(numbers: GrowingNumbers, value: number): void {
  if (numbers.length === numbers.values.length) {
    const grown = new Float64Array(numbers.values.length * 2);
    grown.set(numbers.values);
    numbers.values = grown;
  }
  numbers.values[numbers.length] = value;
  numbers.length += 1;
}

function filled(numbers: GrowingNumbers): Float64Array {
  return numbers.values.subarray(0, numbers.length);
}

function emptyPieces(): Pieces {
  return { lines: growingNumbers(), starts: growingNumbers(), ends: growingNumbers() };
}

function addPiece(pieces: Pieces, line: number, start: number, end: number): void {
  if (end < start) return;
  pushNumber(pieces.lines, line);
  pushNumber(pieces.starts, start);
  pushNumber(pieces.ends, end);
}

function emptyRays(): Rays {
  return { alongs: growingNumbers(), acrosses: growingNumbers() };
}

function addRay(rays: Rays, along: number, across: number): number {
  pushNumber(rays.alongs, along);
  pushNumber(rays.acrosses, across);
  return rays.alongs.length - 1;
}

function frameOf(input: ObstacleInput, ports: readonly GraphPort[]): Frame | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of [...input.hardRects, ...input.softRects]) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  for (const port of ports) {
    left = Math.min(left, port.x);
    top = Math.min(top, port.y);
    right = Math.max(right, port.x);
    bottom = Math.max(bottom, port.y);
  }
  if (left === Infinity) return null;
  const topLimit = input.contentTop + CONTENT_TOP_MARGIN;
  return { left: Math.round(left - FRAME_MARGIN), top: Math.max(Math.round(top - FRAME_MARGIN), topLimit), right: Math.round(right + FRAME_MARGIN), bottom: Math.round(bottom + FRAME_MARGIN) };
}

function blockingRectsOf(hardRects: readonly Rect[]): FlatRects {
  const blockers = emptyFlatRects(hardRects.length);
  hardRects.forEach((rect, index) => {
    setFlatRect(blockers, index, rect.x - BLOCKING_MARGIN, rect.y - BLOCKING_MARGIN, rect.x + rect.width + BLOCKING_MARGIN, rect.y + rect.height + BLOCKING_MARGIN);
  });
  return blockers;
}

interface BlockerView {
  starts: Float64Array;
  lows: Float64Array;
  highs: Float64Array;
}

function blockerViewOf(blockers: FlatRects, direction: number): BlockerView {
  if (direction === RIGHT) return { starts: blockers.lefts, lows: blockers.tops, highs: blockers.bottoms };
  if (direction === LEFT) return { starts: blockers.rights.map((right) => -right), lows: blockers.tops, highs: blockers.bottoms };
  if (direction === DOWN) return { starts: blockers.tops, lows: blockers.lefts, highs: blockers.rights };
  return { starts: blockers.bottoms.map((bottom) => -bottom), lows: blockers.lefts, highs: blockers.rights };
}

function descendingOrder(values: Float64Array): Int32Array {
  const order = new Int32Array(values.length);
  for (let index = 0; index < order.length; index += 1) order[index] = index;
  return order.sort((first, second) => (values[second] ?? 0) - (values[first] ?? 0));
}

function blockersAcross(blockers: FlatRects, direction: number, rayAcrosses: Float64Array): FlatRects {
  const isAlongX = direction === RIGHT || direction === LEFT;
  const lows = isAlongX ? blockers.tops : blockers.lefts;
  const highs = isAlongX ? blockers.bottoms : blockers.rights;
  const sortedAcrosses = Float64Array.from(rayAcrosses).sort();
  const kept: number[] = [];
  for (let blocker = 0; blocker < blockers.count; blocker += 1) {
    const firstAtOrAbove = firstIndexAtLeast(sortedAcrosses, 0, sortedAcrosses.length, lows[blocker] ?? 0);
    if (firstAtOrAbove < sortedAcrosses.length && (sortedAcrosses[firstAtOrAbove] ?? 0) <= (highs[blocker] ?? 0)) kept.push(blocker);
  }
  const crossing = emptyFlatRects(kept.length);
  kept.forEach((blocker, index) => {
    setFlatRect(crossing, index, blockers.lefts[blocker] ?? 0, blockers.tops[blocker] ?? 0, blockers.rights[blocker] ?? 0, blockers.bottoms[blocker] ?? 0);
  });
  return crossing;
}

function firstBlockerHitsByScan(blockers: FlatRects, direction: number, rays: Rays): Float64Array {
  const view = blockerViewOf(blockers, direction);
  const isNegated = direction === LEFT || direction === UP;
  const hits = new Float64Array(rays.alongs.length);
  for (let ray = 0; ray < hits.length; ray += 1) {
    const rayAlong = isNegated ? -(rays.alongs.values[ray] ?? 0) : rays.alongs.values[ray] ?? 0;
    const rayAcross = rays.acrosses.values[ray] ?? 0;
    let nearest = Infinity;
    for (let blocker = 0; blocker < blockers.count; blocker += 1) {
      const start = view.starts[blocker] ?? 0;
      if (start >= rayAlong && start < nearest && (view.lows[blocker] ?? 0) < rayAcross && rayAcross < (view.highs[blocker] ?? 0)) nearest = start;
    }
    hits[ray] = isNegated ? -nearest : nearest;
  }
  return hits;
}

function firstBlockerHits(allBlockers: FlatRects, direction: number, rays: Rays): Float64Array {
  if (rays.alongs.length * allBlockers.count <= MAX_RAY_BLOCKER_PAIRS_FOR_SCAN) return firstBlockerHitsByScan(allBlockers, direction, rays);
  const blockers = rays.alongs.length * FEW_RAYS_SHARE < allBlockers.count ? blockersAcross(allBlockers, direction, filled(rays.acrosses)) : allBlockers;
  const view = blockerViewOf(blockers, direction);
  const isNegated = direction === LEFT || direction === UP;
  const rayAlongs = filled(rays.alongs).map((along) => (isNegated ? -along : along));
  const rayAcrosses = filled(rays.acrosses);
  const acrossValues = new Float64Array(blockers.count * 2 + rayAcrosses.length);
  acrossValues.set(view.lows, 0);
  acrossValues.set(view.highs, blockers.count);
  acrossValues.set(rayAcrosses, blockers.count * 2);
  const across = distinctSorted(acrossValues);
  const capacity = leafCapacityOf(across.length);
  const nearestStartByNode = new Float64Array(capacity * 2).fill(Infinity);
  const hits = new Float64Array(rayAlongs.length).fill(Infinity);
  const blockerOrder = descendingOrder(view.starts);
  let nextBlocker = 0;
  for (const ray of descendingOrder(rayAlongs)) {
    const rayAlong = rayAlongs[ray] ?? 0;
    for (; nextBlocker < blockerOrder.length; nextBlocker += 1) {
      const blocker = blockerOrder[nextBlocker] ?? 0;
      const start = view.starts[blocker] ?? 0;
      if (start < rayAlong) break;
      let low = leafOf(across, view.lows[blocker] ?? 0) + 1 + capacity;
      let high = leafOf(across, view.highs[blocker] ?? 0) + capacity;
      while (low < high) {
        if (low & 1) {
          nearestStartByNode[low] = Math.min(nearestStartByNode[low] ?? Infinity, start);
          low += 1;
        }
        if (high & 1) {
          high -= 1;
          nearestStartByNode[high] = Math.min(nearestStartByNode[high] ?? Infinity, start);
        }
        low >>= 1;
        high >>= 1;
      }
    }
    let nearest = Infinity;
    for (let node = leafOf(across, rayAcrosses[ray] ?? 0) + capacity; node >= 1; node >>= 1) nearest = Math.min(nearest, nearestStartByNode[node] ?? Infinity);
    hits[ray] = isNegated ? -nearest : nearest;
  }
  return hits;
}

function insideBlockerFlagsByScan(blockers: FlatRects, xs: Float64Array, ys: Float64Array): Uint8Array {
  const isInside = new Uint8Array(xs.length);
  for (let point = 0; point < xs.length; point += 1) {
    const x = xs[point] ?? 0;
    const y = ys[point] ?? 0;
    for (let blocker = 0; blocker < blockers.count && isInside[point] === 0; blocker += 1) {
      if ((blockers.lefts[blocker] ?? 0) < x && x < (blockers.rights[blocker] ?? 0) && (blockers.tops[blocker] ?? 0) < y && y < (blockers.bottoms[blocker] ?? 0)) isInside[point] = 1;
    }
  }
  return isInside;
}

function insideBlockerFlags(blockers: FlatRects, xs: Float64Array, ys: Float64Array): Uint8Array {
  if (xs.length * blockers.count <= MAX_RAY_BLOCKER_PAIRS_FOR_SCAN) return insideBlockerFlagsByScan(blockers, xs, ys);
  const isInside = new Uint8Array(xs.length);
  const points = emptyFlatRects(xs.length);
  for (let point = 0; point < xs.length; point += 1) setFlatRect(points, point, xs[point] ?? 0, ys[point] ?? 0, xs[point] ?? 0, ys[point] ?? 0);
  forEachTouchingPairAcross(points, blockers, (point, blocker) => {
    const x = xs[point] ?? 0;
    const y = ys[point] ?? 0;
    const isStrictlyInside = (blockers.lefts[blocker] ?? 0) < x && x < (blockers.rights[blocker] ?? 0) && (blockers.tops[blocker] ?? 0) < y && y < (blockers.bottoms[blocker] ?? 0);
    if (isStrictlyInside) isInside[point] = 1;
  });
  return isInside;
}

interface Origins {
  xs: GrowingNumbers;
  ys: GrowingNumbers;
  awayDirections: GrowingNumbers;
}

function cornerOrigins(rects: readonly Rect[], frame: Frame): Origins {
  const origins: Origins = { xs: growingNumbers(), ys: growingNumbers(), awayDirections: growingNumbers() };
  for (const rect of rects) {
    const left = Math.round(rect.x - CLEARANCE);
    const right = Math.round(rect.x + rect.width + CLEARANCE);
    const top = Math.max(Math.round(rect.y - CLEARANCE), frame.top);
    const bottom = Math.round(rect.y + rect.height + CLEARANCE);
    for (const [x, y, horizontalAway, verticalAway] of [[left, top, LEFT, UP], [right, top, RIGHT, UP], [left, bottom, LEFT, DOWN], [right, bottom, RIGHT, DOWN]] as const) {
      pushNumber(origins.xs, x);
      pushNumber(origins.ys, y);
      pushNumber(origins.awayDirections, horizontalAway * 4 + verticalAway);
    }
  }
  return origins;
}

interface ShotRays {
  rays: Rays[];
  hits: Float64Array[];
}

function shootAll(blockers: FlatRects, rays: Rays[]): ShotRays {
  return { rays, hits: rays.map((directionRays, direction) => firstBlockerHits(blockers, direction, directionRays)) };
}

function clampedHit(hit: number, direction: number, frame: Frame): number {
  if (direction === RIGHT) return Math.min(hit, frame.right);
  if (direction === LEFT) return Math.max(hit, frame.left);
  if (direction === DOWN) return Math.min(hit, frame.bottom);
  return Math.max(hit, frame.top);
}

function midlineBeyond(origin: number, hit: number, direction: number): number | null {
  if (!Number.isFinite(hit)) return null;
  const isForward = direction === RIGHT || direction === DOWN;
  const neighborLine = isForward ? hit + BLOCKING_MARGIN - CLEARANCE : hit - BLOCKING_MARGIN + CLEARANCE;
  if (Math.abs(neighborLine - origin) <= MIDLINE_GAP) return null;
  return Math.round((origin + neighborLine) / 2);
}

function addUnblockedPieces(pieces: Pieces, y: number, left: number, right: number, blockers: FlatRects): void {
  const crossings: [number, number][] = [];
  for (let index = 0; index < blockers.count; index += 1) {
    if ((blockers.tops[index] ?? 0) < y && y < (blockers.bottoms[index] ?? 0)) crossings.push([blockers.lefts[index] ?? 0, blockers.rights[index] ?? 0]);
  }
  crossings.sort((first, second) => first[0] - second[0]);
  let start = left;
  for (const [crossingLeft, crossingRight] of crossings) {
    if (crossingLeft > start) addPiece(pieces, y, start, Math.min(crossingLeft, right));
    start = Math.max(start, crossingRight);
  }
  addPiece(pieces, y, start, right);
}

function portPiecesOf(prepared: PreparedObstacles, ports: readonly GraphPort[]): { horizontal: Pieces; vertical: Pieces } {
  const horizontal = emptyPieces();
  const vertical = emptyPieces();
  const portRays = [emptyRays(), emptyRays(), emptyRays(), emptyRays()];
  const portRayIndexes = ports.map((port) => {
    const isAlongX = port.outwardDirection === RIGHT || port.outwardDirection === LEFT;
    const directionRays = portRays[port.outwardDirection] ?? emptyRays();
    return addRay(directionRays, isAlongX ? port.x : port.y, isAlongX ? port.y : port.x);
  });
  const portShots = shootAll(prepared.blockers, portRays);
  ports.forEach((port, portIndex) => {
    const reach = clampedHit(portShots.hits[port.outwardDirection]?.[portRayIndexes[portIndex] ?? 0] ?? Infinity, port.outwardDirection, prepared.frame);
    if (port.outwardDirection === RIGHT || port.outwardDirection === LEFT) {
      addPiece(horizontal, port.y, Math.min(port.x, reach), Math.max(port.x, reach));
      addPiece(vertical, port.x, port.y, port.y);
      return;
    }
    addPiece(vertical, port.x, Math.min(port.y, reach), Math.max(port.y, reach));
    addPiece(horizontal, port.y, port.x, port.x);
  });
  return { horizontal, vertical };
}

const CORNER_ROW_SIZE = 12;
const FEW_RAYS_SHARE = 4;
const MAX_RAY_BLOCKER_PAIRS_FOR_SCAN = 4096;

interface CornerTable {
  count: number;
  xs: Float64Array;
  ys: Float64Array;
  awayDirections: Float64Array;
  rows: Float64Array;
}

function cornerTableOf(input: ObstacleInput, frame: Frame): CornerTable {
  const origins = cornerOrigins([...input.hardRects, ...input.softRects], frame);
  const count = origins.xs.length;
  return { count, xs: filled(origins.xs), ys: filled(origins.ys), awayDirections: filled(origins.awayDirections), rows: new Float64Array(count * CORNER_ROW_SIZE).fill(Number.NaN) };
}

function setRowPiece(rows: Float64Array, corner: number, slot: number, line: number, start: number, end: number): void {
  const offset = corner * CORNER_ROW_SIZE + slot * 3;
  rows[offset] = line;
  rows[offset + 1] = start;
  rows[offset + 2] = end;
}

function fillCornerRows(table: CornerTable, corners: readonly number[], blockers: FlatRects, frame: Frame): void {
  const xs = Float64Array.from(corners, (corner) => table.xs[corner] ?? 0);
  const ys = Float64Array.from(corners, (corner) => table.ys[corner] ?? 0);
  const isCornerBlocked = insideBlockerFlags(blockers, xs, ys);
  const cornerRays = [emptyRays(), emptyRays(), emptyRays(), emptyRays()];
  const rayByCornerAndDirection = new Int32Array(corners.length * 4).fill(-1);
  for (let index = 0; index < corners.length; index += 1) {
    if (isCornerBlocked[index] === 1) continue;
    const x = xs[index] ?? 0;
    const y = ys[index] ?? 0;
    for (let direction = 0; direction < 4; direction += 1) {
      const directionRays = cornerRays[direction];
      if (!directionRays) continue;
      const isAlongX = direction === RIGHT || direction === LEFT;
      rayByCornerAndDirection[index * 4 + direction] = addRay(directionRays, isAlongX ? x : y, isAlongX ? y : x);
    }
  }
  const cornerShots = shootAll(blockers, cornerRays);
  const hitOf = (shots: ShotRays, direction: number, ray: number) => clampedHit(shots.hits[direction]?.[ray] ?? Infinity, direction, frame);
  const midlineRays = [emptyRays(), emptyRays(), emptyRays(), emptyRays()];
  const verticalMidlines: number[] = [];
  const horizontalMidlines: number[] = [];
  for (let index = 0; index < corners.length; index += 1) {
    const corner = corners[index] ?? 0;
    table.rows.fill(Number.NaN, corner * CORNER_ROW_SIZE, (corner + 1) * CORNER_ROW_SIZE);
    if (isCornerBlocked[index] === 1) continue;
    const x = xs[index] ?? 0;
    const y = ys[index] ?? 0;
    const rayOf = (direction: number) => rayByCornerAndDirection[index * 4 + direction] ?? -1;
    setRowPiece(table.rows, corner, 0, y, hitOf(cornerShots, LEFT, rayOf(LEFT)), hitOf(cornerShots, RIGHT, rayOf(RIGHT)));
    setRowPiece(table.rows, corner, 1, x, hitOf(cornerShots, UP, rayOf(UP)), hitOf(cornerShots, DOWN, rayOf(DOWN)));
    const away = table.awayDirections[corner] ?? 0;
    const horizontalAway = Math.floor(away / 4);
    const verticalAway = away % 4;
    const midlineX = midlineBeyond(x, cornerShots.hits[horizontalAway]?.[rayOf(horizontalAway)] ?? Infinity, horizontalAway);
    if (midlineX !== null) {
      verticalMidlines.push(corner, addRay(midlineRays[UP] ?? emptyRays(), y, midlineX), addRay(midlineRays[DOWN] ?? emptyRays(), y, midlineX), midlineX);
    }
    const midlineY = midlineBeyond(y, cornerShots.hits[verticalAway]?.[rayOf(verticalAway)] ?? Infinity, verticalAway);
    if (midlineY !== null && midlineY >= frame.top) {
      horizontalMidlines.push(corner, addRay(midlineRays[LEFT] ?? emptyRays(), x, midlineY), addRay(midlineRays[RIGHT] ?? emptyRays(), x, midlineY), midlineY);
    }
  }
  const midlineShots = shootAll(blockers, midlineRays);
  for (let index = 0; index < verticalMidlines.length; index += 4) {
    setRowPiece(table.rows, verticalMidlines[index] ?? 0, 2, verticalMidlines[index + 3] ?? 0, hitOf(midlineShots, UP, verticalMidlines[index + 1] ?? 0), hitOf(midlineShots, DOWN, verticalMidlines[index + 2] ?? 0));
  }
  for (let index = 0; index < horizontalMidlines.length; index += 4) {
    setRowPiece(table.rows, horizontalMidlines[index] ?? 0, 3, horizontalMidlines[index + 3] ?? 0, hitOf(midlineShots, LEFT, horizontalMidlines[index + 1] ?? 0), hitOf(midlineShots, RIGHT, horizontalMidlines[index + 2] ?? 0));
  }
}

function piecesOfTable(table: CornerTable, frame: Frame, blockers: FlatRects): { horizontal: Pieces; vertical: Pieces } {
  const horizontal = emptyPieces();
  const vertical = emptyPieces();
  const slotPieces = [horizontal, vertical, vertical, horizontal];
  for (let corner = 0; corner < table.count; corner += 1) {
    for (let slot = 0; slot < 4; slot += 1) {
      const offset = corner * CORNER_ROW_SIZE + slot * 3;
      const line = table.rows[offset] ?? Number.NaN;
      const slotTarget = slotPieces[slot];
      if (Number.isNaN(line) || !slotTarget) continue;
      addPiece(slotTarget, line, table.rows[offset + 1] ?? 0, table.rows[offset + 2] ?? 0);
    }
  }
  addUnblockedPieces(horizontal, frame.top, frame.left, frame.right, blockers);
  addPiece(horizontal, frame.bottom, frame.left, frame.right);
  addPiece(vertical, frame.left, frame.top, frame.bottom);
  addPiece(vertical, frame.right, frame.top, frame.bottom);
  return { horizontal, vertical };
}

function isPieceBefore(first: MergedPieces, firstIndex: number, second: MergedPieces, secondIndex: number): boolean {
  const firstLine = first.lines[firstIndex] ?? 0;
  const secondLine = second.lines[secondIndex] ?? 0;
  return firstLine < secondLine || (firstLine === secondLine && (first.starts[firstIndex] ?? 0) <= (second.starts[secondIndex] ?? 0));
}

function mergedTogether(base: MergedPieces, extra: MergedPieces): MergedPieces {
  if (extra.count === 0) return base;
  const capacity = base.count + extra.count;
  const merged = { lines: new Float64Array(capacity), starts: new Float64Array(capacity), ends: new Float64Array(capacity) };
  let count = 0;
  let nextBase = 0;
  let nextExtra = 0;
  while (nextBase < base.count || nextExtra < extra.count) {
    const takesBase = nextExtra >= extra.count || (nextBase < base.count && isPieceBefore(base, nextBase, extra, nextExtra));
    const source = takesBase ? base : extra;
    const piece = takesBase ? nextBase : nextExtra;
    if (takesBase) nextBase += 1;
    if (!takesBase) nextExtra += 1;
    const line = source.lines[piece] ?? 0;
    const start = source.starts[piece] ?? 0;
    const end = source.ends[piece] ?? 0;
    const last = count - 1;
    if (count > 0 && merged.lines[last] === line && start <= (merged.ends[last] ?? 0)) {
      merged.ends[last] = Math.max(merged.ends[last] ?? 0, end);
      continue;
    }
    merged.lines[count] = line;
    merged.starts[count] = start;
    merged.ends[count] = end;
    count += 1;
  }
  return { count, lines: merged.lines.subarray(0, count), starts: merged.starts.subarray(0, count), ends: merged.ends.subarray(0, count) };
}

function mergedPieces(pieces: Pieces): MergedPieces {
  const lines = filled(pieces.lines);
  const starts = filled(pieces.starts);
  const ends = filled(pieces.ends);
  const order = new Int32Array(lines.length);
  for (let index = 0; index < order.length; index += 1) order[index] = index;
  order.sort((first, second) => (lines[first] ?? 0) - (lines[second] ?? 0) || (starts[first] ?? 0) - (starts[second] ?? 0));
  const merged = { lines: new Float64Array(lines.length), starts: new Float64Array(lines.length), ends: new Float64Array(lines.length) };
  let count = 0;
  for (const piece of order) {
    const line = lines[piece] ?? 0;
    const start = starts[piece] ?? 0;
    const end = ends[piece] ?? 0;
    const last = count - 1;
    if (count > 0 && merged.lines[last] === line && start <= (merged.ends[last] ?? 0)) {
      merged.ends[last] = Math.max(merged.ends[last] ?? 0, end);
      continue;
    }
    merged.lines[count] = line;
    merged.starts[count] = start;
    merged.ends[count] = end;
    count += 1;
  }
  return { count, lines: merged.lines.subarray(0, count), starts: merged.starts.subarray(0, count), ends: merged.ends.subarray(0, count) };
}

function firstIndexAtLeast(values: Float64Array, first: number, end: number, value: number): number {
  let low = first;
  let high = end;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((values[middle] ?? 0) < value) {
      low = middle + 1;
      continue;
    }
    high = middle;
  }
  return low;
}

function firstIndexAbove(values: Float64Array, first: number, end: number, value: number): number {
  let low = first;
  let high = end;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((values[middle] ?? 0) <= value) {
      low = middle + 1;
      continue;
    }
    high = middle;
  }
  return low;
}

function forEachCoveringNode(capacity: number, firstLeaf: number, lastLeaf: number, onNode: (node: number) => void): void {
  let low = firstLeaf + capacity;
  let high = lastLeaf + capacity + 1;
  while (low < high) {
    if (low & 1) {
      onNode(low);
      low += 1;
    }
    if (high & 1) {
      high -= 1;
      onNode(high);
    }
    low >>= 1;
    high >>= 1;
  }
}

function prefixSums(counts: Int32Array): Int32Array {
  for (let index = 1; index < counts.length; index += 1) counts[index] = (counts[index] ?? 0) + (counts[index - 1] ?? 0);
  return counts;
}

function distinctLinesOf(pieces: MergedPieces): Float64Array {
  return distinctSorted(Float64Array.from(pieces.lines));
}

function lineIndexOf(pieces: MergedPieces, acrossValues: Float64Array): LineIndex {
  const capacity = leafCapacityOf(Math.max(acrossValues.length, 1));
  const firstLeaves = new Int32Array(pieces.count);
  const lastLeaves = new Int32Array(pieces.count);
  const offsets = new Int32Array(capacity * 2 + 1);
  for (let piece = 0; piece < pieces.count; piece += 1) {
    firstLeaves[piece] = firstIndexAtLeast(acrossValues, 0, acrossValues.length, pieces.starts[piece] ?? 0);
    lastLeaves[piece] = firstIndexAbove(acrossValues, 0, acrossValues.length, pieces.ends[piece] ?? 0) - 1;
    forEachCoveringNode(capacity, firstLeaves[piece] ?? 0, lastLeaves[piece] ?? -1, (node) => {
      offsets[node + 1] = (offsets[node + 1] ?? 0) + 1;
    });
  }
  prefixSums(offsets);
  const cursors = offsets.slice();
  const total = offsets[capacity * 2] ?? 0;
  const lines = new Float64Array(total);
  const pieceIds = new Int32Array(total);
  for (let piece = 0; piece < pieces.count; piece += 1) {
    forEachCoveringNode(capacity, firstLeaves[piece] ?? 0, lastLeaves[piece] ?? -1, (node) => {
      const position = cursors[node] ?? 0;
      lines[position] = pieces.lines[piece] ?? 0;
      pieceIds[position] = piece;
      cursors[node] = position + 1;
    });
  }
  return { acrossValues, capacity, offsets, lines, pieces: pieceIds };
}

function nearestPieceAlong(index: LineIndex, across: number, from: number, isForward: boolean): number {
  const leaf = firstIndexAtLeast(index.acrossValues, 0, index.acrossValues.length, across);
  if (index.acrossValues[leaf] !== across) return -1;
  let nearestPiece = -1;
  let nearestLine = isForward ? Infinity : -Infinity;
  for (let node = leaf + index.capacity; node >= 1; node >>= 1) {
    const first = index.offsets[node] ?? 0;
    const end = index.offsets[node + 1] ?? 0;
    const position = isForward ? firstIndexAbove(index.lines, first, end, from) : firstIndexAtLeast(index.lines, first, end, from) - 1;
    if (position < first || position >= end) continue;
    const line = index.lines[position] ?? 0;
    const isNearer = isForward ? line < nearestLine : line > nearestLine;
    if (!isNearer) continue;
    nearestLine = line;
    nearestPiece = index.pieces[position] ?? -1;
  }
  return nearestPiece;
}

function softIndexOf(softRects: readonly Rect[], isAlongX: boolean): SoftIndex {
  const acrossLows = Float64Array.from(softRects, (rect) => (isAlongX ? rect.y : rect.x));
  const acrossHighs = Float64Array.from(softRects, (rect) => (isAlongX ? rect.y + rect.height : rect.x + rect.width));
  const alongLows = Float64Array.from(softRects, (rect) => (isAlongX ? rect.x : rect.y));
  const alongHighs = Float64Array.from(softRects, (rect) => (isAlongX ? rect.x + rect.width : rect.y + rect.height));
  const boundaryValues = new Float64Array(softRects.length * 2);
  boundaryValues.set(acrossLows, 0);
  boundaryValues.set(acrossHighs, softRects.length);
  const boundaries = distinctSorted(boundaryValues);
  const capacity = leafCapacityOf(Math.max(boundaries.length * 2 - 1, 1));
  const leafRangeOf = (rect: number): [number, number] => [
    firstIndexAtLeast(boundaries, 0, boundaries.length, acrossLows[rect] ?? 0) * 2 + 1,
    firstIndexAtLeast(boundaries, 0, boundaries.length, acrossHighs[rect] ?? 0) * 2 - 1,
  ];
  const offsets = new Int32Array(capacity * 2 + 1);
  const rectsByAlongLow = Int32Array.from(softRects.keys()).sort((first, second) => (alongLows[first] ?? 0) - (alongLows[second] ?? 0));
  for (const rect of rectsByAlongLow) {
    const [firstLeaf, lastLeaf] = leafRangeOf(rect);
    forEachCoveringNode(capacity, firstLeaf, lastLeaf, (node) => {
      offsets[node + 1] = (offsets[node + 1] ?? 0) + 1;
    });
  }
  prefixSums(offsets);
  const cursors = offsets.slice();
  const total = offsets[capacity * 2] ?? 0;
  const sortedAlongLows = new Float64Array(total);
  const reachMaxima = new Float64Array(total);
  for (const rect of rectsByAlongLow) {
    const [firstLeaf, lastLeaf] = leafRangeOf(rect);
    forEachCoveringNode(capacity, firstLeaf, lastLeaf, (node) => {
      const position = cursors[node] ?? 0;
      const isNodeStart = position === (offsets[node] ?? 0);
      sortedAlongLows[position] = alongLows[rect] ?? 0;
      reachMaxima[position] = isNodeStart ? alongHighs[rect] ?? 0 : Math.max(reachMaxima[position - 1] ?? 0, alongHighs[rect] ?? 0);
      cursors[node] = position + 1;
    });
  }
  return { boundaries, capacity, offsets, alongLows: sortedAlongLows, reachMaxima };
}

function softLeafOf(boundaries: Float64Array, across: number): number {
  const position = firstIndexAtLeast(boundaries, 0, boundaries.length, across);
  if (boundaries[position] === across) return position * 2;
  if (position === 0 || position === boundaries.length) return -1;
  return position * 2 - 1;
}

function crossesSoftRect(index: SoftIndex, across: number, alongLow: number, alongHigh: number): boolean {
  const leaf = softLeafOf(index.boundaries, across);
  if (leaf < 0) return false;
  for (let node = leaf + index.capacity; node >= 1; node >>= 1) {
    const first = index.offsets[node] ?? 0;
    const end = firstIndexAtLeast(index.alongLows, first, index.offsets[node + 1] ?? 0, alongHigh);
    if (end > first && (index.reachMaxima[end - 1] ?? 0) > alongLow) return true;
  }
  return false;
}

function pieceComponents(horizontal: MergedPieces, vertical: MergedPieces): Int32Array {
  const parents = Int32Array.from({ length: horizontal.count + vertical.count }, (_, piece) => piece);
  const rootOf = (piece: number) => {
    let current = piece;
    while (parents[current] !== current) {
      const grandparent = parents[parents[current] ?? current] ?? current;
      parents[current] = grandparent;
      current = grandparent;
    }
    return current;
  };
  const join = (first: number, second: number) => {
    parents[rootOf(first)] = rootOf(second);
  };
  const lineValues = distinctLinesOf(horizontal);
  const capacity = leafCapacityOf(Math.max(lineValues.length, 1));
  const activeCounts = new Int32Array(capacity * 2);
  const representatives = new Int32Array(capacity * 2).fill(-1);
  const leafOfHorizontal = (piece: number) => firstIndexAtLeast(lineValues, 0, lineValues.length, horizontal.lines[piece] ?? 0) + capacity;
  const open = (piece: number) => {
    const leaf = leafOfHorizontal(piece);
    activeCounts[leaf] = 1;
    representatives[leaf] = piece;
    for (let node = leaf >> 1; node >= 1; node >>= 1) {
      activeCounts[node] = (activeCounts[node] ?? 0) + 1;
      representatives[node] = -1;
    }
  };
  const close = (piece: number) => {
    const leaf = leafOfHorizontal(piece);
    activeCounts[leaf] = 0;
    for (let node = leaf >> 1; node >= 1; node >>= 1) activeCounts[node] = (activeCounts[node] ?? 0) - 1;
  };
  const connect = (node: number, nodeFirst: number, nodeLast: number, first: number, last: number, piece: number): void => {
    if ((activeCounts[node] ?? 0) === 0 || nodeLast < first || nodeFirst > last) return;
    const isInside = first <= nodeFirst && nodeLast <= last;
    const representative = representatives[node] ?? -1;
    if (isInside && representative >= 0) {
      join(representative, piece);
      return;
    }
    const middle = (nodeFirst + nodeLast) >> 1;
    connect(node * 2, nodeFirst, middle, first, last, piece);
    connect(node * 2 + 1, middle + 1, nodeLast, first, last, piece);
    if (isInside) representatives[node] = piece;
  };
  const openingOrder = Int32Array.from({ length: horizontal.count }, (_, piece) => piece).sort((first, second) => (horizontal.starts[first] ?? 0) - (horizontal.starts[second] ?? 0));
  const closingOrder = Int32Array.from({ length: horizontal.count }, (_, piece) => piece).sort((first, second) => (horizontal.ends[first] ?? 0) - (horizontal.ends[second] ?? 0));
  let nextOpening = 0;
  let nextClosing = 0;
  for (let piece = 0; piece < vertical.count; piece += 1) {
    const x = vertical.lines[piece] ?? 0;
    for (;;) {
      const opening = openingOrder[nextOpening] ?? -1;
      const closing = closingOrder[nextClosing] ?? -1;
      const openingStart = opening >= 0 ? horizontal.starts[opening] ?? 0 : Infinity;
      const closingEnd = closing >= 0 ? horizontal.ends[closing] ?? 0 : Infinity;
      if (closingEnd < x && closingEnd < openingStart) {
        close(closing);
        nextClosing += 1;
        continue;
      }
      if (openingStart > x) break;
      open(opening);
      nextOpening += 1;
    }
    const firstLeaf = firstIndexAtLeast(lineValues, 0, lineValues.length, vertical.starts[piece] ?? 0);
    const lastLeaf = firstIndexAbove(lineValues, 0, lineValues.length, vertical.ends[piece] ?? 0) - 1;
    connect(1, 0, capacity - 1, firstLeaf, lastLeaf, horizontal.count + piece);
  }
  return Int32Array.from(parents.keys(), (piece) => rootOf(piece));
}

function pieceAt(pieces: MergedPieces, line: number, along: number): number {
  let low = 0;
  let high = pieces.count;
  while (low < high) {
    const middle = (low + high) >> 1;
    const middleLine = pieces.lines[middle] ?? 0;
    const isAtOrBefore = middleLine < line || (middleLine === line && (pieces.starts[middle] ?? 0) <= along);
    if (isAtOrBefore) {
      low = middle + 1;
      continue;
    }
    high = middle;
  }
  const piece = low - 1;
  if (piece < 0 || pieces.lines[piece] !== line || (pieces.ends[piece] ?? 0) < along) return -1;
  return piece;
}

function emptyNodeStore(capacity: number): NodeStore {
  return { horizontalPieces: new Int32Array(capacity), verticalPieces: new Int32Array(capacity), neighbors: new Int32Array(capacity * 4).fill(UNKNOWN_NEIGHBOR), softSteps: new Uint8Array(capacity * 4) };
}

function grownNodes(graph: VisibilityGraph, nodes: NodeStore): NodeStore {
  const capacity = graph.xs.length * 2;
  const grown = emptyNodeStore(capacity);
  grown.horizontalPieces.set(nodes.horizontalPieces);
  grown.verticalPieces.set(nodes.verticalPieces);
  grown.neighbors.set(nodes.neighbors);
  grown.softSteps.set(nodes.softSteps);
  const xs = new Float64Array(capacity);
  const ys = new Float64Array(capacity);
  xs.set(graph.xs);
  ys.set(graph.ys);
  graph.xs = xs;
  graph.ys = ys;
  return grown;
}

function nodeSlotOf(horizontalPiece: number, verticalPiece: number, slotMask: number): number {
  let mixed = Math.imul(horizontalPiece, 0x9e3779b1) ^ Math.imul(verticalPiece, 0x85ebca6b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  return (mixed ^ (mixed >>> 15)) & slotMask;
}

function preparedFor(input: ObstacleInput, ports: readonly GraphPort[]): PreparedObstacles | null {
  const frame = frameOf(input, ports);
  if (!frame) return null;
  const blockers = blockingRectsOf(input.hardRects);
  const corners = cornerTableOf(input, frame);
  fillCornerRows(corners, Array.from({ length: corners.count }, (_, corner) => corner), blockers, frame);
  return preparedOf(input, frame, blockers, corners);
}

function preparedOf(input: ObstacleInput, frame: Frame, blockers: FlatRects, corners: CornerTable): PreparedObstacles {
  const pieces = piecesOfTable(corners, frame, blockers);
  return { input, frame, blockers, corners, horizontal: mergedPieces(pieces.horizontal), vertical: mergedPieces(pieces.vertical), softAlongX: softIndexOf(input.softRects, true), softAlongY: softIndexOf(input.softRects, false) };
}

function prepareObstacles(input: ObstacleInput): PreparedObstacles | null {
  return preparedFor(input, []);
}

function isSameFrame(first: Frame, second: Frame): boolean {
  return first.left === second.left && first.top === second.top && first.right === second.right && first.bottom === second.bottom;
}

function buildGraphOn(givenPrepared: PreparedObstacles, ports: readonly GraphPort[]): VisibilityGraph | null {
  const portFrame = frameOf(givenPrepared.input, ports);
  const prepared = portFrame && !isSameFrame(portFrame, givenPrepared.frame) ? preparedFor(givenPrepared.input, ports) : givenPrepared;
  if (!prepared) return null;
  const { softAlongX, softAlongY } = prepared;
  const portPieces = portPiecesOf(prepared, ports);
  const horizontal = mergedTogether(prepared.horizontal, mergedPieces(portPieces.horizontal));
  const vertical = mergedTogether(prepared.vertical, mergedPieces(portPieces.vertical));
  const verticalIndex = lineIndexOf(vertical, distinctLinesOf(horizontal));
  const horizontalIndex = lineIndexOf(horizontal, distinctLinesOf(vertical));
  const componentOfPiece = pieceComponents(horizontal, vertical);
  let nodes = emptyNodeStore(INITIAL_NODE_CAPACITY);
  let nodeBySlot = new Int32Array(INITIAL_NODE_CAPACITY * 2).fill(EMPTY_NODE_SLOT);
  const slotOfPieces = (horizontalPiece: number, verticalPiece: number) => {
    const slotMask = nodeBySlot.length - 1;
    for (let slot = nodeSlotOf(horizontalPiece, verticalPiece, slotMask); ; slot = (slot + 1) & slotMask) {
      const node = nodeBySlot[slot] ?? EMPTY_NODE_SLOT;
      if (node === EMPTY_NODE_SLOT || (nodes.horizontalPieces[node] === horizontalPiece && nodes.verticalPieces[node] === verticalPiece)) return slot;
    }
  };
  const growNodeSlots = () => {
    nodeBySlot = new Int32Array(nodeBySlot.length * 2).fill(EMPTY_NODE_SLOT);
    for (let node = 0; node < graph.nodeCount; node += 1) nodeBySlot[slotOfPieces(nodes.horizontalPieces[node] ?? 0, nodes.verticalPieces[node] ?? 0)] = node;
  };
  const nodeOf = (horizontalPiece: number, verticalPiece: number) => {
    const known = nodeBySlot[slotOfPieces(horizontalPiece, verticalPiece)] ?? EMPTY_NODE_SLOT;
    if (known !== EMPTY_NODE_SLOT) return known;
    const node = graph.nodeCount;
    if (node === graph.xs.length) nodes = grownNodes(graph, nodes);
    if ((node + 1) * 2 > nodeBySlot.length) growNodeSlots();
    graph.xs[node] = vertical.lines[verticalPiece] ?? 0;
    graph.ys[node] = horizontal.lines[horizontalPiece] ?? 0;
    nodes.horizontalPieces[node] = horizontalPiece;
    nodes.verticalPieces[node] = verticalPiece;
    nodeBySlot[slotOfPieces(horizontalPiece, verticalPiece)] = node;
    graph.nodeCount += 1;
    return node;
  };
  const nextNodeAlong = (node: number, direction: number) => {
    const isForward = direction === RIGHT || direction === DOWN;
    const x = graph.xs[node] ?? 0;
    const y = graph.ys[node] ?? 0;
    if (direction === RIGHT || direction === LEFT) {
      const horizontalPiece = nodes.horizontalPieces[node] ?? 0;
      const verticalPiece = nearestPieceAlong(verticalIndex, y, x, isForward);
      const nextX = vertical.lines[verticalPiece] ?? NaN;
      if (verticalPiece < 0 || nextX < (horizontal.starts[horizontalPiece] ?? 0) || nextX > (horizontal.ends[horizontalPiece] ?? 0)) return -1;
      return nodeOf(horizontalPiece, verticalPiece);
    }
    const verticalPiece = nodes.verticalPieces[node] ?? 0;
    const horizontalPiece = nearestPieceAlong(horizontalIndex, x, y, isForward);
    const nextY = horizontal.lines[horizontalPiece] ?? NaN;
    if (horizontalPiece < 0 || nextY < (vertical.starts[verticalPiece] ?? 0) || nextY > (vertical.ends[verticalPiece] ?? 0)) return -1;
    return nodeOf(horizontalPiece, verticalPiece);
  };
  const neighborOf = (node: number, direction: number) => {
    const known = nodes.neighbors[node * 4 + direction] ?? UNKNOWN_NEIGHBOR;
    if (known !== UNKNOWN_NEIGHBOR) return known;
    const next = nextNodeAlong(node, direction);
    nodes.neighbors[node * 4 + direction] = next;
    if (next >= 0) nodes.neighbors[next * 4 + (direction ^ 1)] = node;
    return next;
  };
  const isSoftStep = (node: number, direction: number) => {
    const known = nodes.softSteps[node * 4 + direction] ?? 0;
    if (known !== 0) return known === SOFT_STEP;
    const next = neighborOf(node, direction);
    const isAlongX = direction === RIGHT || direction === LEFT;
    const [across, from, to] = isAlongX ? [graph.ys[node] ?? 0, graph.xs[node] ?? 0, graph.xs[next] ?? 0] : [graph.xs[node] ?? 0, graph.ys[node] ?? 0, graph.ys[next] ?? 0];
    const isSoft = next >= 0 && crossesSoftRect(isAlongX ? softAlongX : softAlongY, across, Math.min(from, to), Math.max(from, to));
    const marker = isSoft ? SOFT_STEP : CLEAR_STEP;
    nodes.softSteps[node * 4 + direction] = marker;
    if (next >= 0) nodes.softSteps[next * 4 + (direction ^ 1)] = marker;
    return isSoft;
  };
  const nodeAt = (x: number, y: number) => {
    const horizontalPiece = pieceAt(horizontal, y, x);
    const verticalPiece = pieceAt(vertical, x, y);
    return horizontalPiece < 0 || verticalPiece < 0 ? -1 : nodeOf(horizontalPiece, verticalPiece);
  };
  const componentOf = (node: number) => componentOfPiece[nodes.horizontalPieces[node] ?? 0] ?? -1;
  const cachedNodeBudget = (horizontal.count + vertical.count) * CACHED_NODES_PER_PIECE;
  const beginSearch = () => {
    if (graph.nodeCount <= cachedNodeBudget) return;
    nodeBySlot.fill(EMPTY_NODE_SLOT);
    nodes.neighbors.fill(UNKNOWN_NEIGHBOR, 0, graph.nodeCount * 4);
    nodes.softSteps.fill(0, 0, graph.nodeCount * 4);
    graph.nodeCount = 0;
  };
  const pieceExtentOf = (node: number, isAlongX: boolean): [number, number] => {
    const pieces = isAlongX ? horizontal : vertical;
    const piece = (isAlongX ? nodes.horizontalPieces[node] : nodes.verticalPieces[node]) ?? 0;
    return [pieces.starts[piece] ?? 0, pieces.ends[piece] ?? 0];
  };
  const graph: VisibilityGraph = { nodeCount: 0, xs: new Float64Array(INITIAL_NODE_CAPACITY), ys: new Float64Array(INITIAL_NODE_CAPACITY), neighborOf, isSoftStep, nodeAt, componentOf, beginSearch, pieceExtentOf };
  return graph;
}

export { buildGraphOn, CLEARANCE, prepareObstacles };
export type { GraphPort, VisibilityGraph };
