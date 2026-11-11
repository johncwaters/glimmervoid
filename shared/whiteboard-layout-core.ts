import { BOX_CHANGES, dialValuesOfBox, isBorderlessBox, mediaOfBox, STEP_STATUSES, WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, Box, BoxInput, BoxLine, BoxMedia, DialValue, Element, Frame, Stroke, Wire } from './contracts/whiteboard.ts';
import { DEVICE_CATALOG, deviceArtSizeOf } from './whiteboard-devices.ts';
import type { DeviceFit, DeviceName } from './whiteboard-devices.ts';
import { ICON_BOX_GLYPH_GAP, ICON_BOX_GLYPH_SIZE, TITLE_ICON_CHARS } from './whiteboard-icons.ts';
import { planSteps, stepBoxesOf } from './whiteboard-plan-core.ts';
import type { PlanStep } from './whiteboard-plan-core.ts';
import { cappedWarningLists, previewWires, rectsOverlap, routeWires, unionOf, warningListOf } from './whiteboard-route-core.ts';
import { touchingPairsWithin } from './whiteboard-sweep-core.ts';
import type { Point, RouteMemory, WarningList } from './whiteboard-route-core.ts';
import { forEachSlotTouching, gridOfRects } from './spatial-grid-core.ts';
import type { LaidOutBox, LaidOutDevice, LaidOutElement, LaidOutFrame, LaidOutLine, LaidOutMedia, LaidOutStep, LaidOutStroke, LaidOutWire, LegendRow, PlacedBox, PlacedElement, PlanBand, PlanColumn } from './contracts/whiteboard-tiles.ts';
import { elementTableOf } from './whiteboard-element-table.ts';

const MARGIN = 40;
const DEFAULT_BOX_WIDTH = 220;
const FREE_GAP = 90;
const BOX_GAP = 30;
const WIRE_HEADROOM = 18;
const BOX_PADDING = 12;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const MAX_KEY_INDENT_CHARS = 12;
const ITEM_INDENT_CHARS = 2;
const TITLE_CHARS_PER_LINE = 20;
const BODY_CHARS_PER_LINE = 26;
const FRAME_PADDING = 18;
const FRAME_TITLE_HEIGHT = 26;
const STACK_SPREAD = 6;
const LEGEND_ROW_HEIGHT = 22;
const PLAN_TITLE_BASELINE = 16;
const PLAN_TITLE_HEIGHT = 30;
const PLAN_BAND_GAP = 40;
const STEP_HEADER_HEIGHT = 18;
const MEDIA_GAP = 8;
const MEDIA_MAX_HEIGHT = 320;
const OVERLAP_CELL_SIZE = 256;
const ICON_BOX_WIDTH = 160;
const SOFT_BREAK_CHARS = '_./:,-';
const FITTED_BOX_WIDTH_MAX = 480;
const FITTED_BOX_WIDTH_STEP = 20;
const FITTED_BOX_SHAPES: ReadonlySet<Box['shape']> = new Set(['box', 'decision', 'sticky', 'note', 'text']);


interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PlacedLayout {
  elements: PlacedElement[];
  legend: LegendRow[];
  caption: { text: string; x: number; y: number } | null;
  plan: PlanBand | null;
  pinnedOffsetY: number;
  bounds: Rect;
  warnings: string[];
}

interface BoardLayout extends Omit<PlacedLayout, 'elements'> {
  elements: LaidOutElement[];
}

interface WrappedText {
  lines: string[];
  isCutMidWord: boolean;
}

function softBreakLengthOf(word: string, charsPerLine: number): number | null {
  for (let length = charsPerLine; length >= Math.ceil(charsPerLine / 2); length -= 1) {
    if (SOFT_BREAK_CHARS.includes(word.charAt(length - 1))) return length;
  }
  return null;
}

function piecesOfWord(word: string, charsPerLine: number): WrappedText {
  const lines: string[] = [];
  let isCutMidWord = false;
  let rest = word;
  while (rest.length > charsPerLine) {
    const softLength = softBreakLengthOf(rest, charsPerLine);
    isCutMidWord ||= softLength === null;
    lines.push(rest.slice(0, softLength ?? charsPerLine));
    rest = rest.slice(softLength ?? charsPerLine);
  }
  return { lines: [...lines, rest], isCutMidWord };
}

function wrappedText(text: string, charsPerLine: number): WrappedText {
  const columns = Math.max(1, charsPerLine);
  const lines: string[] = [];
  let isCutMidWord = false;
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const pieces = piecesOfWord(word, columns);
    isCutMidWord ||= pieces.isCutMidWord;
    for (const piece of pieces.lines) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (candidate.length <= columns) {
        current = candidate;
        continue;
      }
      lines.push(current);
      current = piece;
    }
  }
  if (current) lines.push(current);
  return { lines: lines.length > 0 ? lines : [''], isCutMidWord };
}

function wrapText(text: string, charsPerLine: number): string[] {
  return wrappedText(text, charsPerLine).lines;
}

interface MeasuredRows {
  rows: LaidOutLine[];
  isCutMidWord: boolean;
}

function measuredRowsOfLine(line: BoxLine, bodyCharsPerLine: number): MeasuredRows {
  const mutedIndentChars = line.muted ? 2 : 0;
  const marker = line.style === 'kv' ? line.key : null;
  const rowOf = (text: string, index: number, indentChars: number, rowMarker: string | null): LaidOutLine => ({
    text, muted: line.muted, style: line.style, marker: index === 0 ? rowMarker : null, indentChars, isFirstRow: index === 0,
  });
  if (marker && marker.length + 1 > MAX_KEY_INDENT_CHARS) {
    const value = wrappedText(line.text, bodyCharsPerLine - mutedIndentChars - ITEM_INDENT_CHARS);
    return { rows: [rowOf('', 0, 0, marker), ...value.lines.map((text) => rowOf(text, 1, ITEM_INDENT_CHARS, null))], isCutMidWord: value.isCutMidWord };
  }
  const indentChars = line.style === 'item' ? ITEM_INDENT_CHARS : marker ? marker.length + 1 : 0;
  const wrapped = wrappedText(line.text, bodyCharsPerLine - mutedIndentChars - indentChars - (line.style === 'code' ? 1 : 0));
  return { rows: wrapped.lines.map((text, index) => rowOf(text, index, indentChars, marker)), isCutMidWord: wrapped.isCutMidWord };
}

function measuredLines(lines: readonly BoxLine[], bodyCharsPerLine: number): MeasuredRows {
  const measured = lines.map((line) => measuredRowsOfLine(line, bodyCharsPerLine));
  return { rows: measured.flatMap((line) => line.rows), isCutMidWord: measured.some((line) => line.isCutMidWord) };
}

function laidOutLines(lines: readonly BoxLine[], bodyCharsPerLine = BODY_CHARS_PER_LINE): LaidOutLine[] {
  return measuredLines(lines, bodyCharsPerLine).rows;
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
  dialValues: Record<string, DialValue>;
}

interface ContentArt {
  width: number;
  height: number;
  scale: number;
  screen: Rect;
}

function boxContentOf(box: Box): BoxContent {
  const titleIconChars = box.icon ? TITLE_ICON_CHARS : 0;
  if (box.shape === 'icon') return { lines: [], media: null, device: null, fit: 'fit', glyphRoom: ICON_BOX_GLYPH_SIZE + ICON_BOX_GLYPH_GAP, titleIconChars: 0, dialValues: {} };
  const dialValues = dialValuesOfBox(box);
  if (box.shape === 'device') return { lines: [], media: box.media, device: box.device, fit: box.fit, glyphRoom: 0, titleIconChars, dialValues };
  return { lines: box.lines, media: mediaOfBox(box), device: null, fit: 'fit', glyphRoom: 0, titleIconChars, dialValues };
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
    kind: media.kind, asset: media.asset, mime: media.mime, hasPreview: media.hasPreview, alt: media.alt, fit: content.fit, dialValues: content.dialValues,
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

type BoxShape = ReturnType<typeof measuredBoxShape>;

const boxShapeCache = new WeakMap<Box, BoxShape>();

function boxShape(box: Box): BoxShape {
  const cached = boxShapeCache.get(box);
  if (cached) return cached;
  const shape = measuredBoxShape(box);
  boxShapeCache.set(box, shape);
  return shape;
}

interface BoxText {
  titleLines: string[];
  wasLines: string[];
  bodyLines: LaidOutLine[];
}

function boxTextOf(box: Box, boxWidth: number): BoxText {
  const content = boxContentOf(box);
  const titleCharsPerLine = charsPerLineAt(TITLE_CHARS_PER_LINE, boxWidth);
  return {
    titleLines: wrapText(box.title, titleCharsPerLine - content.titleIconChars),
    wasLines: box.change === 'relabeled' && box.was ? wrapText(box.was, titleCharsPerLine) : [],
    bodyLines: laidOutLines(content.lines, charsPerLineAt(BODY_CHARS_PER_LINE, boxWidth)),
  };
}

interface TextFit {
  isTitleOnOneLine: boolean;
  isTitleCutMidWord: boolean;
  isBodyCutMidWord: boolean;
}

function textFitAt(box: Box, boxWidth: number): TextFit {
  const content = boxContentOf(box);
  const title = wrappedText(box.title, charsPerLineAt(TITLE_CHARS_PER_LINE, boxWidth) - content.titleIconChars);
  return {
    isTitleOnOneLine: title.lines.length === 1,
    isTitleCutMidWord: title.isCutMidWord,
    isBodyCutMidWord: measuredLines(content.lines, charsPerLineAt(BODY_CHARS_PER_LINE, boxWidth)).isCutMidWord,
  };
}

function firstWidthWhere(fromWidth: number, toWidth: number, accepts: (fit: TextFit) => boolean, box: Box): number | null {
  for (let width = fromWidth; width <= toWidth; width += FITTED_BOX_WIDTH_STEP) {
    if (accepts(textFitAt(box, width))) return width;
  }
  return null;
}

function fittedBoxWidthOf(box: Box): number | null {
  if (!FITTED_BOX_SHAPES.has(box.shape) || mediaOfBox(box)) return null;
  const preferences: ((fit: TextFit) => boolean)[] = [
    (fit) => fit.isTitleOnOneLine && !fit.isBodyCutMidWord,
    (fit) => fit.isTitleOnOneLine,
    (fit) => !fit.isTitleCutMidWord && !fit.isBodyCutMidWord,
    (fit) => !fit.isTitleCutMidWord,
  ];
  const fittedWidths = preferences.flatMap((accepts) => firstWidthWhere(DEFAULT_BOX_WIDTH, FITTED_BOX_WIDTH_MAX, accepts, box) ?? []);
  const fitted = fittedWidths[0] ?? DEFAULT_BOX_WIDTH;
  return fitted === DEFAULT_BOX_WIDTH ? null : fitted;
}

function titleCutWarningOf(box: Box): string | null {
  const boxWidth = boxWidthOf(box);
  if (box.shape === 'icon' || box.shape === 'device' || !textFitAt(box, boxWidth).isTitleCutMidWord) return null;
  const fittingWidth = firstWidthWhere(boxWidth + FITTED_BOX_WIDTH_STEP, WHITEBOARD_LIMITS.boxWidthMax, (fit) => !fit.isTitleCutMidWord, box);
  const cutText = `box ${box.id} title is cut mid-word at width ${boxWidth}`;
  return fittingWidth === null ? cutText : `${cutText}; set width ${fittingWidth}`;
}

function measuredBoxShape(box: Box) {
  const content = boxContentOf(box);
  const stepHeaderHeight = box.step ? STEP_HEADER_HEIGHT : 0;
  const boxWidth = boxWidthOf(box);
  const { titleLines, wasLines, bodyLines } = boxTextOf(box, boxWidth);
  const textHeight = BOX_PADDING + stepHeaderHeight + content.glyphRoom + (wasLines.length + titleLines.length) * TITLE_LINE_HEIGHT + bodyLines.length * BODY_LINE_HEIGHT;
  const art = contentArtOf(content, boxWidth);
  const artRoom = art ? art.height + MEDIA_GAP : 0;
  const headerHeight = textHeight + BOX_PADDING + artRoom;
  return { headerHeight, content, artTop: textHeight + MEDIA_GAP, art, height: Math.max(headerHeight, box.height ?? 0) };
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
    case 'stroke':
      elementsByKind.stroke.push(element);
      return;
  }
}

function indexedBoardOf(board: Board): IndexedBoard {
  const elementsByKind: ElementsByKind = { box: [], frame: [], wire: [], stroke: [] };
  for (const element of board.elements.values()) addByKind(elementsByKind, element);
  return { ...board, elementsByKind, planStepById: new Map(planSteps(board).map((step) => [step.boxId, step])) };
}

function elementsOfKind<Kind extends Element['kind']>(board: IndexedBoard, kind: Kind): readonly Extract<Element, { kind: Kind }>[] {
  return board.elementsByKind[kind];
}

function laidOutStep(planStepById: ReadonlyMap<string, PlanStep>, box: Box): LaidOutStep | null {
  if (!box.step) return null;
  return { label: planStepById.get(box.id)?.label ?? '', status: box.step.status };
}

function laidOutBox(planStepById: ReadonlyMap<string, PlanStep>, box: Box, position: Point): PlacedBox {
  const shape = boxShape(box);
  const width = boxWidthOf(box);
  return {
    kind: 'box', id: box.id, x: position.x, y: position.y, width, height: shape.height,
    icon: box.icon, change: box.change,
    shape: box.shape, tone: box.shape === 'sticky' ? box.tone : null, isBorderless: isBorderlessBox(box), headerHeight: shape.headerHeight, media: laidOutMedia(shape.content, position, shape.artTop, shape.art), device: laidOutDevice(shape.content, position, shape.artTop, shape.art), step: laidOutStep(planStepById, box),
  };
}

type Near = NonNullable<BoxInput['near']>;

function nearPosition(target: PlacedBox, near: Near, size: { width: number; height: number }): Point {
  const centeredY = target.y + target.height / 2 - size.height / 2;
  const centeredX = target.x + target.width / 2 - size.width / 2;
  switch (near.side) {
    case 'right': return { x: target.x + target.width + near.gap, y: centeredY };
    case 'left': return { x: target.x - size.width - near.gap, y: centeredY };
    case 'bottom': return { x: centeredX, y: target.y + target.height + near.gap };
    case 'top': return { x: centeredX, y: target.y - size.height - near.gap };
  }
}

function laidOutNearBox(planStepById: ReadonlyMap<string, PlanStep>, box: Box, near: Near, target: PlacedBox): PlacedBox {
  const position = nearPosition(target, near, { width: boxWidthOf(box), height: boxShape(box).height });
  return laidOutBox(planStepById, box, { x: Math.round(position.x), y: Math.round(position.y) });
}

function freeOrigin(boxesById: ReadonlyMap<string, PlacedBox>, boxesTop: number): Point {
  const rightmostEdge = [...boxesById.values()].reduce((rightmost, box) => Math.max(rightmost, box.x + box.width), -Infinity);
  return { x: boxesById.size > 0 ? rightmostEdge + FREE_GAP : MARGIN, y: boxesTop };
}

function isStackedPanel(box: Box): boolean {
  return box.shape === 'panel' && box.step === null && box.at === null;
}

function placeStackedPanels(board: IndexedBoard, boxesTop: number, boxesById: Map<string, PlacedBox>): void {
  const stackedPanels = elementsOfKind(board, 'box').filter(isStackedPanel).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (stackedPanels.length === 0) return;
  const drawingRight = [...boxesById.values()].reduce((rightmost, box) => Math.max(rightmost, box.x + box.width), -Infinity);
  const stackX = boxesById.size > 0 ? Math.round(drawingRight + FREE_GAP) : MARGIN;
  let nextY = boxesTop;
  for (const panel of stackedPanels) {
    const placed = laidOutBox(board.planStepById, panel, { x: stackX, y: nextY });
    boxesById.set(panel.id, placed);
    nextY += placed.height + BOX_GAP;
  }
}

function layoutBoxes(board: IndexedBoard, boxesTop: number, stepBandPositions: ReadonlyMap<string, Point>): Map<string, PlacedBox> {
  const boxesById = new Map<string, PlacedBox>();
  for (const box of elementsOfKind(board, 'box')) {
    const bandPosition = stepBandPositions.get(box.id);
    if (bandPosition) boxesById.set(box.id, laidOutBox(board.planStepById, box, bandPosition));
  }
  for (const box of elementsOfKind(board, 'box')) {
    if (box.at) boxesById.set(box.id, laidOutBox(board.planStepById, box, box.at));
  }
  placeStackedPanels(board, boxesTop, boxesById);
  for (const box of elementsOfKind(board, 'box')) {
    if (!boxesById.has(box.id)) boxesById.set(box.id, laidOutBox(board.planStepById, box, freeOrigin(boxesById, boxesTop)));
  }
  return boxesById;
}

function laidOutFrameOf(frame: Frame, boxesById: ReadonlyMap<string, PlacedBox>): LaidOutFrame | null {
  if (frame.collapsed) return laidOutStackOf(frame, boxesById);
  const around = unionOf(frame.contains.flatMap((id) => boxesById.get(id) ?? []));
  if (!around) return null;
  return {
    kind: 'frame', id: frame.id, title: frame.title, stackedBoxCount: null,
    x: around.x - FRAME_PADDING, y: around.y - FRAME_PADDING - FRAME_TITLE_HEIGHT,
    width: around.width + FRAME_PADDING * 2, height: around.height + FRAME_PADDING * 2 + FRAME_TITLE_HEIGHT,
  };
}

function laidOutStackOf(frame: Frame, boxesById: ReadonlyMap<string, PlacedBox>): LaidOutFrame | null {
  const topCardId = frame.contains[0];
  const topCard = topCardId === undefined ? undefined : boxesById.get(topCardId);
  if (!topCard) return null;
  return {
    kind: 'frame', id: frame.id, title: frame.title, stackedBoxCount: frame.contains.length,
    x: topCard.x, y: topCard.y - FRAME_TITLE_HEIGHT,
    width: topCard.width + STACK_SPREAD * 2, height: topCard.height + FRAME_TITLE_HEIGHT + STACK_SPREAD * 2,
  };
}

interface StackedView {
  visibleBoxesById: Map<string, PlacedBox>;
  topCardIdByHiddenId: Map<string, string>;
}

function stackedViewOf(board: IndexedBoard, boxesById: Map<string, PlacedBox>): StackedView {
  const topCardIdByHiddenId = new Map<string, string>();
  for (const frame of elementsOfKind(board, 'frame')) {
    const topCardId = frame.collapsed ? frame.contains[0] : undefined;
    if (topCardId === undefined) continue;
    for (const hiddenId of frame.contains.slice(1)) topCardIdByHiddenId.set(hiddenId, topCardId);
  }
  if (topCardIdByHiddenId.size === 0) return { visibleBoxesById: boxesById, topCardIdByHiddenId };
  const visibleBoxesById = new Map([...boxesById].filter(([boxId]) => !topCardIdByHiddenId.has(boxId)));
  return { visibleBoxesById, topCardIdByHiddenId };
}

function wireEndingAtCard(wire: Wire, cardIdOf: (boxId: string) => string): Wire | null {
  const from = cardIdOf(wire.from);
  const to = cardIdOf(wire.to);
  if (from === to) return null;
  if (from === wire.from && to === wire.to) return wire;
  return { ...wire, from, to };
}

function wiresEndingAtCards(wires: readonly Wire[], topCardIdByHiddenId: ReadonlyMap<string, string>): readonly Wire[] {
  if (topCardIdByHiddenId.size === 0) return wires;
  const cardIdOf = (boxId: string) => topCardIdByHiddenId.get(boxId) ?? boxId;
  return wires.flatMap((wire) => wireEndingAtCard(wire, cardIdOf) ?? []);
}

function layoutFrames(board: IndexedBoard, boxesById: ReadonlyMap<string, PlacedBox>): LaidOutFrame[] {
  return elementsOfKind(board, 'frame').flatMap((frame) => laidOutFrameOf(frame, boxesById) ?? []);
}

function frameTitleStripOf(frame: Rect): Rect {
  return { x: frame.x, y: frame.y, width: frame.width, height: FRAME_TITLE_HEIGHT };
}

function headerRectOf(boxesTop: number): Rect {
  return { x: 0, y: 0, width: MARGIN, height: boxesTop };
}

function contentBoundsOf(around: Rect | null): Rect {
  if (!around) return { x: 0, y: 0, width: MARGIN * 2, height: MARGIN * 2 };
  return { x: Math.min(0, around.x - MARGIN), y: Math.min(0, around.y - MARGIN), width: around.width + MARGIN * 2, height: around.height + MARGIN * 2 };
}

function boundsOf(elements: readonly PlacedElement[], wireExtent: Rect | null, boxesTop: number): Rect {
  const rects = elements.flatMap((element) => (element.kind === 'wire' ? [] : [element]));
  return contentBoundsOf(unionOf([...rects, ...(wireExtent ? [wireExtent] : []), headerRectOf(boxesTop)]));
}

interface PlacedBoard {
  boxesById: Map<string, PlacedBox>;
  collectPlacementWarnings: () => string[];
  frames: LaidOutFrame[];
  routing: ReturnType<typeof routeWires>;
}

interface Placement {
  boxesTop: number;
  contentTop: number;
  stepBandPositions: ReadonlyMap<string, Point>;
}

interface LayoutMemory {
  route: RouteMemory;
}

function boxOverlapWarning(firstBoxId: string, secondBoxId: string): string {
  return `box ${firstBoxId} overlaps box ${secondBoxId}`;
}

function coveredTitleWarning(boxId: string, frameId: string): string {
  return `box ${boxId} covers the title of frame ${frameId}`;
}

function overlapWarnings(boxesById: ReadonlyMap<string, PlacedBox>, frames: readonly LaidOutFrame[], board: IndexedBoard): string[] {
  const boxes = [...boxesById.values()];
  const boxOverlaps = touchingPairsWithin(boxes).flatMap(([firstIndex, secondIndex]) => {
    const first = boxes[firstIndex];
    const second = boxes[secondIndex];
    return first && second && rectsOverlap(first, second) ? [boxOverlapWarning(first.id, second.id)] : [];
  });
  const containedIdsByFrameId = new Map(elementsOfKind(board, 'frame').map((frame) => [frame.id, new Set(frame.contains)]));
  const boxGrid = gridOfRects(boxes, OVERLAP_CELL_SIZE);
  const coveredTitles = frames.flatMap((frame) => {
    const titleStrip = frameTitleStripOf(frame);
    const coveringBoxIndexes: number[] = [];
    forEachSlotTouching(boxGrid, titleStrip, (boxIndex) => {
      const box = boxes[boxIndex];
      if (box && !containedIdsByFrameId.get(frame.id)?.has(box.id) && rectsOverlap(box, titleStrip)) coveringBoxIndexes.push(boxIndex);
    });
    return coveringBoxIndexes.sort((first, second) => first - second).map((boxIndex) => coveredTitleWarning(boxes[boxIndex]?.id ?? '', frame.id));
  });
  return [...boxOverlaps, ...coveredTitles];
}

function placeAndRoute(board: IndexedBoard, placement: Placement, previousRoute: RouteMemory | null): PlacedBoard {
  const placedBoxesById = layoutBoxes(board, placement.boxesTop, placement.stepBandPositions);
  const { visibleBoxesById: boxesById, topCardIdByHiddenId } = stackedViewOf(board, placedBoxesById);
  const frames = layoutFrames(board, boxesById);
  const routing = routeWires({
    wires: wiresEndingAtCards(elementsOfKind(board, 'wire'), topCardIdByHiddenId), boxesById,
    softObstacles: frames.map(frameTitleStripOf),
    contentTop: placement.contentTop,
    storedWireKeyOf: (wire) => board.elements.bodyOf(wire.id),
  }, previousRoute);
  return {
    boxesById, frames, routing,
    collectPlacementWarnings: () => [...overlapWarnings(boxesById, frames, board), ...elementsOfKind(board, 'box').flatMap((box) => (boxesById.has(box.id) ? titleCutWarningOf(box) ?? [] : []))],
  };
}

function isInStepBand(box: Box): boolean {
  return box.step !== null && box.at === null;
}

interface StepBand {
  positionById: Map<string, Point>;
  bottom: number;
  columns: PlanColumn[];
}

function stepBandOf(board: Board): StepBand {
  const bandBoxById = new Map<string, Box>(stepBoxesOf(board).filter(isInStepBand).map((box) => [box.id, box]));
  const positionById = new Map<string, Point>();
  if (bandBoxById.size === 0) return { positionById, bottom: MARGIN, columns: [] };
  const bandBoxesByLevel = new Map<number, Box[]>();
  for (const step of planSteps(board)) {
    const box = bandBoxById.get(step.boxId);
    if (box) bandBoxesByLevel.set(step.level, [...(bandBoxesByLevel.get(step.level) ?? []), box]);
  }
  let levelX = MARGIN;
  let lowestBottom = MARGIN;
  const columns: PlanColumn[] = [];
  for (const level of [...bandBoxesByLevel.keys()].sort((left, right) => left - right)) {
    const boxesAtLevel = bandBoxesByLevel.get(level) ?? [];
    let nextY = MARGIN + PLAN_TITLE_HEIGHT;
    let columnBottom = nextY;
    for (const box of boxesAtLevel) {
      positionById.set(box.id, { x: levelX, y: nextY });
      nextY += boxShape(box).height;
      columnBottom = nextY;
      lowestBottom = Math.max(lowestBottom, nextY);
      nextY += BOX_GAP;
    }
    if (boxesAtLevel.length > 0) columns.push({ x: levelX, bottom: columnBottom, boxCount: boxesAtLevel.length });
    levelX += Math.max(...boxesAtLevel.map(boxWidthOf)) + FREE_GAP;
  }
  return { positionById, bottom: lowestBottom + PLAN_BAND_GAP, columns };
}

function wireCeilingOf(freeformTop: number): number {
  const hasStepBand = freeformTop > MARGIN;
  return hasStepBand ? freeformTop - WIRE_HEADROOM : Number.NEGATIVE_INFINITY;
}

function pinnedOffsetYOf(board: Board): number {
  return stepBandOf(board).bottom - MARGIN;
}

function pinnedOffsetYAfterLeaving(plan: PlanBand | null, leavingBoxes: readonly { x: number; height: number }[]): number {
  const remainingBottoms = (plan?.columns ?? []).flatMap((column) => {
    const leavingHere = leavingBoxes.filter((box) => box.x === column.x);
    if (leavingHere.length >= column.boxCount) return [];
    return [column.bottom - leavingHere.reduce((shrink, box) => shrink + box.height + BOX_GAP, 0)];
  });
  if (remainingBottoms.length === 0) return 0;
  return Math.max(MARGIN, ...remainingBottoms) + PLAN_BAND_GAP - MARGIN;
}

function laidOutStrokeOf(stroke: Stroke, pinnedOffsetY: number): LaidOutStroke {
  const points = stroke.points.map((value, index) => (index % 2 === 1 ? value + pinnedOffsetY : value));
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 1 < points.length; index += 2) {
    const x = points[index] ?? 0;
    const y = points[index + 1] ?? 0;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  const halfWidth = stroke.width / 2;
  return { kind: 'stroke', id: stroke.id, points, strokeWidth: stroke.width, tone: stroke.tone, x: left - halfWidth, y: top - halfWidth, width: right - left + stroke.width, height: bottom - top + stroke.width };
}

function withPinnedBoxesShifted(board: Board, offsetY: number): Board {
  if (offsetY === 0) return board;
  const elements = [...board.elements.values()].map((element) => (element.kind !== 'box' || !element.at ? element : { ...element, at: { x: element.at.x, y: element.at.y + offsetY } }));
  return { ...board, elements: elementTableOf(elements) };
}

const WIRE_STYLE_WORDS: Readonly<Record<Wire['tone'], string | null>> = { plain: null, fail: 'failure path', join: 'joins' };

function wireStyleKey(tone: Wire['tone'], isDashed: boolean): string {
  return `${tone}|${isDashed}`;
}

function defaultWireStyleLabel(tone: Wire['tone'], isDashed: boolean): string | null {
  const words = [WIRE_STYLE_WORDS[tone], isDashed ? 'optional' : null].filter((word) => word !== null);
  return words.length > 0 ? words.join(', ') : null;
}

const CHANGE_LEGEND_LABELS: Readonly<Record<Exclude<Box['change'], 'none'>, string>> = { added: 'added by this change', removed: 'removed by this change', relabeled: 'renamed, old title struck through' };

type LegendEntry = { label: string; swatch: LegendRow['swatch'] };

interface WireStyle {
  tone: Wire['tone'];
  dashed: boolean;
}

function changeEntriesOf(usedChanges: ReadonlySet<Box['change']>): LegendEntry[] {
  return BOX_CHANGES.flatMap((change) => (change === 'none' || !usedChanges.has(change) ? [] : [{ label: CHANGE_LEGEND_LABELS[change], swatch: { kind: 'change' as const, change } }]));
}

function statusEntriesOf(hasPlanSteps: boolean): LegendEntry[] {
  if (!hasPlanSteps) return [];
  return STEP_STATUSES.map((status) => ({ label: `plan step ${status}`, swatch: { kind: 'status' as const, status } }));
}

function legendEntriesOf(board: IndexedBoard): LegendEntry[] {
  return legendEntriesFrom(board.legend, elementsOfKind(board, 'wire'), new Set(elementsOfKind(board, 'box').map((box) => box.change)), board.planStepById.size > 0);
}

function legendEntriesFrom(customLegend: Board['legend'], usedWireStyles: Iterable<WireStyle>, usedChanges: ReadonlySet<Box['change']>, hasPlanSteps: boolean): LegendEntry[] {
  const customLabelByKey = new Map(customLegend.map((entry) => [wireStyleKey(entry.tone, entry.dashed), entry.label]));
  const usedKeys = new Set<string>();
  const wireEntries = [...usedWireStyles].flatMap((wire) => {
    const key = wireStyleKey(wire.tone, wire.dashed);
    const label = customLabelByKey.get(key) ?? defaultWireStyleLabel(wire.tone, wire.dashed);
    if (usedKeys.has(key) || label === null) return [];
    usedKeys.add(key);
    return [{ key, label, swatch: { kind: 'wire' as const, tone: wire.tone, isDashed: wire.dashed } }];
  }).sort((left, right) => left.key.localeCompare(right.key));
  const unusedCustomEntries = customLegend
    .filter((entry) => !usedKeys.has(wireStyleKey(entry.tone, entry.dashed)))
    .map((entry) => ({ label: entry.label, swatch: { kind: 'wire' as const, tone: entry.tone, isDashed: entry.dashed } }));
  return [...wireEntries.map(({ label, swatch }) => ({ label, swatch })), ...unusedCustomEntries, ...changeEntriesOf(usedChanges), ...statusEntriesOf(hasPlanSteps)];
}

function dressedBox(placed: PlacedBox, record: Element | undefined): LaidOutBox {
  if (record?.kind !== 'box') return { ...placed, titleLines: [], wasLines: [], bodyLines: [] };
  return { ...placed, ...boxTextOf(record, placed.width) };
}

function dressedElement(placed: PlacedElement, record: Element | undefined): LaidOutElement {
  switch (placed.kind) {
    case 'box': return dressedBox(placed, record);
    default: return placed;
  }
}

function dressedLayout(placed: PlacedLayout, board: Board): BoardLayout {
  return { ...placed, elements: placed.elements.map((element) => dressedElement(element, board.elements.get(element.id))) };
}

function layoutBoard(storedBoard: Board): BoardLayout {
  return dressedLayout(placeBoardWithMemory(storedBoard, null).layout, storedBoard);
}

function storedRectsOfBoxes(storedBoard: Board): Map<string, PlacedBox> {
  const { positionById: stepBandPositions, bottom: freeformTop } = stepBandOf(storedBoard);
  const pinnedOffsetY = freeformTop - MARGIN;
  const board = indexedBoardOf(withPinnedBoxesShifted(storedBoard, pinnedOffsetY));
  const boxesById = layoutBoxes(board, freeformTop, stepBandPositions);
  return new Map([...boxesById].map(([boxId, placed]) => [boxId, { ...placed, y: placed.y - pinnedOffsetY }]));
}

function placeBoardWithMemory(storedBoard: Board, previous: LayoutMemory | null): { layout: PlacedLayout; memory: LayoutMemory; warningLists: WarningList[] } {
  const { positionById: stepBandPositions, bottom: freeformTop, columns: planColumns } = stepBandOf(storedBoard);
  const pinnedOffsetY = freeformTop - MARGIN;
  const board = indexedBoardOf(withPinnedBoxesShifted(storedBoard, pinnedOffsetY));
  const boxesTop = freeformTop;
  const placed = placeAndRoute(board, { boxesTop, contentTop: wireCeilingOf(freeformTop), stepBandPositions }, previous?.route ?? null);
  const memory: LayoutMemory = { route: placed.routing.memory };
  const elements: PlacedElement[] = [
    ...placed.frames,
    ...placed.routing.wires,
    ...placed.boxesById.values(),
    ...elementsOfKind(board, 'stroke').map((stroke) => laidOutStrokeOf(stroke, pinnedOffsetY)),
  ];
  const chrome = chromeAround(board.caption, boundsOf(elements, placed.routing.extent, boxesTop), legendEntriesOf(board), stepBandPositions.size > 0 ? planColumns : [], pinnedOffsetY);
  const warningLists = [...placed.routing.collectWarnings(), warningListOf(placed.collectPlacementWarnings())];
  return { layout: { elements, ...chrome, warnings: cappedWarningLists(warningLists) }, memory, warningLists };
}

function chromeAround(caption: string | null, contentBounds: Rect, legendEntries: readonly LegendEntry[], planColumns: readonly PlanColumn[], pinnedOffsetY: number): Omit<PlacedLayout, 'elements' | 'warnings'> {
  const legendTop = contentBounds.y + contentBounds.height;
  const legend = legendEntries.map((entry, index): LegendRow => ({ ...entry, x: MARGIN, y: legendTop + index * LEGEND_ROW_HEIGHT }));
  const captionTop = legendTop + legend.length * LEGEND_ROW_HEIGHT + (legend.length > 0 ? 12 : 0);
  const placedCaption = caption ? { text: caption, x: MARGIN, y: captionTop } : null;
  const extraHeight = legend.length * LEGEND_ROW_HEIGHT + (placedCaption ? 30 : 0) + (legend.length > 0 ? 12 : 0);
  return {
    legend,
    caption: placedCaption,
    pinnedOffsetY,
    plan: planColumns.length > 0 ? { titleAt: { x: MARGIN, y: MARGIN + PLAN_TITLE_BASELINE }, columns: [...planColumns] } : null,
    bounds: { ...contentBounds, height: contentBounds.height + extraHeight },
  };
}

function elementSignature(element: PlacedElement): string {
  return JSON.stringify(element);
}

function movedBox<Moving extends PlacedBox>(box: Moving, offsetX: number, offsetY: number): Moving {
  const media = box.media ? { ...box.media, x: box.media.x + offsetX, y: box.media.y + offsetY } : null;
  const device = box.device ? { ...box.device, x: box.device.x + offsetX, y: box.device.y + offsetY, screen: { ...box.device.screen, x: box.device.screen.x + offsetX, y: box.device.screen.y + offsetY } } : null;
  return { ...box, x: box.x + offsetX, y: box.y + offsetY, media, device };
}

type DragPreview = (offsetX: number, offsetY: number) => LaidOutElement[];

function createDragPreview(storedBoard: Board, layout: BoardLayout, draggedBoxIds: ReadonlySet<string>): DragPreview {
  const movingIds = draggedBoxIds;
  const boxesById = new Map<string, LaidOutBox>();
  const stillSoftObstacles: Rect[] = [];
  for (const element of layout.elements) {
    if (element.kind === 'box') boxesById.set(element.id, element);
    if (element.kind === 'frame') stillSoftObstacles.push(frameTitleStripOf(element));
  }
  const movingBoxes = [...movingIds].flatMap((elementId) => boxesById.get(elementId) ?? []);
  const wires = [...storedBoard.elements.values()].flatMap((element) => (element.kind === 'wire' && (movingIds.has(element.from) || movingIds.has(element.to)) ? [element] : []));
  const contentTop = wireCeilingOf(layout.pinnedOffsetY + MARGIN);
  return (offsetX, offsetY) => {
    const moved = movingBoxes.map((box) => movedBox(box, offsetX, offsetY));
    for (const box of moved) boxesById.set(box.id, box);
    return [...moved, ...previewWires({ wires, boxesById, softObstacles: stillSoftObstacles, contentTop })];
  };
}

export {
  FRAME_TITLE_HEIGHT, STACK_SPREAD,
  boxOverlapWarning, chromeAround, contentBoundsOf, coveredTitleWarning, createDragPreview, elementSignature, frameTitleStripOf, headerRectOf, isInStepBand, isStackedPanel,
  dressedElement, dressedLayout, fittedBoxWidthOf, titleCutWarningOf, laidOutBox, nearPosition, laidOutFrameOf, laidOutStrokeOf, wireEndingAtCard, laidOutNearBox, layoutBoard, legendEntriesFrom, placeBoardWithMemory, movedBox, pinnedOffsetYAfterLeaving, pinnedOffsetYOf, stepBandOf, storedRectsOfBoxes, wireCeilingOf,
};
export type { BoardLayout, DragPreview, LaidOutBox, LaidOutDevice, LaidOutElement, LaidOutFrame, LaidOutLine, LaidOutMedia, LaidOutStep, LaidOutStroke, LaidOutWire, LegendEntry, PlacedBox, PlacedElement, PlacedLayout, Rect };
