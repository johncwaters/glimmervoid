import type { IconName } from './contracts/whiteboard.ts';
import { escapeMarkup } from './escape-markup.ts';
import { DEVICE_CATALOG } from './whiteboard-devices.ts';
import { ICON_BOX_GLYPH_GAP, ICON_BOX_GLYPH_SIZE, ICON_CATALOG, ICON_NAMES, ICON_VIEWBOX, LINE_ICON_CHARS, TITLE_ICON_CHARS } from './whiteboard-icons.ts';
import type { BoardLayout, LaidOutBox, LaidOutDevice, LaidOutElement, LaidOutMedia, LaidOutFrame, LaidOutLine, LaidOutNote, LaidOutStep, LaidOutWire, Rect } from './whiteboard-layout-core.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const BOX_TEXT_INSET = 12;
const TITLE_BASELINE = 26;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const NOTE_LINE_HEIGHT = 17;
const MUTED_INDENT = 14;
const STEP_LABEL_BASELINE = 22;
const STEP_HEADER_HEIGHT = 18;
const PLAN_TITLE = 'Plan';
const LINKED_BOARD_TEXT = 'open linked board';
const PORT_RADIUS = 5;
const RESIZE_HANDLE_SIZE = 10;
const LOOP_BADGE_RADIUS = 6;
const LOOP_BADGE_INSET = 20;
const OCCLUDER_MARGIN = 6;
const OCCLUDER_CORNER_RADIUS = 8;
const DECISION_POINT_INSET = 12;
const OUTPUT_LABEL_BASELINE_OFFSET = 4;
const OUTPUT_DOT_RADIUS = 3;
const MONO_CHAR_WIDTH = 7.2;
const CODE_BAND_RISE = 13;
const CODE_BAND_HEIGHT = 17;
const ITEM_DOT_RADIUS = 2.2;
const TITLE_RULE_RISE = 12;
const LEGEND_SAMPLE_WIDTH = 28;
const TITLE_CHAR_WIDTH = 9.6;
const TITLE_ICON_SIZE = 14;
const TITLE_ICON_RISE = 12;
const LINE_ICON_SIZE = 13;
const LINE_ICON_RISE = 10;
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
.wb-panel .wb-box-outline { fill: #110f20; stroke: #4a4268; stroke-width: 1.4; }
.wb-change-added .wb-box-outline { stroke: #22c55e; stroke-dasharray: 7 5; }
.wb-change-removed { opacity: 0.6; }
.wb-change-removed .wb-box-outline { fill: transparent; stroke: #ef4444; stroke-dasharray: 7 5; }
.wb-change-removed .wb-box-title { text-decoration: line-through; }
.wb-change-relabeled .wb-box-outline { stroke: #f5c26b; }
.wb-box-was { fill: #a79fc4; font-size: 16px; text-decoration: line-through; }
.wb-legend-swatch.wb-box-outline { stroke-width: 1.6; }
.wb-box-title { fill: #e6e0f5; font-size: 16px; font-weight: 700; }
.wb-box-line { fill: #e6e0f5; font-size: 12px; }
.wb-box-line.wb-muted { fill: #a79fc4; }
.wb-line-code { fill: #c4b5fd; }
.wb-code-band { fill: #221d3a; }
.wb-line-marker { fill: #a79fc4; font-size: 12px; }
.wb-line-key { fill: #a79fc4; font-size: 12px; font-weight: 700; }
.wb-item-dot { fill: #a79fc4; }
.wb-panel-rule { stroke: #4a4268; stroke-width: 1; }
.wb-output-divider { stroke: #4a4268; stroke-width: 1; }
.wb-output-label { fill: #e6e0f5; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.wb-output-dot { fill: #a79fc4; }
.wb-step .wb-box-outline, .wb-step-swatch { stroke: #c084fc; }
.wb-step-label, .wb-step-link { fill: #c084fc; font-size: 12px; font-weight: 700; }
.wb-step-status { fill: #a79fc4; font-size: 11px; }
.wb-step-planned { fill: #a79fc4; }
.wb-step-building { fill: #f59e0b; }
.wb-step-landed { fill: #22c55e; }
.wb-frame-outline { fill: rgba(192, 132, 252, 0.04); stroke: #4a4268; stroke-width: 1.4; stroke-dasharray: 10 6; }
.wb-frame-title { fill: #a79fc4; font-size: 12px; font-weight: 700; }
.wb-loop .wb-frame-outline { stroke: #c084fc; }
.wb-loop-badge { fill: none; stroke: #c084fc; stroke-width: 1.6; }
.wb-back .wb-wire-line { stroke: #c084fc; }
.wb-wire-hit, .wb-port, .wb-resize-handle { display: none; }
.wb-wire-line { fill: none; stroke: #a79fc4; stroke-width: 1.6; }
.wb-wire-line.wb-dashed { stroke-dasharray: 7 6; }
.wb-tone-fail .wb-wire-line { stroke: #ef4444; }
.wb-tone-join .wb-wire-line { stroke: #c084fc; }
.wb-wire-dot { fill: #a79fc4; }
.wb-wire-label { fill: #e6e0f5; font-size: 12px; text-anchor: middle; paint-order: stroke; stroke: #0d0b16; stroke-width: 5; }
.wb-note-card { fill: #2a2213; stroke: #f5c26b; stroke-width: 1.2; }
.wb-note-text { fill: #f8e7c4; font-size: 12px; }
.wb-note-byline { fill: #c9a868; font-size: 12px; }
.wb-resolved { opacity: 0.5; }
.wb-legend-text { fill: #a79fc4; font-size: 12px; }
.wb-caption { fill: #a79fc4; font-size: 14px; }
.wb-image-placeholder { fill: #221d3a; stroke: #4a4268; stroke-width: 1; stroke-dasharray: 4 4; }
.wb-image-placeholder-text { fill: #a79fc4; font-size: 12px; }
.wb-title-icon { color: #e6e0f5; }
.wb-line-icon { color: #a79fc4; }
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

function decisionOutlinePath(box: LaidOutBox): string {
  const right = box.x + box.width;
  const headerMidY = box.y + box.headerHeight / 2;
  const top = `M${box.x + DECISION_POINT_INSET},${box.y} H${right - DECISION_POINT_INSET} L${right},${headerMidY}`;
  if (box.outputs.length === 0) return `${top} L${right - DECISION_POINT_INSET},${box.y + box.height} H${box.x + DECISION_POINT_INSET} L${box.x},${headerMidY} Z`;
  return `${top} V${box.y + box.height} H${box.x} V${headerMidY} Z`;
}

function outputRowsMarkup(box: LaidOutBox): string[] {
  return box.outputs.flatMap((output) => {
    const rowHalfHeight = (box.height - box.headerHeight) / box.outputs.length / 2;
    const rowTop = output.port.y - rowHalfHeight;
    return [
      tag('line', { x1: box.x, y1: rowTop, x2: box.x + box.width, y2: rowTop, class: 'wb-output-divider' }),
      text(output.label, box.x + BOX_TEXT_INSET, output.port.y + OUTPUT_LABEL_BASELINE_OFFSET, 'wb-output-label'),
      tag('circle', { cx: output.port.x, cy: output.port.y, r: OUTPUT_DOT_RADIUS, class: 'wb-output-dot' }),
    ];
  });
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

function lineRowMarkup(line: LaidOutLine, left: number, width: number, baseline: number): string[] {
  const iconLeft = left + BOX_TEXT_INSET + (line.muted ? MUTED_INDENT : 0);
  const rowLeft = line.icon ? iconLeft + LINE_ICON_CHARS * MONO_CHAR_WIDTH : iconLeft;
  const parts: string[] = [];
  if (line.icon && line.isFirstRow) parts.push(iconMarkup(line.icon, iconLeft, baseline - LINE_ICON_RISE, LINE_ICON_SIZE, 'wb-line-icon'));
  if (line.style === 'code') parts.push(tag('rect', { x: rowLeft - 4, y: baseline - CODE_BAND_RISE, width: left + width - BOX_TEXT_INSET + 4 - rowLeft + 4, height: CODE_BAND_HEIGHT, rx: 3, class: 'wb-code-band' }));
  if (line.style === 'item' && line.isFirstRow) parts.push(tag('circle', { cx: rowLeft + 4, cy: baseline - 4, r: ITEM_DOT_RADIUS, class: 'wb-item-dot' }));
  if (line.marker !== null) parts.push(text(line.marker, rowLeft, baseline, line.style === 'kv' ? 'wb-line-key' : 'wb-line-marker'));
  if (line.text) parts.push(text(line.text, rowLeft + line.indentChars * MONO_CHAR_WIDTH, baseline, lineClassOf(line)));
  return parts;
}

function bodyLinesMarkup(lines: readonly LaidOutLine[], left: number, width: number, top: number): string[] {
  return lines.flatMap((line, index) => lineRowMarkup(line, left, width, top + index * BODY_LINE_HEIGHT));
}

function boxOutlineMarkup(box: LaidOutBox): string {
  if (box.shape === 'decision') return tag('path', { d: decisionOutlinePath(box), class: 'wb-box-outline' });
  return tag('rect', { x: box.x, y: box.y, width: box.width, height: box.height, rx: 8, class: 'wb-box-outline' });
}

function mediaMarkup(media: LaidOutMedia, assetHref: AssetHref, clipPathId: string | null = null): string[] {
  const href = assetHref(media);
  const placeholderText = media.alt || media.kind;
  const label = tag('title', {}, escapeMarkup(placeholderText));
  const clipPath = clipPathId ? `url(#${clipPathId})` : null;
  if (href) return [tag('image', { href, x: media.x, y: media.y, width: media.width, height: media.height, preserveAspectRatio: PREFERRED_ASPECT_BY_FIT[media.fit], 'clip-path': clipPath, class: 'wb-image' }, label)];
  return [
    tag('rect', { x: media.x, y: media.y, width: media.width, height: media.height, rx: 6, class: 'wb-image-placeholder' }, label),
    text(placeholderText, media.x + media.width / 2, media.y + media.height / 2 + 4, 'wb-image-placeholder-text', { 'text-anchor': 'middle' }),
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
  const parts = [boxOutlineMarkup(box), ...outputRowsMarkup(box)];
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
  box.wasLines.forEach((line, index) => {
    parts.push(text(line, textLeft, box.y + TITLE_BASELINE + stepHeaderHeight + glyphRoom + index * TITLE_LINE_HEIGHT, 'wb-box-was', textAnchor));
  });
  const titleTop = box.y + TITLE_BASELINE + stepHeaderHeight + glyphRoom + box.wasLines.length * TITLE_LINE_HEIGHT;
  const titleIcon = isIconBox ? null : box.icon;
  if (titleIcon) parts.push(iconMarkup(titleIcon, textLeft, titleTop - TITLE_ICON_RISE, TITLE_ICON_SIZE, 'wb-title-icon'));
  const titleLeft = titleIcon ? textLeft + TITLE_ICON_CHARS * TITLE_CHAR_WIDTH : textLeft;
  box.titleLines.forEach((line, index) => {
    parts.push(text(line, titleLeft, titleTop + index * TITLE_LINE_HEIGHT, 'wb-box-title', textAnchor));
  });
  const bodyTop = titleTop + box.titleLines.length * TITLE_LINE_HEIGHT;
  if (box.shape === 'panel' && box.bodyLines.length > 0) parts.push(tag('line', { x1: box.x + BOX_TEXT_INSET, y1: bodyTop - TITLE_RULE_RISE, x2: box.x + box.width - BOX_TEXT_INSET, y2: bodyTop - TITLE_RULE_RISE, class: 'wb-panel-rule' }));
  parts.push(...bodyLinesMarkup(box.bodyLines, box.x, box.width, bodyTop));
  if (box.step?.linkedBoardId) {
    parts.push(text(LINKED_BOARD_TEXT, box.x + BOX_TEXT_INSET, bodyTop + box.bodyLines.length * BODY_LINE_HEIGHT, 'wb-step-link', { 'data-linked-board-id': box.step.linkedBoardId }));
  }
  if (box.device) parts.push(...deviceMarkup(box, box.device, box.titleLines.join(' '), assetHref));
  if (box.media && !box.device) parts.push(...mediaMarkup(box.media, assetHref));
  parts.push(tag('rect', { x: box.x + box.width - RESIZE_HANDLE_SIZE, y: box.y + box.height - RESIZE_HANDLE_SIZE, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE, rx: 2, class: 'wb-resize-handle' }));
  const shapeClass = box.shape === 'box' || box.shape === 'decision' ? '' : ` wb-${box.shape}`;
  const stepClass = box.step ? ' wb-step' : '';
  const changeClass = box.change === 'none' ? '' : ` wb-change-${box.change}`;
  return elementGroup(box, `wb-box${shapeClass}${stepClass}${changeClass}`, parts);
}

function loopBadgeMarkup(frame: LaidOutFrame): string {
  const centerX = frame.x + frame.width - LOOP_BADGE_INSET;
  const centerY = frame.y + LOOP_BADGE_RADIUS + 6;
  const arc = `M ${centerX + LOOP_BADGE_RADIUS} ${centerY} A ${LOOP_BADGE_RADIUS} ${LOOP_BADGE_RADIUS} 0 1 1 ${centerX} ${centerY - LOOP_BADGE_RADIUS}`;
  return tag('path', { d: arc, 'marker-end': 'url(#wb-arrow)', class: 'wb-loop-badge' });
}

function frameMarkup(frame: LaidOutFrame): string {
  const parts = [
    tag('rect', { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 12, class: 'wb-frame-outline' }),
    text(frame.title, frame.x + 14, frame.y + 18, 'wb-frame-title'),
  ];
  if (frame.isLoop) parts.push(loopBadgeMarkup(frame));
  return elementGroup(frame, frame.isLoop ? 'wb-frame wb-loop' : 'wb-frame', parts);
}

function wireMarkup(wire: LaidOutWire): string {
  const parts = [
    tag('path', { d: wire.path, class: 'wb-wire-hit' }),
    tag('path', { d: wire.path, 'marker-end': wire.hasArrowhead ? 'url(#wb-arrow)' : null, class: wire.isDashed ? 'wb-wire-line wb-dashed' : 'wb-wire-line' }),
    tag('circle', { cx: wire.start.x, cy: wire.start.y, r: 3, class: 'wb-wire-dot' }),
  ];
  if (wire.joinAt) parts.push(tag('circle', { cx: wire.joinAt.x, cy: wire.joinAt.y, r: 3, class: 'wb-wire-dot' }));
  if (wire.label) parts.push(text(wire.label, wire.labelAt.x, wire.labelAt.y, 'wb-wire-label'));
  return elementGroup(wire, wire.isBack ? `wb-wire wb-back wb-tone-${wire.tone}` : `wb-wire wb-tone-${wire.tone}`, parts);
}

function noteMarkup(note: LaidOutNote): string {
  const parts = [tag('rect', { x: note.x, y: note.y, width: note.width, height: note.height, rx: 4, class: 'wb-note-card' })];
  note.lines.forEach((line, index) => {
    parts.push(text(line, note.x + 10, note.y + 22 + index * NOTE_LINE_HEIGHT, 'wb-note-text'));
  });
  if (note.byline) parts.push(text(note.byline, note.x + 10, note.y + 22 + note.lines.length * NOTE_LINE_HEIGHT, 'wb-note-byline'));
  return elementGroup(note, note.isResolved ? 'wb-note wb-resolved' : 'wb-note', parts);
}

function elementMarkup(element: LaidOutElement, assetHref: AssetHref = NO_ASSET_HREF): string {
  switch (element.kind) {
    case 'box': return boxMarkup(element, assetHref);
    case 'frame': return frameMarkup(element);
    case 'wire': return wireMarkup(element);
    case 'note': return noteMarkup(element);
  }
}

type PageOccluder = Exclude<LaidOutElement, { kind: 'wire' | 'frame' }>;

function occluderMarkup(occluder: PageOccluder): string {
  const grownEdge = { fill: 'black', stroke: 'black', 'stroke-width': OCCLUDER_MARGIN * 2, 'stroke-linejoin': 'round' };
  if (occluder.kind === 'box' && occluder.shape === 'decision') return tag('path', { d: decisionOutlinePath(occluder), ...grownEdge });
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
  return tag('g', { class: swatch.isBack ? `wb-back wb-tone-${swatch.tone}` : `wb-tone-${swatch.tone}` }, sample);
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
    for (const line of element.bodyLines) {
      if (line.icon && line.isFirstRow) iconNames.add(line.icon);
    }
  }
  return [...iconNames];
}

const LAYER_ORDER: readonly LaidOutElement['kind'][] = ['frame', 'wire', 'box', 'note'];

function boardSvgDocument(layout: BoardLayout, assetHref: AssetHref = NO_ASSET_HREF): string {
  const { x, y, width, height } = layout.bounds;
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
export { boardSvgDocument, chromeMarkup, definitionsMarkup, elementMarkup, pageMaskImage, SVG_NAMESPACE };
