import { escapeMarkup } from './escape-markup.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutFrame, LaidOutNote, LaidOutUnit, LaidOutWire } from './whiteboard-layout-core.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const BOX_TEXT_INSET = 12;
const TITLE_BASELINE = 26;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 18;
const NOTE_LINE_HEIGHT = 17;
const MUTED_INDENT = 14;
const COLUMN_TITLE_LINE_HEIGHT = 16;
const UNIT_LABEL_BASELINE = 24;
const UNIT_LABEL_HEIGHT = 18;
const PLAN_TITLE = 'Plan';
const LINKED_BOARD_TEXT = 'open linked board';
const PORT_RADIUS = 5;
const BAND_LABEL_BASELINE = 17;

const STANDALONE_STYLE = `
svg { font-family: 'ComicMono', 'CommitMono', 'Cascadia Code', 'Menlo', monospace; }
.wb-backdrop { fill: #0d0b16; }
.wb-column-title { fill: #a79fc4; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.wb-column-rule { stroke: #4a4268; stroke-width: 1; stroke-dasharray: 2 5; }
.wb-band-rule { stroke: #2a2440; stroke-width: 1; }
.wb-band-label { font-size: 12px; font-weight: 700; }
.wb-box-outline { fill: #15122a; stroke: #a79fc4; stroke-width: 1.6; }
.wb-ghost { opacity: 0.6; }
.wb-ghost .wb-box-outline { fill: transparent; stroke-dasharray: 7 5; }
.wb-box-title { fill: #e6e0f5; font-size: 16px; font-weight: 700; }
.wb-box-line { fill: #e6e0f5; font-size: 12px; }
.wb-box-line.wb-muted { fill: #a79fc4; }
.wb-lane-pill { fill: transparent; stroke-width: 1.2; }
.wb-lane-pill-text { font-size: 12px; font-weight: 700; }
.wb-unit-outline { fill: #15122a; stroke: #c084fc; stroke-width: 1.6; }
.wb-unit-label, .wb-unit-link { fill: #c084fc; font-size: 12px; font-weight: 700; }
.wb-frame-outline { fill: rgba(192, 132, 252, 0.04); stroke: #4a4268; stroke-width: 1.4; stroke-dasharray: 10 6; }
.wb-frame-title { fill: #a79fc4; font-size: 12px; font-weight: 700; }
.wb-wire-hit, .wb-port { display: none; }
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
`;

type AttributeValue = string | number;

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

function laneStroke(hex: string | undefined): string | null {
  return hex ? `stroke:${hex}` : null;
}

function boxMarkup(box: LaidOutBox): string {
  const parts = [tag('rect', { x: box.x, y: box.y, width: box.width, height: box.height, rx: 8, class: 'wb-box-outline', style: laneStroke(box.lane?.hex) })];
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  for (const [cx, cy] of [[midX, box.y], [box.x + box.width, midY], [midX, box.y + box.height], [box.x, midY]] as const) {
    parts.push(tag('circle', { cx, cy, r: PORT_RADIUS, class: 'wb-port' }));
  }
  box.titleLines.forEach((line, index) => {
    parts.push(text(line, box.x + BOX_TEXT_INSET, box.y + TITLE_BASELINE + index * TITLE_LINE_HEIGHT, 'wb-box-title'));
  });
  const bodyTop = box.y + TITLE_BASELINE + box.titleLines.length * TITLE_LINE_HEIGHT;
  box.bodyLines.forEach((line, index) => {
    const x = box.x + BOX_TEXT_INSET + (line.muted ? MUTED_INDENT : 0);
    parts.push(text(line.text, x, bodyTop + index * BODY_LINE_HEIGHT, line.muted ? 'wb-box-line wb-muted' : 'wb-box-line'));
  });
  if (box.lane && box.showsLanePill) {
    const pillY = box.y + box.height - 28;
    const pillWidth = Math.min(box.width - BOX_TEXT_INSET * 2, 16 + box.lane.label.length * 8);
    parts.push(
      tag('rect', { x: box.x + BOX_TEXT_INSET, y: pillY, width: pillWidth, height: 18, rx: 9, class: 'wb-lane-pill', style: laneStroke(box.lane.hex) }),
      text(box.lane.label, box.x + BOX_TEXT_INSET + 8, pillY + 13, 'wb-lane-pill-text', { style: `fill:${box.lane.hex}` }),
    );
  }
  return elementGroup(box, box.isGhost ? 'wb-box wb-ghost' : 'wb-box', parts);
}

function frameMarkup(frame: LaidOutFrame): string {
  return elementGroup(frame, 'wb-frame', [
    tag('rect', { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 12, class: 'wb-frame-outline' }),
    text(frame.title, frame.x + 14, frame.y + 18, 'wb-frame-title'),
  ]);
}

function wireMarkup(wire: LaidOutWire): string {
  const parts = [
    tag('path', { d: wire.path, class: 'wb-wire-hit' }),
    tag('path', { d: wire.path, 'marker-end': wire.hasArrowhead ? 'url(#wb-arrow)' : null, class: wire.isDashed ? 'wb-wire-line wb-dashed' : 'wb-wire-line', style: laneStroke(wire.strokeHex ?? undefined) }),
    tag('circle', { cx: wire.start.x, cy: wire.start.y, r: 3, class: 'wb-wire-dot' }),
  ];
  if (wire.joinAt) parts.push(tag('circle', { cx: wire.joinAt.x, cy: wire.joinAt.y, r: 3, class: 'wb-wire-dot' }));
  if (wire.label) parts.push(text(wire.label, wire.labelAt.x, wire.labelAt.y, 'wb-wire-label'));
  return elementGroup(wire, `wb-wire wb-tone-${wire.tone}`, parts);
}

function noteMarkup(note: LaidOutNote): string {
  const parts = [tag('rect', { x: note.x, y: note.y, width: note.width, height: note.height, rx: 4, class: 'wb-note-card' })];
  note.lines.forEach((line, index) => {
    parts.push(text(line, note.x + 10, note.y + 22 + index * NOTE_LINE_HEIGHT, 'wb-note-text'));
  });
  if (note.byline) parts.push(text(note.byline, note.x + 10, note.y + 22 + note.lines.length * NOTE_LINE_HEIGHT, 'wb-note-byline'));
  return elementGroup(note, note.isResolved ? 'wb-note wb-resolved' : 'wb-note', parts);
}

function unitMarkup(unit: LaidOutUnit): string {
  const parts = [
    tag('rect', { x: unit.x, y: unit.y, width: unit.width, height: unit.height, rx: 8, class: 'wb-unit-outline' }),
    text(unit.label, unit.x + BOX_TEXT_INSET, unit.y + UNIT_LABEL_BASELINE, 'wb-unit-label'),
  ];
  const titleTop = unit.y + UNIT_LABEL_BASELINE + UNIT_LABEL_HEIGHT;
  unit.titleLines.forEach((line, index) => {
    parts.push(text(line, unit.x + BOX_TEXT_INSET, titleTop + index * TITLE_LINE_HEIGHT, 'wb-box-title'));
  });
  const bodyTop = titleTop + unit.titleLines.length * TITLE_LINE_HEIGHT;
  unit.bodyLines.forEach((line, index) => {
    parts.push(text(line, unit.x + BOX_TEXT_INSET, bodyTop + index * BODY_LINE_HEIGHT, 'wb-box-line'));
  });
  if (unit.linkedBoardId) {
    parts.push(text(LINKED_BOARD_TEXT, unit.x + BOX_TEXT_INSET, bodyTop + unit.bodyLines.length * BODY_LINE_HEIGHT, 'wb-unit-link', { 'data-linked-board-id': unit.linkedBoardId }));
  }
  return elementGroup(unit, 'wb-unit', parts);
}

function elementMarkup(element: LaidOutElement): string {
  switch (element.kind) {
    case 'box': return boxMarkup(element);
    case 'frame': return frameMarkup(element);
    case 'wire': return wireMarkup(element);
    case 'note': return noteMarkup(element);
    case 'unit': return unitMarkup(element);
  }
}

function chromeMarkup(layout: BoardLayout): string {
  const parts: string[] = [];
  if (layout.plan) {
    parts.push(text(PLAN_TITLE, layout.plan.titleAt.x, layout.plan.titleAt.y, 'wb-column-title'));
    for (const arrowPath of layout.plan.arrowPaths) parts.push(tag('path', { d: arrowPath, 'marker-end': 'url(#wb-arrow)', class: 'wb-wire-line' }));
  }
  for (const band of layout.bands) {
    parts.push(tag('line', { x1: band.x, y1: band.y, x2: band.x + band.width, y2: band.y, class: 'wb-band-rule' }));
    if (band.label) parts.push(text(band.label, band.x, band.y + BAND_LABEL_BASELINE, 'wb-band-label', { style: `fill:${band.hex}` }));
  }
  for (const column of layout.columns) {
    if (column.titleLines.length === 0) continue;
    column.titleLines.forEach((line, index) => {
      parts.push(text(line, column.x, column.titleBaselineY + index * COLUMN_TITLE_LINE_HEIGHT, 'wb-column-title'));
    });
    parts.push(tag('line', { x1: column.x, y1: column.ruleY, x2: column.x + column.width, y2: column.ruleY, class: 'wb-column-rule' }));
  }
  for (const entry of layout.legend) {
    parts.push(
      tag('rect', { x: entry.x, y: entry.y, width: 14, height: 14, rx: 3, class: 'wb-legend-swatch', style: `fill:${entry.hex}` }),
      text(entry.label, entry.x + 22, entry.y + 12, 'wb-legend-text'),
    );
  }
  if (layout.caption) parts.push(text(layout.caption.text, layout.caption.x, layout.caption.y + 16, 'wb-caption'));
  return tag('g', { class: 'wb-chrome' }, parts.join(''));
}

function arrowDefinitionsMarkup(): string {
  const arrowhead = tag('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: 'context-stroke' });
  return tag('defs', {}, tag('marker', { id: 'wb-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, arrowhead));
}

const LAYER_ORDER: readonly LaidOutElement['kind'][] = ['frame', 'wire', 'box', 'note', 'unit'];

function boardSvgDocument(layout: BoardLayout): string {
  const { x, y, width, height } = layout.bounds;
  const layers = LAYER_ORDER.map((kind) => tag('g', { class: 'wb-layer' }, layout.elements.filter((element) => element.kind === kind).map(elementMarkup).join('')));
  const body = [
    tag('style', {}, STANDALONE_STYLE),
    arrowDefinitionsMarkup(),
    tag('rect', { x, y, width, height, class: 'wb-backdrop' }),
    chromeMarkup(layout),
    ...layers,
  ].join('');
  return `${tag('svg', { xmlns: SVG_NAMESPACE, viewBox: `${x} ${y} ${width} ${height}`, width, height }, body)}\n`;
}

export { arrowDefinitionsMarkup, boardSvgDocument, chromeMarkup, elementMarkup, SVG_NAMESPACE };
