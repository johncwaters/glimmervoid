import { WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Wire } from './contracts/whiteboard.ts';
import type { LaidOutBox, LaidOutPanel, LaidOutWire, Rect } from './whiteboard-layout-core.ts';

type Side = 'left' | 'right' | 'top' | 'bottom';

interface Point {
  x: number;
  y: number;
}

interface Segment {
  from: Point;
  to: Point;
}

const CLEARANCE = 14;
const BEND_COST = 30;
const CROSS_COST = 40;
const OVERLAP_COST = 120;
const SOFT_OBSTACLE_COST = 300;
const BACK_INTERIOR_COST = 400;
const SHARED_EDGE_DISCOUNT = 0.5;
const MAX_GRID_NODES = 40_000;
const MAX_EXPANSIONS = 20_000;
const MAX_TOTAL_EXPANSIONS = 400_000;
const MAX_BENDS = 6;
const MAX_WIRES_FOR_PORT_SEARCH = 12;
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
  warnings: string[];
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
  isFallback: boolean;
}

interface KeyUsage {
  total: number;
  countByExitKey: Map<string, number>;
  countByBusKey: Map<string, number>;
  countByBusAndExitKey: Map<string, number>;
}

interface SearchBuffers {
  bestCost: Float64Array;
  cameFrom: Int32Array;
  touchedStates: number[];
}

interface SearchBudget {
  remainingExpansions: number;
}

interface Grid {
  xs: number[];
  ys: number[];
  xIndexByValue: Map<number, number>;
  yIndexByValue: Map<number, number>;
  isBlocked: Uint8Array[];
  isSoft: Uint8Array[];
}

interface RouteUsage {
  usageByEdge: Map<number, KeyUsage>;
  usageByNodeAndAxis: Map<number, KeyUsage>;
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
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
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

interface VerticalSpan {
  top: number;
  bottom: number;
}

interface DefaultSides {
  exitSide: Side;
  entrySide: Side;
  facingEntrySide: Side | null;
}

function acrossGapSides(from: LaidOutBox, to: LaidOutBox, startSpan: VerticalSpan): DefaultSides {
  const exitSide: Side = centerOf(to).x > centerOf(from).x ? 'right' : 'left';
  const facingEntrySide: Side = exitSide === 'right' ? 'left' : 'right';
  if (startSpan.bottom < to.y) return { exitSide, entrySide: 'top', facingEntrySide };
  if (startSpan.top > to.y + to.height) return { exitSide, entrySide: 'bottom', facingEntrySide };
  return { exitSide, entrySide: facingEntrySide, facingEntrySide: null };
}

function defaultSides(from: LaidOutBox, to: LaidOutBox, isBack: boolean, startSpan: VerticalSpan): DefaultSides {
  if (from.id === to.id) return { exitSide: 'right', entrySide: 'top', facingEntrySide: null };
  if (isBack) return { exitSide: 'bottom', entrySide: 'bottom', facingEntrySide: null };
  if (hasHorizontalGap(from, to)) return acrossGapSides(from, to, startSpan);
  return centerOf(to).y > centerOf(from).y
    ? { exitSide: 'bottom', entrySide: 'top', facingEntrySide: null }
    : { exitSide: 'top', entrySide: 'bottom', facingEntrySide: null };
}

function isTurnBlocked(plan: WirePlan, input: RouteInput): boolean {
  const startY = plan.outputPort?.y ?? centerOf(plan.from).y;
  const startX = plan.exitSide === 'right' ? plan.from.x + plan.from.width : plan.from.x;
  const corner = { x: centerOf(plan.to).x, y: startY };
  const entryY = plan.entrySide === 'top' ? plan.to.y : plan.to.y + plan.to.height;
  const turn = [{ from: { x: startX, y: startY }, to: corner }, { from: corner, to: { x: corner.x, y: entryY } }];
  const obstacles = [...input.boxesById.values()].filter((box) => box.id !== plan.from.id && box.id !== plan.to.id).map((box) => inflated(box, CLEARANCE));
  return turn.some((segment) => obstacles.some((obstacle) => segmentHitsRect(segment, obstacle)));
}

function isJoiningFacingBus(plan: WirePlan, facingEntrySide: Side, plans: readonly WirePlan[]): boolean {
  return plans.some((other) => other !== plan && other.to.id === plan.to.id && other.styleKey === plan.styleKey && other.entrySide === facingEntrySide);
}

function planWires(input: RouteInput): WirePlan[] {
  const facingEntrySideByPlan = new Map<WirePlan, Side>();
  const plans = input.wires.flatMap((wire): WirePlan[] => {
    const from = input.boxesById.get(wire.from);
    const to = input.boxesById.get(wire.to);
    if (!from || !to) return [];
    const output = from.outputs.find((candidate) => candidate.id === wire.fromOutput);
    const startSpan = output ? { top: output.port.y, bottom: output.port.y } : { top: from.y, bottom: from.y + from.height };
    const sides = defaultSides(from, to, wire.back, startSpan);
    const exitSide = output ? 'right' : wire.fromSide ?? sides.exitSide;
    const entrySide = wire.toSide ?? sides.entrySide;
    const strokeHex = wire.tone === 'lane' ? from.lane?.hex ?? null : null;
    const styleKey = `${wire.dashed || wire.back}|${wire.tone}|${strokeHex}`;
    const exitKey = output ? `${from.id}|output ${output.id}|${styleKey}` : `${from.id}|${exitSide}|${styleKey}`;
    const plan: WirePlan = {
      wire, from, to, strokeHex, styleKey, exitSide, entrySide, busKey: null, exitKey, outputPort: output?.port ?? null,
      start: output?.port ?? centerOf(from), end: centerOf(to),
    };
    if (!wire.toSide && sides.facingEntrySide) facingEntrySideByPlan.set(plan, sides.facingEntrySide);
    return [plan];
  });
  for (const [plan, facingEntrySide] of facingEntrySideByPlan) {
    if (plan.wire.fromSide || isTurnBlocked(plan, input) || isJoiningFacingBus(plan, facingEntrySide, plans)) plan.entrySide = facingEntrySide;
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

function withMidpoints(sortedValues: readonly number[]): number[] {
  const values = [...sortedValues];
  for (const [index, value] of sortedValues.entries()) {
    const next = sortedValues[index + 1];
    if (next !== undefined && next - value > CLEARANCE * 3) values.push(Math.round((value + next) / 2));
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function buildGrid(plans: readonly WirePlan[], hardRects: readonly Rect[], softRects: readonly Rect[], contentTop: number): Grid | null {
  const allRects = [...hardRects, ...softRects];
  const around = unionOf([...allRects, ...plans.flatMap((plan) => [{ ...plan.start, width: 0, height: 0 }, { ...plan.end, width: 0, height: 0 }])]);
  if (!around) return null;
  const portXs = plans.flatMap((plan) => [plan.start.x, plan.end.x]);
  const portYs = plans.flatMap((plan) => [plan.start.y, plan.end.y]);
  const topLimit = contentTop + 4;
  const rawXs = [...allRects.flatMap((rect) => [rect.x - CLEARANCE, rect.x + rect.width + CLEARANCE]), around.x - CLEARANCE * 3, around.x + around.width + CLEARANCE * 3].map(Math.round);
  const rawYs = [...allRects.flatMap((rect) => [rect.y - CLEARANCE, rect.y + rect.height + CLEARANCE]), around.y - CLEARANCE * 3, around.y + around.height + CLEARANCE * 3].map(Math.round)
    .filter((y) => y >= topLimit);
  const xs = withMidpoints([...new Set([...rawXs, ...portXs])].sort((left, right) => left - right));
  const ys = withMidpoints([...new Set([...rawYs, ...portYs])].sort((left, right) => left - right));
  if (xs.length * ys.length > MAX_GRID_NODES) return null;
  const blockingRects = hardRects.map((rect) => inflated(rect, 1));
  const edgeFlags = (axis: 0 | 1, rects: readonly Rect[]) => {
    const flags = new Uint8Array(xs.length * ys.length);
    for (const [yIndex, y] of ys.entries()) {
      for (const [xIndex, x] of xs.entries()) {
        const nextX = xs[xIndex + 1];
        const nextY = ys[yIndex + 1];
        const segment = axis === 0
          ? nextX === undefined ? null : { from: { x, y }, to: { x: nextX, y } }
          : nextY === undefined ? null : { from: { x, y }, to: { x, y: nextY } };
        if (segment && rects.some((rect) => segmentHitsRect(segment, rect))) flags[yIndex * xs.length + xIndex] = 1;
      }
    }
    return flags;
  };
  return {
    xs, ys,
    xIndexByValue: new Map(xs.map((x, index) => [x, index])),
    yIndexByValue: new Map(ys.map((y, index) => [y, index])),
    isBlocked: [edgeFlags(0, blockingRects), edgeFlags(1, blockingRects)],
    isSoft: [edgeFlags(0, softRects), edgeFlags(1, softRects)],
  };
}

interface MinHeap {
  push: (state: number, priority: number) => void;
  pop: () => number | undefined;
}

function createMinHeap(): MinHeap {
  const states: number[] = [];
  const priorities: number[] = [];
  const swap = (first: number, second: number) => {
    [states[first], states[second]] = [states[second] ?? 0, states[first] ?? 0];
    [priorities[first], priorities[second]] = [priorities[second] ?? 0, priorities[first] ?? 0];
  };
  return {
    push(state, priority) {
      states.push(state);
      priorities.push(priority);
      let index = states.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if ((priorities[parent] ?? 0) <= (priorities[index] ?? 0)) break;
        swap(parent, index);
        index = parent;
      }
    },
    pop() {
      const top = states[0];
      const lastState = states.pop();
      const lastPriority = priorities.pop();
      if (states.length === 0 || lastState === undefined || lastPriority === undefined) return top;
      states[0] = lastState;
      priorities[0] = lastPriority;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < states.length && (priorities[left] ?? 0) < (priorities[smallest] ?? 0)) smallest = left;
        if (right < states.length && (priorities[right] ?? 0) < (priorities[smallest] ?? 0)) smallest = right;
        if (smallest === index) return top;
        swap(smallest, index);
        index = smallest;
      }
    },
  };
}

function edgeKeyOf(grid: Grid, xIndex: number, yIndex: number, direction: number): { axis: 0 | 1; index: number } {
  if (direction === 0) return { axis: 0, index: yIndex * grid.xs.length + xIndex };
  if (direction === 1) return { axis: 0, index: yIndex * grid.xs.length + xIndex - 1 };
  if (direction === 2) return { axis: 1, index: yIndex * grid.xs.length + xIndex };
  return { axis: 1, index: (yIndex - 1) * grid.xs.length + xIndex };
}

function busAndExitKeyOf(busKey: string, exitKey: string): string {
  return `${busKey}\n${exitKey}`;
}

function compatibleCountOf(keyUsage: KeyUsage, plan: WirePlan): number {
  const sameExitCount = keyUsage.countByExitKey.get(plan.exitKey) ?? 0;
  if (plan.busKey === null) return sameExitCount;
  const sameBusCount = keyUsage.countByBusKey.get(plan.busKey) ?? 0;
  const sameBusAndExitCount = keyUsage.countByBusAndExitKey.get(busAndExitKeyOf(plan.busKey, plan.exitKey)) ?? 0;
  return sameExitCount + sameBusCount - sameBusAndExitCount;
}

function usagePenalty(usage: RouteUsage, plan: WirePlan, edgeKey: { axis: 0 | 1; index: number }, nodeIndex: number, length: number): number {
  const edgeUsage = usage.usageByEdge.get(edgeKey.axis * 1_000_000 + edgeKey.index);
  const crossingUsage = usage.usageByNodeAndAxis.get((1 - edgeKey.axis) * 1_000_000 + nodeIndex);
  const compatibleOnEdge = edgeUsage ? compatibleCountOf(edgeUsage, plan) : 0;
  const sharesEdge = compatibleOnEdge > 0;
  const overlapsStranger = edgeUsage !== undefined && edgeUsage.total > compatibleOnEdge;
  const crossesStranger = crossingUsage !== undefined && crossingUsage.total > compatibleCountOf(crossingUsage, plan);
  return (sharesEdge ? -length * (1 - SHARED_EDGE_DISCOUNT) : 0) + (overlapsStranger ? OVERLAP_COST : 0) + (crossesStranger ? CROSS_COST : 0);
}

function createSearchBuffers(grid: Grid): SearchBuffers {
  const stateCount = grid.xs.length * grid.ys.length * 4;
  return { bestCost: new Float64Array(stateCount).fill(Infinity), cameFrom: new Int32Array(stateCount).fill(-1), touchedStates: [] };
}

function resetSearchBuffers(buffers: SearchBuffers): void {
  for (const state of buffers.touchedStates) {
    buffers.bestCost[state] = Infinity;
    buffers.cameFrom[state] = -1;
  }
  buffers.touchedStates.length = 0;
}

function routeOnGrid(grid: Grid, plan: WirePlan, usage: RouteUsage, backInterior: Rect | null, buffers: SearchBuffers, budget: SearchBudget): number[] | null {
  const states = searchGrid(grid, plan, usage, backInterior, buffers, budget);
  resetSearchBuffers(buffers);
  return states;
}

function searchGrid(grid: Grid, plan: WirePlan, usage: RouteUsage, backInterior: Rect | null, buffers: SearchBuffers, budget: SearchBudget): number[] | null {
  const width = grid.xs.length;
  const startX = grid.xIndexByValue.get(plan.start.x);
  const startY = grid.yIndexByValue.get(plan.start.y);
  const endX = grid.xIndexByValue.get(plan.end.x);
  const endY = grid.yIndexByValue.get(plan.end.y);
  if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) return null;
  const startNode = startY * width + startX;
  const endNode = endY * width + endX;
  const startDirection = OUTWARD_DIRECTION_BY_SIDE[plan.exitSide];
  const endDirection = INWARD_DIRECTION_BY_SIDE[plan.entrySide];
  const { bestCost, cameFrom, touchedStates } = buffers;
  const heap = createMinHeap();
  const startState = startNode * 4 + startDirection;
  const estimate = (xIndex: number, yIndex: number) => Math.abs((grid.xs[xIndex] ?? 0) - plan.end.x) + Math.abs((grid.ys[yIndex] ?? 0) - plan.end.y);
  bestCost[startState] = 0;
  touchedStates.push(startState);
  heap.push(startState, estimate(startX, startY));
  for (let expansions = 0; expansions < MAX_EXPANSIONS && budget.remainingExpansions > 0; expansions += 1) {
    budget.remainingExpansions -= 1;
    const state = heap.pop();
    if (state === undefined) return null;
    const node = state >> 2;
    const direction = state & 3;
    if (node === endNode && direction === endDirection) return reconstructNodes(cameFrom, state);
    const xIndex = node % width;
    const yIndex = (node - xIndex) / width;
    const costSoFar = bestCost[state] ?? Infinity;
    for (const [nextDirection, step] of STEP_BY_DIRECTION.entries()) {
      if (node === startNode && nextDirection !== startDirection) continue;
      if (nextDirection === REVERSE_DIRECTION[direction]) continue;
      const nextX = xIndex + step.x;
      const nextY = yIndex + step.y;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= grid.ys.length) continue;
      const nextNode = nextY * width + nextX;
      if (nextNode === endNode && nextDirection !== endDirection) continue;
      const edgeKey = edgeKeyOf(grid, xIndex, yIndex, nextDirection);
      const isForcedMove = node === startNode || nextNode === endNode;
      if (!isForcedMove && grid.isBlocked[edgeKey.axis]?.[edgeKey.index] === 1) continue;
      const from = { x: grid.xs[xIndex] ?? 0, y: grid.ys[yIndex] ?? 0 };
      const to = { x: grid.xs[nextX] ?? 0, y: grid.ys[nextY] ?? 0 };
      const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
      const isInsideBackInterior = backInterior !== null && segmentHitsRect({ from, to }, backInterior);
      const stepCost = length
        + (nextDirection === direction ? 0 : BEND_COST)
        + (grid.isSoft[edgeKey.axis]?.[edgeKey.index] === 1 ? SOFT_OBSTACLE_COST : 0)
        + (isInsideBackInterior ? BACK_INTERIOR_COST : 0)
        + usagePenalty(usage, plan, edgeKey, nextNode, length);
      const nextState = nextNode * 4 + nextDirection;
      const nextCost = costSoFar + Math.max(stepCost, 1);
      if (nextCost >= (bestCost[nextState] ?? Infinity)) continue;
      bestCost[nextState] = nextCost;
      cameFrom[nextState] = state;
      touchedStates.push(nextState);
      heap.push(nextState, nextCost + estimate(nextX, nextY));
    }
  }
  return null;
}

function reconstructNodes(cameFrom: Int32Array, goalState: number): number[] {
  const states: number[] = [];
  for (let state = goalState; state !== -1; state = cameFrom[state] ?? -1) states.push(state);
  return states.reverse();
}

function recordUsage(grid: Grid, usage: RouteUsage, plan: WirePlan, states: readonly number[]): void {
  const width = grid.xs.length;
  const increment = (countByKey: Map<string, number>, key: string) => countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
  const remember = (usageByKey: Map<number, KeyUsage>, key: number) => {
    const keyUsage = usageByKey.get(key) ?? { total: 0, countByExitKey: new Map(), countByBusKey: new Map(), countByBusAndExitKey: new Map() };
    usageByKey.set(key, keyUsage);
    keyUsage.total += 1;
    increment(keyUsage.countByExitKey, plan.exitKey);
    if (plan.busKey === null) return;
    increment(keyUsage.countByBusKey, plan.busKey);
    increment(keyUsage.countByBusAndExitKey, busAndExitKeyOf(plan.busKey, plan.exitKey));
  };
  for (const [index, state] of states.entries()) {
    const previous = states[index - 1];
    if (previous === undefined) continue;
    const previousNode = previous >> 2;
    const direction = state & 3;
    const xIndex = previousNode % width;
    const yIndex = (previousNode - xIndex) / width;
    const edgeKey = edgeKeyOf(grid, xIndex, yIndex, direction);
    remember(usage.usageByEdge, edgeKey.axis * 1_000_000 + edgeKey.index);
    remember(usage.usageByNodeAndAxis, edgeKey.axis * 1_000_000 + previousNode);
    remember(usage.usageByNodeAndAxis, edgeKey.axis * 1_000_000 + (state >> 2));
  }
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

function routeAll(plans: readonly WirePlan[], input: RouteInput, budget: SearchBudget): DrawnWire[] {
  const hardRects = [...input.boxesById.values(), ...input.panels];
  const grid = buildGrid(plans, hardRects, input.softObstacles, input.contentTop);
  const buffers = grid ? createSearchBuffers(grid) : null;
  const usage: RouteUsage = { usageByEdge: new Map(), usageByNodeAndAxis: new Map() };
  const routeLength = (plan: WirePlan) => Math.abs(plan.start.x - plan.end.x) + Math.abs(plan.start.y - plan.end.y);
  const ordered = [...plans].sort((left, right) => routeLength(right) - routeLength(left) || left.wire.id.localeCompare(right.wire.id));
  const drawnById = new Map<string, DrawnWire>();
  for (const plan of ordered) {
    const states = grid && buffers ? routeOnGrid(grid, plan, usage, backInteriorOf(plan, input.loopFrames), buffers, budget) : null;
    if (grid && states) recordUsage(grid, usage, plan, states);
    const points = grid && states
      ? withoutBends(states.map((state) => {
        const node = state >> 2;
        const xIndex = node % grid.xs.length;
        return { x: grid.xs[xIndex] ?? 0, y: grid.ys[(node - xIndex) / grid.xs.length] ?? 0 };
      }))
      : fallbackPoints(plan);
    drawnById.set(plan.wire.id, { plan, points, segments: segmentsOf(points), isFallback: !states });
  }
  return plans.flatMap((plan) => drawnById.get(plan.wire.id) ?? []);
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

function findCrossings(drawn: readonly DrawnWire[]): string[] {
  return drawn.flatMap((first, index) => drawn.slice(index + 1).flatMap((second) => {
    if (areSiblings(first, second)) return [];
    const pairs = first.segments.flatMap((firstSegment) => second.segments.map((secondSegment) => [firstSegment, secondSegment] as const));
    if (pairs.some(([firstSegment, secondSegment]) => segmentsCross(firstSegment, secondSegment))) return [`wire ${first.plan.wire.id} crosses wire ${second.plan.wire.id}`];
    return pairs.some(([firstSegment, secondSegment]) => segmentsOverlap(firstSegment, secondSegment)) ? [`wire ${first.plan.wire.id} overlaps wire ${second.plan.wire.id}`] : [];
  }));
}

function findBoxCrossings(drawn: readonly DrawnWire[], input: RouteInput): string[] {
  const solids: (LaidOutBox | LaidOutPanel)[] = [...input.boxesById.values(), ...input.panels];
  return drawn.flatMap((wire) => solids.flatMap((solid) => {
    if (solid.id === wire.plan.from.id || solid.id === wire.plan.to.id) return [];
    const inset = inflated(solid, -2);
    return wire.segments.some((segment) => segmentHitsRect(segment, inset)) ? [`wire ${wire.plan.wire.id} runs through ${solid.kind} ${solid.id}`] : [];
  }));
}

function routeQualityWarnings(drawn: readonly DrawnWire[]): string[] {
  return drawn.flatMap((wire) => {
    if (wire.isFallback) return [`wire ${wire.plan.wire.id} found no clear route, so it is drawn as a straight dog-leg`];
    const bends = Math.max(0, wire.points.length - 2);
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

function routeWithPortOrder(plans: readonly WirePlan[], input: RouteInput, requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, readonly string[]>, budget: SearchBudget): { drawn: DrawnWire[]; crossingCost: number } {
  assignPorts(requestsBySide, groupOrderBySide);
  alignLonePorts(plans, groupOrderBySide);
  const drawn = routeAll(plans, input, budget);
  return { drawn, crossingCost: findBoxCrossings(drawn, input).length * BOX_CROSSING_COST + findCrossings(drawn).length };
}

function routeWithFewestCrossings(plans: readonly WirePlan[], input: RouteInput, requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, string[]>, budget: SearchBudget): DrawnWire[] {
  let best = routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide, budget);
  if (plans.length > MAX_WIRES_FOR_PORT_SEARCH) return best.drawn;
  for (const groupOrder of groupOrderBySide.values()) {
    for (let index = 0; best.crossingCost > 0 && index + 1 < groupOrder.length; index += 1) {
      swapNeighbors(groupOrder, index);
      const trial = routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide, budget);
      if (trial.crossingCost < best.crossingCost) {
        best = trial;
        continue;
      }
      swapNeighbors(groupOrder, index);
    }
  }
  return routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide, budget).drawn;
}

function routeWires(input: RouteInput): RouteResult {
  const plans = planWires(input);
  const requestsBySide = portRequestsBySide(plans);
  const groupOrderBySide = defaultPortOrders(requestsBySide);
  const budget: SearchBudget = { remainingExpansions: MAX_TOTAL_EXPANSIONS };
  const drawn = routeWithFewestCrossings(plans, input, requestsBySide, groupOrderBySide, budget);
  const budgetWarnings = budget.remainingExpansions > 0 ? [] : ['the board has more wires than fit in one routing pass, so some are drawn as straight dog-legs'];
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
    warnings: [...budgetWarnings, ...findBoxCrossings(drawn, input), ...findCrossings(drawn), ...routeQualityWarnings(drawn), ...crowdedSideWarnings(requestsBySide, groupOrderBySide), ...labelWarnings],
    extent: unionOf([...pointRects, ...labelRects]),
  };
}

export { cappedWarnings, labelWidthOf, pathOf, rectsOverlap, routeWires, unionOf, withoutBends };
export type { Point };
