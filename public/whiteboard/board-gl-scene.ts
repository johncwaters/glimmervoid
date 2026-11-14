import type { IconName, NoteTone } from '#shared/contracts/whiteboard.ts';
import { DEVICE_CATALOG } from '#shared/whiteboard-devices.ts';
import { ICON_BOX_GLYPH_GAP, ICON_BOX_GLYPH_SIZE, TITLE_ICON_CHARS } from '#shared/whiteboard-icons.ts';
import { FRAME_TITLE_HEIGHT, RESIZE_HANDLES, STACK_SPREAD, TITLE_SCALE_BY_TEXT_SIZE, handleSidesOf, titleLineHeightOf } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutBox, LaidOutDevice, LaidOutElement, LaidOutFrame, LaidOutLine, LaidOutStep, LaidOutStroke, LaidOutWire, Rect, ResizeHandle } from '#shared/whiteboard-layout-core.ts';
import { pointsOfPath } from '#shared/whiteboard-route-core.ts';
import { SHAPE_TRAITS } from '#shared/whiteboard-shapes.ts';
import {
  BODY_LINE_HEIGHT, BOX_TEXT_INSET, ITEM_DOT_RADIUS, LEGEND_SAMPLE_WIDTH,
  MONO_CHAR_WIDTH, MUTED_INDENT, PLAN_TITLE, PORT_RADIUS,
  RESIZE_HANDLE_SIZE, STEP_HEADER_HEIGHT, STEP_LABEL_BASELINE, TITLE_BASELINE, TITLE_LINE_HEIGHT, codeBandRectOf, decisionOutlinePoints,
  ICON_BOX_TOP_INSET, STAND_FOOT_HEIGHT, STAND_FOOT_WIDTH, STAND_NECK_WIDTH, TITLE_CHAR_WIDTH, TITLE_ICON_RISE, TITLE_ICON_SIZE,
  TOOLBAR_ADDRESS_HEIGHT, TOOLBAR_ADDRESS_INSET, TOOLBAR_DOT_RADIUS, TOOLBAR_DOT_SPACING,
} from '#shared/whiteboard-svg-core.ts';
import { firstCodePoints } from '#shared/text.ts';
import { iconStrokesOf } from './board-gl-icons.ts';

type Rgba = readonly [number, number, number, number];

interface Point {
  x: number;
  y: number;
}

interface BoardPalette {
  board: Rgba;
  ink: Rgba;
  inkDim: Rgba;
  line: Rgba;
  accent: Rgba;
  running: Rgba;
  failed: Rgba;
  waiting: Rgba;
  muted: Rgba;
  cardBackground: Rgba;
  noteStroke: Rgba;
  noteCard: Rgba;
  codeBand: Rgba;
  fillByTone: Readonly<Record<NoteTone, Rgba>>;
  edgeByTone: Readonly<Record<NoteTone, Rgba>>;
  frameFill: Rgba;
  placeholderFill: Rgba;
  metaSize: number;
  bodySize: number;
  titleSize: number;
}

interface GlyphCell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  page: number;
}

interface GlyphSource {
  cellOf: (character: string, isBold: boolean) => GlyphCell;
  cellWidthEm: number;
  cellHeightEm: number;
  padLeftEm: number;
  ascentEm: number;
}

interface PartBuilder {
  rects: number[];
  segments: number[];
  triangles: number[];
  glyphs: number[];
}

interface GeometryPart {
  rects: Float32Array;
  segments: Float32Array;
  triangles: Float32Array;
  glyphs: Float32Array;
}

interface LayeredPart {
  layer: number;
  part: GeometryPart;
}

interface ElementGeometry {
  id: string;
  kind: LaidOutElement['kind'];
  paintRank: number;
  bounds: Rect;
  parts: LayeredPart[];
  hitShape: HitShape;
}

interface BoxTextRects {
  title: Rect;
  lines: readonly Rect[];
  emptyBody: Rect | null;
}

type HitShape =
  | { kind: 'rect'; rect: Rect; mediaRect: Rect | null; hasDrawnMedia: boolean; text: BoxTextRects }
  | { kind: 'outline'; rect: Rect; titleRect: Rect }
  | { kind: 'path'; points: Point[] };

const RECT_FLOATS = 16;
const SEGMENT_FLOATS = 14;
const TRIANGLE_VERTEX_FLOATS = 8;
const GLYPH_FLOATS = 15;
const UNSET_DEPTH = 0;
const LAYER_COUNT = 6;
const CHROME_LAYER = 0;
const WIRE_LABEL_LAYER = 3;
const BOX_LAYER = 4;
const LAYER_BY_KIND: Record<LaidOutElement['kind'], number> = { frame: 1, wire: 2, box: BOX_LAYER, stroke: 5 };
const MIN_TEXT_PX = 4;
const ROW_DESCENT = 5;
const MIN_DETAIL_BOX_PX = 12;
const MIN_WIRE_LABEL_PX = 8;
const MIN_ARROWHEAD_PX = 4;
const ARROWHEAD_LENGTH = 12.8;
const ARROWHEAD_HALF_WIDTH = 5.12;
const ARROWHEAD_OVERSHOOT = 1.28;
const WIRE_WIDTH = 1.6;
const BOLD_WIRE_WIDTH = 3.2;
const OUTLINE_WIDTH = 1.6;
const LETTER_SPACING_EM = 0.08;
const CHAR_WIDTH_EM = MONO_CHAR_WIDTH / 12;
const LABEL_HALO_PAD = 3;
const CORNER_STEPS = 4;
const ALWAYS = 0;

const ICON_VIEWBOX_SIZE = 24;
const ICON_STROKE_UNITS = 2;
const TRANSPARENT: Rgba = [0, 0, 0, 0];

function mixed(first: Rgba, second: Rgba, firstShare: number): Rgba {
  const secondShare = 1 - firstShare;
  return [first[0] * firstShare + second[0] * secondShare, first[1] * firstShare + second[1] * secondShare, first[2] * firstShare + second[2] * secondShare, first[3] * firstShare + second[3] * secondShare];
}

function faded(color: Rgba, opacity: number): Rgba {
  if (opacity === 1) return color;
  return [color[0], color[1], color[2], color[3] * opacity];
}

function createPart(): PartBuilder {
  return { rects: [], segments: [], triangles: [], glyphs: [] };
}

function sealPart(part: PartBuilder): GeometryPart {
  return { rects: Float32Array.from(part.rects), segments: Float32Array.from(part.segments), triangles: Float32Array.from(part.triangles), glyphs: Float32Array.from(part.glyphs) };
}

interface Dash {
  on: number;
  off: number;
}

const SOLID: Dash = { on: 0, off: 0 };

function pushRect(part: PartBuilder, rect: Rect, radius: number, fill: Rgba, stroke: Rgba, strokeWidth: number, minScale: number): void {
  part.rects.push(rect.x, rect.y, rect.width, rect.height, radius, strokeWidth, fill[0], fill[1], fill[2], fill[3], stroke[0], stroke[1], stroke[2], stroke[3], minScale, UNSET_DEPTH);
}

function pushCircle(part: PartBuilder, center: Point, radius: number, fill: Rgba, stroke: Rgba, strokeWidth: number, minScale: number): void {
  pushRect(part, { x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2 }, radius, fill, stroke, strokeWidth, minScale);
}

function pushPolyline(part: PartBuilder, points: readonly Point[], width: number, color: Rgba, dash: Dash, minScale: number): void {
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to) continue;
    part.segments.push(from.x, from.y, to.x, to.y, width, dash.on, dash.off, travelled, color[0], color[1], color[2], color[3], minScale, UNSET_DEPTH);
    travelled += Math.hypot(to.x - from.x, to.y - from.y);
  }
}

function pushTriangle(part: PartBuilder, corners: readonly [Point, Point, Point], color: Rgba, minScale: number): void {
  for (const corner of corners) part.triangles.push(corner.x, corner.y, color[0], color[1], color[2], color[3], minScale, UNSET_DEPTH);
}

function pushConvexFill(part: PartBuilder, polygon: readonly Point[], color: Rgba, minScale: number): void {
  const [first] = polygon;
  if (!first) return;
  for (let index = 2; index < polygon.length; index += 1) {
    const second = polygon[index - 1];
    const third = polygon[index];
    if (second && third) pushTriangle(part, [first, second, third], color, minScale);
  }
}

function pushArrowhead(part: PartBuilder, tail: Point, tip: Point, color: Rgba, minScale: number): void {
  const length = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  if (length === 0) return;
  const directionX = (tip.x - tail.x) / length;
  const directionY = (tip.y - tail.y) / length;
  const point = { x: tip.x + directionX * ARROWHEAD_OVERSHOOT, y: tip.y + directionY * ARROWHEAD_OVERSHOOT };
  const baseX = point.x - directionX * ARROWHEAD_LENGTH;
  const baseY = point.y - directionY * ARROWHEAD_LENGTH;
  pushTriangle(part, [point, { x: baseX - directionY * ARROWHEAD_HALF_WIDTH, y: baseY + directionX * ARROWHEAD_HALF_WIDTH }, { x: baseX + directionY * ARROWHEAD_HALF_WIDTH, y: baseY - directionX * ARROWHEAD_HALF_WIDTH }], color, minScale);
}

function roundedOutline(rect: Rect, radius: number): Point[] {
  const corners = [
    { x: rect.x + rect.width - radius, y: rect.y + radius, startAngle: -Math.PI / 2 },
    { x: rect.x + rect.width - radius, y: rect.y + rect.height - radius, startAngle: 0 },
    { x: rect.x + radius, y: rect.y + rect.height - radius, startAngle: Math.PI / 2 },
    { x: rect.x + radius, y: rect.y + radius, startAngle: Math.PI },
  ];
  const points: Point[] = [{ x: rect.x + radius, y: rect.y }];
  for (const corner of corners) {
    for (let step = 0; step <= CORNER_STEPS; step += 1) {
      const angle = corner.startAngle + (step / CORNER_STEPS) * (Math.PI / 2);
      points.push({ x: corner.x + Math.cos(angle) * radius, y: corner.y + Math.sin(angle) * radius });
    }
  }
  points.push({ x: rect.x + radius, y: rect.y });
  return points;
}

function pushOutlinedRect(part: PartBuilder, rect: Rect, radius: number, fill: Rgba, stroke: Rgba, strokeWidth: number, dash: Dash, minScale: number): void {
  if (dash.on === 0) {
    pushRect(part, rect, radius, fill, stroke, strokeWidth, minScale);
    return;
  }
  pushRect(part, rect, radius, fill, fill, 0, minScale);
  pushPolyline(part, roundedOutline(rect, radius), strokeWidth, stroke, dash, minScale);
}

interface TextStyle {
  size: number;
  color: Rgba;
  isBold?: boolean;
  anchor?: 'start' | 'middle' | 'end';
  isUppercase?: boolean;
  isStruckThrough?: boolean;
  minPixels?: number;
}

function textAdvance(style: TextStyle): number {
  return style.size * (CHAR_WIDTH_EM + (style.isUppercase ? LETTER_SPACING_EM : 0));
}

function textWidth(content: string, style: TextStyle): number {
  return [...content].length * textAdvance(style);
}

function textMinScale(style: TextStyle): number {
  return (style.minPixels ?? MIN_TEXT_PX) / style.size;
}

function pushText(part: PartBuilder, glyphs: GlyphSource, content: string, x: number, baseline: number, style: TextStyle): void {
  const shown = style.isUppercase ? content.toUpperCase() : content;
  const advance = textAdvance(style);
  const width = textWidth(shown, style);
  const anchorShift = style.anchor === 'middle' ? width / 2 : style.anchor === 'end' ? width : 0;
  const left = x - anchorShift;
  const minScale = textMinScale(style);
  const quadWidth = glyphs.cellWidthEm * style.size;
  const quadHeight = glyphs.cellHeightEm * style.size;
  const top = baseline - glyphs.ascentEm * style.size;
  const { color } = style;
  let column = 0;
  for (const character of shown) {
    if (character !== ' ') {
      const cell = glyphs.cellOf(character, style.isBold === true);
      part.glyphs.push(left + column * advance - glyphs.padLeftEm * style.size, top, quadWidth, quadHeight, cell.u0, cell.v0, cell.u1, cell.v1, cell.page, color[0], color[1], color[2], color[3], minScale, UNSET_DEPTH);
    }
    column += 1;
  }
  if (style.isStruckThrough) pushPolyline(part, [{ x: left, y: baseline - style.size * 0.3 }, { x: left + width, y: baseline - style.size * 0.3 }], 1, color, SOLID, minScale);
}

function pushIcon(part: PartBuilder, name: IconName, x: number, y: number, size: number, color: Rgba, minScale: number): void {
  const unit = size / ICON_VIEWBOX_SIZE;
  const strokeWidth = ICON_STROKE_UNITS * unit;
  const strokes = iconStrokesOf(name);
  for (const polyline of strokes.polylines) pushPolyline(part, polyline.map((point) => ({ x: x + point.x * unit, y: y + point.y * unit })), strokeWidth, color, SOLID, minScale);
  for (const circle of strokes.circles) pushCircle(part, { x: x + circle.center.x * unit, y: y + circle.center.y * unit }, circle.radius * unit, circle.isFilled ? color : TRANSPARENT, color, strokeWidth, minScale);
}

function boundsOfPoints(points: readonly Point[], pad: number): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return { x: minX, y: minY, width: Math.max(...xs) + pad - minX, height: Math.max(...ys) + pad - minY };
}

function unionRect(first: Rect, second: Rect): Rect {
  const minX = Math.min(first.x, second.x);
  const minY = Math.min(first.y, second.y);
  return { x: minX, y: minY, width: Math.max(first.x + first.width, second.x + second.width) - minX, height: Math.max(first.y + first.height, second.y + second.height) - minY };
}

interface SceneContext {
  palette: BoardPalette;
  glyphs: GlyphSource;
  hasDrawnMedia: (box: LaidOutBox) => boolean;
  stackSpreadOf?: (frameId: string) => number;
}

function lineTextColor(line: LaidOutLine, palette: BoardPalette): Rgba {
  if (line.style === 'code') return palette.accent;
  return line.muted ? palette.inkDim : palette.ink;
}

function pushBodyLines(part: PartBuilder, context: SceneContext, lines: readonly LaidOutLine[], left: number, top: number, opacity: number, detailMinScale: number): void {
  const { palette, glyphs } = context;
  const meta = palette.metaSize;
  lines.forEach((line, index) => {
    const baseline = top + index * BODY_LINE_HEIGHT;
    const rowLeft = left + BOX_TEXT_INSET + (line.muted ? MUTED_INDENT : 0);
    if (line.style === 'code') pushRect(part, codeBandRectOf(line, rowLeft, baseline), 3, faded(palette.codeBand, opacity), faded(palette.codeBand, opacity), 0, detailMinScale);
    if (line.style === 'item' && line.isFirstRow) pushCircle(part, { x: rowLeft + 4, y: baseline - 4 }, ITEM_DOT_RADIUS, faded(palette.inkDim, opacity), faded(palette.inkDim, opacity), 0, detailMinScale);
    if (line.marker !== null) pushText(part, glyphs, line.marker, rowLeft, baseline, { size: meta, color: faded(palette.inkDim, opacity), isBold: line.style === 'kv' });
    if (line.text) pushText(part, glyphs, line.text, rowLeft + line.indentChars * MONO_CHAR_WIDTH, baseline, { size: meta, color: faded(lineTextColor(line, palette), opacity) });
  });
}

function lineRectsOf(lines: readonly LaidOutLine[], box: Rect, bodyTop: number): Rect[] {
  const lineRects: Rect[] = [];
  lines.forEach((line, rowIndex) => {
    const lastRect = lineRects.at(-1);
    if (!line.isFirstRow && lastRect) {
      lineRects[lineRects.length - 1] = { ...lastRect, height: lastRect.height + BODY_LINE_HEIGHT };
      return;
    }
    lineRects.push({ x: box.x, y: bodyTop + rowIndex * BODY_LINE_HEIGHT - BODY_LINE_HEIGHT + ROW_DESCENT, width: box.width, height: BODY_LINE_HEIGHT });
  });
  return lineRects;
}

function boxTextRectsOf(box: LaidOutBox, titleTop: number, bodyTop: number): BoxTextRects {
  const titleLineHeight = titleLineHeightOf(box.textSize);
  const title = { x: box.x, y: titleTop - titleLineHeight + ROW_DESCENT, width: box.width, height: box.titleLines.length * titleLineHeight };
  const lines = lineRectsOf(box.bodyLines, box, bodyTop);
  const lastTextRect = lines.at(-1) ?? title;
  const textBottom = lastTextRect.y + lastTextRect.height;
  const boxBottom = box.y + box.height;
  const hasEmptyBody = SHAPE_TRAITS[box.shape].holdsLines && boxBottom > textBottom;
  return { title, lines, emptyBody: hasEmptyBody ? { x: box.x, y: textBottom, width: box.width, height: boxBottom - textBottom } : null };
}

type OutlinedBox = Pick<LaidOutBox, 'change' | 'shape' | 'tone' | 'isBorderless'> & { step: unknown };

function boxOutlineColors(box: OutlinedBox, palette: BoardPalette): { fill: Rgba; stroke: Rgba; dash: Dash; width: number } {
  const stepStroke = box.step ? palette.accent : null;
  const restingFill = restingFillOf(box, palette);
  if (box.change === 'added') return { fill: restingFill, stroke: stepStroke ?? palette.running, dash: { on: 7, off: 5 }, width: OUTLINE_WIDTH };
  if (box.change === 'removed') return { fill: [0, 0, 0, 0], stroke: stepStroke ?? palette.failed, dash: { on: 7, off: 5 }, width: OUTLINE_WIDTH };
  if (box.change === 'relabeled') return { fill: restingFill, stroke: stepStroke ?? palette.noteStroke, dash: SOLID, width: OUTLINE_WIDTH };
  return { fill: restingFill, stroke: stepStroke ?? restingStrokeOf(box, palette), dash: SOLID, width: OUTLINE_WIDTH };
}

function restingFillOf(box: OutlinedBox, palette: BoardPalette): Rgba {
  if (box.tone) return palette.fillByTone[box.tone];
  if (box.shape === 'note') return palette.noteCard;
  return box.isBorderless ? TRANSPARENT : palette.board;
}

function restingStrokeOf(box: OutlinedBox, palette: BoardPalette): Rgba {
  if (box.tone) return palette.edgeByTone[box.tone];
  if (box.shape === 'note') return palette.noteStroke;
  return box.isBorderless ? TRANSPARENT : palette.inkDim;
}

function stepStatusColor(status: LaidOutStep['status'], palette: BoardPalette): Rgba {
  if (status === 'building') return palette.waiting;
  if (status === 'landed') return palette.running;
  return palette.muted;
}

function pushDeviceBase(part: PartBuilder, device: LaidOutDevice, bodyBottom: number, color: Rgba, edge: Rgba, minScale: number): void {
  const { base } = DEVICE_CATALOG[device.name];
  if (!base) return;
  const baseHeight = base.height * device.scale;
  const middleX = device.x + device.width / 2;
  if (base.overhang > 0) {
    pushRect(part, { x: device.x, y: bodyBottom, width: device.width, height: baseHeight }, baseHeight / 3, color, edge, 1, minScale);
    return;
  }
  const footHeight = STAND_FOOT_HEIGHT * device.scale;
  const neckWidth = STAND_NECK_WIDTH * device.scale;
  const footWidth = STAND_FOOT_WIDTH * device.scale;
  pushRect(part, { x: middleX - neckWidth / 2, y: bodyBottom, width: neckWidth, height: baseHeight - footHeight }, 0, color, edge, 1, minScale);
  pushRect(part, { x: middleX - footWidth / 2, y: bodyBottom + baseHeight - footHeight, width: footWidth, height: footHeight }, footHeight / 3, color, edge, 1, minScale);
}

function pushDevice(part: PartBuilder, context: SceneContext, box: LaidOutBox, device: LaidOutDevice, opacity: number, minScale: number): void {
  const { palette, glyphs } = context;
  const spec = DEVICE_CATALOG[device.name];
  const bodyColor = faded(mixed(palette.ink, palette.board, 0.12), opacity);
  const edge = faded(palette.inkDim, opacity);
  const screenColor = faded(palette.board, opacity);
  const overhang = (spec.base?.overhang ?? 0) * device.scale;
  const bodyX = device.x + overhang;
  const bodyWidth = device.width - overhang * 2;
  const bodyHeight = (spec.bezel.top + spec.toolbarHeight + spec.screen.height + spec.bezel.bottom) * device.scale;
  pushRect(part, { x: bodyX, y: device.y, width: bodyWidth, height: bodyHeight }, spec.bezel.radius * device.scale, bodyColor, edge, 1, minScale);
  pushDeviceBase(part, device, device.y + bodyHeight, bodyColor, edge, minScale);
  if (spec.toolbarHeight > 0) {
    const toolbarTop = device.y + spec.bezel.top * device.scale;
    const toolbarHeight = spec.toolbarHeight * device.scale;
    const toolbarMiddleY = toolbarTop + toolbarHeight / 2;
    const addressHeight = TOOLBAR_ADDRESS_HEIGHT * device.scale;
    const addressInset = TOOLBAR_ADDRESS_INSET * device.scale;
    const toolbarColor = faded(mixed(palette.ink, palette.board, 0.06), opacity);
    pushRect(part, { x: bodyX, y: toolbarTop, width: bodyWidth, height: toolbarHeight }, 0, toolbarColor, toolbarColor, 0, minScale);
    for (const dotNumber of [1, 2, 3]) pushCircle(part, { x: bodyX + dotNumber * TOOLBAR_DOT_SPACING * device.scale, y: toolbarMiddleY }, TOOLBAR_DOT_RADIUS * device.scale, edge, edge, 0, minScale);
    pushRect(part, { x: bodyX + addressInset, y: toolbarMiddleY - addressHeight / 2, width: bodyWidth - addressInset * 2, height: addressHeight }, addressHeight / 2, screenColor, screenColor, 0, minScale);
  }
  pushRect(part, device.screen, spec.bezel.screenRadius * device.scale, screenColor, screenColor, 0, minScale);
  if (box.media) return;
  pushText(part, glyphs, box.titleLines.join(' '), device.screen.x + device.screen.width / 2, device.screen.y + device.screen.height / 2 + 4, { size: palette.metaSize, color: faded(palette.inkDim, opacity), anchor: 'middle' });
}

function boxGeometry(box: LaidOutBox, context: SceneContext): { part: PartBuilder; hitShape: HitShape } {
  const { palette, glyphs } = context;
  const part = createPart();
  const opacity = box.change === 'removed' ? 0.6 : 1;
  const detailMinScale = MIN_DETAIL_BOX_PX / Math.max(1, box.height);
  const outline = boxOutlineColors(box, palette);
  const fill = faded(outline.fill, opacity);
  const stroke = faded(outline.stroke, opacity);
  if (box.shape === 'decision') {
    const polygon = decisionOutlinePoints(box);
    pushConvexFill(part, polygon, fill, ALWAYS);
    const [firstCorner] = polygon;
    if (firstCorner) pushPolyline(part, [...polygon, firstCorner], outline.width, stroke, outline.dash, ALWAYS);
  }
  if (box.shape !== 'decision') pushOutlinedRect(part, box, 8, fill, stroke, outline.width, outline.dash, ALWAYS);
  const stepHeaderHeight = box.step ? STEP_HEADER_HEIGHT : 0;
  if (box.step) {
    pushText(part, glyphs, box.step.label, box.x + BOX_TEXT_INSET, box.y + STEP_LABEL_BASELINE, { size: palette.metaSize, color: faded(palette.accent, opacity), isBold: true });
    pushText(part, glyphs, box.step.status, box.x + box.width - BOX_TEXT_INSET, box.y + STEP_LABEL_BASELINE, { size: palette.metaSize, color: faded(stepStatusColor(box.step.status, palette), opacity), anchor: 'end' });
  }
  const isIconBox = box.shape === 'icon';
  const glyphRoom = isIconBox ? ICON_BOX_GLYPH_SIZE + ICON_BOX_GLYPH_GAP : 0;
  const middleX = box.x + box.width / 2;
  if (isIconBox && box.icon) pushIcon(part, box.icon, middleX - ICON_BOX_GLYPH_SIZE / 2, box.y + ICON_BOX_TOP_INSET + stepHeaderHeight, ICON_BOX_GLYPH_SIZE, faded(palette.accent, opacity), detailMinScale);
  const textLeft = isIconBox ? middleX : box.x + BOX_TEXT_INSET;
  const textAnchor = isIconBox ? 'middle' : 'start';
  const titleLineHeight = titleLineHeightOf(box.textSize);
  const titleSize = palette.titleSize * TITLE_SCALE_BY_TEXT_SIZE[box.textSize];
  const firstTitleBaseline = box.y + TITLE_BASELINE + titleLineHeight - TITLE_LINE_HEIGHT + stepHeaderHeight + glyphRoom;
  box.wasLines.forEach((line, index) => {
    pushText(part, glyphs, line, textLeft, firstTitleBaseline + index * titleLineHeight, { size: titleSize, color: faded(palette.inkDim, opacity), isStruckThrough: true, anchor: textAnchor });
  });
  const titleTop = firstTitleBaseline + box.wasLines.length * titleLineHeight;
  const titleIcon = isIconBox ? null : box.icon;
  if (titleIcon) pushIcon(part, titleIcon, textLeft, titleTop - TITLE_ICON_RISE, TITLE_ICON_SIZE, faded(palette.ink, opacity), detailMinScale);
  const titleLeft = titleIcon ? textLeft + TITLE_ICON_CHARS * TITLE_CHAR_WIDTH : textLeft;
  box.titleLines.forEach((line, index) => {
    pushText(part, glyphs, line, titleLeft, titleTop + index * titleLineHeight, { size: titleSize, color: faded(palette.ink, opacity), isBold: true, isStruckThrough: box.change === 'removed', anchor: textAnchor });
  });
  if (box.device) pushDevice(part, context, box, box.device, opacity, detailMinScale);
  const bodyTop = titleTop + box.titleLines.length * titleLineHeight;
  pushBodyLines(part, context, box.bodyLines, box.x, bodyTop, opacity, detailMinScale);
  const hasDrawnMedia = box.media !== null && context.hasDrawnMedia(box);
  if (box.media && !hasDrawnMedia) {
    const placeholderStyle: TextStyle = { size: palette.metaSize, color: faded(palette.inkDim, opacity), anchor: 'middle' };
    const placeholderMaxChars = Math.max(0, Math.floor((box.media.width - BOX_TEXT_INSET * 2) / textAdvance(placeholderStyle)));
    const placeholderText = firstCodePoints(box.media.alt || box.media.kind, placeholderMaxChars);
    pushOutlinedRect(part, box.media, 6, faded(palette.placeholderFill, opacity), faded(palette.inkDim, opacity), 1, { on: 4, off: 4 }, detailMinScale);
    pushText(part, glyphs, placeholderText, box.media.x + box.media.width / 2, box.media.y + box.media.height / 2 + 4, placeholderStyle);
  }
  return { part, hitShape: { kind: 'rect', rect: box, mediaRect: box.media, hasDrawnMedia, text: boxTextRectsOf(box, titleTop, bodyTop) } };
}

function stackGeometry(frame: LaidOutFrame, stackedBoxCount: number, context: SceneContext): { part: PartBuilder; hitShape: HitShape } {
  const { palette, glyphs } = context;
  const part = createPart();
  const card = { x: frame.x, y: frame.y + FRAME_TITLE_HEIGHT, width: frame.width - STACK_SPREAD * 2, height: frame.height - FRAME_TITLE_HEIGHT - STACK_SPREAD * 2 };
  const ghostSpread = context.stackSpreadOf?.(frame.id) ?? STACK_SPREAD;
  for (const depth of [2, 1]) {
    const ghostCard = { ...card, x: card.x + ghostSpread * depth, y: card.y + ghostSpread * depth };
    pushOutlinedRect(part, ghostCard, 8, palette.cardBackground, palette.line, 1.2, SOLID, ALWAYS);
  }
  const titleStyle: TextStyle = { size: palette.metaSize, color: palette.inkDim, isBold: true };
  const titleText = `${frame.title} (${stackedBoxCount})`;
  pushText(part, glyphs, titleText, frame.x + 4, frame.y + 18, titleStyle);
  const titleRect = { x: frame.x, y: frame.y, width: 8 + textWidth(titleText, titleStyle), height: FRAME_TITLE_HEIGHT };
  return { part, hitShape: { kind: 'outline', rect: frame, titleRect } };
}

function frameGeometry(frame: LaidOutFrame, context: SceneContext): { part: PartBuilder; hitShape: HitShape } {
  if (frame.stackedBoxCount !== null) return stackGeometry(frame, frame.stackedBoxCount, context);
  const { palette, glyphs } = context;
  const part = createPart();
  pushOutlinedRect(part, frame, 12, palette.frameFill, palette.line, 1.4, { on: 10, off: 6 }, ALWAYS);
  const titleStyle: TextStyle = { size: palette.metaSize, color: palette.inkDim, isBold: true };
  pushText(part, glyphs, frame.title, frame.x + 14, frame.y + 18, titleStyle);
  const titleRect = { x: frame.x, y: frame.y, width: 28 + textWidth(frame.title, titleStyle), height: 26 };
  return { part, hitShape: { kind: 'outline', rect: frame, titleRect } };
}

function wireColor(wire: Pick<LaidOutWire, 'tone'>, palette: BoardPalette): Rgba {
  if (wire.tone === 'fail') return palette.failed;
  if (wire.tone === 'join') return palette.accent;
  return palette.inkDim;
}

function pushArrowAtEnd(part: PartBuilder, points: readonly Point[], color: Rgba): void {
  const tail = points[points.length - 2];
  const tip = points[points.length - 1];
  if (tail && tip) pushArrowhead(part, tail, tip, color, MIN_ARROWHEAD_PX / ARROWHEAD_LENGTH);
}

function wireGeometry(wire: LaidOutWire, context: SceneContext): { parts: LayeredPart[]; hitShape: HitShape; bounds: Rect } {
  const { palette, glyphs } = context;
  const part = createPart();
  const labelPart = createPart();
  const points = pointsOfPath(wire.path);
  const color = wireColor(wire, palette);
  pushPolyline(part, points, wire.isBold ? BOLD_WIRE_WIDTH : WIRE_WIDTH, color, wire.isDashed ? { on: 7, off: 6 } : SOLID, ALWAYS);
  if (wire.hasArrowhead) pushArrowAtEnd(part, points, color);
  const dotMinScale = MIN_ARROWHEAD_PX / 6;
  pushCircle(part, wire.start, 3, palette.inkDim, palette.inkDim, 0, dotMinScale);
  if (wire.joinAt) pushCircle(part, wire.joinAt, 3, palette.inkDim, palette.inkDim, 0, dotMinScale);
  let bounds = boundsOfPoints(points.length > 0 ? points : [wire.start, wire.end], 8);
  if (wire.label) {
    const labelStyle: TextStyle = { size: palette.metaSize, color: palette.ink, anchor: 'middle', minPixels: MIN_WIRE_LABEL_PX };
    const width = textWidth(wire.label, labelStyle);
    const halo = { x: wire.labelAt.x - width / 2 - LABEL_HALO_PAD, y: wire.labelAt.y - palette.metaSize, width: width + LABEL_HALO_PAD * 2, height: palette.metaSize + LABEL_HALO_PAD + 2 };
    pushRect(labelPart, halo, 3, palette.board, palette.board, 0, textMinScale(labelStyle));
    pushText(labelPart, glyphs, wire.label, wire.labelAt.x, wire.labelAt.y, labelStyle);
    bounds = unionRect(bounds, halo);
  }
  return { parts: [{ layer: LAYER_BY_KIND.wire, part: sealPart(part) }, { layer: WIRE_LABEL_LAYER, part: sealPart(labelPart) }], hitShape: { kind: 'path', points }, bounds };
}

function pointsOfStroke(stroke: LaidOutStroke): Point[] {
  const points: Point[] = [];
  for (let index = 0; index + 1 < stroke.points.length; index += 2) points.push({ x: stroke.points[index] ?? 0, y: stroke.points[index + 1] ?? 0 });
  return points;
}

function strokeColorOf(stroke: LaidOutStroke, palette: BoardPalette): Rgba {
  return stroke.tone === 'ink' ? palette.ink : palette.edgeByTone[stroke.tone];
}

function strokeGeometry(stroke: LaidOutStroke, context: SceneContext): { part: PartBuilder; hitShape: HitShape } {
  const part = createPart();
  const points = pointsOfStroke(stroke);
  pushPolyline(part, points, stroke.strokeWidth, strokeColorOf(stroke, context.palette), SOLID, ALWAYS);
  return { part, hitShape: { kind: 'path', points } };
}

function singleLayer(element: Exclude<LaidOutElement, LaidOutWire>, drawn: { part: PartBuilder; hitShape: HitShape }): { parts: LayeredPart[]; hitShape: HitShape; bounds: Rect } {
  return { parts: [{ layer: LAYER_BY_KIND[element.kind], part: sealPart(drawn.part) }], hitShape: drawn.hitShape, bounds: paintedBoundsOf(element, drawn.hitShape) };
}

function paintedBoundsOf(element: Rect, hitShape: HitShape): Rect {
  if (hitShape.kind !== 'outline') return element;
  const right = Math.max(element.x + element.width, hitShape.titleRect.x + hitShape.titleRect.width);
  return { x: element.x, y: element.y, width: right - element.x, height: element.height };
}

function geometryOf(element: LaidOutElement, context: SceneContext): { parts: LayeredPart[]; hitShape: HitShape; bounds: Rect } {
  switch (element.kind) {
    case 'box': return singleLayer(element, boxGeometry(element, context));
    case 'frame': return singleLayer(element, frameGeometry(element, context));
    case 'wire': return wireGeometry(element, context);
    case 'stroke': return singleLayer(element, strokeGeometry(element, context));
  }
}

function elementGeometry(element: LaidOutElement, paintRank: number, context: SceneContext): ElementGeometry {
  const { parts, hitShape, bounds } = geometryOf(element, context);
  return { id: element.id, kind: element.kind, paintRank, bounds, parts, hitShape };
}

function legendSwatch(part: PartBuilder, entry: BoardLayout['legend'][number], palette: BoardPalette): void {
  const { swatch } = entry;
  if (swatch.kind === 'status') {
    pushRect(part, { x: entry.x, y: entry.y, width: 14, height: 14 }, 3, stepStatusColor(swatch.status, palette), palette.accent, OUTLINE_WIDTH, ALWAYS);
    return;
  }
  if (swatch.kind === 'change') {
    const sample = { x: entry.x, y: entry.y, width: LEGEND_SAMPLE_WIDTH, height: 14 };
    const colors = boxOutlineColors({ change: swatch.change, shape: 'box', tone: null, isBorderless: false, step: null }, palette);
    const opacity = swatch.change === 'removed' ? 0.6 : 1;
    pushOutlinedRect(part, sample, 3, faded(colors.fill, opacity), faded(colors.stroke, opacity), colors.width, colors.dash, ALWAYS);
    return;
  }
  const color = wireColor(swatch, palette);
  const points = [{ x: entry.x, y: entry.y + 7 }, { x: entry.x + LEGEND_SAMPLE_WIDTH, y: entry.y + 7 }];
  pushPolyline(part, points, WIRE_WIDTH, color, swatch.isDashed ? { on: 7, off: 6 } : SOLID, ALWAYS);
  pushArrowAtEnd(part, points, color);
}

function chromeGeometry(layout: BoardLayout, context: SceneContext): ElementGeometry {
  const { palette, glyphs } = context;
  const part = createPart();
  const headingStyle: TextStyle = { size: palette.metaSize, color: palette.inkDim, isBold: true, isUppercase: true };
  if (layout.plan) pushText(part, glyphs, PLAN_TITLE, layout.plan.titleAt.x, layout.plan.titleAt.y, headingStyle);
  for (const entry of layout.legend) {
    legendSwatch(part, entry, palette);
    const labelX = entry.x + (entry.swatch.kind === 'status' ? 22 : LEGEND_SAMPLE_WIDTH + 12);
    pushText(part, glyphs, entry.label, labelX, entry.y + 12, { size: palette.metaSize, color: palette.inkDim });
  }
  if (layout.caption) pushText(part, glyphs, layout.caption.text, layout.caption.x, layout.caption.y + 16, { size: palette.bodySize, color: palette.inkDim });
  return { id: '', kind: 'frame', paintRank: -1, bounds: layout.bounds, parts: [{ layer: CHROME_LAYER, part: sealPart(part) }], hitShape: { kind: 'path', points: [] } };
}

type Decoration = { kind: 'selected'; element: LaidOutElement } | { kind: 'wire-target'; element: LaidOutElement } | { kind: 'flagged'; element: LaidOutElement } | { kind: 'hover-handles'; box: LaidOutBox } | { kind: 'resize-handles'; area: Rect } | { kind: 'look'; element: Exclude<LaidOutElement, { kind: 'wire' }> };

function outlineDecoration(part: PartBuilder, element: LaidOutElement, color: Rgba, width: number): void {
  if (element.kind === 'wire') {
    pushPolyline(part, pointsOfPath(element.path), 2.6, color, SOLID, ALWAYS);
    return;
  }
  if (element.kind === 'stroke') {
    pushPolyline(part, pointsOfStroke(element), element.strokeWidth + 4, color, SOLID, ALWAYS);
    return;
  }
  if (element.kind === 'box' && element.shape === 'decision') {
    const polygon = decisionOutlinePoints(element);
    const [firstCorner] = polygon;
    if (firstCorner) pushPolyline(part, [...polygon, firstCorner], width, color, SOLID, ALWAYS);
    return;
  }
  const radiusByKind: Record<Exclude<LaidOutElement['kind'], 'wire' | 'stroke'>, number> = { box: 8, frame: 12 };
  pushRect(part, element, radiusByKind[element.kind], [0, 0, 0, 0], color, width, ALWAYS);
}

function boxPortCenters(box: Rect): Point[] {
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  return [{ x: midX, y: box.y }, { x: box.x + box.width, y: midY }, { x: midX, y: box.y + box.height }, { x: box.x, y: midY }];
}

interface ResizeHandleRect {
  handle: ResizeHandle;
  rect: Rect;
}

function resizeHandleRectsOf(area: Rect): ResizeHandleRect[] {
  return RESIZE_HANDLES.map((handle) => {
    const side = handleSidesOf(handle);
    const centerX = area.x + (area.width * (side.x + 1)) / 2;
    const centerY = area.y + (area.height * (side.y + 1)) / 2;
    return { handle, rect: { x: centerX - RESIZE_HANDLE_SIZE / 2, y: centerY - RESIZE_HANDLE_SIZE / 2, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE } };
  });
}

const LOOK_BADGE_RADIUS = 9;
const LOOK_LABEL_GAP = 4;
const LOOK_BADGE_LABEL = 'worth a look';

function decorationPart(decorations: readonly Decoration[], context: SceneContext): GeometryPart {
  const { palette, glyphs } = context;
  const part = createPart();
  for (const decoration of decorations) {
    if (decoration.kind === 'selected' || decoration.kind === 'wire-target') {
      outlineDecoration(part, decoration.element, palette.accent, 2.4);
      continue;
    }
    if (decoration.kind === 'flagged') {
      outlineDecoration(part, decoration.element, palette.waiting, 2.4);
      continue;
    }
    if (decoration.kind === 'hover-handles') {
      for (const center of boxPortCenters(decoration.box)) pushCircle(part, center, PORT_RADIUS, palette.board, palette.accent, OUTLINE_WIDTH, ALWAYS);
      continue;
    }
    if (decoration.kind === 'resize-handles') {
      for (const { rect } of resizeHandleRectsOf(decoration.area)) pushRect(part, rect, 2, palette.board, palette.accent, OUTLINE_WIDTH, ALWAYS);
      continue;
    }
    const center = { x: decoration.element.x + decoration.element.width, y: decoration.element.y };
    pushCircle(part, center, LOOK_BADGE_RADIUS, palette.waiting, palette.cardBackground, 2, ALWAYS);
    pushText(part, glyphs, '!', center.x, center.y + 4, { size: palette.metaSize, color: palette.cardBackground, isBold: true, anchor: 'middle', minPixels: 0 });
    pushText(part, glyphs, LOOK_BADGE_LABEL, center.x - LOOK_BADGE_RADIUS - LOOK_LABEL_GAP, center.y - LOOK_LABEL_GAP, { size: palette.metaSize, color: palette.waiting, isBold: true, anchor: 'end', minPixels: 0 });
  }
  return sealPart(part);
}

function sceneOf(layout: BoardLayout, context: SceneContext, reuse: (element: LaidOutElement) => ElementGeometry | null): { chrome: ElementGeometry; elements: ElementGeometry[] } {
  const ranked = layout.elements.map((element, index) => ({ element, index })).sort((left, right) => LAYER_BY_KIND[left.element.kind] - LAYER_BY_KIND[right.element.kind] || left.index - right.index);
  const elements = ranked.map(({ element }, paintRank) => {
    const reused = reuse(element);
    if (reused) return { ...reused, paintRank };
    return elementGeometry(element, paintRank, context);
  });
  return { chrome: chromeGeometry(layout, context), elements };
}

export {
  BOX_LAYER, GLYPH_FLOATS, LAYER_COUNT, RECT_FLOATS, SEGMENT_FLOATS, TRIANGLE_VERTEX_FLOATS,
  boxPortCenters, decorationPart, resizeHandleRectsOf, sceneOf,
};
export type { BoardPalette, BoxTextRects, Decoration, ElementGeometry, GeometryPart, GlyphCell, GlyphSource, Point, Rgba, SceneContext };
