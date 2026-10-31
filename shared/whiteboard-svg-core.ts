import { escapeMarkup } from './escape-markup.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutFrame, LaidOutLine, LaidOutNote, LaidOutPanel, LaidOutUnit, LaidOutWire } from './whiteboard-layout-core.ts';

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
const LOOP_BADGE_RADIUS = 6;
const LOOP_BADGE_INSET = 20;
const DECISION_POINT_INSET = 12;
const OUTPUT_LABEL_BASELINE_OFFSET = 4;
const OUTPUT_DOT_RADIUS = 3;
const MONO_CHAR_WIDTH = 7.2;
const CODE_BAND_RISE = 13;
const CODE_BAND_HEIGHT = 17;
const ITEM_DOT_RADIUS = 2.2;
const LEGEND_SAMPLE_WIDTH = 28;

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
.wb-line-code { fill: #c4b5fd; }
.wb-code-band { fill: #221d3a; }
.wb-line-marker { fill: #a79fc4; font-size: 12px; }
.wb-line-key { fill: #a79fc4; font-size: 12px; font-weight: 700; }
.wb-item-dot { fill: #a79fc4; }
.wb-panel-outline { fill: #110f20; stroke: #4a4268; stroke-width: 1.4; }
.wb-panel-rule { stroke: #4a4268; stroke-width: 1; }
.wb-output-divider { stroke: #4a4268; stroke-width: 1; }
.wb-output-label { fill: #e6e0f5; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.wb-output-dot { fill: #a79fc4; }
.wb-lane-pill { fill: transparent; stroke-width: 1.2; }
.wb-lane-pill-text { font-size: 12px; font-weight: 700; }
.wb-unit-outline { fill: #15122a; stroke: #c084fc; stroke-width: 1.6; }
.wb-unit-label, .wb-unit-link { fill: #c084fc; font-size: 12px; font-weight: 700; }
.wb-frame-outline { fill: rgba(192, 132, 252, 0.04); stroke: #4a4268; stroke-width: 1.4; stroke-dasharray: 10 6; }
.wb-frame-title { fill: #a79fc4; font-size: 12px; font-weight: 700; }
.wb-loop .wb-frame-outline { stroke: #c084fc; }
.wb-loop-badge { fill: none; stroke: #c084fc; stroke-width: 1.6; }
.wb-back .wb-wire-line { stroke: #c084fc; }
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

function lineRowMarkup(line: LaidOutLine, left: number, width: number, baseline: number): string[] {
  const rowLeft = left + BOX_TEXT_INSET + (line.muted ? MUTED_INDENT : 0);
  const parts: string[] = [];
  if (line.style === 'code') parts.push(tag('rect', { x: rowLeft - 4, y: baseline - CODE_BAND_RISE, width: left + width - BOX_TEXT_INSET + 4 - rowLeft + 4, height: CODE_BAND_HEIGHT, rx: 3, class: 'wb-code-band' }));
  if (line.style === 'item' && line.isFirstRow) parts.push(tag('circle', { cx: rowLeft + 4, cy: baseline - 4, r: ITEM_DOT_RADIUS, class: 'wb-item-dot' }));
  if (line.marker !== null) parts.push(text(line.marker, rowLeft, baseline, line.style === 'kv' ? 'wb-line-key' : 'wb-line-marker'));
  if (line.text) parts.push(text(line.text, rowLeft + line.indentChars * MONO_CHAR_WIDTH, baseline, lineClassOf(line)));
  return parts;
}

function bodyLinesMarkup(lines: readonly LaidOutLine[], left: number, width: number, top: number): string[] {
  return lines.flatMap((line, index) => lineRowMarkup(line, left, width, top + index * BODY_LINE_HEIGHT));
}

function panelMarkup(panel: LaidOutPanel): string {
  const parts = [tag('rect', { x: panel.x, y: panel.y, width: panel.width, height: panel.height, rx: 6, class: 'wb-panel-outline' })];
  panel.titleLines.forEach((line, index) => {
    parts.push(text(line, panel.x + BOX_TEXT_INSET, panel.y + TITLE_BASELINE + index * TITLE_LINE_HEIGHT, 'wb-box-title'));
  });
  const bodyTop = panel.y + TITLE_BASELINE + panel.titleLines.length * TITLE_LINE_HEIGHT;
  if (panel.bodyLines.length > 0) parts.push(tag('line', { x1: panel.x + BOX_TEXT_INSET, y1: bodyTop - 12, x2: panel.x + panel.width - BOX_TEXT_INSET, y2: bodyTop - 12, class: 'wb-panel-rule' }));
  parts.push(...bodyLinesMarkup(panel.bodyLines, panel.x, panel.width, bodyTop));
  return elementGroup(panel, 'wb-panel', parts);
}

function boxOutlineMarkup(box: LaidOutBox): string {
  if (box.shape === 'decision') return tag('path', { d: decisionOutlinePath(box), class: 'wb-box-outline', style: laneStroke(box.lane?.hex) });
  return tag('rect', { x: box.x, y: box.y, width: box.width, height: box.height, rx: 8, class: 'wb-box-outline', style: laneStroke(box.lane?.hex) });
}

function boxMarkup(box: LaidOutBox): string {
  const parts = [boxOutlineMarkup(box), ...outputRowsMarkup(box)];
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  for (const [cx, cy] of [[midX, box.y], [box.x + box.width, midY], [midX, box.y + box.height], [box.x, midY]] as const) {
    parts.push(tag('circle', { cx, cy, r: PORT_RADIUS, class: 'wb-port' }));
  }
  box.titleLines.forEach((line, index) => {
    parts.push(text(line, box.x + BOX_TEXT_INSET, box.y + TITLE_BASELINE + index * TITLE_LINE_HEIGHT, 'wb-box-title'));
  });
  const bodyTop = box.y + TITLE_BASELINE + box.titleLines.length * TITLE_LINE_HEIGHT;
  parts.push(...bodyLinesMarkup(box.bodyLines, box.x, box.width, bodyTop));
  if (box.lane && box.showsLanePill) {
    const pillY = box.y + box.headerHeight - 28;
    const pillWidth = Math.min(box.width - BOX_TEXT_INSET * 2, 16 + box.lane.label.length * 8);
    parts.push(
      tag('rect', { x: box.x + BOX_TEXT_INSET, y: pillY, width: pillWidth, height: 18, rx: 9, class: 'wb-lane-pill', style: laneStroke(box.lane.hex) }),
      text(box.lane.label, box.x + BOX_TEXT_INSET + 8, pillY + 13, 'wb-lane-pill-text', { style: `fill:${box.lane.hex}` }),
    );
  }
  return elementGroup(box, box.isGhost ? 'wb-box wb-ghost' : 'wb-box', parts);
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
    tag('path', { d: wire.path, 'marker-end': wire.hasArrowhead ? 'url(#wb-arrow)' : null, class: wire.isDashed ? 'wb-wire-line wb-dashed' : 'wb-wire-line', style: laneStroke(wire.strokeHex ?? undefined) }),
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
  parts.push(...bodyLinesMarkup(unit.bodyLines, unit.x, unit.width, bodyTop));
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
    case 'panel': return panelMarkup(element);
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
  for (const entry of layout.legend) parts.push(legendRowMarkup(entry));
  if (layout.caption) parts.push(text(layout.caption.text, layout.caption.x, layout.caption.y + 16, 'wb-caption'));
  return tag('g', { class: 'wb-chrome' }, parts.join(''));
}

function legendSwatchMarkup(entry: BoardLayout['legend'][number]): string {
  const { swatch } = entry;
  if (swatch.kind === 'lane') return tag('rect', { x: entry.x, y: entry.y, width: 14, height: 14, rx: 3, class: 'wb-legend-swatch', style: `fill:${swatch.hex}` });
  const sample = tag('path', { d: `M${entry.x},${entry.y + 7} H${entry.x + LEGEND_SAMPLE_WIDTH}`, 'marker-end': 'url(#wb-arrow)', class: swatch.isDashed ? 'wb-wire-line wb-dashed' : 'wb-wire-line' });
  return tag('g', { class: swatch.isBack ? `wb-back wb-tone-${swatch.tone}` : `wb-tone-${swatch.tone}` }, sample);
}

function legendRowMarkup(entry: BoardLayout['legend'][number]): string {
  const labelX = entry.x + (entry.swatch.kind === 'lane' ? 22 : LEGEND_SAMPLE_WIDTH + 12);
  return legendSwatchMarkup(entry) + text(entry.label, labelX, entry.y + 12, 'wb-legend-text');
}

function arrowDefinitionsMarkup(): string {
  const arrowhead = tag('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: 'context-stroke' });
  return tag('defs', {}, tag('marker', { id: 'wb-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, arrowhead));
}

const LAYER_ORDER: readonly LaidOutElement['kind'][] = ['frame', 'wire', 'box', 'panel', 'note', 'unit'];

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
