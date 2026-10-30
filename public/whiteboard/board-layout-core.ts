import type { Board, Box, Element, Note, Wire } from '#shared/contracts/whiteboard.ts';

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

function columnLeftEdgesOf(board: Board, stackHeightByBoxId: ReadonlyMap<string, number>): number[] {
  const notedColumnIds = new Set(elementsOfKind(board, 'box').filter((box) => !box.at && stackHeightByBoxId.has(box.id)).map((box) => box.column));
  const noteGap = NOTE_WIDTH - NOTE_OVERLAP + NOTE_CLEARANCE;
  const columnLeftEdges: number[] = [];
  let nextX = MARGIN;
  for (const column of board.columns) {
    columnLeftEdges.push(nextX);
    nextX += COLUMN_WIDTH + (notedColumnIds.has(column.id) ? Math.max(COLUMN_GAP, noteGap) : COLUMN_GAP);
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

function wireEnds(from: Rect, to: Rect) {
  const fromCenterX = from.x + from.width / 2;
  const toCenterX = to.x + to.width / 2;
  const isSideBySide = Math.abs(toCenterX - fromCenterX) > from.width / 2;
  if (isSideBySide) {
    const isRightward = toCenterX > fromCenterX;
    const start = { x: isRightward ? from.x + from.width : from.x, y: from.y + Math.min(from.height / 2, 40) };
    const end = { x: isRightward ? to.x : to.x + to.width, y: to.y + Math.min(to.height / 2, 40) };
    const bend = (end.x - start.x) / 2;
    return { start, end, path: `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}` };
  }
  const isDownward = to.y > from.y;
  const start = { x: fromCenterX, y: isDownward ? from.y + from.height : from.y };
  const end = { x: toCenterX, y: isDownward ? to.y : to.y + to.height };
  const bend = (end.y - start.y) / 2;
  return { start, end, path: `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}` };
}

function layoutWires(board: Board, boxesById: ReadonlyMap<string, LaidOutBox>): LaidOutWire[] {
  return elementsOfKind(board, 'wire').flatMap((wire) => {
    const from = boxesById.get(wire.from);
    const to = boxesById.get(wire.to);
    if (!from || !to) return [];
    const ends = wireEnds(from, to);
    return [{
      kind: 'wire' as const, id: wire.id, path: ends.path, start: ends.start, end: ends.end,
      label: wire.label, labelAt: { x: (ends.start.x + ends.end.x) / 2, y: (ends.start.y + ends.end.y) / 2 - 6 },
      isDashed: wire.dashed, tone: wire.tone, strokeHex: wire.tone === 'lane' ? from.lane?.hex ?? null : null,
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

function boundsOf(elements: readonly LaidOutElement[], columnLeftEdges: readonly number[], boxesTop: number): Rect {
  const rects = elements.flatMap((element) => (element.kind === 'wire' ? [] : [element]));
  const columnsRight = (columnLeftEdges.at(-1) ?? MARGIN) + COLUMN_WIDTH;
  const around = unionOf([...rects, { x: 0, y: 0, width: columnsRight, height: boxesTop }]);
  if (!around) return { x: 0, y: 0, width: columnsRight + MARGIN, height: MARGIN * 2 };
  return { x: Math.min(0, around.x - MARGIN), y: Math.min(0, around.y - MARGIN), width: around.width + MARGIN * 2, height: around.height + MARGIN * 2 };
}

function layoutBoard(board: Board): BoardLayout {
  const stackHeightByBoxId = noteStackHeightByBoxId(board);
  const columnLeftEdges = columnLeftEdgesOf(board, stackHeightByBoxId);
  const titleLinesByColumn = columnTitleLines(board);
  const extraHeaderHeight = headerExtraHeight(titleLinesByColumn);
  const boxesTop = MARGIN + COLUMN_HEADER_HEIGHT + extraHeaderHeight;
  const boxesById = layoutBoxes(board, columnLeftEdges, boxesTop, stackHeightByBoxId);
  const elements: LaidOutElement[] = [
    ...layoutFrames(board, boxesById),
    ...layoutWires(board, boxesById),
    ...boxesById.values(),
    ...layoutNotes(board, boxesById),
  ];
  const contentBounds = boundsOf(elements, columnLeftEdges, boxesTop);
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
      ruleY: MARGIN + COLUMN_RULE_OFFSET + extraHeaderHeight, x: columnLeftEdges[index] ?? MARGIN, width: COLUMN_WIDTH,
    })),
    elements,
    legend,
    caption,
    bounds: { ...contentBounds, height: contentBounds.height + extraHeight },
  };
}

function elementSignature(element: LaidOutElement): string {
  return JSON.stringify(element);
}

export { elementSignature, layoutBoard };
export type { BoardLayout, LaidOutBox, LaidOutColumn, LaidOutElement, LaidOutFrame, LaidOutNote, LaidOutWire, Rect };
