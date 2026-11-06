import { BOX_CHANGES, STEP_STATUSES } from './contracts/whiteboard.ts';
import type { Board, Box, BoxMedia, Element, Note, Step, Wire } from './contracts/whiteboard.ts';

type BoxLine = Box['lines'][number];
import { planSteps } from './whiteboard-plan-core.ts';
import type { PlanStep } from './whiteboard-plan-core.ts';
import { cappedWarningLists, labelWidthOf, previewWires, rectsOverlap, routeWires, unionOf, warningListOf } from './whiteboard-route-core.ts';
import { touchingPairsWithin } from './whiteboard-sweep-core.ts';
import type { Point, RouteMemory } from './whiteboard-route-core.ts';

const MARGIN = 40;
const COLUMN_HEADER_HEIGHT = 44;
const COLUMN_WIDTH = 220;
const COLUMN_GAP = 90;
const BOX_GAP = 30;
const BOX_PADDING = 12;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const OUTPUT_ROW_HEIGHT = 28;
const MAX_KEY_INDENT_CHARS = 12;
const ITEM_INDENT_CHARS = 2;
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
const STEP_HEADER_HEIGHT = 18;
const BAND_HEADER_HEIGHT = 26;
const BAND_GAP = 24;
const MEDIA_GAP = 8;
const MEDIA_MAX_HEIGHT = 320;

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
  bodyLines: LaidOutLine[];
  lane: LaidOutLane | null;
  showsLanePill: boolean;
  change: Box['change'];
  wasLines: string[];
  shape: Box['shape'];
  headerHeight: number;
  outputs: LaidOutOutput[];
  media: LaidOutMedia | null;
  step: LaidOutStep | null;
}

interface LaidOutStep {
  label: string;
  status: Step['status'];
  linkedBoardId: string | null;
}

interface LaidOutMedia extends Rect {
  kind: BoxMedia['kind'];
  asset: string;
  mime: BoxMedia['mime'];
  hasPreview: boolean;
  alt: string;
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

interface LaidOutLine {
  text: string;
  muted: boolean;
  style: BoxLine['style'];
  marker: string | null;
  indentChars: number;
  isFirstRow: boolean;
}

type LegendSwatch = { kind: 'lane'; hex: string } | { kind: 'wire'; tone: Wire['tone']; isDashed: boolean; isBack: boolean } | { kind: 'change'; change: Exclude<Box['change'], 'none'> } | { kind: 'status'; status: Step['status'] };

interface LegendRow {
  label: string;
  x: number;
  y: number;
  swatch: LegendSwatch;
}

type LaidOutElement = LaidOutBox | LaidOutFrame | LaidOutWire | LaidOutNote;

interface PlanBand {
  titleAt: { x: number; y: number };
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
  legend: LegendRow[];
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

function rowsOfLine(line: BoxLine, numberInRun: number, bodyCharsPerLine: number): LaidOutLine[] {
  const mutedIndentChars = line.muted ? 2 : 0;
  const marker = line.style === 'numbered' ? `${numberInRun}.` : line.style === 'kv' ? line.key : null;
  const rowOf = (text: string, index: number, indentChars: number, rowMarker: string | null): LaidOutLine => ({
    text, muted: line.muted, style: line.style, marker: index === 0 ? rowMarker : null, indentChars, isFirstRow: index === 0,
  });
  if (marker && marker.length + 1 > MAX_KEY_INDENT_CHARS) {
    const valueRows = wrapText(line.text, bodyCharsPerLine - mutedIndentChars - ITEM_INDENT_CHARS).map((text) => rowOf(text, 1, ITEM_INDENT_CHARS, null));
    return [rowOf('', 0, 0, marker), ...valueRows];
  }
  const indentChars = line.style === 'item' ? ITEM_INDENT_CHARS : marker ? marker.length + 1 : 0;
  return wrapText(line.text, bodyCharsPerLine - mutedIndentChars - indentChars - (line.style === 'code' ? 1 : 0)).map((text, index) => rowOf(text, index, indentChars, marker));
}

function laidOutLines(lines: readonly BoxLine[], bodyCharsPerLine = BODY_CHARS_PER_LINE): LaidOutLine[] {
  let numberInRun = 0;
  return lines.flatMap((line) => {
    numberInRun = line.style === 'numbered' ? numberInRun + 1 : 0;
    return rowsOfLine(line, numberInRun, bodyCharsPerLine);
  });
}

function laneOf(board: Board, box: Box): LaidOutLane | null {
  const lane = board.lanes.find((candidate) => candidate.id === box.lane);
  if (!lane) return null;
  return { label: lane.label || lane.id, hex: LANE_HEX_BY_COLOR[lane.color] };
}

function isGridBox(box: Box): box is Box & { column: string } {
  return box.column !== null && box.at === null && box.near === null;
}

function boxWidthOf(box: Box): number {
  return box.width ?? COLUMN_WIDTH;
}

function charsPerLineAt(defaultCharsPerLine: number, boxWidth: number): number {
  return Math.floor(defaultCharsPerLine * (boxWidth - BOX_PADDING * 2) / (COLUMN_WIDTH - BOX_PADDING * 2));
}

function mediaSizeOf(box: Box): { width: number; height: number } | null {
  if (!box.media) return null;
  const boxWidth = boxWidthOf(box);
  const width = boxWidth - BOX_PADDING * 2;
  const maxHeight = Math.round(MEDIA_MAX_HEIGHT * boxWidth / COLUMN_WIDTH);
  const height = Math.min(maxHeight, Math.max(1, Math.round(width * box.media.height / box.media.width)));
  return { width, height };
}

function laidOutMedia(box: Box, position: Point, mediaTop: number, mediaSize: { width: number; height: number } | null): LaidOutMedia | null {
  if (!box.media || !mediaSize) return null;
  return { kind: box.media.kind, asset: box.media.asset, mime: box.media.mime, hasPreview: box.media.hasPreview, alt: box.media.alt, x: position.x + BOX_PADDING, y: position.y + mediaTop, width: mediaSize.width, height: mediaSize.height };
}

function boxShape(board: Board, box: Box) {
  const stepHeaderHeight = box.step ? STEP_HEADER_HEIGHT : 0;
  const linkLineCount = box.step?.linkedBoardId ? 1 : 0;
  const boxWidth = boxWidthOf(box);
  const titleCharsPerLine = charsPerLineAt(TITLE_CHARS_PER_LINE, boxWidth);
  const titleLines = wrapText(box.title, titleCharsPerLine);
  const wasLines = box.change === 'relabeled' && box.was ? wrapText(box.was, titleCharsPerLine) : [];
  const bodyLines = laidOutLines(box.lines, charsPerLineAt(BODY_CHARS_PER_LINE, boxWidth));
  const lane = laneOf(board, box);
  const showsLanePill = lane !== null && !isGridBox(box);
  const textHeight = BOX_PADDING + stepHeaderHeight + (wasLines.length + titleLines.length) * TITLE_LINE_HEIGHT + (bodyLines.length + linkLineCount) * BODY_LINE_HEIGHT;
  const mediaSize = mediaSizeOf(box);
  const mediaRoom = mediaSize ? mediaSize.height + MEDIA_GAP : 0;
  const headerHeight = textHeight + BOX_PADDING + mediaRoom + (showsLanePill ? LANE_PILL_HEIGHT + 6 : 0);
  const outputs = box.shape === 'decision' ? box.outputs : [];
  return { titleLines, wasLines, bodyLines, lane, showsLanePill, headerHeight, outputs, mediaTop: textHeight + MEDIA_GAP, mediaSize, height: headerHeight + outputs.length * OUTPUT_ROW_HEIGHT };
}

type ElementsByKind = { [Kind in Element['kind']]: Extract<Element, { kind: Kind }>[] };

interface IndexedBoard extends Board {
  elementsByKind: ElementsByKind;
  planStepById: ReadonlyMap<string, PlanStep>;
}

function addByKind(elementsByKind: ElementsByKind, element: Element): void {
  switch (element.kind) {
    case 'box':
      elementsByKind.box.push(element);
      return;
    case 'frame':
      elementsByKind.frame.push(element);
      return;
    case 'wire':
      elementsByKind.wire.push(element);
      return;
    case 'note':
      elementsByKind.note.push(element);
      return;
  }
}

function indexedBoardOf(board: Board): IndexedBoard {
  const elementsByKind: ElementsByKind = { box: [], frame: [], wire: [], note: [] };
  for (const element of Object.values(board.elements)) addByKind(elementsByKind, element);
  return { ...board, elementsByKind, planStepById: new Map(planSteps(board).map((step) => [step.boxId, step])) };
}

function elementsOfKind<Kind extends Element['kind']>(board: IndexedBoard, kind: Kind): readonly Extract<Element, { kind: Kind }>[] {
  return board.elementsByKind[kind];
}

function noteShape(note: Note): NoteShape {
  const lines = wrapText(note.text, NOTE_CHARS_PER_LINE);
  return { lines, height: BOX_PADDING * 2 + (lines.length + 1) * NOTE_LINE_HEIGHT };
}

function noteStackHeightByBoxId(board: IndexedBoard): Map<string, number> {
  const stackHeightByBoxId = new Map<string, number>();
  for (const note of elementsOfKind(board, 'note')) {
    const stackedSoFar = stackHeightByBoxId.get(note.on);
    const noteHeight = noteShape(note).height;
    stackHeightByBoxId.set(note.on, stackedSoFar === undefined ? noteHeight : stackedSoFar + NOTE_GAP + noteHeight);
  }
  return stackHeightByBoxId;
}

function columnTitleLines(board: Pick<IndexedBoard, 'columns'>): string[][] {
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

function gapReservesOf(board: IndexedBoard, stackHeightByBoxId: ReadonlyMap<string, number>): GapReserve[] {
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

function columnWidthsOf(board: IndexedBoard): number[] {
  const columnIndexById = new Map(board.columns.map((column, index) => [column.id, index]));
  const columnWidths = board.columns.map(() => COLUMN_WIDTH);
  for (const box of elementsOfKind(board, 'box').filter(isGridBox)) {
    const columnIndex = columnIndexById.get(box.column) ?? 0;
    columnWidths[columnIndex] = Math.max(columnWidths[columnIndex] ?? COLUMN_WIDTH, boxWidthOf(box));
  }
  return columnWidths;
}

function columnLeftEdgesOf(columnWidths: readonly number[], gapWidths: readonly number[]): number[] {
  const columnLeftEdges: number[] = [];
  let nextX = MARGIN;
  for (const [index, columnWidth] of columnWidths.entries()) {
    columnLeftEdges.push(nextX);
    nextX += columnWidth + (gapWidths[index] ?? COLUMN_GAP);
  }
  return columnLeftEdges;
}

function columnsRightOf(columnLeftEdges: readonly number[], columnWidths: readonly number[]): number {
  return (columnLeftEdges.at(-1) ?? MARGIN) + (columnWidths.at(-1) ?? COLUMN_WIDTH);
}

function frameIdByBoxId(board: IndexedBoard): Map<string, string> {
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

function bandIdOf(board: IndexedBoard, box: Box): string {
  return board.lanes.some((lane) => lane.id === box.lane) ? box.lane ?? '' : '';
}

function bandIdsOf(board: IndexedBoard, gridBoxes: readonly Box[]): string[] {
  const usedBandIds = new Set(gridBoxes.map((box) => bandIdOf(board, box)));
  return ['', ...board.lanes.map((lane) => lane.id)].filter((bandId) => usedBandIds.has(bandId));
}

function laidOutStep(board: IndexedBoard, box: Box): LaidOutStep | null {
  if (!box.step) return null;
  return { label: board.planStepById.get(box.id)?.label ?? '', status: box.step.status, linkedBoardId: box.step.linkedBoardId };
}

function laidOutBox(board: IndexedBoard, box: Box, position: Point): LaidOutBox {
  const shape = boxShape(board, box);
  const width = boxWidthOf(box);
  return {
    kind: 'box', id: box.id, x: position.x, y: position.y, width, height: shape.height,
    titleLines: shape.titleLines, bodyLines: shape.bodyLines, lane: shape.lane, showsLanePill: shape.showsLanePill, change: box.change, wasLines: shape.wasLines,
    shape: box.shape, headerHeight: shape.headerHeight, media: laidOutMedia(box, position, shape.mediaTop, shape.mediaSize), step: laidOutStep(board, box),
    outputs: shape.outputs.map((output, index) => ({
      id: output.id, label: output.label,
      port: { x: position.x + width, y: position.y + shape.headerHeight + index * OUTPUT_ROW_HEIGHT + OUTPUT_ROW_HEIGHT / 2 },
    })),
  };
}

function placeGridBoxes(board: IndexedBoard, columnLeftEdges: readonly number[], columnWidths: readonly number[], boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>, boxesById: Map<string, LaidOutBox>): LaidOutBand[] {
  const frameIds = frameIdByBoxId(board);
  const gridBoxes = elementsOfKind(board, 'box').filter(isGridBox).map((box, index) => ({ box, index }))
    .sort((left, right) => left.box.order - right.box.order || left.index - right.index).map(({ box }) => box);
  const bandIds = bandIdsOf(board, gridBoxes);
  const hasLabeledBands = bandIds.some((bandId) => bandId !== '');
  const columnsRight = columnsRightOf(columnLeftEdges, columnWidths);
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

function nearPosition(target: LaidOutBox, near: NonNullable<Box['near']>, size: { width: number; height: number }): Point {
  const centeredY = target.y + target.height / 2 - size.height / 2;
  const centeredX = target.x + target.width / 2 - size.width / 2;
  switch (near.side) {
    case 'right': return { x: target.x + target.width + near.gap, y: centeredY };
    case 'left': return { x: target.x - size.width - near.gap, y: centeredY };
    case 'bottom': return { x: centeredX, y: target.y + target.height + near.gap };
    case 'top': return { x: centeredX, y: target.y - size.height - near.gap };
  }
}

function freeOrigin(boxesById: ReadonlyMap<string, LaidOutBox>, boxesTop: number): Point {
  const rightmostEdge = [...boxesById.values()].reduce((rightmost, box) => Math.max(rightmost, box.x + box.width), -Infinity);
  return { x: boxesById.size > 0 ? rightmostEdge + COLUMN_GAP : MARGIN, y: boxesTop };
}

function placeNearBoxes(board: IndexedBoard, boxesTop: number, boxesById: Map<string, LaidOutBox>, warnings: string[]): void {
  const nearBoxes = elementsOfKind(board, 'box').filter((box) => box.at === null && box.near !== null);
  const pendingIds = new Set(nearBoxes.map((box) => box.id));
  const place = (box: Box, chainIds: ReadonlySet<string>): LaidOutBox | undefined => {
    const settled = boxesById.get(box.id);
    if (settled || !box.near) return settled;
    const target = board.elements[box.near.of];
    const canFollow = target?.kind === 'box' && !chainIds.has(target.id) && (boxesById.has(target.id) || pendingIds.has(target.id));
    const targetBox = canFollow ? place(target, new Set([...chainIds, box.id])) : undefined;
    if (!targetBox) warnings.push(`box ${box.id} sits near ${box.near.of}, which is not placed on the board`);
    const size = { width: boxWidthOf(box), height: boxShape(board, box).height };
    const position = targetBox ? nearPosition(targetBox, box.near, size) : freeOrigin(boxesById, boxesTop);
    const placed = laidOutBox(board, box, { x: Math.round(position.x), y: Math.round(position.y) });
    boxesById.set(box.id, placed);
    return placed;
  };
  for (const box of nearBoxes) place(box, new Set());
}

function isStackedPanel(box: Box): boolean {
  return box.shape === 'panel' && box.step === null && box.column === null && box.near === null && box.at === null;
}

function placeStackedPanels(board: IndexedBoard, columnsRight: number, boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>, boxesById: Map<string, LaidOutBox>): void {
  const stackedPanels = elementsOfKind(board, 'box').filter(isStackedPanel).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (stackedPanels.length === 0) return;
  const drawingRight = [...boxesById.values()].reduce((rightmost, box) => Math.max(rightmost, box.x + box.width + (stackHeightByBoxId.has(box.id) ? NOTE_WIDTH - NOTE_OVERLAP : 0)), columnsRight);
  const stackX = Math.round(drawingRight + COLUMN_GAP);
  let nextY = boxesTop;
  for (const panel of stackedPanels) {
    const placed = laidOutBox(board, panel, { x: stackX, y: nextY });
    boxesById.set(panel.id, placed);
    nextY += Math.max(placed.height, (stackHeightByBoxId.get(panel.id) ?? 0) - NOTE_RISE) + BOX_GAP;
  }
}

function layoutBoxes(board: IndexedBoard, columnLeftEdges: readonly number[], columnWidths: readonly number[], boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>, stepBandPositions: ReadonlyMap<string, Point>): PlacedBoxes {
  const boxesById = new Map<string, LaidOutBox>();
  const warnings: string[] = [];
  const bands = placeGridBoxes(board, columnLeftEdges, columnWidths, boxesTop, stackHeightByBoxId, boxesById);
  for (const box of elementsOfKind(board, 'box')) {
    const bandPosition = stepBandPositions.get(box.id);
    if (bandPosition) boxesById.set(box.id, laidOutBox(board, box, bandPosition));
  }
  for (const box of elementsOfKind(board, 'box')) {
    if (box.at) boxesById.set(box.id, laidOutBox(board, box, box.at));
  }
  placeNearBoxes(board, boxesTop, boxesById, warnings);
  placeStackedPanels(board, columnsRightOf(columnLeftEdges, columnWidths), boxesTop, stackHeightByBoxId, boxesById);
  for (const box of elementsOfKind(board, 'box')) {
    if (!boxesById.has(box.id)) boxesById.set(box.id, laidOutBox(board, box, freeOrigin(boxesById, boxesTop)));
  }
  return { boxesById, bands, warnings };
}

function layoutFrames(board: IndexedBoard, boxesById: ReadonlyMap<string, LaidOutBox>): LaidOutFrame[] {
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

function layoutNotes(board: IndexedBoard, boxesById: ReadonlyMap<string, LaidOutBox>): LaidOutNote[] {
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

function boundsOf(elements: readonly LaidOutElement[], wireExtent: Rect | null, columnsRight: number, boxesTop: number): Rect {
  const rects = elements.flatMap((element) => (element.kind === 'wire' ? [] : [element]));
  const around = unionOf([...rects, ...(wireExtent ? [wireExtent] : []), { x: 0, y: 0, width: columnsRight, height: boxesTop }]);
  if (!around) return { x: 0, y: 0, width: columnsRight + MARGIN, height: MARGIN * 2 };
  return { x: Math.min(0, around.x - MARGIN), y: Math.min(0, around.y - MARGIN), width: around.width + MARGIN * 2, height: around.height + MARGIN * 2 };
}

interface PlacedBoard {
  columnLeftEdges: number[];
  columnWidths: number[];
  boxesById: Map<string, LaidOutBox>;
  bands: LaidOutBand[];
  collectPlacementWarnings: () => string[];
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
  stepBandPositions: ReadonlyMap<string, Point>;
}

interface LayoutMemory {
  gapCount: number;
  reservedTracksByGap: number[];
  reservedLabelWidths: number[];
  route: RouteMemory;
}

function gapSpansOf(columnLeftEdges: readonly number[], columnWidths: readonly number[]): { left: number; right: number }[] {
  return columnLeftEdges.slice(0, -1).map((leftEdge, index) => {
    const left = leftEdge + (columnWidths[index] ?? COLUMN_WIDTH);
    return { left, right: columnLeftEdges[index + 1] ?? left };
  });
}

function tracksByGapOf(routing: ReturnType<typeof routeWires>, columnLeftEdges: readonly number[], columnWidths: readonly number[]): number[] {
  const verticalXs = routing.segments.filter((segment) => segment.from.x === segment.to.x).map((segment) => segment.from.x);
  return gapSpansOf(columnLeftEdges, columnWidths).map((span) => new Set(verticalXs.filter((x) => x > span.left && x < span.right)).size);
}

function labelWidthByGapOf(routing: ReturnType<typeof routeWires>, columnLeftEdges: readonly number[], columnWidths: readonly number[]): number[] {
  return gapSpansOf(columnLeftEdges, columnWidths).map((span) => routing.wires.reduce((widest, wire) => (wire.label && wire.labelAt.x > span.left && wire.labelAt.x < span.right ? Math.max(widest, labelWidthOf(wire.label)) : widest), 0));
}

function overlapWarnings(boxesById: ReadonlyMap<string, LaidOutBox>, frames: readonly LaidOutFrame[], board: IndexedBoard): string[] {
  const boxes = [...boxesById.values()];
  const boxOverlaps = touchingPairsWithin(boxes).flatMap(([firstIndex, secondIndex]) => {
    const first = boxes[firstIndex];
    const second = boxes[secondIndex];
    return first && second && rectsOverlap(first, second) ? [`box ${first.id} overlaps box ${second.id}`] : [];
  });
  const containedIdsByFrameId = new Map(elementsOfKind(board, 'frame').map((frame) => [frame.id, new Set(frame.contains)]));
  const coveredTitles = frames.flatMap((frame) => boxes.flatMap((box) => {
    const titleStrip = { x: frame.x, y: frame.y, width: frame.width, height: FRAME_TITLE_HEIGHT };
    return !containedIdsByFrameId.get(frame.id)?.has(box.id) && rectsOverlap(box, titleStrip) ? [`box ${box.id} covers the title of frame ${frame.id}`] : [];
  }));
  return [...boxOverlaps, ...coveredTitles];
}

function placeAndRoute(board: IndexedBoard, placement: Placement, previousRoute: RouteMemory | null): PlacedBoard {
  const columnWidths = columnWidthsOf(board);
  const columnLeftEdges = columnLeftEdgesOf(columnWidths, placement.gapWidths);
  const { boxesById, bands, warnings: nearWarnings } = layoutBoxes(board, columnLeftEdges, columnWidths, placement.boxesTop, placement.stackHeightByBoxId, placement.stepBandPositions);
  const frames = layoutFrames(board, boxesById);
  const notes = layoutNotes(board, boxesById);
  const routing = routeWires({
    wires: elementsOfKind(board, 'wire'), boxesById,
    softObstacles: [...notes, ...frames.map((frame) => ({ x: frame.x, y: frame.y, width: frame.width, height: FRAME_TITLE_HEIGHT }))],
    loopFrames: frames.filter((frame) => frame.isLoop),
    contentTop: placement.contentTop,
  }, previousRoute);
  return {
    columnLeftEdges, columnWidths, boxesById, bands, frames, notes, routing,
    collectPlacementWarnings: () => [...nearWarnings, ...overlapWarnings(boxesById, frames, board)],
    tracksByGap: tracksByGapOf(routing, columnLeftEdges, columnWidths),
    labelWidthByGap: labelWidthByGapOf(routing, columnLeftEdges, columnWidths),
  };
}

interface RoomInputs {
  reserves: readonly GapReserve[];
  boxesTop: number;
  contentTop: number;
  stackHeightByBoxId: ReadonlyMap<string, number>;
  stepBandPositions: ReadonlyMap<string, Point>;
}

function maxByIndex(first: readonly number[], second: readonly number[]): number[] {
  return Array.from({ length: Math.max(first.length, second.length) }, (_, index) => Math.max(first[index] ?? 0, second[index] ?? 0));
}

function hasUnneededRoom(placed: PlacedBoard, reservedTracksByGap: readonly number[], reservedLabelWidths: readonly number[]): boolean {
  const hasSpareTracks = reservedTracksByGap.some((tracks, index) => tracks > (placed.tracksByGap[index] ?? 0));
  return hasSpareTracks || reservedLabelWidths.some((width, index) => width > (placed.labelWidthByGap[index] ?? 0));
}

function placeFromReservations(board: IndexedBoard, room: RoomInputs, previous: LayoutMemory | null, seedTracksByGap: number[], seedLabelWidths: number[]): { placed: PlacedBoard; memory: LayoutMemory } {
  let reservedTracksByGap = seedTracksByGap;
  let reservedLabelWidths = seedLabelWidths;
  for (let attempt = 1; ; attempt += 1) {
    const gapWidths = gapWidthsOf(room.reserves, reservedTracksByGap, reservedLabelWidths);
    const placed = placeAndRoute(board, { gapWidths, boxesTop: room.boxesTop, contentTop: room.contentTop, stackHeightByBoxId: room.stackHeightByBoxId, stepBandPositions: room.stepBandPositions }, previous?.route ?? null);
    const needsMoreTracks = placed.tracksByGap.some((tracks, index) => tracks > (reservedTracksByGap[index] ?? 0));
    const needsWiderLabels = placed.labelWidthByGap.some((width, index) => width > (reservedLabelWidths[index] ?? 0));
    if (attempt >= MAX_ROOM_ATTEMPTS || (!needsMoreTracks && !needsWiderLabels)) {
      return { placed, memory: { gapCount: room.reserves.length, reservedTracksByGap, reservedLabelWidths, route: placed.routing.memory } };
    }
    reservedTracksByGap = maxByIndex(reservedTracksByGap, placed.tracksByGap);
    reservedLabelWidths = maxByIndex(reservedLabelWidths, placed.labelWidthByGap);
  }
}

function placeWithReservedRoom(board: IndexedBoard, room: RoomInputs, previous: LayoutMemory | null): { placed: PlacedBoard; memory: LayoutMemory } {
  if (!previous || previous.gapCount !== room.reserves.length) return placeFromReservations(board, room, previous, [], []);
  const seeded = placeFromReservations(board, room, previous, previous.reservedTracksByGap, previous.reservedLabelWidths);
  if (!hasUnneededRoom(seeded.placed, seeded.memory.reservedTracksByGap, seeded.memory.reservedLabelWidths)) return seeded;
  return placeFromReservations(board, room, previous, [], []);
}

function isInStepBand(box: Box): boolean {
  return box.step !== null && box.column === null && box.near === null && box.at === null;
}

interface StepBand {
  positionById: Map<string, Point>;
  bottom: number;
}

function stepBandOf(board: Board): StepBand {
  const bandBoxById = new Map<string, Box>();
  for (const element of Object.values(board.elements)) {
    if (element.kind === 'box' && isInStepBand(element)) bandBoxById.set(element.id, element);
  }
  const positionById = new Map<string, Point>();
  if (bandBoxById.size === 0) return { positionById, bottom: MARGIN };
  const bandBoxesByLevel = new Map<number, Box[]>();
  for (const step of planSteps(board)) {
    const box = bandBoxById.get(step.boxId);
    if (box) bandBoxesByLevel.set(step.level, [...(bandBoxesByLevel.get(step.level) ?? []), box]);
  }
  let levelX = MARGIN;
  let lowestBottom = MARGIN;
  for (const level of [...bandBoxesByLevel.keys()].sort((left, right) => left - right)) {
    const boxesAtLevel = bandBoxesByLevel.get(level) ?? [];
    let nextY = MARGIN + PLAN_TITLE_HEIGHT;
    for (const box of boxesAtLevel) {
      positionById.set(box.id, { x: levelX, y: nextY });
      nextY += boxShape(board, box).height;
      lowestBottom = Math.max(lowestBottom, nextY);
      nextY += BOX_GAP;
    }
    levelX += Math.max(...boxesAtLevel.map(boxWidthOf)) + COLUMN_GAP;
  }
  return { positionById, bottom: lowestBottom + PLAN_BAND_GAP };
}

function pinnedOffsetYOf(board: Board): number {
  return stepBandOf(board).bottom - MARGIN;
}

function withPinnedBoxesShifted(board: Board, offsetY: number): Board {
  if (offsetY === 0) return board;
  const elements = Object.fromEntries(Object.entries(board.elements).map(([elementId, element]) => {
    if (element.kind !== 'box' || !element.at) return [elementId, element];
    return [elementId, { ...element, at: { x: element.at.x, y: element.at.y + offsetY } }];
  }));
  return { ...board, elements };
}

const WIRE_STYLE_WORDS: Readonly<Record<Wire['tone'], string | null>> = { plain: null, fail: 'failure path', join: 'joins', lane: null };

function wireStyleKey(tone: Wire['tone'], isDashed: boolean, isBack: boolean): string {
  return `${tone}|${isDashed}|${isBack}`;
}

function defaultWireStyleLabel(tone: Wire['tone'], isDashed: boolean, isBack: boolean): string | null {
  const words = [WIRE_STYLE_WORDS[tone], isBack ? 'returns to an earlier step' : null, isDashed && !isBack ? 'optional' : null].filter((word) => word !== null);
  return words.length > 0 ? words.join(', ') : null;
}

const CHANGE_LEGEND_LABELS: Readonly<Record<Exclude<Box['change'], 'none'>, string>> = { added: 'added by this change', removed: 'removed by this change', relabeled: 'renamed, old title struck through' };

function changeEntriesOf(board: IndexedBoard): { label: string; swatch: LegendSwatch }[] {
  const usedChanges = new Set(elementsOfKind(board, 'box').map((box) => box.change));
  return BOX_CHANGES.flatMap((change) => (change === 'none' || !usedChanges.has(change) ? [] : [{ label: CHANGE_LEGEND_LABELS[change], swatch: { kind: 'change' as const, change } }]));
}

function statusEntriesOf(board: IndexedBoard): { label: string; swatch: LegendSwatch }[] {
  if (board.planStepById.size === 0) return [];
  return STEP_STATUSES.map((status) => ({ label: `plan step ${status}`, swatch: { kind: 'status' as const, status } }));
}

function legendEntriesOf(board: IndexedBoard): { label: string; swatch: LegendSwatch }[] {
  const laneEntries = board.lanes.map((lane) => ({ label: lane.label || lane.id, swatch: { kind: 'lane' as const, hex: LANE_HEX_BY_COLOR[lane.color] } }));
  const customLabelByKey = new Map(board.legend.map((entry) => [wireStyleKey(entry.tone, entry.dashed || entry.back, entry.back), entry.label]));
  const usedKeys = new Set<string>();
  const wireEntries = elementsOfKind(board, 'wire').flatMap((wire) => {
    const isDashed = wire.dashed || wire.back;
    const key = wireStyleKey(wire.tone, isDashed, wire.back);
    const label = customLabelByKey.get(key) ?? defaultWireStyleLabel(wire.tone, isDashed, wire.back);
    if (usedKeys.has(key) || label === null) return [];
    usedKeys.add(key);
    return [{ key, label, swatch: { kind: 'wire' as const, tone: wire.tone, isDashed, isBack: wire.back } }];
  }).sort((left, right) => left.key.localeCompare(right.key));
  const unusedCustomEntries = board.legend
    .filter((entry) => !usedKeys.has(wireStyleKey(entry.tone, entry.dashed || entry.back, entry.back)))
    .map((entry) => ({ label: entry.label, swatch: { kind: 'wire' as const, tone: entry.tone, isDashed: entry.dashed || entry.back, isBack: entry.back } }));
  return [...laneEntries, ...wireEntries.map(({ label, swatch }) => ({ label, swatch })), ...unusedCustomEntries, ...changeEntriesOf(board), ...statusEntriesOf(board)];
}

function layoutBoard(storedBoard: Board): BoardLayout {
  return layoutBoardWithMemory(storedBoard, null).layout;
}

function layoutBoardWithMemory(storedBoard: Board, previous: LayoutMemory | null): { layout: BoardLayout; memory: LayoutMemory } {
  const { positionById: stepBandPositions, bottom: freeformTop } = stepBandOf(storedBoard);
  const pinnedOffsetY = freeformTop - MARGIN;
  const board = indexedBoardOf(withPinnedBoxesShifted(storedBoard, pinnedOffsetY));
  const stackHeightByBoxId = noteStackHeightByBoxId(board);
  const titleLinesByColumn = columnTitleLines(board);
  const extraHeaderHeight = headerExtraHeight(titleLinesByColumn);
  const ruleY = freeformTop + COLUMN_RULE_OFFSET + extraHeaderHeight;
  const boxesTop = freeformTop + COLUMN_HEADER_HEIGHT + extraHeaderHeight;
  const reserves = gapReservesOf(board, stackHeightByBoxId);
  const { placed, memory } = placeWithReservedRoom(board, { reserves, boxesTop, contentTop: ruleY, stackHeightByBoxId, stepBandPositions }, previous);
  const { columnLeftEdges, columnWidths } = placed;
  const elements: LaidOutElement[] = [
    ...placed.frames,
    ...placed.routing.wires,
    ...placed.boxesById.values(),
    ...placed.notes,
  ];
  const contentBounds = boundsOf(elements, placed.routing.extent, columnsRightOf(columnLeftEdges, columnWidths), boxesTop);
  const legendTop = contentBounds.y + contentBounds.height;
  const legend = legendEntriesOf(board).map((entry, index): LegendRow => ({ ...entry, x: MARGIN, y: legendTop + index * LEGEND_ROW_HEIGHT }));
  const captionTop = legendTop + legend.length * LEGEND_ROW_HEIGHT + (legend.length > 0 ? 12 : 0);
  const caption = board.caption ? { text: board.caption, x: MARGIN, y: captionTop } : null;
  const extraHeight = legend.length * LEGEND_ROW_HEIGHT + (caption ? 30 : 0) + (legend.length > 0 ? 12 : 0);
  const layout: BoardLayout = {
    columns: board.columns.map((column, index) => ({
      id: column.id, titleLines: titleLinesByColumn[index] ?? [], titleBaselineY: freeformTop + COLUMN_TITLE_BASELINE,
      ruleY, x: columnLeftEdges[index] ?? MARGIN, width: columnWidths[index] ?? COLUMN_WIDTH,
    })),
    bands: placed.bands,
    elements,
    legend,
    caption,
    pinnedOffsetY,
    plan: stepBandPositions.size > 0 ? { titleAt: { x: MARGIN, y: MARGIN + PLAN_TITLE_BASELINE } } : null,
    bounds: { ...contentBounds, height: contentBounds.height + extraHeight },
    warnings: cappedWarningLists([...placed.routing.collectWarnings(), warningListOf(placed.collectPlacementWarnings())]),
  };
  return { layout, memory };
}

function elementSignature(element: LaidOutElement): string {
  return JSON.stringify(element);
}

function movedBox(box: LaidOutBox, offsetX: number, offsetY: number): LaidOutBox {
  const outputs = box.outputs.map((output) => ({ ...output, port: { x: output.port.x + offsetX, y: output.port.y + offsetY } }));
  const media = box.media ? { ...box.media, x: box.media.x + offsetX, y: box.media.y + offsetY } : null;
  return { ...box, x: box.x + offsetX, y: box.y + offsetY, outputs, media };
}

type DragPreview = (offsetX: number, offsetY: number) => LaidOutElement[];

function movingIdsOf(storedBoard: Board, draggedBoxIds: ReadonlySet<string>): Set<string> {
  const movingIds = new Set(draggedBoxIds);
  let hasGrown = true;
  while (hasGrown) {
    hasGrown = false;
    for (const element of Object.values(storedBoard.elements)) {
      const anchorId = element.kind === 'box' ? element.near?.of : element.kind === 'note' ? element.on : undefined;
      if (movingIds.has(element.id) || !anchorId || !movingIds.has(anchorId)) continue;
      movingIds.add(element.id);
      hasGrown = true;
    }
  }
  return movingIds;
}

function createDragPreview(storedBoard: Board, layout: BoardLayout, draggedBoxIds: ReadonlySet<string>): DragPreview {
  const movingIds = movingIdsOf(storedBoard, draggedBoxIds);
  const boxesById = new Map<string, LaidOutBox>();
  const stillSoftObstacles: Rect[] = [];
  const movingNotes: LaidOutNote[] = [];
  const loopFrames: Rect[] = [];
  for (const element of layout.elements) {
    if (element.kind === 'box') boxesById.set(element.id, element);
    if (element.kind === 'note' && movingIds.has(element.id)) movingNotes.push(element);
    if (element.kind === 'note' && !movingIds.has(element.id)) stillSoftObstacles.push(element);
    if (element.kind === 'frame') stillSoftObstacles.push({ x: element.x, y: element.y, width: element.width, height: FRAME_TITLE_HEIGHT });
    if (element.kind === 'frame' && element.isLoop) loopFrames.push(element);
  }
  const movingBoxes = [...movingIds].flatMap((elementId) => boxesById.get(elementId) ?? []);
  const wires = Object.values(storedBoard.elements).flatMap((element) => (element.kind === 'wire' && (movingIds.has(element.from) || movingIds.has(element.to)) ? [element] : []));
  const contentTop = stepBandOf(storedBoard).bottom + COLUMN_RULE_OFFSET + headerExtraHeight(columnTitleLines(storedBoard));
  return (offsetX, offsetY) => {
    const moved = movingBoxes.map((box) => movedBox(box, offsetX, offsetY));
    for (const box of moved) boxesById.set(box.id, box);
    const notes = movingNotes.map((note) => ({ ...note, x: note.x + offsetX, y: note.y + offsetY }));
    return [...moved, ...notes, ...previewWires({ wires, boxesById, softObstacles: [...stillSoftObstacles, ...notes], loopFrames, contentTop })];
  };
}

export { createDragPreview, elementSignature, isStackedPanel, layoutBoard, layoutBoardWithMemory, pinnedOffsetYOf };
export type { BoardLayout, DragPreview, LayoutMemory, LaidOutBox, LaidOutMedia, LaidOutElement, LaidOutFrame, LaidOutLine, LaidOutNote, LaidOutStep, LaidOutWire, Rect };
