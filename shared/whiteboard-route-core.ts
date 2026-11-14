import { WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Wire, WireEnd } from './contracts/whiteboard.ts';
import type { RememberedRoute } from './contracts/whiteboard-tiles.ts';
import type { PlacedBox, LaidOutWire, Rect } from './whiteboard-layout-core.ts';
import { emptyFlatRects, flatRectsOf, forEachTouchingPairAcross, forEachTouchingPairWithin, orderOfPairs, setFlatRect } from './whiteboard-sweep-core.ts';
import type { FlatRects } from './whiteboard-sweep-core.ts';
import { nudgeSharedLines } from './whiteboard-nudge-core.ts';
import type { PortSlack } from './whiteboard-nudge-core.ts';
import { createSpatialGrid, forEachSlotTouching, gridOfRects, hasSlotTouching, placeSlot } from './spatial-grid-core.ts';
import type { SpatialGrid } from './spatial-grid-core.ts';
import { buildGraphOn, CLEARANCE, prepareObstacles } from './whiteboard-visibility-core.ts';
import type { GraphPort, VisibilityGraph } from './whiteboard-visibility-core.ts';

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
const WIRE_CROSSING_COST = 60;
const ROUTED_LINE_CELL_SIZE = 512;
const SOFT_COST_PER_UNIT = 3;
const MAX_BENDS = 6;
const OFF_FACING_SIDE_COST = 1;
const SIDE_CHOICE_BEND_COST = 1e6;
const INITIAL_STATE_CAPACITY = 4096;
const MAX_WIRES_FOR_LOCAL_ROUTING = 200;
const LOCAL_WINDOW_MARGIN = 240;
const WALL_THICKNESS = 2;
const MAX_AREA_WINDOW_SOLIDS = 3000;
const WIDER_WINDOW_MARGINS = [LOCAL_WINDOW_MARGIN * 4, LOCAL_WINDOW_MARGIN * 16];
const AREA_CELL_SIZE = 512;
const MAX_RECTS_FOR_DIRECT_SCAN = 64;
const PORT_SPACING = 14;
const PORT_INSET = 8;
const LABEL_CHAR_WIDTH = 6.6;
const LABEL_GAP = 5;
const LABEL_ASCENT = 10;
const LABEL_DESCENT = 3;
const LABEL_CLEARANCE = 2;
const LABEL_BOX_CLEARANCE = 6;
const LABEL_SLIDE_FRACTIONS = [0.5, 0.35, 0.65, 0.2, 0.8];
const LABEL_CELL_SIZE = 256;

const RIGHT = 0;
const LEFT = 1;
const STEP_BY_DIRECTION = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }] as const;
const OUTWARD_DIRECTION_BY_SIDE: Record<Side, number> = { right: 0, left: 1, bottom: 2, top: 3 };
const INWARD_DIRECTION_BY_SIDE: Record<Side, number> = { left: 0, right: 1, top: 2, bottom: 3 };
const REVERSE_DIRECTION = [1, 0, 3, 2];
const STRAIGHT_ROUTE_MARGIN = 1;
const CURVE_SAMPLES = 16;
const CURVE_BEND_FRACTION = 0.2;
const MIN_SEGMENT_HANDLE_LENGTH = 24;

interface AreaObstacles {
  hardRects: readonly Rect[];
  softRects: readonly Rect[];
}

interface RouteInput {
  wires: readonly Wire[];
  boxesById: ReadonlyMap<string, PlacedBox>;
  softObstacles: readonly Rect[];
  contentTop: number;
  contextWires?: readonly Wire[];
  obstaclesIn?: (area: Rect) => AreaObstacles;
  storedWireKeyOf?: (wire: Wire) => string | undefined;
}

interface PortEnds {
  start: Point;
  end: Point;
  busKey: string | null;
}

interface IndexPairs {
  firsts: number[];
  seconds: number[];
  isCrossings: boolean[];
}

interface WarningPairs {
  wireIds: string[];
  wireSignatureById: Map<string, string>;
  solidKeys: string[];
  wirePairs: IndexPairs;
  runsThroughPairs: IndexPairs;
}

interface WarningList {
  count: number;
  messageAt: (index: number) => string;
}

interface RouteMemory {
  contentTop: number;
  rectByKey: Map<string, Rect>;
  routeById: Map<string, RememberedRoute>;
  warningPairs: WarningPairs | null;
}

interface RouteReuse {
  routeById: ReadonlyMap<string, RememberedRoute>;
  cleanIds: ReadonlySet<string>;
  isPreview: boolean;
}

interface RouteResult {
  wires: LaidOutWire[];
  segments: Segment[];
  collectWarnings: () => WarningList[];
  extent: Rect | null;
  memory: RouteMemory;
  portEndsById: Map<string, PortEnds>;
}

interface WirePlan {
  wire: Wire;
  from: PlacedBox;
  to: PlacedBox;
  styleKey: string;
  exitSide: Side;
  entrySide: Side;
  busKey: string | null;
  exitKey: string;
  start: Point;
  end: Point;
  found: FoundRoute | null;
}

interface FoundRoute {
  exitSide: Side;
  entrySide: Side;
  start: Point;
  end: Point;
  points: Point[];
}

interface DrawnWire {
  plan: WirePlan;
  points: Point[];
  segments: Segment[];
  routedPoints: Point[];
  states: number[] | null;
}


interface SideTerminal {
  side: Side;
  point: Point;
  direction: number;
  bias: number;
}

interface PlacedTerminal extends SideTerminal {
  node: number;
  component: number;
  approachStart: number;
  approachEnd: number;
}

interface SideChoice {
  plan: WirePlan;
  exits: SideTerminal[];
  entries: SideTerminal[];
}

interface SearchOutcome {
  states: number[];
  exit: PlacedTerminal;
  entry: PlacedTerminal;
}

interface MinHeap {
  states: Int32Array;
  priorities: Float64Array;
  tieBreaks: Float64Array;
  size: number;
  lastPoppedPriority: number;
}

interface RoutedLines {
  grid: SpatialGrid;
  segments: Segment[];
}

interface Crossables {
  horizontals: Segment[];
  verticals: Segment[];
}

interface SearchBuffers {
  bestCost: Float64Array;
  cameFrom: Int32Array;
  touchedStates: Int32Array;
  touchedCount: number;
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

function warningListOf(messages: readonly string[]): WarningList {
  return { count: messages.length, messageAt: (index) => messages[index] ?? '' };
}

function cappedWarningLists(lists: readonly WarningList[]): string[] {
  const total = lists.reduce((sum, list) => sum + list.count, 0);
  const shownCount = total <= WHITEBOARD_LIMITS.layoutWarnings ? total : WHITEBOARD_LIMITS.layoutWarnings - 1;
  const shown: string[] = [];
  for (const list of lists) {
    for (let index = 0; index < list.count && shown.length < shownCount; index += 1) shown.push(list.messageAt(index));
  }
  return total === shownCount ? shown : [...shown, `and ${total - shownCount} more`];
}

function cappedWarnings(warnings: readonly string[]): string[] {
  return cappedWarningLists([warningListOf(warnings)]);
}

function hasHorizontalGap(first: Rect, second: Rect): boolean {
  return second.x >= first.x + first.width || second.x + second.width <= first.x;
}

interface SidePair {
  exitSide: Side;
  entrySide: Side;
}

function facingSides(from: PlacedBox, to: PlacedBox): SidePair {
  if (from.id === to.id) return { exitSide: 'right', entrySide: 'top' };
  const fromCenter = centerOf(from);
  const toCenter = centerOf(to);
  if (hasHorizontalGap(from, to)) return toCenter.x > fromCenter.x ? { exitSide: 'right', entrySide: 'left' } : { exitSide: 'left', entrySide: 'right' };
  return toCenter.y > fromCenter.y ? { exitSide: 'bottom', entrySide: 'top' } : { exitSide: 'top', entrySide: 'bottom' };
}

const ALL_SIDES: readonly Side[] = ['right', 'left', 'bottom', 'top'];

function probeOf(plan: WirePlan, pair: SidePair): WirePlan {
  const centeredStart = portPositions(plan.from, pair.exitSide, 1)[0] ?? centerOf(plan.from);
  const centeredEnd = portPositions(plan.to, pair.entrySide, 1)[0] ?? centerOf(plan.to);
  if (!isFacing(pair.exitSide, pair.entrySide)) return { ...plan, ...pair, start: centeredStart, end: centeredEnd };
  const alignedEnd = alignedAlong(centeredEnd, pair.entrySide, plan.to, centeredStart);
  const start = alignedEnd === centeredEnd ? alignedAlong(centeredStart, pair.exitSide, plan.from, centeredEnd) : centeredStart;
  return { ...plan, ...pair, start, end: alignedEnd };
}

function pointsOfStates(graph: VisibilityGraph, states: readonly number[]): Point[] {
  return withoutBends(states.map((state) => ({ x: graph.xs[state >> 2] ?? 0, y: graph.ys[state >> 2] ?? 0 })));
}

function sideTerminalsOf(box: PlacedBox, sides: readonly Side[], facingSide: Side, facingPoint: Point, directionBySide: Record<Side, number>): SideTerminal[] {
  return sides.map((side) => ({
    side,
    point: side === facingSide ? facingPoint : portPositions(box, side, 1)[0] ?? centerOf(box),
    direction: directionBySide[side],
    bias: side === facingSide ? 0 : OFF_FACING_SIDE_COST,
  }));
}

function otherSidesFirst(facingSide: Side): Side[] {
  return [facingSide, ...ALL_SIDES.filter((side) => side !== facingSide)];
}

function sideChoiceOf(plan: WirePlan, facing: SidePair): SideChoice | null {
  const { wire, from, to } = plan;
  if (from.id === to.id) return null;
  const exitSides = wire.fromSide ? [plan.exitSide] : otherSidesFirst(facing.exitSide);
  const entrySides = wire.toSide ? [wire.toSide] : otherSidesFirst(facing.entrySide);
  if (exitSides.length < 2 && entrySides.length < 2) return null;
  const facingProbe = probeOf(plan, { exitSide: exitSides[0] ?? facing.exitSide, entrySide: entrySides[0] ?? facing.entrySide });
  const exits = sideTerminalsOf(from, exitSides, exitSides[0] ?? facing.exitSide, facingProbe.start, OUTWARD_DIRECTION_BY_SIDE);
  const entries = sideTerminalsOf(to, entrySides, entrySides[0] ?? facing.entrySide, facingProbe.end, INWARD_DIRECTION_BY_SIDE);
  return { plan, exits, entries };
}

function choicePortsOf(choices: readonly SideChoice[]): GraphPort[] {
  return choices.flatMap((choice) => [
    ...choice.exits.map((exit) => ({ x: exit.point.x, y: exit.point.y, outwardDirection: exit.direction })),
    ...choice.entries.map((entry) => ({ x: entry.point.x, y: entry.point.y, outwardDirection: REVERSE_DIRECTION[entry.direction] ?? 0 })),
  ]);
}

function applySideChoice(choice: SideChoice, exit: SideTerminal, entry: SideTerminal, points: Point[]): void {
  choice.plan.exitSide = exit.side;
  choice.plan.entrySide = entry.side;
  choice.plan.found = { exitSide: exit.side, entrySide: entry.side, start: exit.point, end: entry.point, points };
}

function isOutwardAlong(exit: SideTerminal, entry: SideTerminal): boolean {
  const delta = { x: entry.point.x - exit.point.x, y: entry.point.y - exit.point.y };
  if (delta.x !== 0 && delta.y !== 0) return false;
  const direction = delta.x > 0 ? OUTWARD_DIRECTION_BY_SIDE.right : delta.x < 0 ? OUTWARD_DIRECTION_BY_SIDE.left : delta.y > 0 ? OUTWARD_DIRECTION_BY_SIDE.bottom : OUTWARD_DIRECTION_BY_SIDE.top;
  return (delta.x !== 0 || delta.y !== 0) && exit.direction === direction && entry.direction === direction;
}

function isHorizontalDirection(direction: number): boolean {
  return direction === OUTWARD_DIRECTION_BY_SIDE.right || direction === OUTWARD_DIRECTION_BY_SIDE.left;
}

function directionFrom(from: Point, to: Point): number {
  if (to.x > from.x) return OUTWARD_DIRECTION_BY_SIDE.right;
  if (to.x < from.x) return OUTWARD_DIRECTION_BY_SIDE.left;
  return to.y > from.y ? OUTWARD_DIRECTION_BY_SIDE.bottom : OUTWARD_DIRECTION_BY_SIDE.top;
}

function oneBendPointsOf(exit: SideTerminal, entry: SideTerminal): Point[] | null {
  if (isHorizontalDirection(exit.direction) === isHorizontalDirection(entry.direction)) return null;
  const corner = isHorizontalDirection(exit.direction) ? { x: entry.point.x, y: exit.point.y } : { x: exit.point.x, y: entry.point.y };
  if (isSamePoint(corner, exit.point) || isSamePoint(corner, entry.point)) return null;
  if (directionFrom(exit.point, corner) !== exit.direction || directionFrom(corner, entry.point) !== entry.direction) return null;
  return [exit.point, corner, entry.point];
}

function isHardClear(points: readonly Point[], plan: WirePlan, input: RouteInput): boolean {
  return segmentsOf([...points]).every((segment) => {
    const corridor = pointBoundsOf(segment.from, segment.to);
    const obstacles = input.obstaclesIn?.(inflated(corridor, STRAIGHT_ROUTE_MARGIN));
    return obstacles !== undefined && !obstacles.hardRects.some((rect) => rect !== plan.from && rect !== plan.to && rectsOverlap(inflated(rect, STRAIGHT_ROUTE_MARGIN), corridor));
  });
}

function pathLengthOf(points: readonly Point[]): number {
  return segmentsOf([...points]).reduce((sum, segment) => sum + segmentLength(segment), 0);
}

function isCorridorClear(segment: Segment, plan: WirePlan, input: RouteInput, routedLines: RoutedLines): boolean {
  const corridor = pointBoundsOf(segment.from, segment.to);
  const obstacles = input.obstaclesIn?.(inflated(corridor, STRAIGHT_ROUTE_MARGIN));
  if (!obstacles) return false;
  if (obstacles.hardRects.some((rect) => rect !== plan.from && rect !== plan.to && rectsOverlap(inflated(rect, STRAIGHT_ROUTE_MARGIN), corridor))) return false;
  if (obstacles.softRects.some((rect) => rectsOverlap(rect, corridor))) return false;
  const crossables = crossablesIn(routedLines, corridor);
  const others = isHorizontal(segment) ? crossables.verticals : crossables.horizontals;
  return !others.some((other) => segmentsCross(segment, other));
}

interface ShortRoute {
  exit: SideTerminal;
  entry: SideTerminal;
  points: Point[];
}

interface RouteCandidate {
  exit: SideTerminal;
  entry: SideTerminal;
  points: Point[];
  bends: number;
  cost: number;
}

function candidatePointsOf(exit: SideTerminal, entry: SideTerminal): Point[] | null {
  if (isOutwardAlong(exit, entry)) return [exit.point, entry.point];
  return oneBendPointsOf(exit, entry);
}

function routeCandidatesOf(choice: SideChoice): RouteCandidate[] {
  return choice.exits.flatMap((exit) => choice.entries.flatMap((entry) => {
    const points = candidatePointsOf(exit, entry);
    return points ? [{ exit, entry, points, bends: points.length - 2, cost: pathLengthOf(points) + exit.bias + entry.bias }] : [];
  }));
}

function facingJogPointsOf(exit: SideTerminal, entry: SideTerminal): Point[] | null {
  const step = STEP_BY_DIRECTION[exit.direction];
  if (!step || exit.direction !== entry.direction) return null;
  const distanceAhead = (entry.point.x - exit.point.x) * step.x + (entry.point.y - exit.point.y) * step.y;
  if (distanceAhead < CLEARANCE * 2) return null;
  const middle = { x: Math.round(exit.point.x + step.x * distanceAhead / 2), y: Math.round(exit.point.y + step.y * distanceAhead / 2) };
  const corners = isHorizontalDirection(exit.direction)
    ? [{ x: middle.x, y: exit.point.y }, { x: middle.x, y: entry.point.y }]
    : [{ x: exit.point.x, y: middle.y }, { x: entry.point.x, y: middle.y }];
  const points = [exit.point, ...corners, entry.point];
  return withoutBends(points).length === points.length ? points : null;
}

function keepsClearanceFromOtherBoxes(points: readonly Point[], plan: WirePlan, input: RouteInput): boolean {
  return segmentsOf([...points]).every((segment) => {
    const corridor = inflated(pointBoundsOf(segment.from, segment.to), CLEARANCE);
    const obstacles = input.obstaclesIn?.(corridor);
    return obstacles !== undefined && !obstacles.hardRects.some((rect) => rect !== plan.from && rect !== plan.to && rectsOverlap(rect, corridor));
  });
}

function facingJogOf(choice: SideChoice, input: RouteInput, routedLines: RoutedLines): ShortRoute | null {
  const exit = choice.exits.find((terminal) => terminal.bias === 0);
  const entry = choice.entries.find((terminal) => terminal.bias === 0);
  const points = exit && entry ? facingJogPointsOf(exit, entry) : null;
  if (!exit || !entry || !points || !keepsClearanceFromOtherBoxes(points, choice.plan, input)) return null;
  if (!segmentsOf(points).every((segment) => isCorridorClear(segment, choice.plan, input, routedLines))) return null;
  return { exit, entry, points };
}

function shortRouteOf(choice: SideChoice, input: RouteInput, routedLines: RoutedLines): ShortRoute | null {
  const clearCandidates = routeCandidatesOf(choice).filter((candidate) => isHardClear(candidate.points, choice.plan, input));
  const fewestBends = Math.min(...clearCandidates.map((candidate) => candidate.bends));
  const facingJog = fewestBends > 0 ? facingJogOf(choice, input, routedLines) : null;
  if (facingJog) return facingJog;
  const rivals = clearCandidates.filter((candidate) => candidate.bends === fewestBends);
  const cheapestCost = Math.min(...rivals.map((candidate) => candidate.cost));
  const cheapest = rivals.filter((candidate) => candidate.cost === cheapestCost);
  const [best] = cheapest;
  if (!best || cheapest.length > 1) return null;
  if (best.bends > 0 && !segmentsOf(best.points).every((segment) => isCorridorClear(segment, choice.plan, input, routedLines))) return null;
  return { exit: best.exit, entry: best.entry, points: best.points };
}

function chooseSidesLocally(choices: readonly SideChoice[], input: RouteInput, reuse: RouteReuse): void {
  const buffers = createSearchBuffers();
  const routedLines = createRoutedLines();
  for (const choice of choices) {
    const shortRoute = shortRouteOf(choice, input, routedLines);
    if (shortRoute) {
      applySideChoice(choice, shortRoute.exit, shortRoute.entry, shortRoute.points);
      addRoutedLines(routedLines, segmentsOf(shortRoute.points));
      continue;
    }
    const window = windowOf(choice.plan, reuse);
    const obstacles = windowObstaclesOf(input, window);
    const graph = obstacles ? windowGraphOf(choicePortsOf([choice]), input, window, obstacles) : null;
    const chosen = graph ? searchBetween(graph, choice.exits, choice.entries, SIDE_CHOICE_BEND_COST, buffers, crossablesIn(routedLines, window)) : null;
    resetSearchBuffers(buffers);
    if (!graph || !chosen) continue;
    const points = pointsOfStates(graph, chosen.states);
    applySideChoice(choice, chosen.exit, chosen.entry, points);
    addRoutedLines(routedLines, segmentsOf(points));
  }
}

function chooseSidesBySearch(plans: readonly WirePlan[], facingByPlan: ReadonlyMap<WirePlan, SidePair>, input: RouteInput, reuse: RouteReuse): void {
  const choices = plans.flatMap((plan) => {
    if (reuse.cleanIds.has(plan.wire.id)) return [];
    const choice = sideChoiceOf(plan, facingByPlan.get(plan) ?? { exitSide: plan.exitSide, entrySide: plan.entrySide });
    return choice ? [choice] : [];
  });
  if (choices.length > 0) chooseSidesLocally(choices, input, reuse);
}

function joinFacingBuses(plans: readonly WirePlan[], countedPlans: readonly WirePlan[], facingByPlan: ReadonlyMap<WirePlan, SidePair>): void {
  const busOf = (plan: WirePlan, side: Side) => `${plan.to.id}|${plan.styleKey}|${side}`;
  const facingEntryCountByBus = new Map<string, number>();
  for (const plan of countedPlans) {
    if (plan.entrySide !== facingByPlan.get(plan)?.entrySide) continue;
    facingEntryCountByBus.set(busOf(plan, plan.entrySide), (facingEntryCountByBus.get(busOf(plan, plan.entrySide)) ?? 0) + 1);
  }
  for (const plan of plans) {
    const facing = facingByPlan.get(plan);
    if (!facing || plan.entrySide === facing.entrySide || plan.wire.toSide) continue;
    if ((facingEntryCountByBus.get(busOf(plan, facing.entrySide)) ?? 0) === 0) continue;
    plan.exitSide = plan.wire.fromSide ? plan.exitSide : facing.exitSide;
    plan.entrySide = facing.entrySide;
  }
}

function plannedWireOf(wire: Wire, input: RouteInput, remembered: RememberedRoute | undefined): { plan: WirePlan; facing: SidePair } | null {
  const from = typeof wire.from === 'string' ? input.boxesById.get(wire.from) : undefined;
  const to = typeof wire.to === 'string' ? input.boxesById.get(wire.to) : undefined;
  if (!from || !to) return null;
  const facing = facingSides(from, to);
  const plan: WirePlan = {
    wire, from, to, styleKey: `${wire.dashed}|${wire.tone}|${wire.width}|${wire.arrows}`,
    exitSide: wire.fromSide ?? facing.exitSide, entrySide: wire.toSide ?? facing.entrySide,
    busKey: null, exitKey: '', start: centerOf(from), end: centerOf(to), found: null,
  };
  if (remembered) {
    plan.exitSide = remembered.exitSide;
    plan.entrySide = remembered.entrySide;
  }
  return { plan, facing };
}

interface PlannedWires {
  plans: WirePlan[];
  contextPlans: WirePlan[];
}

function planWires(input: RouteInput, reuse: RouteReuse): PlannedWires {
  const facingByPlan = new Map<WirePlan, SidePair>();
  const plans = input.wires.flatMap((wire): WirePlan[] => {
    const planned = plannedWireOf(wire, input, reuse.cleanIds.has(wire.id) ? reuse.routeById.get(wire.id) : undefined);
    if (!planned) return [];
    facingByPlan.set(planned.plan, planned.facing);
    return [planned.plan];
  });
  const contextPlans = (input.contextWires ?? []).flatMap((wire): WirePlan[] => {
    const planned = plannedWireOf(wire, input, reuse.routeById.get(wire.id));
    if (!planned) return [];
    facingByPlan.set(planned.plan, planned.facing);
    return [planned.plan];
  });
  chooseSidesBySearch(plans, facingByPlan, input, reuse);
  joinFacingBuses(plans, [...plans, ...contextPlans], facingByPlan);
  const allPlans = [...plans, ...contextPlans];
  for (const plan of allPlans) plan.exitKey = `${plan.from.id}|${plan.exitSide}|${plan.styleKey}`;
  const busKeyOf = (plan: WirePlan) => `${plan.to.id}|${plan.entrySide}|${plan.styleKey}`;
  const memberCountByBusKey = new Map<string, number>();
  for (const plan of allPlans) memberCountByBusKey.set(busKeyOf(plan), (memberCountByBusKey.get(busKeyOf(plan)) ?? 0) + 1);
  for (const plan of allPlans) {
    if ((memberCountByBusKey.get(busKeyOf(plan)) ?? 0) > 1) plan.busKey = busKeyOf(plan);
  }
  return { plans, contextPlans };
}

function portPositions(box: PlacedBox, side: Side, count: number): Point[] {
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

function portCapacity(box: PlacedBox, side: Side): number {
  const sideLength = isSideways(side) ? box.height : box.width;
  return Math.max(1, Math.floor((sideLength - PORT_INSET * 2) / PORT_SPACING) + 1);
}

interface PortRequest {
  box: PlacedBox;
  side: Side;
  groupKey: string;
  wireId: string;
  farPoint: Point;
  assign: (point: Point) => void;
}

function portRequestsBySide(plans: readonly WirePlan[], completeBoxIds: ReadonlySet<string> | null = null): Map<string, PortRequest[]> {
  const allRequests: PortRequest[] = plans.flatMap((plan) => [
    { box: plan.from, side: plan.exitSide, groupKey: `exit|${plan.styleKey}`, wireId: plan.wire.id, farPoint: centerOf(plan.to), assign: (point: Point) => { plan.start = point; } },
    { box: plan.to, side: plan.entrySide, groupKey: plan.busKey ? `bus|${plan.busKey}` : `entry|${plan.wire.id}`, wireId: plan.wire.id, farPoint: centerOf(plan.from), assign: (point: Point) => { plan.end = point; } },
  ]);
  const requests = completeBoxIds ? allRequests.filter((request) => completeBoxIds.has(request.box.id)) : allRequests;
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

function alignedAlong(point: Point, side: Side, box: PlacedBox, target: Point): Point {
  if (isSideways(side)) {
    const isInRange = target.y >= box.y + PORT_INSET && target.y <= box.y + box.height - PORT_INSET;
    return isInRange ? { x: point.x, y: target.y } : point;
  }
  const isInRange = target.x >= box.x + PORT_INSET && target.x <= box.x + box.width - PORT_INSET;
  return isInRange ? { x: target.x, y: point.y } : point;
}

function alignLonePorts(plans: readonly WirePlan[], groupOrderBySide: ReadonlyMap<string, readonly string[]>): void {
  const isLonePort = (box: PlacedBox, side: Side) => (groupOrderBySide.get(`${box.id}|${side}`)?.length ?? 0) === 1;
  const memberCountByExitKey = new Map([...groupedBy(plans, (plan) => plan.exitKey)].map(([exitKey, members]) => [exitKey, members.length]));
  for (const plan of plans) {
    if (plan.from.id === plan.to.id || !isFacing(plan.exitSide, plan.entrySide)) continue;
    const alignedEnd = plan.busKey === null && isLonePort(plan.to, plan.entrySide) ? alignedAlong(plan.end, plan.entrySide, plan.to, plan.start) : plan.end;
    if (alignedEnd !== plan.end) {
      plan.end = alignedEnd;
      continue;
    }
    if (isLonePort(plan.from, plan.exitSide) && memberCountByExitKey.get(plan.exitKey) === 1) plan.start = alignedAlong(plan.start, plan.exitSide, plan.from, plan.end);
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

function portsOf(plans: readonly WirePlan[]): GraphPort[] {
  return plans.flatMap((plan) => [
    { x: plan.start.x, y: plan.start.y, outwardDirection: OUTWARD_DIRECTION_BY_SIDE[plan.exitSide] },
    { x: plan.end.x, y: plan.end.y, outwardDirection: OUTWARD_DIRECTION_BY_SIDE[plan.entrySide] },
  ]);
}

function areaQueryOf(input: RouteInput): (area: Rect) => AreaObstacles {
  const boxes = [...input.boxesById.values()];
  const boxGrid = gridOfRects(boxes, AREA_CELL_SIZE);
  const softGrid = gridOfRects(input.softObstacles, AREA_CELL_SIZE);
  return (area) => {
    const hardRects: Rect[] = [];
    const softRects: Rect[] = [];
    forEachSlotTouching(boxGrid, area, (slot) => {
      const box = boxes[slot];
      if (box) hardRects.push(box);
    });
    forEachSlotTouching(softGrid, area, (slot) => {
      const soft = input.softObstacles[slot];
      if (soft) softRects.push(soft);
    });
    return { hardRects, softRects };
  };
}

function withAreaQuery(input: RouteInput): RouteInput {
  return input.obstaclesIn ? input : { ...input, obstaclesIn: areaQueryOf(input) };
}

function wallsAround(window: Rect): Rect[] {
  const outerLeft = window.x - WALL_THICKNESS;
  const outerTop = window.y - WALL_THICKNESS;
  const outerWidth = window.width + WALL_THICKNESS * 2;
  const outerHeight = window.height + WALL_THICKNESS * 2;
  return [
    { x: outerLeft, y: outerTop, width: outerWidth, height: WALL_THICKNESS },
    { x: outerLeft, y: window.y + window.height, width: outerWidth, height: WALL_THICKNESS },
    { x: outerLeft, y: outerTop, width: WALL_THICKNESS, height: outerHeight },
    { x: window.x + window.width, y: outerTop, width: WALL_THICKNESS, height: outerHeight },
  ];
}

function windowObstaclesOf(input: RouteInput, window: Rect): AreaObstacles | null {
  const obstacles = input.obstaclesIn?.(window) ?? null;
  return obstacles && obstacles.hardRects.length <= MAX_AREA_WINDOW_SOLIDS ? obstacles : null;
}

function windowGraphOf(ports: readonly GraphPort[], input: RouteInput, window: Rect, obstacles: AreaObstacles): VisibilityGraph | null {
  const prepared = prepareObstacles({ hardRects: [...obstacles.hardRects, ...wallsAround(window)], softRects: obstacles.softRects, contentTop: input.contentTop });
  return prepared ? buildGraphOn(prepared, ports) : null;
}

function graphThroughOtherBoxesOf(plan: WirePlan, input: RouteInput, window: Rect, obstacles: AreaObstacles): VisibilityGraph | null {
  const endBoxes = plan.from.id === plan.to.id ? [plan.from] : [plan.from, plan.to];
  const otherBoxes = obstacles.hardRects.filter((rect) => rect !== plan.from && rect !== plan.to);
  const prepared = prepareObstacles({ hardRects: [...endBoxes, ...wallsAround(window)], softRects: [...obstacles.softRects, ...otherBoxes], contentTop: input.contentTop });
  return prepared ? buildGraphOn(prepared, portsOf([plan])) : null;
}

function windowOf(plan: WirePlan, reuse: RouteReuse, margin = LOCAL_WINDOW_MARGIN): Rect {
  const rememberedPoints = reuse.routeById.get(plan.wire.id)?.points ?? [];
  const pointRects = rememberedPoints.map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 }));
  return inflated(unionOf([plan.from, plan.to, ...pointRects]) ?? plan.from, margin);
}

function createMinHeap(): MinHeap {
  return { states: new Int32Array(1024), priorities: new Float64Array(1024), tieBreaks: new Float64Array(1024), size: 0, lastPoppedPriority: 0 };
}

function isHeapEntryBefore(heap: MinHeap, first: number, second: number): boolean {
  const firstPriority = heap.priorities[first] ?? 0;
  const secondPriority = heap.priorities[second] ?? 0;
  return firstPriority < secondPriority || (firstPriority === secondPriority && (heap.tieBreaks[first] ?? 0) < (heap.tieBreaks[second] ?? 0));
}

function swapHeapEntries(heap: MinHeap, first: number, second: number): void {
  const firstState = heap.states[first] ?? 0;
  const firstPriority = heap.priorities[first] ?? 0;
  const firstTieBreak = heap.tieBreaks[first] ?? 0;
  heap.states[first] = heap.states[second] ?? 0;
  heap.priorities[first] = heap.priorities[second] ?? 0;
  heap.tieBreaks[first] = heap.tieBreaks[second] ?? 0;
  heap.states[second] = firstState;
  heap.priorities[second] = firstPriority;
  heap.tieBreaks[second] = firstTieBreak;
}

function reserveHeapSlot(heap: MinHeap): number {
  if (heap.size === heap.states.length) {
    const states = new Int32Array(heap.size * 2);
    const priorities = new Float64Array(heap.size * 2);
    const tieBreaks = new Float64Array(heap.size * 2);
    states.set(heap.states);
    priorities.set(heap.priorities);
    tieBreaks.set(heap.tieBreaks);
    heap.states = states;
    heap.priorities = priorities;
    heap.tieBreaks = tieBreaks;
  }
  heap.size += 1;
  return heap.size - 1;
}

function siftUpHeap(heap: MinHeap, slot: number): void {
  let index = slot;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!isHeapEntryBefore(heap, index, parent)) return;
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
  swapHeapEntries(heap, 0, heap.size);
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.size && isHeapEntryBefore(heap, left, smallest)) smallest = left;
    if (right < heap.size && isHeapEntryBefore(heap, right, smallest)) smallest = right;
    if (smallest === index) return top;
    swapHeapEntries(heap, smallest, index);
    index = smallest;
  }
}

function createSearchBuffers(): SearchBuffers {
  return { bestCost: new Float64Array(INITIAL_STATE_CAPACITY).fill(Infinity), cameFrom: new Int32Array(INITIAL_STATE_CAPACITY).fill(-1), touchedStates: new Int32Array(INITIAL_STATE_CAPACITY), touchedCount: 0, heap: createMinHeap() };
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

function markStateTouched(buffers: SearchBuffers, state: number): void {
  if (buffers.touchedCount === buffers.touchedStates.length) {
    const touchedStates = new Int32Array(buffers.touchedCount * 2);
    touchedStates.set(buffers.touchedStates);
    buffers.touchedStates = touchedStates;
  }
  buffers.touchedStates[buffers.touchedCount] = state;
  buffers.touchedCount += 1;
}

function resetSearchBuffers(buffers: SearchBuffers): void {
  for (let index = 0; index < buffers.touchedCount; index += 1) {
    const state = buffers.touchedStates[index] ?? 0;
    buffers.bestCost[state] = Infinity;
    buffers.cameFrom[state] = -1;
  }
  buffers.touchedCount = 0;
  buffers.heap.size = 0;
}

function routeOnGraph(graph: VisibilityGraph, plan: WirePlan, buffers: SearchBuffers, crossables: Crossables): number[] | null {
  const exit = { side: plan.exitSide, point: plan.start, direction: OUTWARD_DIRECTION_BY_SIDE[plan.exitSide], bias: 0 };
  const entry = { side: plan.entrySide, point: plan.end, direction: INWARD_DIRECTION_BY_SIDE[plan.entrySide], bias: 0 };
  const states = searchBetween(graph, [exit], [entry], BEND_COST, buffers, crossables)?.states ?? null;
  resetSearchBuffers(buffers);
  return states;
}

function isAlongX(direction: number): boolean {
  return direction === RIGHT || direction === LEFT;
}

function fewestBendsTo(direction: number, entry: PlacedTerminal, x: number, y: number): number {
  if (direction === REVERSE_DIRECTION[entry.direction]) return 2;
  const isEntryAlongX = isAlongX(entry.direction);
  const along = isEntryAlongX ? x : y;
  const across = isEntryAlongX ? y : x;
  const approachLine = isEntryAlongX ? entry.point.y : entry.point.x;
  const isWithinApproach = entry.approachStart <= along && along <= entry.approachEnd;
  const step = STEP_BY_DIRECTION[direction] ?? { x: 0, y: 0 };
  if (direction === entry.direction) {
    const towardPort = isEntryAlongX ? (entry.point.x - x) * step.x : (entry.point.y - y) * step.y;
    return across === approachLine && isWithinApproach && towardPort >= 0 ? 0 : 2;
  }
  const towardLine = (approachLine - across) * (isEntryAlongX ? step.y : step.x);
  return isWithinApproach && towardLine >= 0 ? 1 : 3;
}

function placedTerminalsOf(graph: VisibilityGraph, terminals: readonly SideTerminal[]): PlacedTerminal[] {
  return terminals.flatMap((terminal) => {
    const node = graph.nodeAt(terminal.point.x, terminal.point.y);
    if (node < 0) return [];
    const [approachStart, approachEnd] = graph.pieceExtentOf(node, isAlongX(terminal.direction));
    return [{ ...terminal, node, component: graph.componentOf(node), approachStart, approachEnd }];
  });
}

function terminalAt(terminals: readonly PlacedTerminal[], node: number): PlacedTerminal | null {
  for (const terminal of terminals) {
    if (terminal.node === node) return terminal;
  }
  return null;
}

const NO_CROSSABLES: Crossables = { horizontals: [], verticals: [] };

function createRoutedLines(): RoutedLines {
  return { grid: createSpatialGrid(ROUTED_LINE_CELL_SIZE), segments: [] };
}

function addRoutedLines(lines: RoutedLines, segments: readonly Segment[]): void {
  for (const segment of segments) {
    placeSlot(lines.grid, lines.segments.length, pointBoundsOf(segment.from, segment.to));
    lines.segments.push(segment);
  }
}

function crossablesIn(lines: RoutedLines, window: Rect): Crossables {
  const crossables: Crossables = { horizontals: [], verticals: [] };
  forEachSlotTouching(lines.grid, window, (slot) => {
    const segment = lines.segments[slot];
    if (segment) (isHorizontal(segment) ? crossables.horizontals : crossables.verticals).push(segment);
  });
  return crossables;
}

function crossingCountOf(crossables: Crossables, graph: VisibilityGraph, node: number, nextNode: number): number {
  const fromX = graph.xs[node] ?? 0;
  const fromY = graph.ys[node] ?? 0;
  const toX = graph.xs[nextNode] ?? 0;
  const toY = graph.ys[nextNode] ?? 0;
  let crossingCount = 0;
  if (fromY === toY) {
    for (const vertical of crossables.verticals) {
      if (isStrictlyBetween(vertical.from.x, fromX, toX) && isStrictlyBetween(fromY, vertical.from.y, vertical.to.y)) crossingCount += 1;
    }
    return crossingCount;
  }
  for (const horizontal of crossables.horizontals) {
    if (isStrictlyBetween(horizontal.from.y, fromY, toY) && isStrictlyBetween(fromX, horizontal.from.x, horizontal.to.x)) crossingCount += 1;
  }
  return crossingCount;
}

function searchBetween(graph: VisibilityGraph, exits: readonly SideTerminal[], entries: readonly SideTerminal[], bendCost: number, buffers: SearchBuffers, crossables: Crossables = NO_CROSSABLES): SearchOutcome | null {
  graph.beginSearch();
  const placedEntries = placedTerminalsOf(graph, entries);
  const placedExits = placedTerminalsOf(graph, exits).filter((exit) => placedEntries.some((entry) => entry.component === exit.component));
  const reachableEntries = placedEntries.filter((entry) => placedExits.some((exit) => exit.component === entry.component));
  if (placedExits.length === 0 || reachableEntries.length === 0) return null;
  const { heap } = buffers;
  ensureStateCapacity(buffers, graph.nodeCount * 4);
  const estimate = (node: number, direction: number) => {
    const x = graph.xs[node] ?? 0;
    const y = graph.ys[node] ?? 0;
    let nearest = Infinity;
    for (const entry of reachableEntries) {
      nearest = Math.min(nearest, Math.abs(entry.point.x - x) + Math.abs(entry.point.y - y) + fewestBendsTo(direction, entry, x, y) * bendCost + entry.bias);
    }
    return nearest;
  };
  for (const exit of placedExits) {
    const state = exit.node * 4 + exit.direction;
    buffers.bestCost[state] = exit.bias;
    markStateTouched(buffers, state);
    const slot = reserveHeapSlot(heap);
    heap.states[slot] = state;
    heap.priorities[slot] = exit.bias + estimate(exit.node, exit.direction);
    heap.tieBreaks[slot] = -exit.bias;
    siftUpHeap(heap, slot);
  }
  for (;;) {
    const state = popFromHeap(heap);
    if (state < 0) return null;
    const node = state >> 2;
    const direction = state & 3;
    const arrivedEntry = terminalAt(reachableEntries, node);
    if (arrivedEntry && direction === arrivedEntry.direction) {
      const states = reconstructNodes(buffers.cameFrom, state);
      const exit = terminalAt(placedExits, (states[0] ?? 0) >> 2);
      return exit ? { states, exit, entry: arrivedEntry } : null;
    }
    const costSoFar = buffers.bestCost[state] ?? Infinity;
    if (heap.lastPoppedPriority > costSoFar + estimate(node, direction) + 1e-6) continue;
    const departingExit = terminalAt(placedExits, node);
    for (let nextDirection = 0; nextDirection < 4; nextDirection += 1) {
      if (departingExit && nextDirection !== departingExit.direction) continue;
      if (nextDirection === REVERSE_DIRECTION[direction]) continue;
      const nextNode = graph.neighborOf(node, nextDirection);
      if (nextNode < 0) continue;
      const nextEntry = terminalAt(reachableEntries, nextNode);
      if (nextEntry && nextDirection !== nextEntry.direction) continue;
      ensureStateCapacity(buffers, graph.nodeCount * 4);
      const length = Math.abs((graph.xs[nextNode] ?? 0) - (graph.xs[node] ?? 0)) + Math.abs((graph.ys[nextNode] ?? 0) - (graph.ys[node] ?? 0));
      const stepCost = length
        + (nextDirection === direction ? 0 : bendCost)
        + crossingCountOf(crossables, graph, node, nextNode) * WIRE_CROSSING_COST
        + (graph.isSoftStep(node, nextDirection) ? length * SOFT_COST_PER_UNIT : 0);
      const nextState = nextNode * 4 + nextDirection;
      const nextCost = costSoFar + Math.max(stepCost, 1) + (nextEntry?.bias ?? 0);
      if (nextCost >= (buffers.bestCost[nextState] ?? Infinity)) continue;
      buffers.bestCost[nextState] = nextCost;
      buffers.cameFrom[nextState] = state;
      markStateTouched(buffers, nextState);
      const slot = reserveHeapSlot(heap);
      heap.states[slot] = nextState;
      heap.priorities[slot] = nextCost + estimate(nextNode, nextDirection);
      heap.tieBreaks[slot] = -nextCost;
      siftUpHeap(heap, slot);
    }
  }
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

function drawnWireOf(graph: VisibilityGraph | null, plan: WirePlan, states: number[] | null): DrawnWire {
  const points = graph && states ? pointsOfStates(graph, states) : fallbackPoints(plan);
  return { plan, points, segments: segmentsOf(points), routedPoints: points, states };
}

function isSamePoint(first: Point, second: Point): boolean {
  return first.x === second.x && first.y === second.y;
}

function reusedWireOf(plan: WirePlan, reuse: RouteReuse): DrawnWire | null {
  if (!reuse.cleanIds.has(plan.wire.id)) return null;
  const remembered = reuse.routeById.get(plan.wire.id);
  if (!remembered || remembered.exitSide !== plan.exitSide || remembered.entrySide !== plan.entrySide) return null;
  if (!isSamePoint(remembered.start, plan.start) || !isSamePoint(remembered.end, plan.end)) return null;
  return { plan, points: remembered.points, segments: segmentsOf(remembered.points), routedPoints: remembered.points, states: remembered.isRouted ? [] : null };
}

function routedInWindow(plan: WirePlan, input: RouteInput, reuse: RouteReuse, buffers: SearchBuffers, routedLines: RoutedLines, margin = LOCAL_WINDOW_MARGIN): DrawnWire | null {
  const window = windowOf(plan, reuse, margin);
  const obstacles = windowObstaclesOf(input, window);
  if (!obstacles) return null;
  const windowGraph = windowGraphOf(portsOf([plan]), input, window, obstacles);
  const windowStates = windowGraph ? routeOnGraph(windowGraph, plan, buffers, crossablesIn(routedLines, window)) : null;
  return windowStates ? drawnWireOf(windowGraph, plan, windowStates) : null;
}

function routedThroughOtherBoxes(plan: WirePlan, input: RouteInput, reuse: RouteReuse, buffers: SearchBuffers, routedLines: RoutedLines): DrawnWire {
  const window = windowOf(plan, reuse);
  const obstacles = input.obstaclesIn?.(window) ?? null;
  const graph = obstacles ? graphThroughOtherBoxesOf(plan, input, window, obstacles) : null;
  return drawnWireOf(graph, plan, graph ? routeOnGraph(graph, plan, buffers, crossablesIn(routedLines, window)) : null);
}

function routedInWiderWindows(plan: WirePlan, input: RouteInput, reuse: RouteReuse, buffers: SearchBuffers, routedLines: RoutedLines): DrawnWire {
  const margins = reuse.isPreview ? [] : WIDER_WINDOW_MARGINS;
  for (const margin of margins) {
    const routed = routedInWindow(plan, input, reuse, buffers, routedLines, margin);
    if (routed) return routed;
  }
  return routedThroughOtherBoxes(plan, input, reuse, buffers, routedLines);
}

function foundWireOf(plan: WirePlan): DrawnWire | null {
  const { found } = plan;
  if (!found || found.exitSide !== plan.exitSide || found.entrySide !== plan.entrySide) return null;
  if (!isSamePoint(found.start, plan.start) || !isSamePoint(found.end, plan.end)) return null;
  return { plan, points: found.points, segments: segmentsOf(found.points), routedPoints: found.points, states: [] };
}

function routedWireOf(plan: WirePlan, input: RouteInput, reuse: RouteReuse, buffers: SearchBuffers, routedLines: RoutedLines): DrawnWire {
  const routed = reusedWireOf(plan, reuse) ?? foundWireOf(plan) ?? routedInWindow(plan, input, reuse, buffers, routedLines) ?? routedInWiderWindows(plan, input, reuse, buffers, routedLines);
  addRoutedLines(routedLines, routed.segments);
  return routed;
}

function portSlackOf(box: PlacedBox, side: Side, port: Point): PortSlack {
  const along = isSideways(side) ? port.y : port.x;
  const sideLow = (isSideways(side) ? box.y : box.x) + PORT_INSET;
  const sideHigh = (isSideways(side) ? box.y + box.height : box.x + box.width) - PORT_INSET;
  return { low: Math.max(sideLow, along - PORT_SPACING / 2), high: Math.min(sideHigh, along + PORT_SPACING / 2) };
}

function routeAll(plans: readonly WirePlan[], input: RouteInput, reuse: RouteReuse): DrawnWire[] {
  const buffers = createSearchBuffers();
  const routedLines = createRoutedLines();
  const routed = plans.map((plan) => routedWireOf(plan, input, reuse, buffers, routedLines));
  if (reuse.isPreview) return routed;
  const nudgeWires = routed.map((wire) => ({
    points: wire.points, exitKey: wire.plan.exitKey, busKey: wire.plan.busKey,
    startSlack: portSlackOf(wire.plan.from, wire.plan.exitSide, wire.plan.start), endSlack: portSlackOf(wire.plan.to, wire.plan.entrySide, wire.plan.end),
  }));
  const nudgedPoints = nudgeSharedLines(nudgeWires, (area) => input.obstaclesIn?.(area).hardRects ?? []);
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

function hasRoomForLabel(segment: Segment, width: number): boolean {
  const labelExtent = isHorizontal(segment) ? width : LABEL_ASCENT + LABEL_DESCENT;
  return segmentLength(segment) >= labelExtent + LABEL_GAP * 2;
}

function labelSegmentsInOrder(segments: readonly Segment[], width: number): Segment[] {
  const byLength = [...segments].sort((left, right) => segmentLength(right) - segmentLength(left));
  const roomy = byLength.filter((segment) => hasRoomForLabel(segment, width));
  const cramped = byLength.filter((segment) => !hasRoomForLabel(segment, width));
  return [...segments.slice(0, 1).filter((segment) => hasRoomForLabel(segment, width)), ...roomy, ...cramped];
}

function labelCandidates(segments: readonly Segment[], width: number): Point[] {
  return labelSegmentsInOrder(segments, width).flatMap((segment) => [...LABEL_SLIDE_FRACTIONS.flatMap((fraction) => {
    const x = segment.from.x + (segment.to.x - segment.from.x) * fraction;
    const y = segment.from.y + (segment.to.y - segment.from.y) * fraction;
    if (isHorizontal(segment)) return [{ x, y: y - LABEL_GAP }, { x, y: y + LABEL_GAP + LABEL_ASCENT }];
    return [{ x: x + LABEL_GAP + width / 2, y: y + LABEL_ASCENT / 2 }, { x: x - LABEL_GAP - width / 2, y: y + LABEL_ASCENT / 2 }];
  }), ...flushLabelCandidates(segment, width)]);
}

function placeLabels(drawn: readonly DrawnWire[], input: RouteInput, warnings: string[]): Map<string, { at: Point; bounds: Rect }> {
  const placedById = new Map<string, { at: Point; bounds: Rect }>();
  const allSegments = drawn.flatMap((wire) => wire.segments);
  const segmentGrid = gridOfRects(allSegments.map((segment) => pointBoundsOf(segment.from, segment.to)), LABEL_CELL_SIZE);
  const solids = [...input.boxesById.values(), ...input.softObstacles];
  const solidGrid = gridOfRects(solids, LABEL_CELL_SIZE);
  const placedBounds: Rect[] = [];
  const placedGrid = createSpatialGrid(LABEL_CELL_SIZE);
  for (const wire of drawn) {
    const label = wire.plan.wire.label;
    if (!label) continue;
    const width = labelWidthOf(label);
    const candidates = labelCandidates(wire.segments, width);
    const isClearBy = (boxClearance: number) => (baseline: Point) => {
      const bounds = labelBoundsAt(baseline, width);
      const offBoxes = inflated(bounds, boxClearance);
      if (bounds.y < input.contentTop) return false;
      const padded = inflated(bounds, LABEL_CLEARANCE);
      if (hasSlotTouching(segmentGrid, padded, (slot) => { const segment = allSegments[slot]; return segment !== undefined && segmentHitsRect(segment, padded); })) return false;
      if (hasSlotTouching(solidGrid, offBoxes, (slot) => { const solid = solids[slot]; return solid !== undefined && rectsOverlap(offBoxes, solid); })) return false;
      return !hasSlotTouching(placedGrid, bounds, (slot) => { const placed = placedBounds[slot]; return placed !== undefined && rectsOverlap(bounds, placed); });
    };
    const clearSpot = candidates.find(isClearBy(LABEL_BOX_CLEARANCE)) ?? candidates.find(isClearBy(0));
    const at = clearSpot ?? candidates[0] ?? centerOf(wire.plan.from);
    if (!clearSpot) warnings.push(`wire ${wire.plan.wire.id} label "${label}" has no clear spot`);
    const placedLabelBounds = labelBoundsAt(at, width);
    placedById.set(wire.plan.wire.id, { at: { x: Math.round(at.x), y: Math.round(at.y) }, bounds: placedLabelBounds });
    placeSlot(placedGrid, placedBounds.length, placedLabelBounds);
    placedBounds.push(placedLabelBounds);
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

function addPieceCrossing(isCrossingByPairKey: Map<number, boolean>, drawn: readonly DrawnWire[], pieces: WirePieces, earlierPiece: number, laterPiece: number): void {
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
}

function emptyIndexPairs(): IndexPairs {
  return { firsts: [], seconds: [], isCrossings: [] };
}

function appendPairKeys(pairs: IndexPairs, isCrossingByPairKey: ReadonlyMap<number, boolean>, secondCount: number): IndexPairs {
  for (const [pairKey, isCrossing] of isCrossingByPairKey) {
    pairs.firsts.push(Math.floor(pairKey / secondCount));
    pairs.seconds.push(pairKey % secondCount);
    pairs.isCrossings.push(isCrossing);
  }
  return pairs;
}

function changedPieceIndexes(pieces: WirePieces, reusable: ReusablePairs): number[] {
  const changedPieces: number[] = [];
  pieces.wireIndexByPiece.forEach((wireIndex, piece) => {
    if (reusable.isChangedByWire[wireIndex]) changedPieces.push(piece);
  });
  return changedPieces;
}

function subsetOfFlatRects(rects: FlatRects, indexes: readonly number[]): FlatRects {
  const subset = emptyFlatRects(indexes.length);
  indexes.forEach((index, slot) => {
    setFlatRect(subset, slot, rects.lefts[index] ?? 0, rects.tops[index] ?? 0, rects.rights[index] ?? 0, rects.bottoms[index] ?? 0);
  });
  return subset;
}

function keptPairsOf(previousPairs: IndexPairs, currentFirstByPrevious: readonly number[], currentSecondByPrevious: readonly number[], isKept: (first: number, second: number) => boolean): IndexPairs {
  const kept = emptyIndexPairs();
  previousPairs.firsts.forEach((previousFirst, position) => {
    const first = currentFirstByPrevious[previousFirst] ?? -1;
    const second = currentSecondByPrevious[previousPairs.seconds[position] ?? 0] ?? -1;
    if (first < 0 || second < 0 || !isKept(first, second)) return;
    kept.firsts.push(Math.min(first, second));
    kept.seconds.push(Math.max(first, second));
    kept.isCrossings.push(previousPairs.isCrossings[position] === true);
  });
  return kept;
}

function wirePairsOf(drawn: readonly DrawnWire[], pieces: WirePieces, reusable: ReusablePairs | null): IndexPairs {
  const isCrossingByPairKey = new Map<number, boolean>();
  if (!reusable) {
    forEachTouchingPairWithin(pieces.rects, (earlierPiece, laterPiece) => addPieceCrossing(isCrossingByPairKey, drawn, pieces, earlierPiece, laterPiece));
    return appendPairKeys(emptyIndexPairs(), isCrossingByPairKey, drawn.length);
  }
  const changedPieces = changedPieceIndexes(pieces, reusable);
  forEachTouchingPairAcross(subsetOfFlatRects(pieces.rects, changedPieces), pieces.rects, (changedSlot, otherPiece) => {
    const changedPiece = changedPieces[changedSlot] ?? 0;
    const changedWire = pieces.wireIndexByPiece[changedPiece] ?? 0;
    const otherWire = pieces.wireIndexByPiece[otherPiece] ?? 0;
    if (reusable.isChangedByWire[otherWire] && otherWire < changedWire) return;
    addPieceCrossing(isCrossingByPairKey, drawn, pieces, changedPiece, otherPiece);
  });
  const isUnchangedPair = (first: number, second: number) => !reusable.isChangedByWire[first] && !reusable.isChangedByWire[second];
  const kept = keptPairsOf(reusable.previous.wirePairs, reusable.wireIndexByPrevious, reusable.wireIndexByPrevious, isUnchangedPair);
  return appendPairKeys(kept, isCrossingByPairKey, drawn.length);
}

function orderedWarningList(pairs: IndexPairs, firstCount: number, secondCount: number, messageOf: (first: number, second: number, isCrossing: boolean) => string): WarningList {
  const order = orderOfPairs(pairs.firsts, pairs.seconds, firstCount, secondCount);
  return {
    count: order.length,
    messageAt: (index) => {
      const position = order[index] ?? 0;
      return messageOf(pairs.firsts[position] ?? 0, pairs.seconds[position] ?? 0, pairs.isCrossings[position] === true);
    },
  };
}

const solidsByInput = new WeakMap<RouteInput, PlacedBox[]>();

function solidsOf(input: RouteInput): PlacedBox[] {
  const known = solidsByInput.get(input);
  if (known) return known;
  const solids = [...input.boxesById.values()];
  solidsByInput.set(input, solids);
  return solids;
}

function solidKeyOf(solid: PlacedBox): string {
  return `box ${solid.id}`;
}

function addRunThrough(crossedPairKeys: Map<number, boolean>, drawn: readonly DrawnWire[], pieces: WirePieces, solids: readonly PlacedBox[], insets: readonly Rect[], piece: number, solidIndex: number): void {
  const wireIndex = pieces.wireIndexByPiece[piece] ?? 0;
  const pairKey = wireIndex * solids.length + solidIndex;
  if (crossedPairKeys.has(pairKey)) return;
  const wire = drawn[wireIndex];
  const solid = solids[solidIndex];
  const inset = insets[solidIndex];
  const segment = pieces.segments[piece];
  if (!wire || !solid || !inset || !segment) return;
  if (solid.id === wire.plan.from.id || solid.id === wire.plan.to.id) return;
  if (segmentHitsRect(segment, inset)) crossedPairKeys.set(pairKey, true);
}

function runsThroughPairsOf(drawn: readonly DrawnWire[], pieces: WirePieces, solids: readonly PlacedBox[], reusable: ReusablePairs | null): IndexPairs {
  const insets = solids.map((solid) => inflated(solid, -2));
  const insetRects = flatRectsOf(insets);
  const crossedPairKeys = new Map<number, boolean>();
  if (!reusable) {
    forEachTouchingPairAcross(pieces.rects, insetRects, (piece, solidIndex) => addRunThrough(crossedPairKeys, drawn, pieces, solids, insets, piece, solidIndex));
    return appendPairKeys(emptyIndexPairs(), crossedPairKeys, solids.length);
  }
  const changedPieces = changedPieceIndexes(pieces, reusable);
  forEachTouchingPairAcross(subsetOfFlatRects(pieces.rects, changedPieces), insetRects, (changedSlot, solidIndex) => addRunThrough(crossedPairKeys, drawn, pieces, solids, insets, changedPieces[changedSlot] ?? 0, solidIndex));
  const isChangedBySolid = solids.map((solid) => reusable.changedSolidKeys.has(solidKeyOf(solid)));
  const changedSolidIndexes = solids.flatMap((_, index) => (isChangedBySolid[index] ? [index] : []));
  forEachTouchingPairAcross(pieces.rects, subsetOfFlatRects(insetRects, changedSolidIndexes), (piece, changedSlot) => addRunThrough(crossedPairKeys, drawn, pieces, solids, insets, piece, changedSolidIndexes[changedSlot] ?? 0));
  const solidIndexByKey = new Map(solids.map((solid, index) => [solidKeyOf(solid), index]));
  const solidIndexByPrevious = reusable.previous.solidKeys.map((key) => solidIndexByKey.get(key) ?? -1);
  const kept = emptyIndexPairs();
  reusable.previous.runsThroughPairs.firsts.forEach((previousWire, position) => {
    const wireIndex = reusable.wireIndexByPrevious[previousWire] ?? -1;
    const solidIndex = solidIndexByPrevious[reusable.previous.runsThroughPairs.seconds[position] ?? 0] ?? -1;
    if (wireIndex < 0 || solidIndex < 0 || reusable.isChangedByWire[wireIndex] || isChangedBySolid[solidIndex]) return;
    kept.firsts.push(wireIndex);
    kept.seconds.push(solidIndex);
    kept.isCrossings.push(true);
  });
  return appendPairKeys(kept, crossedPairKeys, solids.length);
}

function wireSignatureOf(wire: DrawnWire): string {
  return JSON.stringify([wire.points, wire.plan.exitKey, wire.plan.busKey, wire.plan.from.id, wire.plan.to.id]);
}

interface ReusablePairs {
  previous: WarningPairs;
  isChangedByWire: boolean[];
  wireIndexByPrevious: number[];
  changedSolidKeys: ReadonlySet<string>;
}

function reusablePairsOf(drawn: readonly DrawnWire[], signatures: readonly string[], changedSolidKeys: ReadonlySet<string> | null, previous: WarningPairs | null): ReusablePairs | null {
  if (!previous || !changedSolidKeys || changedSolidKeys.size > MAX_RECTS_FOR_DIRECT_SCAN) return null;
  const isChangedByWire = drawn.map((wire, index) => previous.wireSignatureById.get(wire.plan.wire.id) !== signatures[index]);
  if (isChangedByWire.filter(Boolean).length > MAX_WIRES_FOR_LOCAL_ROUTING) return null;
  const indexById = new Map(drawn.map((wire, index) => [wire.plan.wire.id, index]));
  return { previous, isChangedByWire, wireIndexByPrevious: previous.wireIds.map((id) => indexById.get(id) ?? -1), changedSolidKeys };
}

function crossingWarningsOf(drawn: readonly DrawnWire[], input: RouteInput, changedSolidKeys: ReadonlySet<string> | null, memory: RouteMemory | null, previous: WarningPairs | null): WarningList[] {
  const pieces = wirePiecesOf(drawn);
  const solids = solidsOf(input);
  const signatures = drawn.map(wireSignatureOf);
  const reusable = reusablePairsOf(drawn, signatures, changedSolidKeys, previous);
  const runsThroughPairs = runsThroughPairsOf(drawn, pieces, solids, reusable);
  const wirePairs = wirePairsOf(drawn, pieces, reusable);
  if (memory) {
    memory.warningPairs = { wireIds: drawn.map((wire) => wire.plan.wire.id), wireSignatureById: new Map(drawn.map((wire, index) => [wire.plan.wire.id, signatures[index] ?? ''])), solidKeys: solids.map(solidKeyOf), wirePairs, runsThroughPairs };
  }
  const wireIdAt = (index: number) => drawn[index]?.plan.wire.id;
  return [
    orderedWarningList(runsThroughPairs, drawn.length, solids.length, (wireIndex, solidIndex) => `wire ${wireIdAt(wireIndex)} runs through ${solids[solidIndex]?.kind} ${solids[solidIndex]?.id}`),
    orderedWarningList(wirePairs, drawn.length, drawn.length, (first, second, isCrossing) => `wire ${wireIdAt(first)} ${isCrossing ? 'crosses' : 'overlaps'} wire ${wireIdAt(second)}`),
  ];
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

function routeWithPortOrder(planned: PlannedWires, input: RouteInput, requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, readonly string[]>, reuse: RouteReuse): DrawnWire[] {
  assignPorts(requestsBySide, groupOrderBySide);
  alignLonePorts([...planned.plans, ...planned.contextPlans], groupOrderBySide);
  return routeAll(planned.plans, input, reuse);
}

function obstacleRectsByKey(input: RouteInput): Map<string, Rect> {
  const rectByKey = new Map<string, Rect>();
  const keyOfRect = (rect: Rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`;
  for (const box of input.boxesById.values()) rectByKey.set(`box ${box.id}`, box);
  for (const soft of input.softObstacles) rectByKey.set(`soft ${keyOfRect(soft)}`, soft);
  return rectByKey;
}

interface ObstacleChanges {
  keys: Set<string>;
  rects: Rect[];
}

function obstacleChangesOf(previous: ReadonlyMap<string, Rect>, current: ReadonlyMap<string, Rect>): ObstacleChanges {
  const isSameRect = (first: Rect | undefined, second: Rect) => first !== undefined && first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
  const changes: ObstacleChanges = { keys: new Set(), rects: [] };
  for (const [key, rect] of previous) {
    if (isSameRect(current.get(key), rect)) continue;
    changes.keys.add(key);
    changes.rects.push(rect);
  }
  for (const [key, rect] of current) {
    if (isSameRect(previous.get(key), rect)) continue;
    changes.keys.add(key);
    changes.rects.push(rect);
  }
  return changes;
}

function touchedPieceIndexes(pieceRects: readonly Rect[], changedRects: readonly Rect[], onTouched: (pieceIndex: number) => void): void {
  if (changedRects.length > MAX_RECTS_FOR_DIRECT_SCAN) {
    forEachTouchingPairAcross(flatRectsOf(pieceRects), flatRectsOf(changedRects), onTouched);
    return;
  }
  pieceRects.forEach((piece, pieceIndex) => {
    const isTouched = changedRects.some((rect) => piece.x <= rect.x + rect.width && rect.x <= piece.x + piece.width && piece.y <= rect.y + rect.height && rect.y <= piece.y + piece.height);
    if (isTouched) onTouched(pieceIndex);
  });
}

function wireKeyOf(input: RouteInput, wire: Wire): string {
  return input.storedWireKeyOf?.(wire) ?? JSON.stringify(wire);
}

function routeReuseOf(input: RouteInput, previous: RouteMemory | null, changes: ObstacleChanges | null): RouteReuse {
  if (!previous || !changes) return { routeById: previous?.routeById ?? new Map(), cleanIds: new Set(), isPreview: false };
  const changedRects = changes.rects.map((rect) => inflated(rect, CLEARANCE));
  const candidates = input.wires.flatMap((wire) => {
    const remembered = previous.routeById.get(wire.id);
    return remembered && remembered.wireKey === wireKeyOf(input, wire) ? [{ wire, remembered }] : [];
  });
  const pieceRects = candidates.flatMap(({ wire, remembered }) => segmentsOf(remembered.points).map((segment) => ({ wireId: wire.id, rect: pointBoundsOf(segment.from, segment.to) })));
  const touchedWireIds = new Set<string>();
  touchedPieceIndexes(pieceRects.map((piece) => piece.rect), changedRects, (pieceIndex) => {
    const piece = pieceRects[pieceIndex];
    if (piece) touchedWireIds.add(piece.wireId);
  });
  const cleanIds = new Set(candidates.map(({ wire }) => wire.id).filter((wireId) => !touchedWireIds.has(wireId)));
  return { routeById: previous.routeById, cleanIds, isPreview: false };
}

function pointBoundsOf(first: Point, second: Point): Rect {
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(first.x - second.x), height: Math.abs(first.y - second.y) };
}

function routeMemoryOf(input: RouteInput, rectByKey: Map<string, Rect>, drawn: readonly DrawnWire[]): RouteMemory {
  const routeById = new Map(drawn.map((wire): [string, RememberedRoute] => [wire.plan.wire.id, {
    wireKey: wireKeyOf(input, wire.plan.wire), exitSide: wire.plan.exitSide, entrySide: wire.plan.entrySide,
    start: wire.plan.start, end: wire.plan.end, points: wire.routedPoints, isRouted: wire.states !== null,
  }]));
  return { contentTop: input.contentTop, rectByKey, routeById, warningPairs: null };
}

function laidOutWiresOf(drawn: readonly DrawnWire[], labelById: ReadonlyMap<string, { at: Point; bounds: Rect }>): LaidOutWire[] {
  const leaderByBusKey = new Map<string, DrawnWire>();
  for (const wire of [...drawn].sort((left, right) => left.plan.wire.id.localeCompare(right.plan.wire.id))) {
    if (wire.plan.busKey && !leaderByBusKey.has(wire.plan.busKey)) leaderByBusKey.set(wire.plan.busKey, wire);
  }
  return drawn.map((wire): LaidOutWire => {
    const { plan, points } = wire;
    const leader = plan.busKey ? leaderByBusKey.get(plan.busKey) : undefined;
    return {
      kind: 'wire', id: plan.wire.id, path: pathOf(points), start: points[0] ?? plan.start, end: points[points.length - 1] ?? plan.end,
      label: plan.wire.label, labelAt: labelById.get(plan.wire.id)?.at ?? centerOf(plan.from),
      isDashed: plan.wire.dashed, isBold: plan.wire.width === 'bold', tone: plan.wire.tone,
      hasArrowhead: (leader === undefined || leader === wire) && plan.wire.arrows !== 'none', hasStartArrowhead: plan.wire.arrows === 'both', route: plan.wire.route, bends: [], joinAt: joinPointOf(wire, leader),
    };
  });
}

function isRoutedAroundBoxes(wire: Wire): boolean {
  return wire.route === 'elbow' && typeof wire.from === 'string' && typeof wire.to === 'string' && wire.via.length === 0;
}

interface WireAnchor {
  point: Point;
  box: PlacedBox | null;
}

interface DirectWire {
  wire: Wire;
  points: Point[];
}

function anchorOf(end: WireEnd, input: RouteInput): WireAnchor | null {
  if (typeof end !== 'string') return { point: end, box: null };
  const box = input.boxesById.get(end);
  return box ? { point: centerOf(box), box } : null;
}

function roundedPoint(point: Point): Point {
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
}

function edgePointToward(anchor: WireAnchor, toward: Point): Point {
  const { box, point: center } = anchor;
  if (!box) return center;
  const deltaX = toward.x - center.x;
  const deltaY = toward.y - center.y;
  if (deltaX === 0 && deltaY === 0) return center;
  const scaleX = deltaX === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(deltaX);
  const scaleY = deltaY === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(deltaY);
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + deltaX * scale, y: center.y + deltaY * scale };
}

function sideMidpointToward(anchor: WireAnchor, toward: Point, isHorizontalLeg: boolean): Point {
  const { box, point: center } = anchor;
  if (!box) return center;
  if (isHorizontalLeg) return { x: toward.x >= center.x ? box.x + box.width : box.x, y: center.y };
  return { x: center.x, y: toward.y >= center.y ? box.y + box.height : box.y };
}

function elbowPointsBetween(from: WireAnchor, to: WireAnchor): Point[] {
  const isHorizontalFirst = Math.abs(to.point.x - from.point.x) >= Math.abs(to.point.y - from.point.y);
  const start = sideMidpointToward(from, to.point, isHorizontalFirst);
  const end = sideMidpointToward(to, from.point, !isHorizontalFirst);
  const corner = isHorizontalFirst ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
  return withoutBends([start, corner, end]);
}

function edgeAlignedToward(anchor: WireAnchor, toward: Point): Point {
  const { box, point: center } = anchor;
  if (!box) return center;
  if (toward.y > box.y && toward.y < box.y + box.height) return { x: toward.x >= center.x ? box.x + box.width : box.x, y: toward.y };
  if (toward.x > box.x && toward.x < box.x + box.width) return { x: toward.x, y: toward.y >= center.y ? box.y + box.height : box.y };
  return sideMidpointToward(anchor, toward, Math.abs(toward.x - center.x) >= Math.abs(toward.y - center.y));
}

function orthogonalized(points: readonly Point[]): Point[] {
  return points.flatMap((point, index) => {
    const previous = points[index - 1];
    if (!previous || previous.x === point.x || previous.y === point.y) return [point];
    return [{ x: point.x, y: previous.y }, point];
  });
}

function elbowPointsThrough(from: WireAnchor, corners: readonly Point[], to: WireAnchor): Point[] {
  const firstCorner = corners[0] ?? to.point;
  const lastCorner = corners[corners.length - 1] ?? from.point;
  return withoutBends(orthogonalized([edgeAlignedToward(from, firstCorner), ...corners, edgeAlignedToward(to, lastCorner)]));
}

function catmullRomAt(before: Point, from: Point, to: Point, after: Point, progress: number): Point {
  const squared = progress * progress;
  const cubed = squared * progress;
  const along = (pick: (point: Point) => number): number => 0.5 * (2 * pick(from) + (pick(to) - pick(before)) * progress + (2 * pick(before) - 5 * pick(from) + 4 * pick(to) - pick(after)) * squared + (3 * pick(from) - pick(before) - 3 * pick(to) + pick(after)) * cubed);
  return { x: along((point) => point.x), y: along((point) => point.y) };
}

function curvedPointsThrough(controls: readonly Point[]): Point[] {
  const first = controls[0];
  if (!first) return [];
  return [first, ...controls.slice(1).flatMap((to, spanIndex) => {
    const from = controls[spanIndex] ?? to;
    const before = controls[spanIndex - 1] ?? from;
    const after = controls[spanIndex + 2] ?? to;
    return Array.from({ length: CURVE_SAMPLES }, (_, sampleIndex) => catmullRomAt(before, from, to, after, (sampleIndex + 1) / CURVE_SAMPLES));
  })];
}

function curvedPointsBetween(start: Point, end: Point): Point[] {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length === 0) return [start, end];
  const bend = length * CURVE_BEND_FRACTION;
  const control = { x: (start.x + end.x) / 2 - ((end.y - start.y) / length) * bend, y: (start.y + end.y) / 2 + ((end.x - start.x) / length) * bend };
  return Array.from({ length: CURVE_SAMPLES + 1 }, (_, sampleIndex) => {
    const progress = sampleIndex / CURVE_SAMPLES;
    const remaining = 1 - progress;
    return {
      x: remaining * remaining * start.x + 2 * remaining * progress * control.x + progress * progress * end.x,
      y: remaining * remaining * start.y + 2 * remaining * progress * control.y + progress * progress * end.y,
    };
  });
}

function directWireOf(wire: Wire, input: RouteInput): DirectWire | null {
  const from = anchorOf(wire.from, input);
  const to = anchorOf(wire.to, input);
  if (!from || !to) return null;
  const { via } = wire;
  if (wire.route === 'elbow') return { wire, points: (via.length === 0 ? elbowPointsBetween(from, to) : elbowPointsThrough(from, via, to)).map(roundedPoint) };
  const start = edgePointToward(from, via[0] ?? to.point);
  const end = edgePointToward(to, via[via.length - 1] ?? from.point);
  const controls = [start, ...via, end];
  const points = wire.route === 'sharp' ? controls : via.length === 0 ? curvedPointsBetween(start, end) : curvedPointsThrough(controls);
  return { wire, points: points.map(roundedPoint) };
}

function pointAlongPath(points: readonly Point[], fraction: number): Point {
  const lengths = points.slice(1).map((point, index) => {
    const previous = points[index] ?? point;
    return Math.hypot(point.x - previous.x, point.y - previous.y);
  });
  let remaining = lengths.reduce((sum, length) => sum + length, 0) * fraction;
  for (const [index, length] of lengths.entries()) {
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) break;
    if (remaining <= length && length > 0) return { x: from.x + ((to.x - from.x) * remaining) / length, y: from.y + ((to.y - from.y) * remaining) / length };
    remaining -= length;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

interface WireHandle {
  kind: 'bend' | 'midpoint' | 'segment';
  index: number;
  at: Point;
}

function midpointOf(from: Point, to: Point): Point {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

function wireHandlesOf(wire: LaidOutWire): WireHandle[] {
  const pathPoints = pointsOfPath(wire.path);
  if (wire.route === 'elbow') {
    if (pathPoints.length > WHITEBOARD_LIMITS.wireBends) return [];
    return pathPoints.slice(1).flatMap((to, index): WireHandle[] => {
      const from = pathPoints[index];
      if (!from || Math.hypot(to.x - from.x, to.y - from.y) < MIN_SEGMENT_HANDLE_LENGTH) return [];
      return [{ kind: 'segment', index, at: midpointOf(from, to) }];
    });
  }
  const controls = [wire.start, ...wire.bends, wire.end];
  const canAddBend = wire.bends.length < WHITEBOARD_LIMITS.wireBends;
  const midpoints = !canAddBend ? [] : controls.slice(1).map((to, index): WireHandle => {
    const onCurve = wire.route === 'curved' ? pathPoints[index * CURVE_SAMPLES + CURVE_SAMPLES / 2] : undefined;
    return { kind: 'midpoint', index, at: onCurve ?? midpointOf(controls[index] ?? to, to) };
  });
  return [...wire.bends.map((at, index): WireHandle => ({ kind: 'bend', index, at })), ...midpoints];
}

function elbowCornersAfterShift(pathPoints: readonly Point[], segmentIndex: number, drag: Point): Point[] {
  const from = pathPoints[segmentIndex];
  const to = pathPoints[segmentIndex + 1];
  if (!from || !to) return pathPoints.slice(1, -1);
  const isHorizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  const shifted = (point: Point): Point => (isHorizontal ? { x: point.x, y: point.y + drag.y } : { x: point.x + drag.x, y: point.y });
  const isFirstSegment = segmentIndex === 0;
  const isLastSegment = segmentIndex === pathPoints.length - 2;
  const reshaped = [...pathPoints.slice(0, segmentIndex), ...(isFirstSegment ? [from] : []), shifted(from), shifted(to), ...(isLastSegment ? [to] : []), ...pathPoints.slice(segmentIndex + 2)];
  return reshaped.slice(1, -1);
}

function laidOutDirectWireOf(direct: DirectWire): LaidOutWire {
  const { wire, points } = direct;
  const start = points[0] ?? { x: 0, y: 0 };
  const end = points[points.length - 1] ?? start;
  const middle = pointAlongPath(points, 0.5);
  return {
    kind: 'wire', id: wire.id, path: pathOf(points), start, end,
    label: wire.label, labelAt: roundedPoint({ x: middle.x, y: middle.y - LABEL_GAP }),
    isDashed: wire.dashed, isBold: wire.width === 'bold', tone: wire.tone,
    hasArrowhead: wire.arrows !== 'none', hasStartArrowhead: wire.arrows === 'both', route: wire.route, bends: wire.via, joinAt: null,
  };
}

function directWiresOf(input: RouteInput): DirectWire[] {
  return input.wires.flatMap((wire) => (isRoutedAroundBoxes(wire) ? [] : directWireOf(wire, input) ?? []));
}

function boxRoutedInput(input: RouteInput): RouteInput {
  return { ...input, wires: input.wires.filter(isRoutedAroundBoxes), contextWires: input.contextWires?.filter(isRoutedAroundBoxes) };
}

function rememberedDirectRoute(input: RouteInput, direct: DirectWire): RememberedRoute {
  const start = direct.points[0] ?? { x: 0, y: 0 };
  const end = direct.points[direct.points.length - 1] ?? start;
  return { wireKey: wireKeyOf(input, direct.wire), exitSide: 'right', entrySide: 'left', start, end, points: direct.points, isRouted: true };
}

function previewWires(unindexedInput: RouteInput): LaidOutWire[] {
  const directWires = directWiresOf(unindexedInput);
  const input = withAreaQuery(boxRoutedInput(unindexedInput));
  const reuse: RouteReuse = { routeById: new Map(), cleanIds: new Set(), isPreview: true };
  const planned = planWires(input, reuse);
  const requestsBySide = portRequestsBySide(planned.plans);
  const drawn = routeWithPortOrder(planned, input, requestsBySide, defaultPortOrders(requestsBySide), reuse);
  return [...laidOutWiresOf(drawn, placeLabels(drawn, input, [])), ...directWires.map(laidOutDirectWireOf)];
}

function routeWires(unindexedInput: RouteInput, previous: RouteMemory | null): RouteResult {
  const directWires = directWiresOf(unindexedInput);
  const input = withAreaQuery(boxRoutedInput(unindexedInput));
  const rectByKey = obstacleRectsByKey(input);
  const changes = previous && previous.contentTop === input.contentTop ? obstacleChangesOf(previous.rectByKey, rectByKey) : null;
  const reuse = routeReuseOf(input, previous, changes);
  const planned = planWires(input, reuse);
  const completeBoxIds = input.contextWires ? new Set(planned.plans.flatMap((plan) => [plan.from.id, plan.to.id])) : null;
  const requestsBySide = portRequestsBySide([...planned.plans, ...planned.contextPlans], completeBoxIds);
  const groupOrderBySide = defaultPortOrders(requestsBySide);
  const drawn = routeWithPortOrder(planned, input, requestsBySide, groupOrderBySide, reuse);
  const labelWarnings: string[] = [];
  const labelById = placeLabels(drawn, input, labelWarnings);
  const laidOutDirectWires = directWires.map(laidOutDirectWireOf);
  const wires = [...laidOutWiresOf(drawn, labelById), ...laidOutDirectWires];
  const labelRects = [...labelById.values()].map((placed) => placed.bounds);
  const directLabelRects = laidOutDirectWires.flatMap((wire) => (wire.label ? [labelBoundsAt(wire.labelAt, labelWidthOf(wire.label))] : []));
  const memory = routeMemoryOf(input, rectByKey, drawn);
  for (const direct of directWires) memory.routeById.set(direct.wire.id, rememberedDirectRoute(input, direct));
  const pointRects = [...drawn.flatMap((wire) => wire.points), ...directWires.flatMap((direct) => direct.points)].map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 }));
  return {
    wires,
    segments: drawn.flatMap((wire) => wire.segments),
    collectWarnings: () => [warningListOf(routeQualityWarnings(drawn)), ...crossingWarningsOf(drawn, input, changes?.keys ?? null, memory, previous?.warningPairs ?? null), warningListOf([...crowdedSideWarnings(requestsBySide, groupOrderBySide), ...labelWarnings])],
    extent: unionOf([...pointRects, ...labelRects, ...directLabelRects]),
    memory,
    portEndsById: new Map([
      ...[...planned.plans, ...planned.contextPlans].map((plan): [string, PortEnds] => [plan.wire.id, { start: plan.start, end: plan.end, busKey: plan.busKey }]),
      ...laidOutDirectWires.map((wire): [string, PortEnds] => [wire.id, { start: wire.start, end: wire.end, busKey: null }]),
    ]),
  };
}

function pointsOfPath(path: string): Point[] {
  const numbers = path.match(/-?\d+(\.\d+)?(e-?\d+)?/gi)?.map(Number) ?? [];
  const points: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) points.push({ x: numbers[index] ?? 0, y: numbers[index + 1] ?? 0 });
  return points;
}

function wireExtentOf(wire: LaidOutWire): Rect | null {
  const pointRects = pointsOfPath(wire.path).map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 }));
  return unionOf(wire.label ? [...pointRects, labelBoundsAt(wire.labelAt, labelWidthOf(wire.label))] : pointRects);
}

export { cappedWarningLists, cappedWarnings, elbowCornersAfterShift, inflated, labelWidthOf, obstacleRectsByKey, warningListOf, pathOf, pointsOfPath, previewWires, rectsOverlap, routeWires, unionOf, wireExtentOf, wireHandlesOf };
export type { WireHandle };
export type { AreaObstacles, Point, RememberedRoute, RouteInput, RouteMemory, WarningList };
