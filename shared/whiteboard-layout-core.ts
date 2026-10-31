import type { Board, Box, Element, Note, Unit, Wire } from './contracts/whiteboard.ts';
import { planSteps } from './whiteboard-plan-core.ts';
import { cappedWarnings, labelWidthOf, pathOf, rectsOverlap, routeWires, unionOf, withoutBends } from './whiteboard-route-core.ts';
import type { Point } from './whiteboard-route-core.ts';

const MARGIN = 40;
const COLUMN_HEADER_HEIGHT = 44;
const COLUMN_WIDTH = 220;
const COLUMN_GAP = 90;
const BOX_GAP = 30;
const BOX_PADDING = 12;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const OUTPUT_ROW_HEIGHT = 28;
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
const LABEL_GAP = 5;
const MAX_ROOM_ATTEMPTS = 4;
const PLAN_TITLE_BASELINE = 16;
const PLAN_TITLE_HEIGHT = 30;
const PLAN_BAND_GAP = 40;
const UNIT_LABEL_HEIGHT = 18;
const BAND_HEADER_HEIGHT = 26;
const BAND_GAP = 24;

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
  showsLanePill: boolean;
  isGhost: boolean;
  shape: Box['shape'];
  headerHeight: number;
  outputs: LaidOutOutput[];
}

interface LaidOutOutput {
  id: string;
  label: string;
  port: Point;
}

interface LaidOutFrame extends Rect {
  kind: 'frame';
  id: string;
  title: string;
  isLoop: boolean;
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
  isBack: boolean;
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

interface LaidOutUnit extends Rect {
  kind: 'unit';
  id: string;
  label: string;
  titleLines: string[];
  bodyLines: string[];
  linkedBoardId: string | null;
}

type LaidOutElement = LaidOutBox | LaidOutFrame | LaidOutWire | LaidOutNote | LaidOutUnit;

interface PlanBand {
  titleAt: { x: number; y: number };
  arrowPaths: string[];
}

interface LaidOutBand {
  id: string;
  label: string;
  hex: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  bands: LaidOutBand[];
  elements: LaidOutElement[];
  legend: { label: string; hex: string; x: number; y: number }[];
  caption: { text: string; x: number; y: number } | null;
  plan: PlanBand | null;
  pinnedOffsetY: number;
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

function isGridBox(box: Box): box is Box & { column: string } {
  return box.column !== null && box.at === null && box.near === null;
}

function boxShape(board: Board, box: Box) {
  const titleLines = wrapText(box.title, TITLE_CHARS_PER_LINE);
  const bodyLines = box.lines.flatMap((line) => wrapText(line.text, BODY_CHARS_PER_LINE - (line.muted ? 2 : 0)).map((text) => ({ text, muted: line.muted })));
  const lane = laneOf(board, box);
  const showsLanePill = lane !== null && !isGridBox(box);
  const headerHeight = BOX_PADDING * 2 + titleLines.length * TITLE_LINE_HEIGHT + bodyLines.length * BODY_LINE_HEIGHT + (showsLanePill ? LANE_PILL_HEIGHT + 6 : 0);
  const outputs = box.shape === 'decision' ? box.outputs : [];
  return { titleLines, bodyLines, lane, showsLanePill, headerHeight, outputs, height: headerHeight + outputs.length * OUTPUT_ROW_HEIGHT };
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

interface GapReserve {
  left: number;
  right: number;
  minimumWidth: number;
}

function gapReservesOf(board: Board, stackHeightByBoxId: ReadonlyMap<string, number>): GapReserve[] {
  const flowBoxes = elementsOfKind(board, 'box').filter(isGridBox);
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

interface PlacedBoxes {
  boxesById: Map<string, LaidOutBox>;
  bands: LaidOutBand[];
  warnings: string[];
}

function bandIdOf(board: Board, box: Box): string {
  return board.lanes.some((lane) => lane.id === box.lane) ? box.lane ?? '' : '';
}

function bandIdsOf(board: Board, gridBoxes: readonly Box[]): string[] {
  const usedBandIds = new Set(gridBoxes.map((box) => bandIdOf(board, box)));
  return ['', ...board.lanes.map((lane) => lane.id)].filter((bandId) => usedBandIds.has(bandId));
}

function laidOutBox(board: Board, box: Box, position: Point): LaidOutBox {
  const shape = boxShape(board, box);
  return {
    kind: 'box', id: box.id, x: position.x, y: position.y, width: COLUMN_WIDTH, height: shape.height,
    titleLines: shape.titleLines, bodyLines: shape.bodyLines, lane: shape.lane, showsLanePill: shape.showsLanePill, isGhost: box.ghost,
    shape: box.shape, headerHeight: shape.headerHeight,
    outputs: shape.outputs.map((output, index) => ({
      id: output.id, label: output.label,
      port: { x: position.x + COLUMN_WIDTH, y: position.y + shape.headerHeight + index * OUTPUT_ROW_HEIGHT + OUTPUT_ROW_HEIGHT / 2 },
    })),
  };
}

function placeGridBoxes(board: Board, columnLeftEdges: readonly number[], boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>, boxesById: Map<string, LaidOutBox>): LaidOutBand[] {
  const frameIds = frameIdByBoxId(board);
  const gridBoxes = elementsOfKind(board, 'box').filter(isGridBox).map((box, index) => ({ box, index }))
    .sort((left, right) => left.box.order - right.box.order || left.index - right.index).map(({ box }) => box);
  const bandIds = bandIdsOf(board, gridBoxes);
  const hasLabeledBands = bandIds.some((bandId) => bandId !== '');
  const columnsRight = (columnLeftEdges.at(-1) ?? MARGIN) + COLUMN_WIDTH;
  const bands: LaidOutBand[] = [];
  let bandTop = boxesTop;
  for (const bandId of bandIds) {
    const lane = board.lanes.find((candidate) => candidate.id === bandId);
    const stackTop = bandTop + (hasLabeledBands ? BAND_HEADER_HEIGHT : 0);
    const nextYByColumnId = new Map<string, number>();
    const lastFrameIdByColumnId = new Map<string, string | null>();
    for (const box of gridBoxes) {
      if (bandIdOf(board, box) !== bandId) continue;
      const columnIndex = Math.max(0, board.columns.findIndex((column) => column.id === box.column));
      const frameId = frameIds.get(box.id) ?? null;
      const y = (nextYByColumnId.get(box.column) ?? stackTop) + frameClearance(lastFrameIdByColumnId.get(box.column) ?? null, frameId);
      const placed = laidOutBox(board, box, { x: columnLeftEdges[columnIndex] ?? MARGIN, y });
      const noteStackBottom = (stackHeightByBoxId.get(box.id) ?? 0) - NOTE_RISE;
      nextYByColumnId.set(box.column, y + Math.max(placed.height, noteStackBottom) + BOX_GAP);
      lastFrameIdByColumnId.set(box.column, frameId);
      boxesById.set(box.id, placed);
    }
    const stackBottom = Math.max(stackTop, ...nextYByColumnId.values()) - BOX_GAP;
    if (hasLabeledBands) {
      bands.push({ id: bandId, label: lane ? lane.label || lane.id : '', hex: lane ? LANE_HEX_BY_COLOR[lane.color] : '', x: MARGIN, y: bandTop, width: columnsRight - MARGIN, height: stackBottom - bandTop });
    }
    bandTop = stackBottom + BAND_GAP + BOX_GAP;
  }
  return bands;
}

function nearPosition(target: LaidOutBox, near: NonNullable<Box['near']>, height: number): Point {
  const centeredY = target.y + target.height / 2 - height / 2;
  const centeredX = target.x + target.width / 2 - COLUMN_WIDTH / 2;
  switch (near.side) {
    case 'right': return { x: target.x + target.width + near.gap, y: centeredY };
    case 'left': return { x: target.x - COLUMN_WIDTH - near.gap, y: centeredY };
    case 'bottom': return { x: centeredX, y: target.y + target.height + near.gap };
    case 'top': return { x: centeredX, y: target.y - height - near.gap };
  }
}

function freeOrigin(boxesById: ReadonlyMap<string, LaidOutBox>, boxesTop: number): Point {
  const rightEdges = [...boxesById.values()].map((box) => box.x + box.width);
  return { x: rightEdges.length > 0 ? Math.max(...rightEdges) + COLUMN_GAP : MARGIN, y: boxesTop };
}

function placeNearBoxes(board: Board, boxesTop: number, boxesById: Map<string, LaidOutBox>, warnings: string[]): void {
  const nearBoxes = elementsOfKind(board, 'box').filter((box) => box.at === null && box.near !== null);
  const pendingIds = new Set(nearBoxes.map((box) => box.id));
  const place = (box: Box, chainIds: ReadonlySet<string>): LaidOutBox | undefined => {
    const settled = boxesById.get(box.id);
    if (settled || !box.near) return settled;
    const target = board.elements[box.near.of];
    const canFollow = target?.kind === 'box' && !chainIds.has(target.id) && (boxesById.has(target.id) || pendingIds.has(target.id));
    const targetBox = canFollow ? place(target, new Set([...chainIds, box.id])) : undefined;
    if (!targetBox) warnings.push(`box ${box.id} sits near ${box.near.of}, which is not placed on the board`);
    const height = boxShape(board, box).height;
    const position = targetBox ? nearPosition(targetBox, box.near, height) : freeOrigin(boxesById, boxesTop);
    const placed = laidOutBox(board, box, { x: Math.round(position.x), y: Math.round(position.y) });
    boxesById.set(box.id, placed);
    return placed;
  };
  for (const box of nearBoxes) place(box, new Set());
}

function layoutBoxes(board: Board, columnLeftEdges: readonly number[], boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>): PlacedBoxes {
  const boxesById = new Map<string, LaidOutBox>();
  const warnings: string[] = [];
  const bands = placeGridBoxes(board, columnLeftEdges, boxesTop, stackHeightByBoxId, boxesById);
  for (const box of elementsOfKind(board, 'box')) {
    if (box.at) boxesById.set(box.id, laidOutBox(board, box, box.at));
  }
  placeNearBoxes(board, boxesTop, boxesById, warnings);
  for (const box of elementsOfKind(board, 'box')) {
    if (!boxesById.has(box.id)) boxesById.set(box.id, laidOutBox(board, box, freeOrigin(boxesById, boxesTop)));
  }
  return { boxesById, bands, warnings };
}

function layoutFrames(board: Board, boxesById: ReadonlyMap<string, LaidOutBox>): LaidOutFrame[] {
  return elementsOfKind(board, 'frame').flatMap((frame) => {
    const around = unionOf(frame.contains.flatMap((id) => boxesById.get(id) ?? []));
    if (!around) return [];
    return [{
      kind: 'frame' as const, id: frame.id, title: frame.title, isLoop: frame.loop,
      x: around.x - FRAME_PADDING, y: around.y - FRAME_PADDING - FRAME_TITLE_HEIGHT,
      width: around.width + FRAME_PADDING * 2, height: around.height + FRAME_PADDING * 2 + FRAME_TITLE_HEIGHT,
    }];
  });
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
  bands: LaidOutBand[];
  placementWarnings: string[];
  frames: LaidOutFrame[];
  notes: LaidOutNote[];
  routing: ReturnType<typeof routeWires>;
  tracksByGap: number[];
  labelWidthByGap: number[];
}

interface Placement {
  gapWidths: readonly number[];
  boxesTop: number;
  contentTop: number;
  stackHeightByBoxId: ReadonlyMap<string, number>;
}

function gapSpansOf(columnLeftEdges: readonly number[]): { left: number; right: number }[] {
  return columnLeftEdges.slice(0, -1).map((leftEdge, index) => ({ left: leftEdge + COLUMN_WIDTH, right: columnLeftEdges[index + 1] ?? leftEdge + COLUMN_WIDTH }));
}

function tracksByGapOf(routing: ReturnType<typeof routeWires>, columnLeftEdges: readonly number[]): number[] {
  const verticalXs = routing.segments.filter((segment) => segment.from.x === segment.to.x).map((segment) => segment.from.x);
  return gapSpansOf(columnLeftEdges).map((span) => new Set(verticalXs.filter((x) => x > span.left && x < span.right)).size);
}

function labelWidthByGapOf(routing: ReturnType<typeof routeWires>, columnLeftEdges: readonly number[]): number[] {
  return gapSpansOf(columnLeftEdges).map((span) => Math.max(0, ...routing.wires.flatMap((wire) => (wire.label && wire.labelAt.x > span.left && wire.labelAt.x < span.right ? [labelWidthOf(wire.label)] : []))));
}

function overlapWarnings(boxesById: ReadonlyMap<string, LaidOutBox>, frames: readonly LaidOutFrame[], board: Board): string[] {
  const boxes = [...boxesById.values()];
  const boxOverlaps = boxes.flatMap((first, index) => boxes.slice(index + 1).flatMap((second) => (rectsOverlap(first, second) ? [`box ${first.id} overlaps box ${second.id}`] : [])));
  const containedIdsByFrameId = new Map(elementsOfKind(board, 'frame').map((frame) => [frame.id, new Set(frame.contains)]));
  const coveredTitles = frames.flatMap((frame) => boxes.flatMap((box) => {
    const titleStrip = { x: frame.x, y: frame.y, width: frame.width, height: FRAME_TITLE_HEIGHT };
    return !containedIdsByFrameId.get(frame.id)?.has(box.id) && rectsOverlap(box, titleStrip) ? [`box ${box.id} covers the title of frame ${frame.id}`] : [];
  }));
  return [...boxOverlaps, ...coveredTitles];
}

function placeAndRoute(board: Board, placement: Placement): PlacedBoard {
  const columnLeftEdges = columnLeftEdgesOf(board, placement.gapWidths);
  const { boxesById, bands, warnings: nearWarnings } = layoutBoxes(board, columnLeftEdges, placement.boxesTop, placement.stackHeightByBoxId);
  const frames = layoutFrames(board, boxesById);
  const notes = layoutNotes(board, boxesById);
  const routing = routeWires({
    wires: elementsOfKind(board, 'wire'), boxesById,
    softObstacles: [...notes, ...frames.map((frame) => ({ x: frame.x, y: frame.y, width: frame.width, height: FRAME_TITLE_HEIGHT }))],
    loopFrames: frames.filter((frame) => frame.isLoop),
    contentTop: placement.contentTop,
  });
  return {
    columnLeftEdges, boxesById, bands, frames, notes, routing,
    placementWarnings: [...nearWarnings, ...overlapWarnings(boxesById, frames, board)],
    tracksByGap: tracksByGapOf(routing, columnLeftEdges),
    labelWidthByGap: labelWidthByGapOf(routing, columnLeftEdges),
  };
}

interface RoomInputs {
  reserves: readonly GapReserve[];
  boxesTop: number;
  contentTop: number;
  stackHeightByBoxId: ReadonlyMap<string, number>;
}

function maxByIndex(first: readonly number[], second: readonly number[]): number[] {
  return Array.from({ length: Math.max(first.length, second.length) }, (_, index) => Math.max(first[index] ?? 0, second[index] ?? 0));
}

function placeWithReservedRoom(board: Board, room: RoomInputs): PlacedBoard {
  let reservedTracksByGap: number[] = [];
  let reservedLabelWidths: number[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const gapWidths = gapWidthsOf(room.reserves, reservedTracksByGap, reservedLabelWidths);
    const placed = placeAndRoute(board, { gapWidths, boxesTop: room.boxesTop, contentTop: room.contentTop, stackHeightByBoxId: room.stackHeightByBoxId });
    const needsMoreTracks = placed.tracksByGap.some((tracks, index) => tracks > (reservedTracksByGap[index] ?? 0));
    const needsWiderLabels = placed.labelWidthByGap.some((width, index) => width > (reservedLabelWidths[index] ?? 0));
    if (attempt >= MAX_ROOM_ATTEMPTS || (!needsMoreTracks && !needsWiderLabels)) return placed;
    reservedTracksByGap = maxByIndex(reservedTracksByGap, placed.tracksByGap);
    reservedLabelWidths = maxByIndex(reservedLabelWidths, placed.labelWidthByGap);
  }
}

function unitShape(unit: Unit) {
  const titleLines = wrapText(unit.title, TITLE_CHARS_PER_LINE);
  const bodyLines = unit.lines.flatMap((line) => wrapText(line.text, BODY_CHARS_PER_LINE));
  const linkLineCount = unit.linkedBoardId ? 1 : 0;
  const height = BOX_PADDING * 2 + UNIT_LABEL_HEIGHT + titleLines.length * TITLE_LINE_HEIGHT + (bodyLines.length + linkLineCount) * BODY_LINE_HEIGHT;
  return { titleLines, bodyLines, height };
}

function layoutUnits(board: Board): Map<string, LaidOutUnit> {
  const unitsById = new Map<string, LaidOutUnit>();
  const nextYByLevel = new Map<number, number>();
  for (const step of planSteps(board)) {
    const unit = board.elements[step.unitId];
    if (unit?.kind !== 'unit') continue;
    const shape = unitShape(unit);
    const y = nextYByLevel.get(step.level) ?? MARGIN + PLAN_TITLE_HEIGHT;
    nextYByLevel.set(step.level, y + shape.height + BOX_GAP);
    unitsById.set(unit.id, {
      kind: 'unit', id: unit.id, x: MARGIN + (step.level - 1) * (COLUMN_WIDTH + COLUMN_GAP), y, width: COLUMN_WIDTH, height: shape.height,
      label: step.label, titleLines: shape.titleLines, bodyLines: shape.bodyLines, linkedBoardId: unit.linkedBoardId,
    });
  }
  return unitsById;
}

function planArrowPath(from: LaidOutUnit, to: LaidOutUnit): string {
  const start = { x: from.x + from.width, y: from.y + Math.round(from.height / 2) };
  const end = { x: to.x, y: to.y + Math.round(to.height / 2) };
  const bendX = to.x - Math.round(COLUMN_GAP / 2);
  return pathOf(withoutBends([start, { x: bendX, y: start.y }, { x: bendX, y: end.y }, end]));
}

function planArrowPaths(board: Board, unitsById: ReadonlyMap<string, LaidOutUnit>): string[] {
  return elementsOfKind(board, 'unit').flatMap((unit) => {
    const to = unitsById.get(unit.id);
    if (!to) return [];
    return unit.after.flatMap((afterId) => {
      const from = unitsById.get(afterId);
      return from ? [planArrowPath(from, to)] : [];
    });
  });
}

function planBandBottom(unitsById: ReadonlyMap<string, LaidOutUnit>): number {
  if (unitsById.size === 0) return MARGIN;
  return Math.max(...[...unitsById.values()].map((unit) => unit.y + unit.height)) + PLAN_BAND_GAP;
}

function withPinnedBoxesShifted(board: Board, offsetY: number): Board {
  if (offsetY === 0) return board;
  const elements = Object.fromEntries(Object.entries(board.elements).map(([elementId, element]) => {
    if (element.kind !== 'box' || !element.at) return [elementId, element];
    return [elementId, { ...element, at: { x: element.at.x, y: element.at.y + offsetY } }];
  }));
  return { ...board, elements };
}

function layoutBoard(storedBoard: Board): BoardLayout {
  const unitsById = layoutUnits(storedBoard);
  const freeformTop = planBandBottom(unitsById);
  const pinnedOffsetY = freeformTop - MARGIN;
  const board = withPinnedBoxesShifted(storedBoard, pinnedOffsetY);
  const stackHeightByBoxId = noteStackHeightByBoxId(board);
  const titleLinesByColumn = columnTitleLines(board);
  const extraHeaderHeight = headerExtraHeight(titleLinesByColumn);
  const ruleY = freeformTop + COLUMN_RULE_OFFSET + extraHeaderHeight;
  const boxesTop = freeformTop + COLUMN_HEADER_HEIGHT + extraHeaderHeight;
  const reserves = gapReservesOf(board, stackHeightByBoxId);
  const placed = placeWithReservedRoom(board, { reserves, boxesTop, contentTop: ruleY, stackHeightByBoxId });
  const { columnLeftEdges } = placed;
  const elements: LaidOutElement[] = [
    ...placed.frames,
    ...placed.routing.wires,
    ...placed.boxesById.values(),
    ...placed.notes,
    ...unitsById.values(),
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
      id: column.id, titleLines: titleLinesByColumn[index] ?? [], titleBaselineY: freeformTop + COLUMN_TITLE_BASELINE,
      ruleY, x: columnLeftEdges[index] ?? MARGIN, width: COLUMN_WIDTH,
    })),
    bands: placed.bands,
    elements,
    legend,
    caption,
    pinnedOffsetY,
    plan: unitsById.size > 0 ? { titleAt: { x: MARGIN, y: MARGIN + PLAN_TITLE_BASELINE }, arrowPaths: planArrowPaths(board, unitsById) } : null,
    bounds: { ...contentBounds, height: contentBounds.height + extraHeight },
    warnings: cappedWarnings([...placed.placementWarnings, ...placed.routing.warnings]),
  };
}

function elementSignature(element: LaidOutElement): string {
  return JSON.stringify(element);
}

export { elementSignature, layoutBoard };
export type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutFrame, LaidOutNote, LaidOutUnit, LaidOutWire, Rect };
