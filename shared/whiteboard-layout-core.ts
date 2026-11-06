import { BOX_CHANGES, STEP_STATUSES } from './contracts/whiteboard.ts';
import type { Board, Box, BoxLine, BoxMedia, Element, IconName, Note, Step, Wire } from './contracts/whiteboard.ts';
import { DEVICE_CATALOG, deviceArtSizeOf } from './whiteboard-devices.ts';
import type { DeviceFit, DeviceName } from './whiteboard-devices.ts';
import { ICON_BOX_GLYPH_GAP, ICON_BOX_GLYPH_SIZE, LINE_ICON_CHARS, TITLE_ICON_CHARS } from './whiteboard-icons.ts';
import { planSteps } from './whiteboard-plan-core.ts';
import type { PlanStep } from './whiteboard-plan-core.ts';
import { cappedWarningLists, previewWires, rectsOverlap, routeWires, unionOf, warningListOf } from './whiteboard-route-core.ts';
import { touchingPairsWithin } from './whiteboard-sweep-core.ts';
import type { Point, RouteMemory } from './whiteboard-route-core.ts';

const MARGIN = 40;
const DEFAULT_BOX_WIDTH = 220;
const FREE_GAP = 90;
const BOX_GAP = 30;
const WIRE_HEADROOM = 18;
const BOX_PADDING = 12;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const OUTPUT_ROW_HEIGHT = 28;
const MAX_KEY_INDENT_CHARS = 12;
const ITEM_INDENT_CHARS = 2;
const TITLE_CHARS_PER_LINE = 20;
const BODY_CHARS_PER_LINE = 26;
const FRAME_PADDING = 18;
const FRAME_TITLE_HEIGHT = 26;
const NOTE_WIDTH = 170;
const NOTE_CHARS_PER_LINE = 21;
const NOTE_LINE_HEIGHT = 17;
const NOTE_GAP = 10;
const LEGEND_ROW_HEIGHT = 22;
const NOTE_OVERLAP = 24;
const NOTE_RISE = 8;
const PLAN_TITLE_BASELINE = 16;
const PLAN_TITLE_HEIGHT = 30;
const PLAN_BAND_GAP = 40;
const STEP_HEADER_HEIGHT = 18;
const MEDIA_GAP = 8;
const MEDIA_MAX_HEIGHT = 320;
const ICON_BOX_WIDTH = 160;


interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LaidOutBox extends Rect {
  kind: 'box';
  id: string;
  titleLines: string[];
  icon: IconName | null;
  bodyLines: LaidOutLine[];
  change: Box['change'];
  wasLines: string[];
  shape: Box['shape'];
  headerHeight: number;
  outputs: LaidOutOutput[];
  media: LaidOutMedia | null;
  device: LaidOutDevice | null;
  step: LaidOutStep | null;
}

interface LaidOutDevice extends Rect {
  name: DeviceName;
  scale: number;
  screen: Rect;
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
  fit: DeviceFit;
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
  icon: IconName | null;
}

type LegendSwatch = { kind: 'wire'; tone: Wire['tone']; isDashed: boolean; isBack: boolean } | { kind: 'change'; change: Exclude<Box['change'], 'none'> } | { kind: 'status'; status: Step['status'] };

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

interface NoteShape {
  lines: string[];
  height: number;
}

interface BoardLayout {
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

function rowsOfLine(line: BoxLine, numberInRun: number, lineCharsPerLine: number): LaidOutLine[] {
  const bodyCharsPerLine = line.icon ? lineCharsPerLine - LINE_ICON_CHARS : lineCharsPerLine;
  const mutedIndentChars = line.muted ? 2 : 0;
  const marker = line.style === 'numbered' ? `${numberInRun}.` : line.style === 'kv' ? line.key : null;
  const rowOf = (text: string, index: number, indentChars: number, rowMarker: string | null): LaidOutLine => ({
    text, muted: line.muted, style: line.style, marker: index === 0 ? rowMarker : null, indentChars, isFirstRow: index === 0, icon: line.icon,
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

function defaultBoxWidthOf(box: Box): number {
  if (box.shape === 'icon') return ICON_BOX_WIDTH;
  if (box.shape === 'device') return DEVICE_CATALOG[box.device].defaultBoxWidth;
  return DEFAULT_BOX_WIDTH;
}

function boxWidthOf(box: Box): number {
  return box.width ?? defaultBoxWidthOf(box);
}

function charsPerLineAt(defaultCharsPerLine: number, boxWidth: number): number {
  return Math.floor(defaultCharsPerLine * (boxWidth - BOX_PADDING * 2) / (DEFAULT_BOX_WIDTH - BOX_PADDING * 2));
}

interface BoxContent {
  lines: readonly BoxLine[];
  media: BoxMedia | null;
  device: DeviceName | null;
  fit: DeviceFit;
  glyphRoom: number;
  titleIconChars: number;
}

interface ContentArt {
  width: number;
  height: number;
  scale: number;
  screen: Rect;
}

function boxContentOf(box: Box): BoxContent {
  const titleIconChars = box.icon ? TITLE_ICON_CHARS : 0;
  if (box.shape === 'icon') return { lines: [], media: null, device: null, fit: 'fit', glyphRoom: ICON_BOX_GLYPH_SIZE + ICON_BOX_GLYPH_GAP, titleIconChars: 0 };
  if (box.shape === 'device') return { lines: [], media: box.media, device: box.device, fit: box.fit, glyphRoom: 0, titleIconChars };
  return { lines: box.lines, media: box.media, device: null, fit: 'fit', glyphRoom: 0, titleIconChars };
}

function deviceArtOf(device: DeviceName, artWidth: number): ContentArt {
  const { screen, bezel, toolbarHeight, base } = DEVICE_CATALOG[device];
  const artSize = deviceArtSizeOf(device);
  const scale = artWidth / artSize.width;
  return {
    width: artWidth,
    height: Math.round(artSize.height * scale),
    scale,
    screen: {
      x: Math.round(((base?.overhang ?? 0) + bezel.side) * scale),
      y: Math.round((bezel.top + toolbarHeight) * scale),
      width: Math.round(screen.width * scale),
      height: Math.round(screen.height * scale),
    },
  };
}

function mediaArtOf(media: BoxMedia, boxWidth: number): ContentArt {
  const width = boxWidth - BOX_PADDING * 2;
  const maxHeight = Math.round(MEDIA_MAX_HEIGHT * boxWidth / DEFAULT_BOX_WIDTH);
  const height = Math.min(maxHeight, Math.max(1, Math.round(width * media.height / media.width)));
  return { width, height, scale: 1, screen: { x: 0, y: 0, width, height } };
}

function contentArtOf(content: BoxContent, boxWidth: number): ContentArt | null {
  if (content.device) return deviceArtOf(content.device, boxWidth - BOX_PADDING * 2);
  return content.media ? mediaArtOf(content.media, boxWidth) : null;
}

function laidOutMedia(content: BoxContent, position: Point, artTop: number, art: ContentArt | null): LaidOutMedia | null {
  const { media } = content;
  if (!media || !art) return null;
  return {
    kind: media.kind, asset: media.asset, mime: media.mime, hasPreview: media.hasPreview, alt: media.alt, fit: content.fit,
    x: position.x + BOX_PADDING + art.screen.x, y: position.y + artTop + art.screen.y, width: art.screen.width, height: art.screen.height,
  };
}

function laidOutDevice(content: BoxContent, position: Point, artTop: number, art: ContentArt | null): LaidOutDevice | null {
  if (!content.device || !art) return null;
  const artLeft = position.x + BOX_PADDING;
  const artTopY = position.y + artTop;
  const screen = { x: artLeft + art.screen.x, y: artTopY + art.screen.y, width: art.screen.width, height: art.screen.height };
  return { name: content.device, scale: art.scale, x: artLeft, y: artTopY, width: art.width, height: art.height, screen };
}

function boxShape(box: Box) {
  const content = boxContentOf(box);
  const stepHeaderHeight = box.step ? STEP_HEADER_HEIGHT : 0;
  const linkLineCount = box.step?.linkedBoardId ? 1 : 0;
  const boxWidth = boxWidthOf(box);
  const titleCharsPerLine = charsPerLineAt(TITLE_CHARS_PER_LINE, boxWidth);
  const titleLines = wrapText(box.title, titleCharsPerLine - content.titleIconChars);
  const wasLines = box.change === 'relabeled' && box.was ? wrapText(box.was, titleCharsPerLine) : [];
  const bodyLines = laidOutLines(content.lines, charsPerLineAt(BODY_CHARS_PER_LINE, boxWidth));
  const textHeight = BOX_PADDING + stepHeaderHeight + content.glyphRoom + (wasLines.length + titleLines.length) * TITLE_LINE_HEIGHT + (bodyLines.length + linkLineCount) * BODY_LINE_HEIGHT;
  const art = contentArtOf(content, boxWidth);
  const artRoom = art ? art.height + MEDIA_GAP : 0;
  const headerHeight = textHeight + BOX_PADDING + artRoom;
  const outputs = box.shape === 'decision' ? box.outputs : [];
  return { titleLines, wasLines, bodyLines, headerHeight, outputs, content, artTop: textHeight + MEDIA_GAP, art, height: headerHeight + outputs.length * OUTPUT_ROW_HEIGHT };
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

interface PlacedBoxes {
  boxesById: Map<string, LaidOutBox>;
  warnings: string[];
}

function laidOutStep(board: IndexedBoard, box: Box): LaidOutStep | null {
  if (!box.step) return null;
  return { label: board.planStepById.get(box.id)?.label ?? '', status: box.step.status, linkedBoardId: box.step.linkedBoardId };
}

function laidOutBox(board: IndexedBoard, box: Box, position: Point): LaidOutBox {
  const shape = boxShape(box);
  const width = boxWidthOf(box);
  return {
    kind: 'box', id: box.id, x: position.x, y: position.y, width, height: shape.height,
    titleLines: shape.titleLines, icon: box.icon, bodyLines: shape.bodyLines, change: box.change, wasLines: shape.wasLines,
    shape: box.shape, headerHeight: shape.headerHeight, media: laidOutMedia(shape.content, position, shape.artTop, shape.art), device: laidOutDevice(shape.content, position, shape.artTop, shape.art), step: laidOutStep(board, box),
    outputs: shape.outputs.map((output, index) => ({
      id: output.id, label: output.label,
      port: { x: position.x + width, y: position.y + shape.headerHeight + index * OUTPUT_ROW_HEIGHT + OUTPUT_ROW_HEIGHT / 2 },
    })),
  };
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
  return { x: boxesById.size > 0 ? rightmostEdge + FREE_GAP : MARGIN, y: boxesTop };
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
    const size = { width: boxWidthOf(box), height: boxShape(box).height };
    const position = targetBox ? nearPosition(targetBox, box.near, size) : freeOrigin(boxesById, boxesTop);
    const placed = laidOutBox(board, box, { x: Math.round(position.x), y: Math.round(position.y) });
    boxesById.set(box.id, placed);
    return placed;
  };
  for (const box of nearBoxes) place(box, new Set());
}

function isStackedPanel(box: Box): boolean {
  return box.shape === 'panel' && box.step === null && box.near === null && box.at === null;
}

function placeStackedPanels(board: IndexedBoard, boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>, boxesById: Map<string, LaidOutBox>): void {
  const stackedPanels = elementsOfKind(board, 'box').filter(isStackedPanel).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (stackedPanels.length === 0) return;
  const drawingRight = [...boxesById.values()].reduce((rightmost, box) => Math.max(rightmost, box.x + box.width + (stackHeightByBoxId.has(box.id) ? NOTE_WIDTH - NOTE_OVERLAP : 0)), -Infinity);
  const stackX = boxesById.size > 0 ? Math.round(drawingRight + FREE_GAP) : MARGIN;
  let nextY = boxesTop;
  for (const panel of stackedPanels) {
    const placed = laidOutBox(board, panel, { x: stackX, y: nextY });
    boxesById.set(panel.id, placed);
    nextY += Math.max(placed.height, (stackHeightByBoxId.get(panel.id) ?? 0) - NOTE_RISE) + BOX_GAP;
  }
}

function layoutBoxes(board: IndexedBoard, boxesTop: number, stackHeightByBoxId: ReadonlyMap<string, number>, stepBandPositions: ReadonlyMap<string, Point>): PlacedBoxes {
  const boxesById = new Map<string, LaidOutBox>();
  const warnings: string[] = [];
  for (const box of elementsOfKind(board, 'box')) {
    const bandPosition = stepBandPositions.get(box.id);
    if (bandPosition) boxesById.set(box.id, laidOutBox(board, box, bandPosition));
  }
  for (const box of elementsOfKind(board, 'box')) {
    if (box.at) boxesById.set(box.id, laidOutBox(board, box, box.at));
  }
  placeNearBoxes(board, boxesTop, boxesById, warnings);
  placeStackedPanels(board, boxesTop, stackHeightByBoxId, boxesById);
  for (const box of elementsOfKind(board, 'box')) {
    if (!boxesById.has(box.id)) boxesById.set(box.id, laidOutBox(board, box, freeOrigin(boxesById, boxesTop)));
  }
  return { boxesById, warnings };
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

function boundsOf(elements: readonly LaidOutElement[], wireExtent: Rect | null, boxesTop: number): Rect {
  const rects = elements.flatMap((element) => (element.kind === 'wire' ? [] : [element]));
  const around = unionOf([...rects, ...(wireExtent ? [wireExtent] : []), { x: 0, y: 0, width: MARGIN, height: boxesTop }]);
  if (!around) return { x: 0, y: 0, width: MARGIN * 2, height: MARGIN * 2 };
  return { x: Math.min(0, around.x - MARGIN), y: Math.min(0, around.y - MARGIN), width: around.width + MARGIN * 2, height: around.height + MARGIN * 2 };
}

interface PlacedBoard {
  boxesById: Map<string, LaidOutBox>;
  collectPlacementWarnings: () => string[];
  frames: LaidOutFrame[];
  notes: LaidOutNote[];
  routing: ReturnType<typeof routeWires>;
}

interface Placement {
  boxesTop: number;
  contentTop: number;
  stackHeightByBoxId: ReadonlyMap<string, number>;
  stepBandPositions: ReadonlyMap<string, Point>;
}

interface LayoutMemory {
  route: RouteMemory;
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
  const { boxesById, warnings: nearWarnings } = layoutBoxes(board, placement.boxesTop, placement.stackHeightByBoxId, placement.stepBandPositions);
  const frames = layoutFrames(board, boxesById);
  const notes = layoutNotes(board, boxesById);
  const routing = routeWires({
    wires: elementsOfKind(board, 'wire'), boxesById,
    softObstacles: [...notes, ...frames.map((frame) => ({ x: frame.x, y: frame.y, width: frame.width, height: FRAME_TITLE_HEIGHT }))],
    loopFrames: frames.filter((frame) => frame.isLoop),
    contentTop: placement.contentTop,
  }, previousRoute);
  return {
    boxesById, frames, notes, routing,
    collectPlacementWarnings: () => [...nearWarnings, ...overlapWarnings(boxesById, frames, board)],
  };
}

function isInStepBand(box: Box): boolean {
  return box.step !== null && box.near === null && box.at === null;
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
      nextY += boxShape(box).height;
      lowestBottom = Math.max(lowestBottom, nextY);
      nextY += BOX_GAP;
    }
    levelX += Math.max(...boxesAtLevel.map(boxWidthOf)) + FREE_GAP;
  }
  return { positionById, bottom: lowestBottom + PLAN_BAND_GAP };
}

function wireCeilingOf(freeformTop: number): number {
  return freeformTop - WIRE_HEADROOM;
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

const WIRE_STYLE_WORDS: Readonly<Record<Wire['tone'], string | null>> = { plain: null, fail: 'failure path', join: 'joins' };

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
  return [...wireEntries.map(({ label, swatch }) => ({ label, swatch })), ...unusedCustomEntries, ...changeEntriesOf(board), ...statusEntriesOf(board)];
}

function layoutBoard(storedBoard: Board): BoardLayout {
  return layoutBoardWithMemory(storedBoard, null).layout;
}

function layoutBoardWithMemory(storedBoard: Board, previous: LayoutMemory | null): { layout: BoardLayout; memory: LayoutMemory } {
  const { positionById: stepBandPositions, bottom: freeformTop } = stepBandOf(storedBoard);
  const pinnedOffsetY = freeformTop - MARGIN;
  const board = indexedBoardOf(withPinnedBoxesShifted(storedBoard, pinnedOffsetY));
  const stackHeightByBoxId = noteStackHeightByBoxId(board);
  const boxesTop = freeformTop;
  const placed = placeAndRoute(board, { boxesTop, contentTop: wireCeilingOf(freeformTop), stackHeightByBoxId, stepBandPositions }, previous?.route ?? null);
  const memory: LayoutMemory = { route: placed.routing.memory };
  const elements: LaidOutElement[] = [
    ...placed.frames,
    ...placed.routing.wires,
    ...placed.boxesById.values(),
    ...placed.notes,
  ];
  const contentBounds = boundsOf(elements, placed.routing.extent, boxesTop);
  const legendTop = contentBounds.y + contentBounds.height;
  const legend = legendEntriesOf(board).map((entry, index): LegendRow => ({ ...entry, x: MARGIN, y: legendTop + index * LEGEND_ROW_HEIGHT }));
  const captionTop = legendTop + legend.length * LEGEND_ROW_HEIGHT + (legend.length > 0 ? 12 : 0);
  const caption = board.caption ? { text: board.caption, x: MARGIN, y: captionTop } : null;
  const extraHeight = legend.length * LEGEND_ROW_HEIGHT + (caption ? 30 : 0) + (legend.length > 0 ? 12 : 0);
  const layout: BoardLayout = {
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
  const device = box.device ? { ...box.device, x: box.device.x + offsetX, y: box.device.y + offsetY, screen: { ...box.device.screen, x: box.device.screen.x + offsetX, y: box.device.screen.y + offsetY } } : null;
  return { ...box, x: box.x + offsetX, y: box.y + offsetY, outputs, media, device };
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
  const contentTop = wireCeilingOf(stepBandOf(storedBoard).bottom);
  return (offsetX, offsetY) => {
    const moved = movingBoxes.map((box) => movedBox(box, offsetX, offsetY));
    for (const box of moved) boxesById.set(box.id, box);
    const notes = movingNotes.map((note) => ({ ...note, x: note.x + offsetX, y: note.y + offsetY }));
    return [...moved, ...notes, ...previewWires({ wires, boxesById, softObstacles: [...stillSoftObstacles, ...notes], loopFrames, contentTop })];
  };
}

export { createDragPreview, elementSignature, isStackedPanel, layoutBoard, layoutBoardWithMemory, pinnedOffsetYOf };
export type { BoardLayout, DragPreview, LayoutMemory, LaidOutBox, LaidOutDevice, LaidOutMedia, LaidOutElement, LaidOutFrame, LaidOutLine, LaidOutNote, LaidOutStep, LaidOutWire, Rect };
