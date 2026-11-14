import { BRAND_ACCENT } from './brand-mark.ts';
import { NOTE_TONE_HEX, NOTE_TONES, TEXT_SIZES } from './contracts/whiteboard.ts';
import type { IconName } from './contracts/whiteboard.ts';
import { escapeMarkup } from './escape-markup.ts';
import { DEVICE_CATALOG } from './whiteboard-devices.ts';
import { ICON_BOX_GLYPH_GAP, ICON_BOX_GLYPH_SIZE, ICON_CATALOG, ICON_NAMES, ICON_VIEWBOX, TITLE_ICON_CHARS } from './whiteboard-icons.ts';
import { TITLE_SCALE_BY_TEXT_SIZE, titleLineHeightOf } from './whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutBox, LaidOutDevice, LaidOutElement, LaidOutMedia, LaidOutFrame, LaidOutLine, LaidOutStep, LaidOutStroke, LaidOutWire, Rect } from './whiteboard-layout-core.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const BOX_TEXT_INSET = 12;
const TITLE_BASELINE = 26;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const MUTED_INDENT = 14;
const STEP_LABEL_BASELINE = 22;
const STEP_HEADER_HEIGHT = 18;
const PLAN_TITLE = 'Plan';
const PORT_RADIUS = 5;
const RESIZE_HANDLE_SIZE = 10;
const OCCLUDER_MARGIN = 6;
const OCCLUDER_CORNER_RADIUS = 8;
const DECISION_POINT_INSET = 12;
const MONO_CHAR_WIDTH = 7.2;
const CUT_TEXT_ENDING = '...';
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}|[\u{20000}-\u{3fffd}]/u;
const CODE_BAND_RISE = 13;
const CODE_BAND_HEIGHT = 17;
const CODE_BAND_PAD = 4;
const ITEM_DOT_RADIUS = 2.2;
const LEGEND_SAMPLE_WIDTH = 28;
const TITLE_CHAR_WIDTH = 9.6;
const TITLE_ICON_SIZE = 14;
const TITLE_ICON_RISE = 12;
const ICON_BOX_TOP_INSET = 12;
const TOOLBAR_DOT_RADIUS = 6;
const TOOLBAR_DOT_SPACING = 22;
const TOOLBAR_ADDRESS_INSET = 96;
const TOOLBAR_ADDRESS_HEIGHT = 22;
const STAND_NECK_WIDTH = 180;
const STAND_FOOT_WIDTH = 520;
const STAND_FOOT_HEIGHT = 24;
const PREFERRED_ASPECT_BY_FIT = Object.freeze({ fill: 'xMidYMid slice', fit: 'xMidYMid meet' });

const STANDALONE_STYLE = `
svg { font-family: 'ComicMono', 'CommitMono', 'Cascadia Code', 'Menlo', monospace; }
.wb-backdrop { fill: #0d0b16; }
.wb-plan-title { fill: #a79fc4; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.wb-box-outline { fill: #15122a; stroke: #a79fc4; stroke-width: 1.6; }
.wb-borderless .wb-box-outline { fill: transparent; stroke: transparent; }
.wb-note .wb-box-outline { fill: #2a2213; stroke: #f5c26b; stroke-width: 1.2; }
${NOTE_TONES.map((tone) => `.wb-tone-${tone} .wb-box-outline { fill: ${NOTE_TONE_HEX[tone]}; fill-opacity: 0.3; stroke: ${NOTE_TONE_HEX[tone]}; }`).join('\n')}
.wb-change-added .wb-box-outline { stroke: #22c55e; stroke-dasharray: 7 5; }
.wb-change-removed { opacity: 0.6; }
.wb-change-removed .wb-box-outline { fill: transparent; stroke: #ef4444; stroke-dasharray: 7 5; }
.wb-change-removed .wb-box-title { text-decoration: line-through; }
.wb-change-relabeled .wb-box-outline { stroke: #f5c26b; }
.wb-box-was { fill: #a79fc4; font-size: 16px; text-decoration: line-through; }
.wb-legend-swatch.wb-box-outline { stroke-width: 1.6; }
.wb-box-title { fill: #e6e0f5; font-size: 16px; font-weight: 700; }
${TEXT_SIZES.map((size) => `.wb-text-${size} .wb-box-title, .wb-text-${size} .wb-box-was { font-size: ${16 * TITLE_SCALE_BY_TEXT_SIZE[size]}px; }`).join('\n')}
.wb-box-line { fill: #e6e0f5; font-size: 12px; }
.wb-box-line.wb-muted { fill: #a79fc4; }
.wb-line-code { fill: #c4b5fd; }
.wb-code-band { fill: #221d3a; }
.wb-line-marker { fill: #a79fc4; font-size: 12px; }
.wb-line-key { fill: #a79fc4; font-size: 12px; font-weight: 700; }
.wb-item-dot { fill: #a79fc4; }
.wb-step .wb-box-outline, .wb-step-swatch { stroke: ${BRAND_ACCENT}; }
.wb-step-label { fill: ${BRAND_ACCENT}; font-size: 12px; font-weight: 700; }
.wb-step-status { fill: #a79fc4; font-size: 11px; }
.wb-step-planned { fill: #a79fc4; }
.wb-step-building { fill: #f59e0b; }
.wb-step-landed { fill: #22c55e; }
.wb-frame-outline { fill: ${BRAND_ACCENT}; fill-opacity: 0.04; stroke: #4a4268; stroke-width: 1.4; stroke-dasharray: 10 6; }
.wb-frame-title { fill: #a79fc4; font-size: 12px; font-weight: 700; }
.wb-wire-hit, .wb-port, .wb-resize-handle { display: none; }
.wb-wire-line { fill: none; stroke: #a79fc4; stroke-width: 1.6; }
.wb-wire-line.wb-dashed { stroke-dasharray: 7 6; }
.wb-wire-line.wb-bold { stroke-width: 3.2; }
.wb-tone-fail .wb-wire-line { stroke: #ef4444; }
.wb-tone-join .wb-wire-line { stroke: ${BRAND_ACCENT}; }
.wb-wire-dot { fill: #a79fc4; }
.wb-wire-label { fill: #e6e0f5; font-size: 12px; text-anchor: middle; paint-order: stroke; stroke: #0d0b16; stroke-width: 5; }
.wb-resolved { opacity: 0.5; }
.wb-legend-text { fill: #a79fc4; font-size: 12px; }
.wb-caption { fill: #a79fc4; font-size: 14px; }
.wb-image-placeholder { fill: #221d3a; stroke: #4a4268; stroke-width: 1; stroke-dasharray: 4 4; }
.wb-image-placeholder-text { fill: #a79fc4; font-size: 12px; }
.wb-title-icon { color: #e6e0f5; }
.wb-glyph-icon { color: #c4b5fd; }
.wb-device-body { fill: #2a2440; stroke: #6f6790; stroke-width: 1; }
.wb-device-screen { fill: #15121f; }
.wb-device-toolbar { fill: #221d3a; }
.wb-device-address { fill: #15121f; }
.wb-device-dot { fill: #6f6790; }
.wb-device-empty { fill: #a79fc4; font-size: 12px; }
`;

type AttributeValue = string | number;

type AssetHref = (media: LaidOutMedia) => string | null;

const NO_ASSET_HREF: AssetHref = () => null;

function attributesMarkup(attributes: Readonly<Record<string, AttributeValue | null>>): string {
  return Object.entries(attributes)
    .flatMap(([name, value]) => (value === null ? [] : [` ${name}="${escapeMarkup(value)}"`]))
    .join('');
}

function tag(name: string, attributes: Readonly<Record<string, AttributeValue | null>>, children = ''): string {
  return `<${name}${attributesMarkup(attributes)}>${children}</${name}>`;
}

function text(content: string, x: number, y: number, className: string, extra: Readonly<Record<string, AttributeValue | null>> = {}): string {
  return tag('text', { x, y, class: className, ...extra }, escapeMarkup(content));
}

function elementGroup(element: LaidOutElement, className: string, children: readonly string[]): string {
  return tag('g', { class: `wb-element ${className}`, 'data-element-id': element.id, 'data-element-kind': element.kind }, children.join(''));
}

function decisionOutlinePoints(box: LaidOutBox): { x: number; y: number }[] {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const headerMidY = box.y + box.headerHeight / 2;
  return [
    { x: box.x + DECISION_POINT_INSET, y: box.y }, { x: right - DECISION_POINT_INSET, y: box.y }, { x: right, y: headerMidY },
    { x: right - DECISION_POINT_INSET, y: bottom }, { x: box.x + DECISION_POINT_INSET, y: bottom }, { x: box.x, y: headerMidY },
  ];
}

const ELLIPSE_OUTLINE_SEGMENTS = 48;

function ellipseOutlinePoints(box: LaidOutBox): { x: number; y: number }[] {
  const radiusX = box.width / 2;
  const radiusY = box.height / 2;
  return Array.from({ length: ELLIPSE_OUTLINE_SEGMENTS }, (_, index) => {
    const angle = (index / ELLIPSE_OUTLINE_SEGMENTS) * Math.PI * 2;
    return { x: box.x + radiusX + Math.cos(angle) * radiusX, y: box.y + radiusY + Math.sin(angle) * radiusY };
  });
}

function shapedOutlinePoints(box: LaidOutBox): { x: number; y: number }[] | null {
  if (box.shape === 'decision') return decisionOutlinePoints(box);
  if (box.shape === 'ellipse') return ellipseOutlinePoints(box);
  return null;
}

function ellipseAttributesOf(box: LaidOutBox): Record<string, number> {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, rx: box.width / 2, ry: box.height / 2 };
}

function decisionOutlinePath(box: LaidOutBox): string {
  return `${decisionOutlinePoints(box).map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')} Z`;
}

function lineClassOf(line: LaidOutLine): string {
  if (line.style === 'code') return 'wb-box-line wb-line-code';
  return line.muted ? 'wb-box-line wb-muted' : 'wb-box-line';
}

function iconSymbolId(name: IconName): string {
  return `wb-icon-${name}`;
}

function iconMarkup(name: IconName, x: number, y: number, size: number, className: string): string {
  return tag('use', { href: `#${iconSymbolId(name)}`, x, y, width: size, height: size, class: className, 'data-icon': name });
}

function codeBandRectOf(line: LaidOutLine, rowLeft: number, baseline: number): Rect {
  const textLeft = rowLeft + line.indentChars * MONO_CHAR_WIDTH;
  return { x: textLeft - CODE_BAND_PAD, y: baseline - CODE_BAND_RISE, width: line.text.length * MONO_CHAR_WIDTH + CODE_BAND_PAD * 2, height: CODE_BAND_HEIGHT };
}

function lineRowMarkup(line: LaidOutLine, left: number, baseline: number): string[] {
  const rowLeft = left + BOX_TEXT_INSET + (line.muted ? MUTED_INDENT : 0);
  const parts: string[] = [];
  if (line.style === 'code') parts.push(tag('rect', { ...codeBandRectOf(line, rowLeft, baseline), rx: 3, class: 'wb-code-band' }));
  if (line.style === 'item' && line.isFirstRow) parts.push(tag('circle', { cx: rowLeft + 4, cy: baseline - 4, r: ITEM_DOT_RADIUS, class: 'wb-item-dot' }));
  if (line.marker !== null) parts.push(text(line.marker, rowLeft, baseline, line.style === 'kv' ? 'wb-line-key' : 'wb-line-marker'));
  if (line.text) parts.push(text(line.text, rowLeft + line.indentChars * MONO_CHAR_WIDTH, baseline, lineClassOf(line)));
  return parts;
}

function bodyLinesMarkup(lines: readonly LaidOutLine[], left: number, top: number): string[] {
  return lines.flatMap((line, index) => lineRowMarkup(line, left, top + index * BODY_LINE_HEIGHT));
}

function boxOutlineMarkup(box: LaidOutBox): string {
  if (box.shape === 'decision') return tag('path', { d: decisionOutlinePath(box), class: 'wb-box-outline' });
  if (box.shape === 'ellipse') return tag('ellipse', { ...ellipseAttributesOf(box), class: 'wb-box-outline' });
  return tag('rect', { x: box.x, y: box.y, width: box.width, height: box.height, rx: 8, class: 'wb-box-outline' });
}

function charCellsOf(char: string): number {
  return WIDE_CHAR.test(char) ? 2 : 1;
}

function charsFitting(chars: readonly string[], maxCells: number): string[] {
  let usedCells = 0;
  return chars.filter((char) => {
    usedCells += charCellsOf(char);
    return usedCells <= maxCells;
  });
}

function textCutToWidth(fullText: string, width: number): string {
  const chars = Array.from(fullText);
  const maxCells = Math.max(1, Math.floor(width / MONO_CHAR_WIDTH));
  const fullCells = chars.reduce((cells, char) => cells + charCellsOf(char), 0);
  if (fullCells <= maxCells) return fullText;
  if (maxCells <= CUT_TEXT_ENDING.length) return charsFitting(chars, maxCells).join('');
  return `${charsFitting(chars, maxCells - CUT_TEXT_ENDING.length).join('')}${CUT_TEXT_ENDING}`;
}

function mediaMarkup(media: LaidOutMedia, assetHref: AssetHref, clipPathId: string | null = null): string[] {
  const href = assetHref(media);
  const placeholderText = media.alt || media.kind;
  const label = tag('title', {}, escapeMarkup(placeholderText));
  const clipPath = clipPathId ? `url(#${clipPathId})` : null;
  if (href) return [tag('image', { href, x: media.x, y: media.y, width: media.width, height: media.height, preserveAspectRatio: PREFERRED_ASPECT_BY_FIT[media.fit], 'clip-path': clipPath, class: 'wb-image' }, label)];
  return [
    tag('rect', { x: media.x, y: media.y, width: media.width, height: media.height, rx: 6, class: 'wb-image-placeholder' }, label),
    text(textCutToWidth(placeholderText, media.width), media.x + media.width / 2, media.y + media.height / 2 + 4, 'wb-image-placeholder-text', { 'text-anchor': 'middle' }),
  ];
}

function deviceBaseMarkup(device: LaidOutDevice, bodyBottom: number): string[] {
  const { base } = DEVICE_CATALOG[device.name];
  if (!base) return [];
  const baseHeight = base.height * device.scale;
  const midX = device.x + device.width / 2;
  if (base.overhang > 0) return [tag('rect', { x: device.x, y: bodyBottom, width: device.width, height: baseHeight, rx: baseHeight / 3, class: 'wb-device-body' })];
  const footHeight = STAND_FOOT_HEIGHT * device.scale;
  const neckWidth = STAND_NECK_WIDTH * device.scale;
  const footWidth = STAND_FOOT_WIDTH * device.scale;
  return [
    tag('rect', { x: midX - neckWidth / 2, y: bodyBottom, width: neckWidth, height: baseHeight - footHeight, class: 'wb-device-body' }),
    tag('rect', { x: midX - footWidth / 2, y: bodyBottom + baseHeight - footHeight, width: footWidth, height: footHeight, rx: footHeight / 3, class: 'wb-device-body' }),
  ];
}

function deviceToolbarMarkup(device: LaidOutDevice, bodyX: number, bodyWidth: number): string[] {
  const spec = DEVICE_CATALOG[device.name];
  if (spec.toolbarHeight === 0) return [];
  const toolbarTop = device.y + spec.bezel.top * device.scale;
  const toolbarHeight = spec.toolbarHeight * device.scale;
  const toolbarMidY = toolbarTop + toolbarHeight / 2;
  const addressHeight = TOOLBAR_ADDRESS_HEIGHT * device.scale;
  const addressInset = TOOLBAR_ADDRESS_INSET * device.scale;
  return [
    tag('rect', { x: bodyX, y: toolbarTop, width: bodyWidth, height: toolbarHeight, class: 'wb-device-toolbar' }),
    ...[1, 2, 3].map((dotNumber) => tag('circle', { cx: bodyX + dotNumber * TOOLBAR_DOT_SPACING * device.scale, cy: toolbarMidY, r: TOOLBAR_DOT_RADIUS * device.scale, class: 'wb-device-dot' })),
    tag('rect', { x: bodyX + addressInset, y: toolbarMidY - addressHeight / 2, width: bodyWidth - addressInset * 2, height: addressHeight, rx: addressHeight / 2, class: 'wb-device-address' }),
  ];
}

function deviceMarkup(box: LaidOutBox, device: LaidOutDevice, title: string, assetHref: AssetHref): string[] {
  const spec = DEVICE_CATALOG[device.name];
  const overhang = (spec.base?.overhang ?? 0) * device.scale;
  const bodyX = device.x + overhang;
  const bodyWidth = device.width - overhang * 2;
  const bodyHeight = (spec.bezel.top + spec.toolbarHeight + spec.screen.height + spec.bezel.bottom) * device.scale;
  const { screen } = device;
  const screenRadius = spec.bezel.screenRadius * device.scale;
  const clipPathId = `wb-screen-${box.id}`;
  const screenRect = { x: screen.x, y: screen.y, width: screen.width, height: screen.height, rx: screenRadius };
  const parts = [
    tag('rect', { x: bodyX, y: device.y, width: bodyWidth, height: bodyHeight, rx: spec.bezel.radius * device.scale, class: 'wb-device-body' }),
    ...deviceBaseMarkup(device, device.y + bodyHeight),
    ...deviceToolbarMarkup(device, bodyX, bodyWidth),
    tag('clipPath', { id: clipPathId }, tag('rect', screenRect)),
    tag('rect', { ...screenRect, class: 'wb-device-screen' }),
  ];
  if (box.media) return [...parts, ...mediaMarkup(box.media, assetHref, clipPathId)];
  return [...parts, text(title, screen.x + screen.width / 2, screen.y + screen.height / 2 + 4, 'wb-device-empty', { 'text-anchor': 'middle' })];
}

function stepHeaderMarkup(box: LaidOutBox, step: LaidOutStep): string[] {
  return [
    text(step.label, box.x + BOX_TEXT_INSET, box.y + STEP_LABEL_BASELINE, 'wb-step-label'),
    text(step.status, box.x + box.width - BOX_TEXT_INSET, box.y + STEP_LABEL_BASELINE, `wb-step-status wb-step-${step.status}`, { 'text-anchor': 'end' }),
  ];
}

function boxMarkup(box: LaidOutBox, assetHref: AssetHref): string {
  const parts = [boxOutlineMarkup(box)];
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  for (const [cx, cy] of [[midX, box.y], [box.x + box.width, midY], [midX, box.y + box.height], [box.x, midY]] as const) {
    parts.push(tag('circle', { cx, cy, r: PORT_RADIUS, class: 'wb-port' }));
  }
  const stepHeaderHeight = box.step ? STEP_HEADER_HEIGHT : 0;
  if (box.step) parts.push(...stepHeaderMarkup(box, box.step));
  const isIconBox = box.shape === 'icon';
  const glyphRoom = isIconBox ? ICON_BOX_GLYPH_SIZE + ICON_BOX_GLYPH_GAP : 0;
  if (isIconBox && box.icon) parts.push(iconMarkup(box.icon, midX - ICON_BOX_GLYPH_SIZE / 2, box.y + ICON_BOX_TOP_INSET + stepHeaderHeight, ICON_BOX_GLYPH_SIZE, 'wb-glyph-icon'));
  const textLeft = isIconBox ? midX : box.x + BOX_TEXT_INSET;
  const textAnchor = { 'text-anchor': isIconBox ? 'middle' : null };
  const titleLineHeight = titleLineHeightOf(box.textSize);
  const firstTitleBaseline = box.y + TITLE_BASELINE + titleLineHeight - TITLE_LINE_HEIGHT + stepHeaderHeight + glyphRoom;
  box.wasLines.forEach((line, index) => {
    parts.push(text(line, textLeft, firstTitleBaseline + index * titleLineHeight, 'wb-box-was', textAnchor));
  });
  const titleTop = firstTitleBaseline + box.wasLines.length * titleLineHeight;
  const titleIcon = isIconBox ? null : box.icon;
  if (titleIcon) parts.push(iconMarkup(titleIcon, textLeft, titleTop - TITLE_ICON_RISE, TITLE_ICON_SIZE, 'wb-title-icon'));
  const titleLeft = titleIcon ? textLeft + TITLE_ICON_CHARS * TITLE_CHAR_WIDTH : textLeft;
  box.titleLines.forEach((line, index) => {
    parts.push(text(line, titleLeft, titleTop + index * titleLineHeight, 'wb-box-title', textAnchor));
  });
  const bodyTop = titleTop + box.titleLines.length * titleLineHeight;
  parts.push(...bodyLinesMarkup(box.bodyLines, box.x, bodyTop));
  if (box.device) parts.push(...deviceMarkup(box, box.device, box.titleLines.join(' '), assetHref));
  if (box.media && !box.device) parts.push(...mediaMarkup(box.media, assetHref));
  parts.push(tag('rect', { x: box.x + box.width - RESIZE_HANDLE_SIZE, y: box.y + box.height - RESIZE_HANDLE_SIZE, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE, rx: 2, class: 'wb-resize-handle' }));
  const shapeClass = box.shape === 'note' ? ' wb-note' : '';
  const stepClass = box.step ? ' wb-step' : '';
  const changeClass = box.change === 'none' ? '' : ` wb-change-${box.change}`;
  const toneClass = box.tone ? ` wb-tone-${box.tone}` : '';
  const borderlessClass = box.isBorderless ? ' wb-borderless' : '';
  const textSizeClass = box.textSize === 'M' ? '' : ` wb-text-${box.textSize}`;
  return elementGroup(box, `wb-box${shapeClass}${borderlessClass}${toneClass}${textSizeClass}${stepClass}${changeClass}`, parts);
}

function frameMarkup(frame: LaidOutFrame): string {
  const parts = [
    tag('rect', { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 12, class: 'wb-frame-outline' }),
    text(frame.title, frame.x + 14, frame.y + 18, 'wb-frame-title'),
  ];
  return elementGroup(frame, 'wb-frame', parts);
}

function wireMarkup(wire: LaidOutWire): string {
  const parts = [
    tag('path', { d: wire.path, class: 'wb-wire-hit' }),
    tag('path', { d: wire.path, 'marker-end': wire.hasArrowhead ? 'url(#wb-arrow)' : null, class: ['wb-wire-line', wire.isDashed ? 'wb-dashed' : null, wire.isBold ? 'wb-bold' : null].filter((name) => name !== null).join(' ') }),
    tag('circle', { cx: wire.start.x, cy: wire.start.y, r: 3, class: 'wb-wire-dot' }),
  ];
  if (wire.joinAt) parts.push(tag('circle', { cx: wire.joinAt.x, cy: wire.joinAt.y, r: 3, class: 'wb-wire-dot' }));
  if (wire.label) parts.push(text(wire.label, wire.labelAt.x, wire.labelAt.y, 'wb-wire-label'));
  return elementGroup(wire, `wb-wire wb-tone-${wire.tone}`, parts);
}

function strokeMarkup(stroke: LaidOutStroke): string {
  const points: string[] = [];
  for (let index = 0; index + 1 < stroke.points.length; index += 2) points.push(`${stroke.points[index]},${stroke.points[index + 1]}`);
  const color = stroke.tone === 'ink' ? '#e6e0f5' : NOTE_TONE_HEX[stroke.tone];
  const line = tag('polyline', { points: points.join(' '), fill: 'none', stroke: color, 'stroke-width': stroke.strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  return elementGroup(stroke, 'wb-stroke', [line]);
}

function elementMarkup(element: LaidOutElement, assetHref: AssetHref = NO_ASSET_HREF): string {
  switch (element.kind) {
    case 'box': return boxMarkup(element, assetHref);
    case 'frame': return frameMarkup(element);
    case 'wire': return wireMarkup(element);
    case 'stroke': return strokeMarkup(element);
  }
}

type PageOccluder = Exclude<LaidOutElement, { kind: 'wire' | 'frame' }>;

function occluderMarkup(occluder: PageOccluder): string {
  const grownEdge = { fill: 'black', stroke: 'black', 'stroke-width': OCCLUDER_MARGIN * 2, 'stroke-linejoin': 'round' };
  if (occluder.kind === 'box' && occluder.shape === 'decision') return tag('path', { d: decisionOutlinePath(occluder), ...grownEdge });
  if (occluder.kind === 'box' && occluder.shape === 'ellipse') return tag('ellipse', { ...ellipseAttributesOf(occluder), ...grownEdge });
  return tag('rect', { x: occluder.x, y: occluder.y, width: occluder.width, height: occluder.height, rx: OCCLUDER_CORNER_RADIUS, ...grownEdge });
}

function pageMaskImage(page: Rect, occluders: readonly PageOccluder[]): string | null {
  if (occluders.length === 0) return null;
  const pageArea = { x: page.x, y: page.y, width: page.width, height: page.height };
  const mask = tag('mask', { id: 'page-mask', maskUnits: 'userSpaceOnUse', ...pageArea }, [tag('rect', { ...pageArea, fill: 'white' }), ...occluders.map(occluderMarkup)].join(''));
  const markup = tag('svg', { xmlns: SVG_NAMESPACE, viewBox: `${page.x} ${page.y} ${page.width} ${page.height}`, width: page.width, height: page.height, preserveAspectRatio: 'none' }, tag('defs', {}, mask) + tag('rect', { ...pageArea, mask: 'url(#page-mask)' }));
  return `url("data:image/svg+xml,${encodeURIComponent(markup)}")`;
}

function chromeMarkup(layout: BoardLayout): string {
  const parts: string[] = [];
  if (layout.plan) {
    parts.push(text(PLAN_TITLE, layout.plan.titleAt.x, layout.plan.titleAt.y, 'wb-plan-title'));
  }
  for (const entry of layout.legend) parts.push(legendRowMarkup(entry));
  if (layout.caption) parts.push(text(layout.caption.text, layout.caption.x, layout.caption.y + 16, 'wb-caption'));
  return tag('g', { class: 'wb-chrome' }, parts.join(''));
}

function legendSwatchMarkup(entry: BoardLayout['legend'][number]): string {
  const { swatch } = entry;
  if (swatch.kind === 'status') return tag('rect', { x: entry.x, y: entry.y, width: 14, height: 14, rx: 3, class: `wb-legend-swatch wb-step-swatch wb-step-${swatch.status}` });
  if (swatch.kind === 'change') return tag('g', { class: `wb-change-${swatch.change}` }, tag('rect', { x: entry.x, y: entry.y, width: LEGEND_SAMPLE_WIDTH, height: 14, rx: 3, class: 'wb-legend-swatch wb-box-outline' }));
  const sample = tag('path', { d: `M${entry.x},${entry.y + 7} H${entry.x + LEGEND_SAMPLE_WIDTH}`, 'marker-end': 'url(#wb-arrow)', class: swatch.isDashed ? 'wb-wire-line wb-dashed' : 'wb-wire-line' });
  return tag('g', { class: `wb-tone-${swatch.tone}` }, sample);
}

function legendRowMarkup(entry: BoardLayout['legend'][number]): string {
  const labelX = entry.x + (entry.swatch.kind === 'status' ? 22 : LEGEND_SAMPLE_WIDTH + 12);
  return legendSwatchMarkup(entry) + text(entry.label, labelX, entry.y + 12, 'wb-legend-text');
}

function iconSymbolMarkup(name: IconName): string {
  const strokeStyle = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  return tag('symbol', { id: iconSymbolId(name), viewBox: ICON_VIEWBOX, ...strokeStyle }, ICON_CATALOG[name].elements.join(''));
}

function definitionsMarkup(iconNames: readonly IconName[] = ICON_NAMES): string {
  const arrowhead = tag('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: 'context-stroke' });
  const arrowMarker = tag('marker', { id: 'wb-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, arrowhead);
  return tag('defs', {}, arrowMarker + iconNames.map(iconSymbolMarkup).join(''));
}

function iconNamesOf(layout: BoardLayout): IconName[] {
  const iconNames = new Set<IconName>();
  for (const element of layout.elements) {
    if (element.kind !== 'box') continue;
    if (element.icon) iconNames.add(element.icon);
  }
  return [...iconNames];
}

const LAYER_ORDER: readonly LaidOutElement['kind'][] = ['frame', 'wire', 'box'];

function boardSvgDocument(layout: BoardLayout, assetHref: AssetHref = NO_ASSET_HREF, frame: Rect = layout.bounds): string {
  const { x, y, width, height } = frame;
  const layers = LAYER_ORDER.map((kind) => tag('g', { class: 'wb-layer' }, layout.elements.filter((element) => element.kind === kind).map((element) => elementMarkup(element, assetHref)).join('')));
  const body = [
    tag('style', {}, STANDALONE_STYLE),
    definitionsMarkup(iconNamesOf(layout)),
    tag('rect', { x, y, width, height, class: 'wb-backdrop' }),
    chromeMarkup(layout),
    ...layers,
  ].join('');
  return `${tag('svg', { xmlns: SVG_NAMESPACE, viewBox: `${x} ${y} ${width} ${height}`, width, height }, body)}\n`;
}

export type { AssetHref, PageOccluder };
export {
  BODY_LINE_HEIGHT, BOX_TEXT_INSET, ITEM_DOT_RADIUS, LEGEND_SAMPLE_WIDTH,
  MONO_CHAR_WIDTH, MUTED_INDENT, PLAN_TITLE, PORT_RADIUS,
  RESIZE_HANDLE_SIZE, STEP_HEADER_HEIGHT, STEP_LABEL_BASELINE, TITLE_BASELINE, TITLE_LINE_HEIGHT,
  ICON_BOX_TOP_INSET, STAND_FOOT_HEIGHT, STAND_FOOT_WIDTH, STAND_NECK_WIDTH, TITLE_CHAR_WIDTH, TITLE_ICON_RISE, TITLE_ICON_SIZE,
  TOOLBAR_ADDRESS_HEIGHT, TOOLBAR_ADDRESS_INSET, TOOLBAR_DOT_RADIUS, TOOLBAR_DOT_SPACING,
  boardSvgDocument, codeBandRectOf, pageMaskImage, shapedOutlinePoints,
};
