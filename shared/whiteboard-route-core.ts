import { WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Wire } from './contracts/whiteboard.ts';
import type { LaidOutBox, LaidOutPanel, LaidOutWire, Rect } from './whiteboard-layout-core.ts';
import { emptyFlatRects, flatRectsOf, forEachTouchingPairAcross, forEachTouchingPairWithin, pairsInOrder, setFlatRect } from './whiteboard-sweep-core.ts';
import type { FlatRects } from './whiteboard-sweep-core.ts';
import { nudgeSharedLines } from './whiteboard-nudge-core.ts';
import { buildVisibilityGraph, CLEARANCE } from './whiteboard-visibility-core.ts';
import type { VisibilityGraph } from './whiteboard-visibility-core.ts';

type Side = 'left' | 'right' | 'top' | 'bottom';

interface Point {
  x: number;
  y: number;
}

interface Segment {
  from: Point;
  to: Point;
}

const BEND_COST = 30;
const SOFT_OBSTACLE_COST = 300;
const BACK_INTERIOR_COST = 400;
const DEEPER_FIRST = 1e-9;
const MAX_BENDS = 6;
const MAX_WIRES_FOR_PORT_SEARCH = 12;
const PROBE_EXPANSIONS = 3_000;
const INITIAL_STATE_CAPACITY = 4096;
const PORT_SPACING = 14;
const PORT_INSET = 8;
const BOX_CROSSING_COST = 100;
const LABEL_CHAR_WIDTH = 6.6;
const LABEL_GAP = 5;
const LABEL_ASCENT = 10;
const LABEL_DESCENT = 3;
const LABEL_CLEARANCE = 2;
const LABEL_SLIDE_FRACTIONS = [0.5, 0.35, 0.65, 0.2, 0.8];

const STEP_BY_DIRECTION = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }] as const;
const OUTWARD_DIRECTION_BY_SIDE: Record<Side, number> = { right: 0, left: 1, bottom: 2, top: 3 };
const INWARD_DIRECTION_BY_SIDE: Record<Side, number> = { left: 0, right: 1, top: 2, bottom: 3 };
const REVERSE_DIRECTION = [1, 0, 3, 2];

interface RouteInput {
  wires: readonly Wire[];
  boxesById: ReadonlyMap<string, LaidOutBox>;
  panels: readonly LaidOutPanel[];
  softObstacles: readonly Rect[];
  loopFrames: readonly Rect[];
  contentTop: number;
}

interface RouteResult {
  wires: LaidOutWire[];
  segments: Segment[];
  collectWarnings: () => string[];
  extent: Rect | null;
}

interface WirePlan {
  wire: Wire;
  from: LaidOutBox;
  to: LaidOutBox;
  styleKey: string;
  strokeHex: string | null;
  exitSide: Side;
  entrySide: Side;
  busKey: string | null;
  exitKey: string;
  outputPort: Point | null;
  start: Point;
  end: Point;
}

interface DrawnWire {
  plan: WirePlan;
  points: Point[];
  segments: Segment[];
  states: number[] | null;
}

interface MinHeap {
  states: Int32Array;
  priorities: Float64Array;
  size: number;
  lastPoppedPriority: number;
}

interface SearchBuffers {
  bestCost: Float64Array;
  cameFrom: Int32Array;
  touchedStates: number[];
  heap: MinHeap;
}

function isSideways(side: Side): boolean {
  return side === 'left' || side === 'right';
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function inflated(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

function unionOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function rectsTouch(first: Rect, second: Rect): boolean {
  return first.x <= second.x + second.width && second.x <= first.x + first.width && first.y <= second.y + second.height && second.y <= first.y + first.height;
}

function pointBoundsOf(points: readonly Point[]): Rect {
  return unionOf(points.map((point) => ({ ...point, width: 0, height: 0 }))) ?? { x: 0, y: 0, width: 0, height: 0 };
}

function groupedBy<Item, Key>(items: readonly Item[], keyOf: (item: Item) => Key): Map<Key, Item[]> {
  const groups = new Map<Key, Item[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
      continue;
    }
    groups.set(key, [item]);
  }
  return groups;
}

function isHorizontal(segment: Segment): boolean {
  return segment.from.y === segment.to.y;
}

function segmentHitsRect(segment: Segment, rect: Rect): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (isHorizontal(segment)) {
    const y = segment.from.y;
    return rect.y < y && y < bottom && Math.min(segment.from.x, segment.to.x) < right && Math.max(segment.from.x, segment.to.x) > rect.x;
  }
  const x = segment.from.x;
  return rect.x < x && x < right && Math.min(segment.from.y, segment.to.y) < bottom && Math.max(segment.from.y, segment.to.y) > rect.y;
}

function rectsOverlap(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height;
}

function withoutBends(points: readonly Point[]): Point[] {
  const distinct = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
  return distinct.filter((point, index) => {
    const previous = distinct[index - 1];
    const next = distinct[index + 1];
    if (!previous || !next) return true;
    return !((previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y));
  });
}

function segmentsOf(points: readonly Point[]): Segment[] {
  return points.slice(1).flatMap((point, index) => {
    const previous = points[index];
    return previous ? [{ from: previous, to: point }] : [];
  });
}

function pathOf(points: readonly Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function cappedWarnings(warnings: readonly string[]): string[] {
  if (warnings.length <= WHITEBOARD_LIMITS.layoutWarnings) return [...warnings];
  const shown = warnings.slice(0, WHITEBOARD_LIMITS.layoutWarnings - 1);
  return [...shown, `and ${warnings.length - shown.length} more`];
}

function hasHorizontalGap(first: Rect, second: Rect): boolean {
  return second.x >= first.x + first.width || second.x + second.width <= first.x;
}

interface SidePair {
  exitSide: Side;
  entrySide: Side;
}

function facingSides(from: LaidOutBox, to: LaidOutBox, isBack: boolean): SidePair {
  if (from.id === to.id) return { exitSide: 'right', entrySide: 'top' };
  if (isBack) return { exitSide: 'bottom', entrySide: 'bottom' };
  const fromCenter = centerOf(from);
  const toCenter = centerOf(to);
  if (hasHorizontalGap(from, to)) return toCenter.x > fromCenter.x ? { exitSide: 'right', entrySide: 'left' } : { exitSide: 'left', entrySide: 'right' };
  return toCenter.y > fromCenter.y ? { exitSide: 'bottom', entrySide: 'top' } : { exitSide: 'top', entrySide: 'bottom' };
}

const ALL_SIDES: readonly Side[] = ['right', 'left', 'bottom', 'top'];

function candidateSidePairs(plan: WirePlan, facing: SidePair): SidePair[] {
  const { wire, from, to } = plan;
  if (wire.back || from.id === to.id) return [facing];
  const exitSides = plan.outputPort || wire.fromSide ? [plan.exitSide] : [facing.exitSide, ...ALL_SIDES.filter((side) => side !== facing.exitSide)];
  const entrySides = wire.toSide ? [wire.toSide] : [facing.entrySide, ...ALL_SIDES.filter((side) => side !== facing.entrySide)];
  return exitSides.flatMap((exitSide) => entrySides.map((entrySide) => ({ exitSide, entrySide })));
}

function probeOf(plan: WirePlan, pair: SidePair): WirePlan {
  const centeredStart = plan.outputPort ?? portPositions(plan.from, pair.exitSide, 1)[0] ?? centerOf(plan.from);
  const centeredEnd = portPositions(plan.to, pair.entrySide, 1)[0] ?? centerOf(plan.to);
  if (!isFacing(pair.exitSide, pair.entrySide)) return { ...plan, ...pair, start: centeredStart, end: centeredEnd };
  const alignedEnd = alignedAlong(centeredEnd, pair.entrySide, plan.to, centeredStart);
  const start = alignedEnd === centeredEnd && !plan.outputPort ? alignedAlong(centeredStart, pair.exitSide, plan.from, centeredEnd) : centeredStart;
  return { ...plan, ...pair, start, end: alignedEnd };
}

interface ProbeScore {
  turnsAndCrossings: number;
  cost: number;
}

interface ProbedRoute {
  segments: Segment[];
  bounds: Rect;
  bends: number;
  cost: number;
}

function isBetterProbe(candidate: ProbeScore, best: ProbeScore): boolean {
  return candidate.turnsAndCrossings < best.turnsAndCrossings || (candidate.turnsAndCrossings === best.turnsAndCrossings && candidate.cost < best.cost);
}

function pointsOfStates(graph: VisibilityGraph, states: readonly number[]): Point[] {
  return withoutBends(states.map((state) => ({ x: graph.xs[state >> 2] ?? 0, y: graph.ys[state >> 2] ?? 0 })));
}

function probeRoute(graph: VisibilityGraph, probe: WirePlan, buffers: SearchBuffers): ProbedRoute | null {
  const states = searchGraph(graph, probe, null, buffers, PROBE_EXPANSIONS);
  const goalState = states?.at(-1);
  const cost = goalState === undefined ? Infinity : buffers.bestCost[goalState] ?? Infinity;
  resetSearchBuffers(buffers);
  if (!states || cost === Infinity) return null;
  const points = pointsOfStates(graph, states);
  return { segments: segmentsOf(points), bounds: pointBoundsOf(points), bends: Math.max(points.length - 2, 0), cost };
}

function scoreOf(route: ProbedRoute, otherRoutes: readonly ProbedRoute[]): ProbeScore {
  const crossings = otherRoutes.filter((other) => rectsTouch(route.bounds, other.bounds) && other.segments.some((otherSegment) => route.segments.some((segment) => segmentsCross(segment, otherSegment)))).length;
  return { turnsAndCrossings: route.bends + crossings, cost: route.cost };
}

function chooseSidesBySearch(plans: readonly WirePlan[], facingByPlan: ReadonlyMap<WirePlan, SidePair>, input: RouteInput): void {
  const pairsByPlan = new Map(plans.map((plan) => {
    const facing = facingByPlan.get(plan) ?? { exitSide: plan.exitSide, entrySide: plan.entrySide };
    return [plan, candidateSidePairs(plan, facing)] as const;
  }));
  if (![...pairsByPlan.values()].some((pairs) => pairs.length > 1)) return;
  const probes = [...pairsByPlan].flatMap(([plan, pairs]) => pairs.map((pair) => probeOf(plan, pair)));
  const graph = graphOf(probes, input);
  if (!graph) return;
  const buffers = createSearchBuffers();
  const baselineByPlan = new Map(plans.flatMap((plan) => {
    const [facing] = pairsByPlan.get(plan) ?? [];
    const route = facing ? probeRoute(graph, probeOf(plan, facing), buffers) : null;
    return route ? [[plan, route] as const] : [];
  }));
  for (const [plan, pairs] of pairsByPlan) {
    const baseline = baselineByPlan.get(plan);
    if (pairs.length < 2 || !baseline) continue;
    const otherRoutes = [...baselineByPlan].flatMap(([other, route]) => other === plan ? [] : [route]);
    let best = { pair: pairs[0], score: scoreOf(baseline, otherRoutes) };
    for (const pair of pairs.slice(1)) {
      const route = probeRoute(graph, probeOf(plan, pair), buffers);
      const score = route ? scoreOf(route, otherRoutes) : null;
      if (score && isBetterProbe(score, best.score)) best = { pair, score };
    }
    if (!best.pair) continue;
    plan.exitSide = best.pair.exitSide;
    plan.entrySide = best.pair.entrySide;
  }
}

function joinFacingBuses(plans: readonly WirePlan[], facingByPlan: ReadonlyMap<WirePlan, SidePair>): void {
  const isEnteringFacing = (plan: WirePlan) => plan.entrySide === facingByPlan.get(plan)?.entrySide;
  for (let hasChanged = true; hasChanged;) {
    hasChanged = false;
    for (const plan of plans) {
      const facing = facingByPlan.get(plan);
      if (!facing || isEnteringFacing(plan) || plan.wire.toSide) continue;
      const isFacingBusTaken = plans.some((other) => other !== plan && other.to.id === plan.to.id && other.styleKey === plan.styleKey && other.entrySide === facing.entrySide && isEnteringFacing(other));
      if (!isFacingBusTaken) continue;
      plan.exitSide = plan.outputPort || plan.wire.fromSide ? plan.exitSide : facing.exitSide;
      plan.entrySide = facing.entrySide;
      hasChanged = true;
    }
  }
}

function planWires(input: RouteInput): WirePlan[] {
  const facingByPlan = new Map<WirePlan, SidePair>();
  const plans = input.wires.flatMap((wire): WirePlan[] => {
    const from = input.boxesById.get(wire.from);
    const to = input.boxesById.get(wire.to);
    if (!from || !to) return [];
    const facing = facingSides(from, to, wire.back);
    const output = from.outputs.find((candidate) => candidate.id === wire.fromOutput);
    const strokeHex = wire.tone === 'lane' ? from.lane?.hex ?? null : null;
    const plan: WirePlan = {
      wire, from, to, strokeHex, styleKey: `${wire.dashed || wire.back}|${wire.tone}|${strokeHex}`,
      exitSide: output ? 'right' : wire.fromSide ?? facing.exitSide, entrySide: wire.toSide ?? facing.entrySide,
      busKey: null, exitKey: '', outputPort: output?.port ?? null, start: output?.port ?? centerOf(from), end: centerOf(to),
    };
    facingByPlan.set(plan, facing);
    return [plan];
  });
  chooseSidesBySearch(plans, facingByPlan, input);
  joinFacingBuses(plans, facingByPlan);
  for (const plan of plans) {
    const outputId = plan.wire.fromOutput;
    plan.exitKey = plan.outputPort && outputId ? `${plan.from.id}|output ${outputId}|${plan.styleKey}` : `${plan.from.id}|${plan.exitSide}|${plan.styleKey}`;
  }
  const busKeyOf = (plan: WirePlan) => `${plan.to.id}|${plan.entrySide}|${plan.styleKey}`;
  const memberCountByBusKey = new Map<string, number>();
  for (const plan of plans) memberCountByBusKey.set(busKeyOf(plan), (memberCountByBusKey.get(busKeyOf(plan)) ?? 0) + 1);
  for (const plan of plans) {
    if ((memberCountByBusKey.get(busKeyOf(plan)) ?? 0) > 1) plan.busKey = busKeyOf(plan);
  }
  return plans;
}

function portPositions(box: LaidOutBox, side: Side, count: number): Point[] {
  const indexes = Array.from({ length: count }, (_, index) => index);
  if (isSideways(side)) {
    const x = Math.round(side === 'left' ? box.x : box.x + box.width);
    const spacing = Math.min(PORT_SPACING, (box.height - PORT_INSET * 2) / Math.max(count - 1, 1));
    const centeredFirstY = box.y + Math.min(box.height / 2, 40) - ((count - 1) * spacing) / 2;
    const firstY = Math.max(box.y + PORT_INSET, Math.min(centeredFirstY, box.y + box.height - PORT_INSET - (count - 1) * spacing));
    return indexes.map((index) => ({ x, y: Math.round(firstY + index * spacing) }));
  }
  const y = Math.round(side === 'top' ? box.y : box.y + box.height);
  const firstX = box.x + box.width / 2 - ((count - 1) * PORT_SPACING) / 2;
  return indexes.map((index) => ({ x: Math.round(firstX + index * PORT_SPACING), y }));
}

function portCapacity(box: LaidOutBox, side: Side): number {
  const sideLength = isSideways(side) ? box.height : box.width;
  return Math.max(1, Math.floor((sideLength - PORT_INSET * 2) / PORT_SPACING) + 1);
}

interface PortRequest {
  box: LaidOutBox;
  side: Side;
  groupKey: string;
  wireId: string;
  farPoint: Point;
  assign: (point: Point) => void;
}

function portRequestsBySide(plans: readonly WirePlan[]): Map<string, PortRequest[]> {
  const requests: PortRequest[] = plans.flatMap((plan) => [
    ...(plan.outputPort ? [] : [{ box: plan.from, side: plan.exitSide, groupKey: `exit|${plan.styleKey}`, wireId: plan.wire.id, farPoint: centerOf(plan.to), assign: (point: Point) => { plan.start = point; } }]),
    { box: plan.to, side: plan.entrySide, groupKey: plan.busKey ? `bus|${plan.busKey}` : `entry|${plan.wire.id}`, wireId: plan.wire.id, farPoint: plan.outputPort ?? centerOf(plan.from), assign: (point: Point) => { plan.end = point; } },
  ]);
  return groupedBy(requests, (request) => `${request.box.id}|${request.side}`);
}

function defaultPortOrders(requestsBySide: ReadonlyMap<string, readonly PortRequest[]>): Map<string, string[]> {
  return new Map([...requestsBySide.entries()].map(([sideKey, sideRequests]) => {
    const groups = [...groupedBy(sideRequests, (request) => request.groupKey).entries()].map(([groupKey, members]) => ({
      groupKey,
      firstWireId: members.map((member) => member.wireId).sort()[0] ?? groupKey,
      farCoordinate: members.reduce((sum, member) => sum + (isSideways(member.side) ? member.farPoint.y : member.farPoint.x), 0) / members.length,
    }));
    const ordered = groups.sort((left, right) => left.farCoordinate - right.farCoordinate || left.firstWireId.localeCompare(right.firstWireId) || left.groupKey.localeCompare(right.groupKey));
    return [sideKey, ordered.map((group) => group.groupKey)] as const;
  }));
}

function assignPorts(requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, readonly string[]>): void {
  for (const [sideKey, sideRequests] of requestsBySide) {
    const first = sideRequests[0];
    const groupOrder = groupOrderBySide.get(sideKey) ?? [];
    if (!first) continue;
    const positions = portPositions(first.box, first.side, groupOrder.length);
    for (const request of sideRequests) {
      const position = positions[groupOrder.indexOf(request.groupKey)];
      if (position) request.assign(position);
    }
  }
}

function isFacing(exitSide: Side, entrySide: Side): boolean {
  return (exitSide === 'right' && entrySide === 'left') || (exitSide === 'left' && entrySide === 'right')
    || (exitSide === 'bottom' && entrySide === 'top') || (exitSide === 'top' && entrySide === 'bottom');
}

function alignedAlong(point: Point, side: Side, box: LaidOutBox, target: Point): Point {
  if (isSideways(side)) {
    const isInRange = target.y >= box.y + PORT_INSET && target.y <= box.y + box.height - PORT_INSET;
    return isInRange ? { x: point.x, y: target.y } : point;
  }
  const isInRange = target.x >= box.x + PORT_INSET && target.x <= box.x + box.width - PORT_INSET;
  return isInRange ? { x: target.x, y: point.y } : point;
}

function alignLonePorts(plans: readonly WirePlan[], groupOrderBySide: ReadonlyMap<string, readonly string[]>): void {
  const isLonePort = (box: LaidOutBox, side: Side) => (groupOrderBySide.get(`${box.id}|${side}`)?.length ?? 0) === 1;
  const memberCountByExitKey = new Map([...groupedBy(plans, (plan) => plan.exitKey)].map(([exitKey, members]) => [exitKey, members.length]));
  for (const plan of plans) {
    if (plan.from.id === plan.to.id || !isFacing(plan.exitSide, plan.entrySide)) continue;
    const alignedEnd = plan.busKey === null && isLonePort(plan.to, plan.entrySide) ? alignedAlong(plan.end, plan.entrySide, plan.to, plan.start) : plan.end;
    if (alignedEnd !== plan.end) {
      plan.end = alignedEnd;
      continue;
    }
    if (plan.outputPort === null && isLonePort(plan.from, plan.exitSide) && memberCountByExitKey.get(plan.exitKey) === 1) plan.start = alignedAlong(plan.start, plan.exitSide, plan.from, plan.end);
  }
}

function crowdedSideWarnings(requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, readonly string[]>): string[] {
  return [...requestsBySide.entries()].flatMap(([sideKey, sideRequests]) => {
    const first = sideRequests[0];
    const portCount = groupOrderBySide.get(sideKey)?.length ?? 0;
    if (!first || portCount <= portCapacity(first.box, first.side)) return [];
    return [`box ${first.box.id} has ${portCount} wires on its ${first.side} side, more than fit`];
  });
}

function graphOf(plans: readonly WirePlan[], input: RouteInput): VisibilityGraph | null {
  const ports = plans.flatMap((plan) => [
    { x: plan.start.x, y: plan.start.y, outwardDirection: OUTWARD_DIRECTION_BY_SIDE[plan.exitSide] },
    { x: plan.end.x, y: plan.end.y, outwardDirection: OUTWARD_DIRECTION_BY_SIDE[plan.entrySide] },
  ]);
  return buildVisibilityGraph({ hardRects: [...input.boxesById.values(), ...input.panels], softRects: input.softObstacles, ports, contentTop: input.contentTop });
}

function createMinHeap(): MinHeap {
  return { states: new Int32Array(1024), priorities: new Float64Array(1024), size: 0, lastPoppedPriority: 0 };
}

function swapHeapEntries(heap: MinHeap, first: number, second: number): void {
  const firstState = heap.states[first] ?? 0;
  const firstPriority = heap.priorities[first] ?? 0;
  heap.states[first] = heap.states[second] ?? 0;
  heap.priorities[first] = heap.priorities[second] ?? 0;
  heap.states[second] = firstState;
  heap.priorities[second] = firstPriority;
}

function pushToHeap(heap: MinHeap, state: number, priority: number): void {
  if (heap.size === heap.states.length) {
    const states = new Int32Array(heap.size * 2);
    const priorities = new Float64Array(heap.size * 2);
    states.set(heap.states);
    priorities.set(heap.priorities);
    heap.states = states;
    heap.priorities = priorities;
  }
  heap.states[heap.size] = state;
  heap.priorities[heap.size] = priority;
  let index = heap.size;
  heap.size += 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if ((heap.priorities[parent] ?? 0) <= (heap.priorities[index] ?? 0)) return;
    swapHeapEntries(heap, parent, index);
    index = parent;
  }
}

function popFromHeap(heap: MinHeap): number {
  if (heap.size === 0) return -1;
  const top = heap.states[0] ?? -1;
  heap.lastPoppedPriority = heap.priorities[0] ?? 0;
  heap.size -= 1;
  if (heap.size === 0) return top;
  heap.states[0] = heap.states[heap.size] ?? 0;
  heap.priorities[0] = heap.priorities[heap.size] ?? 0;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.size && (heap.priorities[left] ?? 0) < (heap.priorities[smallest] ?? 0)) smallest = left;
    if (right < heap.size && (heap.priorities[right] ?? 0) < (heap.priorities[smallest] ?? 0)) smallest = right;
    if (smallest === index) return top;
    swapHeapEntries(heap, smallest, index);
    index = smallest;
  }
}

function createSearchBuffers(): SearchBuffers {
  return { bestCost: new Float64Array(INITIAL_STATE_CAPACITY).fill(Infinity), cameFrom: new Int32Array(INITIAL_STATE_CAPACITY).fill(-1), touchedStates: [], heap: createMinHeap() };
}

function ensureStateCapacity(buffers: SearchBuffers, stateCount: number): void {
  if (stateCount <= buffers.bestCost.length) return;
  const capacity = Math.max(stateCount, buffers.bestCost.length * 2);
  const bestCost = new Float64Array(capacity).fill(Infinity);
  const cameFrom = new Int32Array(capacity).fill(-1);
  bestCost.set(buffers.bestCost);
  cameFrom.set(buffers.cameFrom);
  buffers.bestCost = bestCost;
  buffers.cameFrom = cameFrom;
}

function resetSearchBuffers(buffers: SearchBuffers): void {
  for (const state of buffers.touchedStates) {
    buffers.bestCost[state] = Infinity;
    buffers.cameFrom[state] = -1;
  }
  buffers.touchedStates.length = 0;
  buffers.heap.size = 0;
}

function routeOnGraph(graph: VisibilityGraph, plan: WirePlan, backInterior: Rect | null, buffers: SearchBuffers): number[] | null {
  const states = searchGraph(graph, plan, backInterior, buffers, Infinity);
  resetSearchBuffers(buffers);
  return states;
}

function graphEdgeHitsRect(graph: VisibilityGraph, node: number, nextNode: number, rect: Rect): boolean {
  const fromX = graph.xs[node] ?? 0;
  const fromY = graph.ys[node] ?? 0;
  const toX = graph.xs[nextNode] ?? 0;
  const toY = graph.ys[nextNode] ?? 0;
  if (fromY === toY) return rect.y < fromY && fromY < rect.y + rect.height && Math.min(fromX, toX) < rect.x + rect.width && Math.max(fromX, toX) > rect.x;
  return rect.x < fromX && fromX < rect.x + rect.width && Math.min(fromY, toY) < rect.y + rect.height && Math.max(fromY, toY) > rect.y;
}

function fewestBendsTo(direction: number, endDirection: number, towardX: number, towardY: number): number {
  if (direction === REVERSE_DIRECTION[endDirection]) return 2;
  if (direction !== endDirection) return 1;
  const step = STEP_BY_DIRECTION[direction] ?? { x: 0, y: 0 };
  const isStraightAhead = step.x === 0 ? towardX === 0 && towardY * step.y >= 0 : towardY === 0 && towardX * step.x >= 0;
  return isStraightAhead ? 0 : 2;
}

function searchGraph(graph: VisibilityGraph, plan: WirePlan, backInterior: Rect | null, buffers: SearchBuffers, maxExpansions: number): number[] | null {
  graph.beginSearch();
  const startNode = graph.nodeAt(plan.start.x, plan.start.y);
  const endNode = graph.nodeAt(plan.end.x, plan.end.y);
  if (startNode < 0 || endNode < 0 || graph.componentOf(startNode) !== graph.componentOf(endNode)) return null;
  const startDirection = OUTWARD_DIRECTION_BY_SIDE[plan.exitSide];
  const endDirection = INWARD_DIRECTION_BY_SIDE[plan.entrySide];
  const { touchedStates, heap } = buffers;
  const startState = startNode * 4 + startDirection;
  ensureStateCapacity(buffers, graph.nodeCount * 4);
  const estimate = (node: number, direction: number) => {
    const towardX = plan.end.x - (graph.xs[node] ?? 0);
    const towardY = plan.end.y - (graph.ys[node] ?? 0);
    return Math.abs(towardX) + Math.abs(towardY) + fewestBendsTo(direction, endDirection, towardX, towardY) * BEND_COST;
  };
  buffers.bestCost[startState] = 0;
  touchedStates.push(startState);
  pushToHeap(heap, startState, estimate(startNode, startDirection));
  for (let expansions = 0; expansions < maxExpansions; expansions += 1) {
    const state = popFromHeap(heap);
    if (state < 0) return null;
    const node = state >> 2;
    const direction = state & 3;
    if (node === endNode && direction === endDirection) return reconstructNodes(buffers.cameFrom, state);
    const costSoFar = buffers.bestCost[state] ?? Infinity;
    if (heap.lastPoppedPriority > costSoFar * (1 - DEEPER_FIRST) + estimate(node, direction) + 1e-6) continue;
    for (let nextDirection = 0; nextDirection < 4; nextDirection += 1) {
      if (node === startNode && nextDirection !== startDirection) continue;
      if (nextDirection === REVERSE_DIRECTION[direction]) continue;
      const nextNode = graph.neighborOf(node, nextDirection);
      if (nextNode < 0) continue;
      if (nextNode === endNode && nextDirection !== endDirection) continue;
      ensureStateCapacity(buffers, graph.nodeCount * 4);
      const length = Math.abs((graph.xs[nextNode] ?? 0) - (graph.xs[node] ?? 0)) + Math.abs((graph.ys[nextNode] ?? 0) - (graph.ys[node] ?? 0));
      const isInsideBackInterior = backInterior !== null && graphEdgeHitsRect(graph, node, nextNode, backInterior);
      const stepCost = length
        + (nextDirection === direction ? 0 : BEND_COST)
        + (graph.isSoftStep(node, nextDirection) ? SOFT_OBSTACLE_COST : 0)
        + (isInsideBackInterior ? BACK_INTERIOR_COST : 0);
      const nextState = nextNode * 4 + nextDirection;
      const nextCost = costSoFar + Math.max(stepCost, 1);
      if (nextCost >= (buffers.bestCost[nextState] ?? Infinity)) continue;
      buffers.bestCost[nextState] = nextCost;
      buffers.cameFrom[nextState] = state;
      touchedStates.push(nextState);
      pushToHeap(heap, nextState, nextCost * (1 - DEEPER_FIRST) + estimate(nextNode, nextDirection));
    }
  }
  return null;
}

function reconstructNodes(cameFrom: Int32Array, goalState: number): number[] {
  const states: number[] = [];
  for (let state = goalState; state !== -1; state = cameFrom[state] ?? -1) states.push(state);
  return states.reverse();
}

function stubOf(point: Point, side: Side): Point {
  const step = STEP_BY_DIRECTION[OUTWARD_DIRECTION_BY_SIDE[side]] ?? { x: 0, y: 0 };
  return { x: point.x + step.x * CLEARANCE, y: point.y + step.y * CLEARANCE };
}

function fallbackPoints(plan: WirePlan): Point[] {
  const startStub = stubOf(plan.start, plan.exitSide);
  const endStub = stubOf(plan.end, plan.entrySide);
  return withoutBends([plan.start, startStub, { x: endStub.x, y: startStub.y }, endStub, plan.end]);
}

function backInteriorOf(plan: WirePlan, loopFrames: readonly Rect[]): Rect | null {
  if (!plan.wire.back) return null;
  const span = unionOf([plan.from, plan.to]);
  if (!span) return null;
  const enclosingLoop = loopFrames.find((frame) => frame.x <= span.x && frame.y <= span.y && frame.x + frame.width >= span.x + span.width && frame.y + frame.height >= span.y + span.height);
  return enclosingLoop ?? span;
}

function drawnWireOf(graph: VisibilityGraph | null, plan: WirePlan, states: number[] | null): DrawnWire {
  const points = graph && states ? pointsOfStates(graph, states) : fallbackPoints(plan);
  return { plan, points, segments: segmentsOf(points), states };
}

function routeAll(plans: readonly WirePlan[], input: RouteInput): DrawnWire[] {
  const graph = graphOf(plans, input);
  const buffers = graph ? createSearchBuffers() : null;
  const routed = plans.map((plan) => drawnWireOf(graph, plan, graph && buffers ? routeOnGraph(graph, plan, backInteriorOf(plan, input.loopFrames), buffers) : null));
  const nudgedPoints = nudgeSharedLines(routed.map((wire) => ({ points: wire.points, exitKey: wire.plan.exitKey, busKey: wire.plan.busKey })), solidsOf(input));
  return routed.map((wire, index) => {
    const points = withoutBends(nudgedPoints[index] ?? wire.points);
    return { ...wire, points, segments: segmentsOf(points) };
  });
}

function bendCountOf(wire: DrawnWire): number {
  return Math.max(0, wire.points.length - 2);
}

function labelWidthOf(label: string): number {
  return Math.ceil(label.length * LABEL_CHAR_WIDTH);
}

function labelBoundsAt(baseline: Point, width: number): Rect {
  return { x: baseline.x - width / 2, y: baseline.y - LABEL_ASCENT, width, height: LABEL_ASCENT + LABEL_DESCENT };
}

function segmentLength(segment: Segment): number {
  return Math.abs(segment.from.x - segment.to.x) + Math.abs(segment.from.y - segment.to.y);
}

function flushLabelCandidates(segment: Segment, width: number): Point[] {
  if (!isHorizontal(segment)) return [];
  const y = segment.from.y;
  const flushXs = [Math.min(segment.from.x, segment.to.x) + LABEL_GAP + width / 2, Math.max(segment.from.x, segment.to.x) - LABEL_GAP - width / 2];
  return flushXs.flatMap((x) => [{ x, y: y - LABEL_GAP }, { x, y: y + LABEL_GAP + LABEL_ASCENT }]);
}

function labelCandidates(segments: readonly Segment[], width: number): Point[] {
  const byLength = [...segments].sort((left, right) => segmentLength(right) - segmentLength(left));
  return [...segments.slice(0, 1), ...byLength].flatMap((segment) => [...LABEL_SLIDE_FRACTIONS.flatMap((fraction) => {
    const x = segment.from.x + (segment.to.x - segment.from.x) * fraction;
    const y = segment.from.y + (segment.to.y - segment.from.y) * fraction;
    if (isHorizontal(segment)) return [{ x, y: y - LABEL_GAP }, { x, y: y + LABEL_GAP + LABEL_ASCENT }];
    return [{ x: x + LABEL_GAP + width / 2, y: y + LABEL_ASCENT / 2 }, { x: x - LABEL_GAP - width / 2, y: y + LABEL_ASCENT / 2 }];
  }), ...flushLabelCandidates(segment, width)]);
}

function placeLabels(drawn: readonly DrawnWire[], input: RouteInput, warnings: string[]): Map<string, { at: Point; bounds: Rect }> {
  const placedById = new Map<string, { at: Point; bounds: Rect }>();
  const allSegments = drawn.flatMap((wire) => wire.segments);
  const solids = [...input.boxesById.values(), ...input.softObstacles];
  for (const wire of drawn) {
    const label = wire.plan.wire.label;
    if (!label) continue;
    const width = labelWidthOf(label);
    const candidates = labelCandidates(wire.segments, width);
    const isClear = (baseline: Point) => {
      const bounds = labelBoundsAt(baseline, width);
      if (bounds.y < input.contentTop) return false;
      const padded = inflated(bounds, LABEL_CLEARANCE);
      if (allSegments.some((segment) => segmentHitsRect(segment, padded))) return false;
      if (solids.some((rect) => rectsOverlap(bounds, rect))) return false;
      return ![...placedById.values()].some((placed) => rectsOverlap(bounds, placed.bounds));
    };
    const clearSpot = candidates.find(isClear);
    const at = clearSpot ?? candidates[0] ?? centerOf(wire.plan.from);
    if (!clearSpot) warnings.push(`wire ${wire.plan.wire.id} label "${label}" has no clear spot`);
    placedById.set(wire.plan.wire.id, { at: { x: Math.round(at.x), y: Math.round(at.y) }, bounds: labelBoundsAt(at, width) });
  }
  return placedById;
}

function isStrictlyBetween(value: number, first: number, second: number): boolean {
  return value > Math.min(first, second) + 0.5 && value < Math.max(first, second) - 0.5;
}

function segmentsCross(first: Segment, second: Segment): boolean {
  if (isHorizontal(first) === isHorizontal(second)) return false;
  const horizontal = isHorizontal(first) ? first : second;
  const vertical = horizontal === first ? second : first;
  return isStrictlyBetween(vertical.from.x, horizontal.from.x, horizontal.to.x) && isStrictlyBetween(horizontal.from.y, vertical.from.y, vertical.to.y);
}

function segmentsOverlap(first: Segment, second: Segment): boolean {
  if (isHorizontal(first) !== isHorizontal(second)) return false;
  const isAlongX = isHorizontal(first);
  const lineOf = (segment: Segment) => (isAlongX ? segment.from.y : segment.from.x);
  const startOf = (segment: Segment) => Math.min(isAlongX ? segment.from.x : segment.from.y, isAlongX ? segment.to.x : segment.to.y);
  const endOf = (segment: Segment) => Math.max(isAlongX ? segment.from.x : segment.from.y, isAlongX ? segment.to.x : segment.to.y);
  return lineOf(first) === lineOf(second) && Math.min(endOf(first), endOf(second)) - Math.max(startOf(first), startOf(second)) > 1;
}

function areSiblings(first: DrawnWire, second: DrawnWire): boolean {
  if (first.plan.busKey !== null && first.plan.busKey === second.plan.busKey) return true;
  return first.plan.exitKey === second.plan.exitKey;
}

interface WirePieces {
  rects: FlatRects;
  segments: Segment[];
  wireIndexByPiece: Int32Array;
}

function wirePiecesOf(drawn: readonly DrawnWire[]): WirePieces {
  const segments = drawn.flatMap((wire) => wire.segments);
  const rects = emptyFlatRects(segments.length);
  const wireIndexByPiece = new Int32Array(segments.length);
  let piece = 0;
  drawn.forEach((wire, wireIndex) => {
    for (const segment of wire.segments) {
      setFlatRect(rects, piece, segment.from.x, segment.from.y, segment.to.x, segment.to.y);
      wireIndexByPiece[piece] = wireIndex;
      piece += 1;
    }
  });
  return { rects, segments, wireIndexByPiece };
}

function findCrossings(drawn: readonly DrawnWire[], pieces: WirePieces): string[] {
  const isCrossingByPairKey = new Map<number, boolean>();
  forEachTouchingPairWithin(pieces.rects, (earlierPiece, laterPiece) => {
    const earlierWire = pieces.wireIndexByPiece[earlierPiece] ?? 0;
    const laterWire = pieces.wireIndexByPiece[laterPiece] ?? 0;
    if (earlierWire === laterWire) return;
    const pairKey = Math.min(earlierWire, laterWire) * drawn.length + Math.max(earlierWire, laterWire);
    if (isCrossingByPairKey.get(pairKey) === true) return;
    const first = drawn[earlierWire];
    const second = drawn[laterWire];
    const earlierSegment = pieces.segments[earlierPiece];
    const laterSegment = pieces.segments[laterPiece];
    if (!first || !second || !earlierSegment || !laterSegment || areSiblings(first, second)) return;
    if (segmentsCross(earlierSegment, laterSegment)) {
      isCrossingByPairKey.set(pairKey, true);
      return;
    }
    if (segmentsOverlap(earlierSegment, laterSegment)) isCrossingByPairKey.set(pairKey, false);
  });
  const pairKeys = [...isCrossingByPairKey.keys()];
  const ordered = pairsInOrder(pairKeys.map((key) => Math.floor(key / drawn.length)), pairKeys.map((key) => key % drawn.length), drawn.length, drawn.length);
  return ordered.map(([firstIndex, secondIndex]) => {
    const verb = isCrossingByPairKey.get(firstIndex * drawn.length + secondIndex) ? 'crosses' : 'overlaps';
    return `wire ${drawn[firstIndex]?.plan.wire.id} ${verb} wire ${drawn[secondIndex]?.plan.wire.id}`;
  });
}

function solidsOf(input: RouteInput): (LaidOutBox | LaidOutPanel)[] {
  return [...input.boxesById.values(), ...input.panels];
}

function findBoxCrossings(drawn: readonly DrawnWire[], pieces: WirePieces, input: RouteInput): string[] {
  const solids = solidsOf(input);
  const insets = solids.map((solid) => inflated(solid, -2));
  const crossedPairKeys = new Set<number>();
  forEachTouchingPairAcross(pieces.rects, flatRectsOf(insets), (piece, solidIndex) => {
    const wireIndex = pieces.wireIndexByPiece[piece] ?? 0;
    const pairKey = wireIndex * solids.length + solidIndex;
    if (crossedPairKeys.has(pairKey)) return;
    const wire = drawn[wireIndex];
    const solid = solids[solidIndex];
    const inset = insets[solidIndex];
    const segment = pieces.segments[piece];
    if (!wire || !solid || !inset || !segment) return;
    if (solid.id === wire.plan.from.id || solid.id === wire.plan.to.id) return;
    if (segmentHitsRect(segment, inset)) crossedPairKeys.add(pairKey);
  });
  const pairKeys = [...crossedPairKeys];
  const ordered = pairsInOrder(pairKeys.map((key) => Math.floor(key / solids.length)), pairKeys.map((key) => key % solids.length), drawn.length, solids.length);
  return ordered.map(([wireIndex, solidIndex]) => `wire ${drawn[wireIndex]?.plan.wire.id} runs through ${solids[solidIndex]?.kind} ${solids[solidIndex]?.id}`);
}

function crossingWarningsOf(drawn: readonly DrawnWire[], input: RouteInput): string[] {
  const pieces = wirePiecesOf(drawn);
  return [...findBoxCrossings(drawn, pieces, input), ...findCrossings(drawn, pieces)];
}

function totalCrossingCostOf(drawn: readonly DrawnWire[], input: RouteInput): number {
  const pieces = wirePiecesOf(drawn);
  return findBoxCrossings(drawn, pieces, input).length * BOX_CROSSING_COST + findCrossings(drawn, pieces).length;
}

function routeQualityWarnings(drawn: readonly DrawnWire[]): string[] {
  return drawn.flatMap((wire) => {
    if (!wire.states) return [`wire ${wire.plan.wire.id} found no clear route, so it is drawn as a straight dog-leg`];
    const bends = bendCountOf(wire);
    return bends > MAX_BENDS ? [`wire ${wire.plan.wire.id} bends ${bends} times`] : [];
  });
}

function isPointOnSegment(point: Point, segment: Segment): boolean {
  if (isHorizontal(segment)) return point.y === segment.from.y && point.x >= Math.min(segment.from.x, segment.to.x) && point.x <= Math.max(segment.from.x, segment.to.x);
  return point.x === segment.from.x && point.y >= Math.min(segment.from.y, segment.to.y) && point.y <= Math.max(segment.from.y, segment.to.y);
}

function joinPointOf(wire: DrawnWire, leader: DrawnWire | undefined): Point | null {
  if (!leader || leader === wire) return null;
  const joined = wire.points.find((point) => leader.segments.some((segment) => isPointOnSegment(point, segment)));
  if (!joined || (joined.x === wire.plan.end.x && joined.y === wire.plan.end.y)) return null;
  return joined;
}

function swapNeighbors(order: string[], index: number): void {
  const left = order[index];
  const right = order[index + 1];
  if (left === undefined || right === undefined) return;
  order[index] = right;
  order[index + 1] = left;
}

function routeWithPortOrder(plans: readonly WirePlan[], input: RouteInput, requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, readonly string[]>): DrawnWire[] {
  assignPorts(requestsBySide, groupOrderBySide);
  alignLonePorts(plans, groupOrderBySide);
  return routeAll(plans, input);
}

function routeWithFewestCrossings(plans: readonly WirePlan[], input: RouteInput, requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, string[]>): DrawnWire[] {
  const firstRouted = routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide);
  if (plans.length > MAX_WIRES_FOR_PORT_SEARCH) return firstRouted;
  let bestCrossingCost = totalCrossingCostOf(firstRouted, input);
  for (const groupOrder of groupOrderBySide.values()) {
    for (let index = 0; bestCrossingCost > 0 && index + 1 < groupOrder.length; index += 1) {
      swapNeighbors(groupOrder, index);
      const trialCrossingCost = totalCrossingCostOf(routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide), input);
      if (trialCrossingCost < bestCrossingCost) {
        bestCrossingCost = trialCrossingCost;
        continue;
      }
      swapNeighbors(groupOrder, index);
    }
  }
  return routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide);
}

function routeWires(input: RouteInput): RouteResult {
  const plans = planWires(input);
  const requestsBySide = portRequestsBySide(plans);
  const groupOrderBySide = defaultPortOrders(requestsBySide);
  const drawn = routeWithFewestCrossings(plans, input, requestsBySide, groupOrderBySide);
  const labelWarnings: string[] = [];
  const labelById = placeLabels(drawn, input, labelWarnings);
  const leaderByBusKey = new Map<string, DrawnWire>();
  for (const wire of [...drawn].sort((left, right) => left.plan.wire.id.localeCompare(right.plan.wire.id))) {
    if (wire.plan.busKey && !leaderByBusKey.has(wire.plan.busKey)) leaderByBusKey.set(wire.plan.busKey, wire);
  }
  const wires = drawn.map((wire): LaidOutWire => {
    const { plan, points } = wire;
    const leader = plan.busKey ? leaderByBusKey.get(plan.busKey) : undefined;
    return {
      kind: 'wire', id: plan.wire.id, path: pathOf(points), start: plan.start, end: plan.end,
      label: plan.wire.label, labelAt: labelById.get(plan.wire.id)?.at ?? centerOf(plan.from),
      isDashed: plan.wire.dashed || plan.wire.back, isBack: plan.wire.back, strokeHex: plan.strokeHex, tone: plan.wire.tone,
      hasArrowhead: leader === undefined || leader === wire, joinAt: joinPointOf(wire, leader),
    };
  });
  const labelRects = [...labelById.values()].map((placed) => placed.bounds);
  const pointRects = drawn.flatMap((wire) => wire.points).map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 }));
  return {
    wires,
    segments: drawn.flatMap((wire) => wire.segments),
    collectWarnings: () => [...routeQualityWarnings(drawn), ...crossingWarningsOf(drawn, input), ...crowdedSideWarnings(requestsBySide, groupOrderBySide), ...labelWarnings],
    extent: unionOf([...pointRects, ...labelRects]),
  };
}

export { cappedWarnings, labelWidthOf, pathOf, rectsOverlap, routeWires, unionOf, withoutBends };
export type { Point };
