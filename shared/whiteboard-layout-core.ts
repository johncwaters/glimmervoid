import { WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, Box, Element, Note, Wire } from './contracts/whiteboard.ts';

const MARGIN = 40;
const COLUMN_HEADER_HEIGHT = 44;
const COLUMN_WIDTH = 220;
const COLUMN_GAP = 90;
const BOX_GAP = 30;
const BOX_PADDING = 12;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const TITLE_CHARS_PER_LINE = 20;
const BODY_CHARS_PER_LINE = 26;
const LANE_PILL_HEIGHT = 20;
const FRAME_PADDING = 18;
const FRAME_TITLE_HEIGHT = 26;
const NOTE_WIDTH = 170;
const NOTE_CHARS_PER_LINE = 21;
const NOTE_LINE_HEIGHT = 17;
const NOTE_GAP = 10;
const LEGEND_ROW_HEIGHT = 22;
const COLUMN_TITLE_CHARS_PER_LINE = 24;
const COLUMN_TITLE_LINE_HEIGHT = 16;
const COLUMN_TITLE_BASELINE = 16;
const COLUMN_RULE_OFFSET = 26;
const NOTE_OVERLAP = 24;
const NOTE_RISE = 8;
const NOTE_CLEARANCE = 40;
const CHANNEL_PAD = 10;
const TRACK_SPACING = 14;
const RUN_CLEARANCE = 4;
const PORT_SPACING = 14;
const PORT_INSET = 8;
const GUTTER_CLEARANCE = 6;
const MIN_GUTTER_HEIGHT = 4;
const MIN_GUTTER_TRACK_SPACING = 6;
const TOP_TRACK_SPACING = 12;
const TOP_BAND_PAD = 10;
const LABEL_CHAR_WIDTH = 6.6;
const LABEL_GAP = 5;
const LABEL_ASCENT = 10;
const LABEL_DESCENT = 3;
const LABEL_CLEARANCE = 2;
const BOX_CROSSING_COST = 100;
const MAX_WIRES_FOR_PORT_SEARCH = 120;
const MAX_ROOM_ATTEMPTS = 4;
const LABEL_SLIDE_FRACTIONS = [0.5, 0.35, 0.65, 0.2, 0.8];

const LANE_HEX_BY_COLOR = Object.freeze({
  blue: '#60a5fa', green: '#4ade80', orange: '#fb923c', pink: '#f472b6', cyan: '#22d3ee', yellow: '#facc15',
});


interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LaidOutLane {
  label: string;
  hex: string;
}

interface LaidOutBox extends Rect {
  kind: 'box';
  id: string;
  titleLines: string[];
  bodyLines: { text: string; muted: boolean }[];
  lane: LaidOutLane | null;
  isGhost: boolean;
}

interface LaidOutFrame extends Rect {
  kind: 'frame';
  id: string;
  title: string;
}

interface LaidOutWire {
  kind: 'wire';
  id: string;
  path: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  label: string | null;
  labelAt: { x: number; y: number };
  isDashed: boolean;
  strokeHex: string | null;
  tone: Wire['tone'];
  hasArrowhead: boolean;
  joinAt: { x: number; y: number } | null;
}

interface LaidOutNote extends Rect {
  kind: 'note';
  id: string;
  lines: string[];
  byline: string;
  isResolved: boolean;
}

type LaidOutElement = LaidOutBox | LaidOutFrame | LaidOutWire | LaidOutNote;

interface LaidOutColumn {
  id: string;
  titleLines: string[];
  titleBaselineY: number;
  ruleY: number;
  x: number;
  width: number;
}

interface NoteShape {
  lines: string[];
  height: number;
}

interface BoardLayout {
  columns: LaidOutColumn[];
  elements: LaidOutElement[];
  legend: { label: string; hex: string; x: number; y: number }[];
  caption: { text: string; x: number; y: number } | null;
  bounds: Rect;
  warnings: string[];
}

function wrapText(text: string, charsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const pieces = word.match(new RegExp(`.{1,${charsPerLine}}`, 'g')) ?? [word];
    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (candidate.length <= charsPerLine) {
        current = candidate;
        continue;
      }
      lines.push(current);
      current = piece;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function laneOf(board: Board, box: Box): LaidOutLane | null {
  const lane = board.lanes.find((candidate) => candidate.id === box.lane);
  if (!lane) return null;
  return { label: lane.label || lane.id, hex: LANE_HEX_BY_COLOR[lane.color] };
}

function boxShape(board: Board, box: Box) {
  const titleLines = wrapText(box.title, TITLE_CHARS_PER_LINE);
  const bodyLines = box.lines.flatMap((line) => wrapText(line.text, BODY_CHARS_PER_LINE - (line.muted ? 2 : 0)).map((text) => ({ text, muted: line.muted })));
  const lane = laneOf(board, box);
  const height = BOX_PADDING * 2 + titleLines.length * TITLE_LINE_HEIGHT + bodyLines.length * BODY_LINE_HEIGHT + (lane ? LANE_PILL_HEIGHT + 6 : 0);
  return { titleLines, bodyLines, lane, height };
}

function elementsOfKind<Kind extends Element['kind']>(board: Board, kind: Kind): Extract<Element, { kind: Kind }>[] {
  return Object.values(board.elements).filter((element): element is Extract<Element, { kind: Kind }> => element.kind === kind);
}

function noteShape(note: Note): NoteShape {
  const lines = wrapText(note.text, NOTE_CHARS_PER_LINE);
  return { lines, height: BOX_PADDING * 2 + (lines.length + 1) * NOTE_LINE_HEIGHT };
}

function noteStackHeightByBoxId(board: Board): Map<string, number> {
  const stackHeightByBoxId = new Map<string, number>();
  for (const note of elementsOfKind(board, 'note')) {
    const stackedSoFar = stackHeightByBoxId.get(note.on);
    const noteHeight = noteShape(note).height;
    stackHeightByBoxId.set(note.on, stackedSoFar === undefined ? noteHeight : stackedSoFar + NOTE_GAP + noteHeight);
  }
  return stackHeightByBoxId;
}

function columnTitleLines(board: Board): string[][] {
  return board.columns.map((column) => (column.title ? wrapText(column.title, COLUMN_TITLE_CHARS_PER_LINE) : []));
}

function headerExtraHeight(titleLinesByColumn: readonly string[][]): number {
  const tallestTitleLineCount = Math.max(1, ...titleLinesByColumn.map((lines) => lines.length));
  return (tallestTitleLineCount - 1) * COLUMN_TITLE_LINE_HEIGHT;
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

interface GapReserve {
  left: number;
  right: number;
  minimumWidth: number;
}

function gapReservesOf(board: Board, stackHeightByBoxId: ReadonlyMap<string, number>): GapReserve[] {
  const flowBoxes = elementsOfKind(board, 'box').filter((box) => !box.at);
  const notedColumnIds = new Set(flowBoxes.filter((box) => stackHeightByBoxId.has(box.id)).map((box) => box.column));
  const framedBoxIds = new Set(elementsOfKind(board, 'frame').flatMap((frame) => frame.contains));
  const framedColumnIds = new Set(flowBoxes.filter((box) => framedBoxIds.has(box.id)).map((box) => box.column));
  const sideReserve = (columnId: string | undefined) => CHANNEL_PAD + (columnId !== undefined && framedColumnIds.has(columnId) ? FRAME_PADDING : 0);
  return board.columns.map((column, index) => {
    const isNoted = notedColumnIds.has(column.id);
    return {
      left: isNoted ? NOTE_WIDTH - NOTE_OVERLAP + CHANNEL_PAD : sideReserve(column.id),
      right: sideReserve(board.columns[index + 1]?.id),
      minimumWidth: isNoted ? Math.max(COLUMN_GAP, NOTE_WIDTH - NOTE_OVERLAP + NOTE_CLEARANCE) : COLUMN_GAP,
    };
  });
}

function gapWidthsOf(reserves: readonly GapReserve[], tracksByGap: readonly number[], labelWidthByGap: readonly number[]): number[] {
  return reserves.map((reserve, index) => {
    const tracks = tracksByGap[index] ?? 0;
    const labelWidth = labelWidthByGap[index] ?? 0;
    const trackNeed = tracks > 0 ? reserve.left + reserve.right + (tracks + 1) * TRACK_SPACING : 0;
    const labelNeed = labelWidth > 0 ? reserve.left + reserve.right + labelWidth + LABEL_GAP * 4 : 0;
    return Math.max(reserve.minimumWidth, trackNeed, labelNeed);
  });
}

function columnLeftEdgesOf(board: Board, gapWidths: readonly number[]): number[] {
  const columnLeftEdges: number[] = [];
  let nextX = MARGIN;
  for (const [index] of board.columns.entries()) {
    columnLeftEdges.push(nextX);
    nextX += COLUMN_WIDTH + (gapWidths[index] ?? COLUMN_GAP);
  }
  return columnLeftEdges;
}

function channelGapsOf(columnLeftEdges: readonly number[], gapWidths: readonly number[], reserves: readonly GapReserve[]): ChannelGap[] {
  return columnLeftEdges.map((leftEdge, index) => {
    const reserve = reserves[index] ?? { left: CHANNEL_PAD, right: CHANNEL_PAD, minimumWidth: COLUMN_GAP };
    const gapRight = leftEdge + COLUMN_WIDTH + (gapWidths[index] ?? COLUMN_GAP);
    return { left: leftEdge + COLUMN_WIDTH + reserve.left, right: gapRight - reserve.right };
  });
}

function columnIndexOf(board: Board, box: Box, laidOut: Rect, columnLeftEdges: readonly number[]): number {
  if (!box.at) return Math.max(0, board.columns.findIndex((column) => column.id === box.column));
  const centerX = laidOut.x + laidOut.width / 2;
  const lastLeftOfCenter = columnLeftEdges.findLastIndex((leftEdge) => leftEdge <= centerX);
  return Math.max(0, lastLeftOfCenter);
}

function frameIdByBoxId(board: Board): Map<string, string> {
  const frameIds = new Map<string, string>();
  for (const frame of elementsOfKind(board, 'frame')) {
    for (const boxId of frame.contains) if (!frameIds.has(boxId)) frameIds.set(boxId, frame.id);
  }
  return frameIds;
}

function frameClearance(previousFrameId: string | null, nextFrameId: string | null): number {
  if (previousFrameId === nextFrameId) return 0;
  const closing = previousFrameId ? FRAME_PADDING : 0;
  const opening = nextFrameId ? FRAME_PADDING + FRAME_TITLE_HEIGHT : 0;
  return closing + opening;
}

function layoutBoxes(board: Board, columnLeftEdges: readonly number[], boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>): Map<string, LaidOutBox> {
  const boxesById = new Map<string, LaidOutBox>();
  const nextYByColumnId = new Map<string, number>();
  const lastFrameIdByColumnId = new Map<string, string | null>();
  const frameIds = frameIdByBoxId(board);
  const boxes = elementsOfKind(board, 'box').map((box, index) => ({ box, index }))
    .sort((left, right) => left.box.order - right.box.order || left.index - right.index);
  for (const { box } of boxes) {
    const columnIndex = Math.max(0, board.columns.findIndex((column) => column.id === box.column));
    const shape = boxShape(board, box);
    const frameId = frameIds.get(box.id) ?? null;
    const flowY = (nextYByColumnId.get(box.column) ?? boxesTop) + frameClearance(lastFrameIdByColumnId.get(box.column) ?? null, frameId);
    const position = box.at ?? { x: columnLeftEdges[columnIndex] ?? MARGIN, y: flowY };
    if (!box.at) {
      const noteStackBottom = (stackHeightByBoxId.get(box.id) ?? 0) - NOTE_RISE;
      nextYByColumnId.set(box.column, flowY + Math.max(shape.height, noteStackBottom) + BOX_GAP);
      lastFrameIdByColumnId.set(box.column, frameId);
    }
    boxesById.set(box.id, {
      kind: 'box', id: box.id, x: position.x, y: position.y, width: COLUMN_WIDTH, height: shape.height,
      titleLines: shape.titleLines, bodyLines: shape.bodyLines, lane: shape.lane, isGhost: box.ghost,
    });
  }
  return boxesById;
}

function unionOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function layoutFrames(board: Board, boxesById: ReadonlyMap<string, LaidOutBox>): LaidOutFrame[] {
  return elementsOfKind(board, 'frame').flatMap((frame) => {
    const around = unionOf(frame.contains.flatMap((id) => boxesById.get(id) ?? []));
    if (!around) return [];
    return [{
      kind: 'frame' as const, id: frame.id, title: frame.title,
      x: around.x - FRAME_PADDING, y: around.y - FRAME_PADDING - FRAME_TITLE_HEIGHT,
      width: around.width + FRAME_PADDING * 2, height: around.height + FRAME_PADDING * 2 + FRAME_TITLE_HEIGHT,
    }];
  });
}

type Side = 'left' | 'right' | 'top' | 'bottom';
type RouteShape = 'straight' | 'channel' | 'long';

interface Point {
  x: number;
  y: number;
}

interface Segment {
  from: Point;
  to: Point;
}

interface ChannelGap {
  left: number;
  right: number;
}

interface RoutingInput {
  wires: readonly Wire[];
  boxesById: ReadonlyMap<string, LaidOutBox>;
  columnIndexByBoxId: ReadonlyMap<string, number>;
  obstacles: readonly Rect[];
  gaps: readonly ChannelGap[];
  topBandBottom: number;
  contentTop: number;
}

interface RoutingResult {
  wires: LaidOutWire[];
  tracksByGap: number[];
  labelWidthByGap: number[];
  topTrackCount: number;
  warnings: string[];
  extent: Rect | null;
}

interface WirePlan {
  wire: Wire;
  from: LaidOutBox;
  to: LaidOutBox;
  styleKey: string;
  strokeHex: string | null;
  shape: RouteShape;
  exitSide: Side;
  entrySide: Side;
  sourceGap: number;
  targetGap: number;
  busKey: string | null;
  start: Point;
  end: Point;
  crossingY: number;
}

interface ChannelRun {
  key: string;
  gap: number;
  top: number;
  bottom: number;
  leftYs: number[];
  rightYs: number[];
  track: number;
  x: number;
}

interface YInterval {
  top: number;
  bottom: number;
}

interface DrawnWire {
  plan: WirePlan;
  points: Point[];
  trunk: Segment[];
  segments: Segment[];
}

function isSideways(side: Side): boolean {
  return side === 'left' || side === 'right';
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function hasBoxBetweenInColumn(from: LaidOutBox, to: LaidOutBox, columnIndex: number, input: RoutingInput): boolean {
  const upper = from.y < to.y ? from : to;
  const lower = upper === from ? to : from;
  return [...input.boxesById.values()].some((box) => box.id !== from.id && box.id !== to.id
    && input.columnIndexByBoxId.get(box.id) === columnIndex
    && box.y < lower.y && box.y + box.height > upper.y + upper.height);
}

function shapeOf(from: LaidOutBox, to: LaidOutBox, input: RoutingInput): Pick<WirePlan, 'shape' | 'exitSide' | 'entrySide' | 'sourceGap' | 'targetGap'> {
  const fromColumn = input.columnIndexByBoxId.get(from.id) ?? 0;
  const toColumn = input.columnIndexByBoxId.get(to.id) ?? 0;
  if (fromColumn === toColumn) {
    if (from.id !== to.id && !hasBoxBetweenInColumn(from, to, fromColumn, input)) {
      const isDownward = to.y > from.y;
      return { shape: 'straight', exitSide: isDownward ? 'bottom' : 'top', entrySide: isDownward ? 'top' : 'bottom', sourceGap: -1, targetGap: -1 };
    }
    return { shape: 'channel', exitSide: 'right', entrySide: 'right', sourceGap: fromColumn, targetGap: fromColumn };
  }
  if (toColumn > fromColumn) {
    return { shape: toColumn === fromColumn + 1 ? 'channel' : 'long', exitSide: 'right', entrySide: 'left', sourceGap: fromColumn, targetGap: toColumn - 1 };
  }
  return { shape: toColumn === fromColumn - 1 ? 'channel' : 'long', exitSide: 'left', entrySide: 'right', sourceGap: fromColumn - 1, targetGap: toColumn };
}

function planWires(input: RoutingInput): WirePlan[] {
  const plans = input.wires.flatMap((wire): WirePlan[] => {
    const from = input.boxesById.get(wire.from);
    const to = input.boxesById.get(wire.to);
    if (!from || !to) return [];
    const strokeHex = wire.tone === 'lane' ? from.lane?.hex ?? null : null;
    const origin = centerOf(from);
    return [{
      wire, from, to, strokeHex, styleKey: `${wire.dashed}|${wire.tone}|${strokeHex}`, ...shapeOf(from, to, input),
      busKey: null, start: origin, end: centerOf(to), crossingY: origin.y,
    }];
  });
  const memberCountByBusKey = new Map<string, number>();
  const busKeyOf = (plan: WirePlan) => `${plan.to.id}|${plan.entrySide}|${plan.styleKey}`;
  for (const plan of plans) {
    if (plan.shape === 'straight') continue;
    memberCountByBusKey.set(busKeyOf(plan), (memberCountByBusKey.get(busKeyOf(plan)) ?? 0) + 1);
  }
  for (const plan of plans) {
    if (plan.shape !== 'straight' && (memberCountByBusKey.get(busKeyOf(plan)) ?? 0) > 1) plan.busKey = busKeyOf(plan);
  }
  return plans;
}

function portPositions(box: LaidOutBox, side: Side, count: number): Point[] {
  const indexes = Array.from({ length: count }, (_, index) => index);
  if (isSideways(side)) {
    const x = side === 'left' ? box.x : box.x + box.width;
    const spacing = Math.min(PORT_SPACING, (box.height - PORT_INSET * 2) / Math.max(count - 1, 1));
    const centeredFirstY = box.y + Math.min(box.height / 2, 40) - ((count - 1) * spacing) / 2;
    const firstY = Math.max(box.y + PORT_INSET, Math.min(centeredFirstY, box.y + box.height - PORT_INSET - (count - 1) * spacing));
    return indexes.map((index) => ({ x, y: Math.round(firstY + index * spacing) }));
  }
  const y = side === 'top' ? box.y : box.y + box.height;
  const firstX = box.x + box.width / 2 - ((count - 1) * PORT_SPACING) / 2;
  return indexes.map((index) => ({ x: Math.round(firstX + index * PORT_SPACING), y }));
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
    { box: plan.from, side: plan.exitSide, groupKey: `exit|${plan.styleKey}`, wireId: plan.wire.id, farPoint: centerOf(plan.to), assign: (point: Point) => { plan.start = point; } },
    { box: plan.to, side: plan.entrySide, groupKey: plan.busKey ? `bus|${plan.busKey}` : `entry|${plan.wire.id}`, wireId: plan.wire.id, farPoint: centerOf(plan.from), assign: (point: Point) => { plan.end = point; } },
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

function crossedSpanOf(plan: WirePlan, gaps: readonly ChannelGap[]): ChannelGap {
  const sourceGap = gaps[plan.sourceGap] ?? { left: plan.start.x, right: plan.start.x };
  const targetGap = gaps[plan.targetGap] ?? { left: plan.end.x, right: plan.end.x };
  return { left: Math.min(sourceGap.left, targetGap.left), right: Math.max(sourceGap.right, targetGap.right) };
}

function blockersAcross(plan: WirePlan, span: ChannelGap, input: RoutingInput): Rect[] {
  const boxes = [...input.boxesById.values()].filter((box) => box.id !== plan.from.id && box.id !== plan.to.id);
  return [...boxes, ...input.obstacles].filter((rect) => rect.x < span.right && rect.x + rect.width > span.left);
}

function isClearRowAt(y: number, blockers: readonly Rect[]): boolean {
  return !blockers.some((rect) => y > rect.y - GUTTER_CLEARANCE && y < rect.y + rect.height + GUTTER_CLEARANCE);
}

function gutterIntervalsBetween(blockers: readonly Rect[]): YInterval[] {
  const blocked = blockers.map((rect) => ({ top: rect.y - GUTTER_CLEARANCE, bottom: rect.y + rect.height + GUTTER_CLEARANCE }))
    .sort((left, right) => left.top - right.top);
  const merged: YInterval[] = [];
  for (const interval of blocked) {
    const last = merged.at(-1);
    if (last && interval.top <= last.bottom) {
      last.bottom = Math.max(last.bottom, interval.bottom);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged.slice(1).flatMap((interval, index) => {
    const above = merged[index];
    if (!above || interval.top - above.bottom < MIN_GUTTER_HEIGHT) return [];
    return [{ top: above.bottom, bottom: interval.top }];
  });
}

interface GutterClaim {
  plan: WirePlan;
  interval: YInterval;
  span: ChannelGap;
}

function overlapsSpan(first: ChannelGap, second: ChannelGap): boolean {
  return first.left < second.right && second.left < first.right;
}

function stackedTracks<Item>(items: readonly Item[], overlaps: (first: Item, second: Item) => boolean): number[] {
  const tracks: number[] = [];
  items.forEach((item, index) => {
    const earlierTracks = items.slice(0, index).flatMap((earlier, earlierIndex) => (overlaps(item, earlier) ? [tracks[earlierIndex] ?? 0] : []));
    tracks.push(earlierTracks.length > 0 ? Math.max(...earlierTracks) + 1 : 0);
  });
  return tracks;
}

function assignCrossings(plans: readonly WirePlan[], input: RoutingInput): number {
  const claims: GutterClaim[] = [];
  const topBandPlans: { plan: WirePlan; span: ChannelGap }[] = [];
  for (const plan of plans) {
    if (plan.shape !== 'long') continue;
    const span = crossedSpanOf(plan, input.gaps);
    const blockers = blockersAcross(plan, span, input);
    const clearPortY = [plan.start.y, plan.end.y].find((y) => isClearRowAt(y, blockers));
    if (clearPortY !== undefined) {
      plan.crossingY = clearPortY;
      continue;
    }
    const middleY = (plan.start.y + plan.end.y) / 2;
    const nearestGutter = gutterIntervalsBetween(blockers)
      .sort((left, right) => Math.abs((left.top + left.bottom) / 2 - middleY) - Math.abs((right.top + right.bottom) / 2 - middleY))[0];
    if (nearestGutter) {
      claims.push({ plan, interval: nearestGutter, span });
      continue;
    }
    topBandPlans.push({ plan, span });
  }
  const claimsByInterval = groupedBy(claims, (claim) => `${Math.round(claim.interval.top)}|${Math.round(claim.interval.bottom)}`);
  for (const intervalClaims of claimsByInterval.values()) {
    const ordered = [...intervalClaims].sort((left, right) => left.plan.start.y - right.plan.start.y || left.plan.wire.id.localeCompare(right.plan.wire.id));
    const tracks = stackedTracks(ordered, (first, second) => overlapsSpan(first.span, second.span));
    const interval = ordered[0]?.interval ?? { top: 0, bottom: 0 };
    const height = interval.bottom - interval.top;
    const capacity = Math.max(1, Math.floor(height / MIN_GUTTER_TRACK_SPACING) - 1);
    const trackCount = Math.min(capacity, Math.max(...tracks) + 1);
    ordered.forEach((claim, index) => {
      const track = tracks[index] ?? 0;
      if (track >= capacity) {
        topBandPlans.push({ plan: claim.plan, span: claim.span });
        return;
      }
      claim.plan.crossingY = Math.round(interval.top + (height * (track + 1)) / (trackCount + 1));
    });
  }
  const outermostFirst = [...topBandPlans].sort((left, right) => (right.span.right - right.span.left) - (left.span.right - left.span.left) || left.plan.wire.id.localeCompare(right.plan.wire.id));
  const topTracks = stackedTracks(outermostFirst, (first, second) => overlapsSpan(first.span, second.span)).map((track) => outermostFirst.length - 1 - track);
  outermostFirst.forEach(({ plan }, index) => {
    plan.crossingY = input.topBandBottom - (topTracks[index] ?? 0) * TOP_TRACK_SPACING;
  });
  return topBandPlans.length > 0 ? Math.max(...topTracks) + 1 : 0;
}

function attachmentSideFor(gap: number, columnIndex: number): 'left' | 'right' {
  return columnIndex <= gap ? 'left' : 'right';
}

function newRun(key: string, gap: number): ChannelRun {
  return { key, gap, top: Infinity, bottom: -Infinity, leftYs: [], rightYs: [], track: -1, x: 0 };
}

function attach(run: ChannelRun, side: 'left' | 'right', y: number): void {
  (side === 'left' ? run.leftYs : run.rightYs).push(y);
  run.top = Math.min(run.top, y);
  run.bottom = Math.max(run.bottom, y);
}

function targetRunKey(plan: WirePlan): string {
  return plan.busKey ? `bus|${plan.busKey}` : `wire|${plan.wire.id}|target`;
}

function buildRuns(plans: readonly WirePlan[], input: RoutingInput): Map<string, ChannelRun> {
  const runsByKey = new Map<string, ChannelRun>();
  const runFor = (key: string, gap: number) => {
    const existing = runsByKey.get(key);
    if (existing) return existing;
    const created = newRun(key, gap);
    runsByKey.set(key, created);
    return created;
  };
  const enteredRunKeys = new Set<string>();
  for (const plan of plans) {
    if (plan.shape === 'straight') continue;
    const fromColumn = input.columnIndexByBoxId.get(plan.from.id) ?? 0;
    const toColumn = input.columnIndexByBoxId.get(plan.to.id) ?? 0;
    const isForward = plan.exitSide === 'right' && plan.entrySide === 'left';
    const targetRun = runFor(targetRunKey(plan), plan.targetGap);
    if (plan.shape === 'channel') attach(targetRun, attachmentSideFor(plan.targetGap, fromColumn), plan.start.y);
    if (plan.shape === 'long') {
      const sourceRun = runFor(`wire|${plan.wire.id}|source`, plan.sourceGap);
      attach(sourceRun, attachmentSideFor(plan.sourceGap, fromColumn), plan.start.y);
      attach(sourceRun, isForward ? 'right' : 'left', plan.crossingY);
      attach(targetRun, isForward ? 'left' : 'right', plan.crossingY);
    }
    if (enteredRunKeys.has(targetRun.key)) continue;
    enteredRunKeys.add(targetRun.key);
    attach(targetRun, attachmentSideFor(plan.targetGap, toColumn), plan.end.y);
  }
  return runsByKey;
}

function countInside(ys: readonly number[], run: ChannelRun): number {
  return ys.filter((y) => y > run.top && y < run.bottom).length;
}

function crossingsWhenLeftOf(leftRun: ChannelRun, rightRun: ChannelRun): number {
  return countInside(rightRun.leftYs, leftRun) + countInside(leftRun.rightYs, rightRun);
}

function placeTracks(runsByKey: ReadonlyMap<string, ChannelRun>, gaps: readonly ChannelGap[]): number[] {
  const tracksByGap = gaps.map(() => 0);
  const runsByGap = groupedBy([...runsByKey.values()].filter((run) => run.bottom > run.top), (run) => run.gap);
  for (const [gapIndex, gapRuns] of runsByGap) {
    const ordered = [...gapRuns].sort((first, second) => crossingsWhenLeftOf(first, second) - crossingsWhenLeftOf(second, first)
      || first.top - second.top || first.key.localeCompare(second.key));
    const tracks = stackedTracks(ordered, (first, second) => first.top < second.bottom + RUN_CLEARANCE && second.top < first.bottom + RUN_CLEARANCE);
    const trackCount = Math.max(...tracks) + 1;
    tracksByGap[gapIndex] = trackCount;
    const gap = gaps[gapIndex] ?? { left: 0, right: 0 };
    ordered.forEach((run, index) => {
      run.track = tracks[index] ?? 0;
      run.x = Math.round(gap.left + ((gap.right - gap.left) * (run.track + 1)) / (trackCount + 1));
    });
  }
  for (const run of runsByKey.values()) {
    if (run.track >= 0) continue;
    const gap = gaps[run.gap] ?? { left: 0, right: 0 };
    run.x = Math.round((gap.left + gap.right) / 2);
  }
  return tracksByGap;
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

function straightPoints(plan: WirePlan): Point[] {
  if (plan.start.x === plan.end.x) return [plan.start, plan.end];
  const middleY = Math.round((plan.start.y + plan.end.y) / 2);
  return [plan.start, { x: plan.start.x, y: middleY }, { x: plan.end.x, y: middleY }, plan.end];
}

function routedPoints(plan: WirePlan, runsByKey: ReadonlyMap<string, ChannelRun>): Point[] {
  if (plan.shape === 'straight') return straightPoints(plan);
  const targetX = runsByKey.get(targetRunKey(plan))?.x ?? plan.end.x;
  const arrivalY = plan.shape === 'long' ? plan.crossingY : plan.start.y;
  const sourceX = runsByKey.get(`wire|${plan.wire.id}|source`)?.x ?? targetX;
  const approach = plan.shape === 'long'
    ? [plan.start, { x: sourceX, y: plan.start.y }, { x: sourceX, y: arrivalY }, { x: targetX, y: arrivalY }]
    : [plan.start, { x: targetX, y: arrivalY }];
  if (plan.busKey) return approach;
  return [...approach, { x: targetX, y: plan.end.y }, plan.end];
}

function pathOf(points: readonly Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function drawWires(plans: readonly WirePlan[], runsByKey: ReadonlyMap<string, ChannelRun>): DrawnWire[] {
  const leadIdByBusKey = new Map<string, string>();
  for (const plan of [...plans].sort((left, right) => left.wire.id.localeCompare(right.wire.id))) {
    if (plan.busKey && !leadIdByBusKey.has(plan.busKey)) leadIdByBusKey.set(plan.busKey, plan.wire.id);
  }
  return plans.map((plan) => {
    const points = withoutBends(routedPoints(plan, runsByKey));
    const trunkRun = plan.busKey ? runsByKey.get(targetRunKey(plan)) : undefined;
    const isLead = plan.busKey !== null && leadIdByBusKey.get(plan.busKey) === plan.wire.id;
    const trunk: Segment[] = trunkRun && isLead
      ? [{ from: { x: trunkRun.x, y: trunkRun.top }, to: { x: trunkRun.x, y: trunkRun.bottom } }, { from: { x: trunkRun.x, y: plan.end.y }, to: plan.end }]
        .filter((segment) => segment.from.x !== segment.to.x || segment.from.y !== segment.to.y)
      : [];
    return { plan, points, trunk, segments: [...segmentsOf(points), ...trunk] };
  });
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

function labelWidthOf(label: string): number {
  return Math.ceil(label.length * LABEL_CHAR_WIDTH);
}

function labelBoundsAt(baseline: Point, width: number): Rect {
  return { x: baseline.x - width / 2, y: baseline.y - LABEL_ASCENT, width, height: LABEL_ASCENT + LABEL_DESCENT };
}

function segmentLength(segment: Segment): number {
  return Math.abs(segment.from.x - segment.to.x) + Math.abs(segment.from.y - segment.to.y);
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

function flushLabelCandidates(segment: Segment, width: number): Point[] {
  if (!isHorizontal(segment)) return [];
  const y = segment.from.y;
  const flushXs = [Math.min(segment.from.x, segment.to.x) + LABEL_GAP + width / 2, Math.max(segment.from.x, segment.to.x) - LABEL_GAP - width / 2];
  return flushXs.flatMap((x) => [{ x, y: y - LABEL_GAP }, { x, y: y + LABEL_GAP + LABEL_ASCENT }]);
}

function inflated(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

function placeLabels(drawn: readonly DrawnWire[], input: RoutingInput, warnings: string[]): Map<string, { at: Point; bounds: Rect }> {
  const placedById = new Map<string, { at: Point; bounds: Rect }>();
  const allSegments = drawn.flatMap((wire) => wire.segments);
  const solids = [...input.boxesById.values(), ...input.obstacles];
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

function isSharedFanOut(first: DrawnWire, second: DrawnWire): boolean {
  return first.plan.styleKey === second.plan.styleKey && first.plan.start.x === second.plan.start.x && first.plan.start.y === second.plan.start.y;
}

function findCrossings(drawn: readonly DrawnWire[]): string[] {
  return drawn.flatMap((first, index) => drawn.slice(index + 1).flatMap((second) => {
    if (first.plan.busKey !== null && first.plan.busKey === second.plan.busKey) return [];
    const pairs = first.segments.flatMap((firstSegment) => second.segments.map((secondSegment) => [firstSegment, secondSegment] as const));
    if (pairs.some(([firstSegment, secondSegment]) => segmentsCross(firstSegment, secondSegment))) return [`wire ${first.plan.wire.id} crosses wire ${second.plan.wire.id}`];
    if (isSharedFanOut(first, second)) return [];
    return pairs.some(([firstSegment, secondSegment]) => segmentsOverlap(firstSegment, secondSegment)) ? [`wire ${first.plan.wire.id} overlaps wire ${second.plan.wire.id}`] : [];
  }));
}

function findBoxCrossings(drawn: readonly DrawnWire[], input: RoutingInput): string[] {
  const boxes = [...input.boxesById.values()];
  return drawn.flatMap((wire) => boxes.flatMap((box) => {
    if (box.id === wire.plan.from.id || box.id === wire.plan.to.id) return [];
    const inset = inflated(box, -2);
    return wire.segments.some((segment) => segmentHitsRect(segment, inset)) ? [`wire ${wire.plan.wire.id} runs through box ${box.id}`] : [];
  }));
}

function cappedWarnings(warnings: readonly string[]): string[] {
  if (warnings.length <= WHITEBOARD_LIMITS.layoutWarnings) return [...warnings];
  const shown = warnings.slice(0, WHITEBOARD_LIMITS.layoutWarnings - 1);
  return [...shown, `and ${warnings.length - shown.length} more`];
}

function labelWidthsByGap(plans: readonly WirePlan[], gaps: readonly ChannelGap[]): number[] {
  const widths = gaps.map(() => 0);
  for (const plan of plans) {
    if (!plan.wire.label || plan.shape !== 'channel') continue;
    widths[plan.targetGap] = Math.max(widths[plan.targetGap] ?? 0, labelWidthOf(plan.wire.label));
  }
  return widths;
}

function extentOf(drawn: readonly DrawnWire[], labelRects: readonly Rect[]): Rect | null {
  const pointRects = drawn.flatMap((wire) => wire.segments.flatMap((segment) => [segment.from, segment.to]))
    .map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 }));
  return unionOf([...pointRects, ...labelRects]);
}

interface RoutedState {
  runsByKey: Map<string, ChannelRun>;
  tracksByGap: number[];
  topTrackCount: number;
  drawn: DrawnWire[];
  crossingCost: number;
}

function routeWithPortOrder(plans: readonly WirePlan[], input: RoutingInput, requestsBySide: ReadonlyMap<string, readonly PortRequest[]>, groupOrderBySide: ReadonlyMap<string, readonly string[]>): RoutedState {
  assignPorts(requestsBySide, groupOrderBySide);
  const topTrackCount = assignCrossings(plans, input);
  const runsByKey = buildRuns(plans, input);
  const tracksByGap = placeTracks(runsByKey, input.gaps);
  const drawn = drawWires(plans, runsByKey);
  const crossingCost = findBoxCrossings(drawn, input).length * BOX_CROSSING_COST + findCrossings(drawn).length;
  return { runsByKey, tracksByGap, topTrackCount, drawn, crossingCost };
}

function swapNeighbors(order: string[], index: number): void {
  const left = order[index];
  const right = order[index + 1];
  if (left === undefined || right === undefined) return;
  order[index] = right;
  order[index + 1] = left;
}

function routeWithFewestCrossings(plans: readonly WirePlan[], input: RoutingInput): RoutedState {
  const requestsBySide = portRequestsBySide(plans);
  const groupOrderBySide = defaultPortOrders(requestsBySide);
  let bestCost = routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide).crossingCost;
  const canSearchPortOrders = plans.length <= MAX_WIRES_FOR_PORT_SEARCH;
  for (const groupOrder of groupOrderBySide.values()) {
    for (let index = 0; canSearchPortOrders && bestCost > 0 && index + 1 < groupOrder.length; index += 1) {
      swapNeighbors(groupOrder, index);
      const trialCost = routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide).crossingCost;
      if (trialCost < bestCost) {
        bestCost = trialCost;
        continue;
      }
      swapNeighbors(groupOrder, index);
    }
  }
  return routeWithPortOrder(plans, input, requestsBySide, groupOrderBySide);
}

function routeWires(input: RoutingInput): RoutingResult {
  const plans = planWires(input);
  const { runsByKey, tracksByGap, topTrackCount, drawn } = routeWithFewestCrossings(plans, input);
  const labelWarnings: string[] = [];
  const labelById = placeLabels(drawn, input, labelWarnings);
  const wires = drawn.map(({ plan, points, trunk }): LaidOutWire => {
    const lastPoint = points.at(-1) ?? plan.end;
    const trunkRun = plan.busKey ? runsByKey.get(targetRunKey(plan)) : undefined;
    const isTrunkLead = trunk.length > 0;
    const isTJoin = trunkRun !== undefined && lastPoint.y > trunkRun.top && lastPoint.y < trunkRun.bottom;
    return {
      kind: 'wire', id: plan.wire.id,
      path: [pathOf(points), ...trunk.map((segment) => pathOf([segment.from, segment.to]))].join(' '),
      start: plan.start, end: isTrunkLead || !plan.busKey ? plan.end : lastPoint,
      label: plan.wire.label, labelAt: labelById.get(plan.wire.id)?.at ?? centerOf(plan.from),
      isDashed: plan.wire.dashed, strokeHex: plan.strokeHex, tone: plan.wire.tone,
      hasArrowhead: plan.busKey === null || isTrunkLead, joinAt: isTJoin ? lastPoint : null,
    };
  });
  const labelRects = [...labelById.values()].map((placed) => placed.bounds);
  return {
    wires, tracksByGap, topTrackCount,
    labelWidthByGap: labelWidthsByGap(plans, input.gaps),
    warnings: cappedWarnings([...findBoxCrossings(drawn, input), ...findCrossings(drawn), ...labelWarnings]),
    extent: extentOf(drawn, labelRects),
  };
}

function noteByline(note: Note): string {
  if (note.resolvedBy) return `resolved by ${note.resolvedBy}`;
  return note.author ? `from ${note.author}` : '';
}

function layoutNotes(board: Board, boxesById: ReadonlyMap<string, LaidOutBox>): LaidOutNote[] {
  const nextYByBoxId = new Map<string, number>();
  return elementsOfKind(board, 'note').flatMap((note) => {
    const target = boxesById.get(note.on);
    if (!target) return [];
    const { lines, height } = noteShape(note);
    const y = nextYByBoxId.get(note.on) ?? target.y - NOTE_RISE;
    nextYByBoxId.set(note.on, y + height + NOTE_GAP);
    return [{
      kind: 'note' as const, id: note.id, x: target.x + target.width - NOTE_OVERLAP, y, width: NOTE_WIDTH, height,
      lines, byline: noteByline(note), isResolved: note.resolvedBy !== null,
    }];
  });
}

function boundsOf(elements: readonly LaidOutElement[], wireExtent: Rect | null, columnLeftEdges: readonly number[], boxesTop: number): Rect {
  const rects = elements.flatMap((element) => (element.kind === 'wire' ? [] : [element]));
  const columnsRight = (columnLeftEdges.at(-1) ?? MARGIN) + COLUMN_WIDTH;
  const around = unionOf([...rects, ...(wireExtent ? [wireExtent] : []), { x: 0, y: 0, width: columnsRight, height: boxesTop }]);
  if (!around) return { x: 0, y: 0, width: columnsRight + MARGIN, height: MARGIN * 2 };
  return { x: Math.min(0, around.x - MARGIN), y: Math.min(0, around.y - MARGIN), width: around.width + MARGIN * 2, height: around.height + MARGIN * 2 };
}

interface PlacedBoard {
  columnLeftEdges: number[];
  boxesById: Map<string, LaidOutBox>;
  frames: LaidOutFrame[];
  notes: LaidOutNote[];
  routing: RoutingResult;
}

interface Placement {
  gapWidths: readonly number[];
  reserves: readonly GapReserve[];
  boxesTop: number;
  contentTop: number;
  stackHeightByBoxId: ReadonlyMap<string, number>;
}

function placeAndRoute(board: Board, placement: Placement): PlacedBoard {
  const columnLeftEdges = columnLeftEdgesOf(board, placement.gapWidths);
  const boxesById = layoutBoxes(board, columnLeftEdges, placement.boxesTop, placement.stackHeightByBoxId);
  const frames = layoutFrames(board, boxesById);
  const notes = layoutNotes(board, boxesById);
  const columnIndexByBoxId = new Map(elementsOfKind(board, 'box').flatMap((box) => {
    const laidOut = boxesById.get(box.id);
    return laidOut ? [[box.id, columnIndexOf(board, box, laidOut, columnLeftEdges)] as const] : [];
  }));
  const routing = routeWires({
    wires: elementsOfKind(board, 'wire'), boxesById, columnIndexByBoxId,
    obstacles: [...notes, ...frames.map((frame) => ({ x: frame.x, y: frame.y, width: frame.width, height: FRAME_TITLE_HEIGHT }))],
    gaps: channelGapsOf(columnLeftEdges, placement.gapWidths, placement.reserves),
    topBandBottom: placement.boxesTop - TOP_BAND_PAD, contentTop: placement.contentTop,
  });
  return { columnLeftEdges, boxesById, frames, notes, routing };
}

interface RoomInputs {
  reserves: readonly GapReserve[];
  headerBoxesTop: number;
  contentTop: number;
  stackHeightByBoxId: ReadonlyMap<string, number>;
}

function maxByIndex(first: readonly number[], second: readonly number[]): number[] {
  return Array.from({ length: Math.max(first.length, second.length) }, (_, index) => Math.max(first[index] ?? 0, second[index] ?? 0));
}

function placeWithReservedRoom(board: Board, draftRouting: RoutingResult, room: RoomInputs): { placed: PlacedBoard; boxesTop: number } {
  let reservedTracksByGap = draftRouting.tracksByGap;
  let reservedTopTracks = draftRouting.topTrackCount;
  for (let attempt = 1; ; attempt += 1) {
    const gapWidths = gapWidthsOf(room.reserves, reservedTracksByGap, draftRouting.labelWidthByGap);
    const boxesTop = room.headerBoxesTop + topBandHeight(reservedTopTracks);
    const placed = placeAndRoute(board, { gapWidths, reserves: room.reserves, boxesTop, contentTop: room.contentTop, stackHeightByBoxId: room.stackHeightByBoxId });
    const needsMoreTop = placed.routing.topTrackCount > reservedTopTracks;
    const needsMoreTracks = placed.routing.tracksByGap.some((tracks, index) => tracks > (reservedTracksByGap[index] ?? 0));
    if (attempt >= MAX_ROOM_ATTEMPTS || (!needsMoreTop && !needsMoreTracks)) return { placed, boxesTop };
    reservedTopTracks = Math.max(reservedTopTracks, placed.routing.topTrackCount);
    reservedTracksByGap = maxByIndex(reservedTracksByGap, placed.routing.tracksByGap);
  }
}

function topBandHeight(topTrackCount: number): number {
  return topTrackCount > 0 ? topTrackCount * TOP_TRACK_SPACING + TOP_BAND_PAD : 0;
}

function layoutBoard(board: Board): BoardLayout {
  const stackHeightByBoxId = noteStackHeightByBoxId(board);
  const titleLinesByColumn = columnTitleLines(board);
  const extraHeaderHeight = headerExtraHeight(titleLinesByColumn);
  const ruleY = MARGIN + COLUMN_RULE_OFFSET + extraHeaderHeight;
  const headerBoxesTop = MARGIN + COLUMN_HEADER_HEIGHT + extraHeaderHeight;
  const reserves = gapReservesOf(board, stackHeightByBoxId);
  const draft = placeAndRoute(board, {
    gapWidths: gapWidthsOf(reserves, [], []), reserves, boxesTop: headerBoxesTop, contentTop: ruleY, stackHeightByBoxId,
  });
  const { placed, boxesTop } = placeWithReservedRoom(board, draft.routing, { reserves, headerBoxesTop, contentTop: ruleY, stackHeightByBoxId });
  const { columnLeftEdges } = placed;
  const elements: LaidOutElement[] = [
    ...placed.frames,
    ...placed.routing.wires,
    ...placed.boxesById.values(),
    ...placed.notes,
  ];
  const contentBounds = boundsOf(elements, placed.routing.extent, columnLeftEdges, boxesTop);
  const legendTop = contentBounds.y + contentBounds.height;
  const legend = board.lanes.map((lane, index) => ({
    label: lane.label || lane.id, hex: LANE_HEX_BY_COLOR[lane.color], x: MARGIN, y: legendTop + index * LEGEND_ROW_HEIGHT,
  }));
  const captionTop = legendTop + legend.length * LEGEND_ROW_HEIGHT + (legend.length > 0 ? 12 : 0);
  const caption = board.caption ? { text: board.caption, x: MARGIN, y: captionTop } : null;
  const extraHeight = legend.length * LEGEND_ROW_HEIGHT + (caption ? 30 : 0) + (legend.length > 0 ? 12 : 0);
  return {
    columns: board.columns.map((column, index) => ({
      id: column.id, titleLines: titleLinesByColumn[index] ?? [], titleBaselineY: MARGIN + COLUMN_TITLE_BASELINE,
      ruleY, x: columnLeftEdges[index] ?? MARGIN, width: COLUMN_WIDTH,
    })),
    elements,
    legend,
    caption,
    bounds: { ...contentBounds, height: contentBounds.height + extraHeight },
    warnings: placed.routing.warnings,
  };
}

function elementSignature(element: LaidOutElement): string {
  return JSON.stringify(element);
}

export { elementSignature, layoutBoard };
export type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutFrame, LaidOutNote, LaidOutWire, Rect };
