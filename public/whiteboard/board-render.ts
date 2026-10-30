import type { Board } from '#shared/contracts/whiteboard.ts';
import { elementSignature, layoutBoard } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutFrame, LaidOutNote, LaidOutUnit, LaidOutWire } from '#shared/whiteboard-layout-core.ts';

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

type LayerName = 'frames' | 'wires' | 'boxes' | 'notes' | 'units';

interface RenderedElement {
  signature: string;
  node: SVGGElement;
}

interface BoardRenderer {
  render(board: Board): BoardLayout;
  layout(): BoardLayout | null;
  elementFromTarget(target: EventTarget | null): { id: string; kind: LaidOutElement['kind'] } | null;
  nodeOf(elementId: string): SVGGElement | null;
  setSelection(selectedIds: ReadonlySet<string>): void;
  clear(): void;
}

function svgNode<Tag extends keyof SVGElementTagNameMap>(tag: Tag, attributes: Record<string, string | number> = {}, className = ''): SVGElementTagNameMap[Tag] {
  const node = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function svgText(text: string, x: number, y: number, className: string): SVGTextElement {
  const node = svgNode('text', { x, y }, className);
  node.textContent = text;
  return node;
}

function elementGroup(element: LaidOutElement, className: string): SVGGElement {
  const group = svgNode('g', {}, `wb-element ${className}`);
  group.dataset.elementId = element.id;
  group.dataset.elementKind = element.kind;
  return group;
}

function drawBox(box: LaidOutBox): SVGGElement {
  const group = elementGroup(box, box.isGhost ? 'wb-box wb-ghost' : 'wb-box');
  const outline = svgNode('rect', { x: box.x, y: box.y, width: box.width, height: box.height, rx: 8 }, 'wb-box-outline');
  if (box.lane) outline.style.stroke = box.lane.hex;
  group.append(outline);
  box.titleLines.forEach((line, index) => {
    group.append(svgText(line, box.x + BOX_TEXT_INSET, box.y + TITLE_BASELINE + index * TITLE_LINE_HEIGHT, 'wb-box-title'));
  });
  const bodyTop = box.y + TITLE_BASELINE + box.titleLines.length * TITLE_LINE_HEIGHT;
  box.bodyLines.forEach((line, index) => {
    const x = box.x + BOX_TEXT_INSET + (line.muted ? MUTED_INDENT : 0);
    group.append(svgText(line.text, x, bodyTop + index * BODY_LINE_HEIGHT, line.muted ? 'wb-box-line wb-muted' : 'wb-box-line'));
  });
  if (!box.lane) return group;
  const pillY = box.y + box.height - 28;
  const pillWidth = Math.min(box.width - BOX_TEXT_INSET * 2, 16 + box.lane.label.length * 8);
  const pill = svgNode('rect', { x: box.x + BOX_TEXT_INSET, y: pillY, width: pillWidth, height: 18, rx: 9 }, 'wb-lane-pill');
  pill.style.stroke = box.lane.hex;
  const pillText = svgText(box.lane.label, box.x + BOX_TEXT_INSET + 8, pillY + 13, 'wb-lane-pill-text');
  pillText.style.fill = box.lane.hex;
  group.append(pill, pillText);
  return group;
}

function drawFrame(frame: LaidOutFrame): SVGGElement {
  const group = elementGroup(frame, 'wb-frame');
  group.append(
    svgNode('rect', { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 12 }, 'wb-frame-outline'),
    svgText(frame.title, frame.x + 14, frame.y + 18, 'wb-frame-title'),
  );
  return group;
}

function drawWire(wire: LaidOutWire): SVGGElement {
  const group = elementGroup(wire, `wb-wire wb-tone-${wire.tone}`);
  const hitArea = svgNode('path', { d: wire.path }, 'wb-wire-hit');
  const line = svgNode('path', wire.hasArrowhead ? { d: wire.path, 'marker-end': 'url(#wb-arrow)' } : { d: wire.path }, wire.isDashed ? 'wb-wire-line wb-dashed' : 'wb-wire-line');
  if (wire.strokeHex) line.style.stroke = wire.strokeHex;
  group.append(hitArea, line, svgNode('circle', { cx: wire.start.x, cy: wire.start.y, r: 3 }, 'wb-wire-dot'));
  if (wire.joinAt) group.append(svgNode('circle', { cx: wire.joinAt.x, cy: wire.joinAt.y, r: 3 }, 'wb-wire-dot'));
  if (wire.label) group.append(svgText(wire.label, wire.labelAt.x, wire.labelAt.y, 'wb-wire-label'));
  return group;
}

function drawNote(note: LaidOutNote): SVGGElement {
  const group = elementGroup(note, note.isResolved ? 'wb-note wb-resolved' : 'wb-note');
  group.append(svgNode('rect', { x: note.x, y: note.y, width: note.width, height: note.height, rx: 4 }, 'wb-note-card'));
  note.lines.forEach((line, index) => {
    group.append(svgText(line, note.x + 10, note.y + 22 + index * NOTE_LINE_HEIGHT, 'wb-note-text'));
  });
  if (note.byline) group.append(svgText(note.byline, note.x + 10, note.y + 22 + note.lines.length * NOTE_LINE_HEIGHT, 'wb-note-byline'));
  return group;
}

function drawUnit(unit: LaidOutUnit): SVGGElement {
  const group = elementGroup(unit, 'wb-unit');
  group.append(
    svgNode('rect', { x: unit.x, y: unit.y, width: unit.width, height: unit.height, rx: 8 }, 'wb-unit-outline'),
    svgText(unit.label, unit.x + BOX_TEXT_INSET, unit.y + UNIT_LABEL_BASELINE, 'wb-unit-label'),
  );
  const titleTop = unit.y + UNIT_LABEL_BASELINE + UNIT_LABEL_HEIGHT;
  unit.titleLines.forEach((line, index) => {
    group.append(svgText(line, unit.x + BOX_TEXT_INSET, titleTop + index * TITLE_LINE_HEIGHT, 'wb-box-title'));
  });
  const bodyTop = titleTop + unit.titleLines.length * TITLE_LINE_HEIGHT;
  unit.bodyLines.forEach((line, index) => {
    group.append(svgText(line, unit.x + BOX_TEXT_INSET, bodyTop + index * BODY_LINE_HEIGHT, 'wb-box-line'));
  });
  if (!unit.linkedBoardId) return group;
  const link = svgText(LINKED_BOARD_TEXT, unit.x + BOX_TEXT_INSET, bodyTop + unit.bodyLines.length * BODY_LINE_HEIGHT, 'wb-unit-link');
  link.dataset.linkedBoardId = unit.linkedBoardId;
  group.append(link);
  return group;
}

const LAYER_BY_KIND: Record<LaidOutElement['kind'], LayerName> = { frame: 'frames', wire: 'wires', box: 'boxes', note: 'notes', unit: 'units' };
const ELEMENT_KINDS = ['box', 'frame', 'wire', 'note', 'unit'] as const;

function drawElement(element: LaidOutElement): SVGGElement {
  switch (element.kind) {
    case 'box': return drawBox(element);
    case 'frame': return drawFrame(element);
    case 'wire': return drawWire(element);
    case 'note': return drawNote(element);
    case 'unit': return drawUnit(element);
  }
}

function drawChrome(layout: BoardLayout): SVGGElement {
  const chrome = svgNode('g', {}, 'wb-chrome');
  if (layout.plan) {
    chrome.append(svgText(PLAN_TITLE, layout.plan.titleAt.x, layout.plan.titleAt.y, 'wb-column-title'));
    for (const arrowPath of layout.plan.arrowPaths) chrome.append(svgNode('path', { d: arrowPath, 'marker-end': 'url(#wb-arrow)' }, 'wb-wire-line'));
  }
  for (const column of layout.columns) {
    if (column.titleLines.length === 0) continue;
    column.titleLines.forEach((line, index) => {
      chrome.append(svgText(line, column.x, column.titleBaselineY + index * COLUMN_TITLE_LINE_HEIGHT, 'wb-column-title'));
    });
    chrome.append(svgNode('line', { x1: column.x, y1: column.ruleY, x2: column.x + column.width, y2: column.ruleY }, 'wb-column-rule'));
  }
  for (const entry of layout.legend) {
    const swatch = svgNode('rect', { x: entry.x, y: entry.y, width: 14, height: 14, rx: 3 }, 'wb-legend-swatch');
    swatch.style.fill = entry.hex;
    chrome.append(swatch, svgText(entry.label, entry.x + 22, entry.y + 12, 'wb-legend-text'));
  }
  if (layout.caption) chrome.append(svgText(layout.caption.text, layout.caption.x, layout.caption.y + 16, 'wb-caption'));
  return chrome;
}

function arrowDefinitions(): SVGDefsElement {
  const defs = svgNode('defs');
  const marker = svgNode('marker', { id: 'wb-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
  marker.append(svgNode('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: 'context-stroke' }));
  defs.append(marker);
  return defs;
}

export function createBoardRenderer(svg: SVGSVGElement): BoardRenderer {
  const layers: Record<LayerName, SVGGElement> = {
    frames: svgNode('g', {}, 'wb-layer'),
    wires: svgNode('g', {}, 'wb-layer'),
    boxes: svgNode('g', {}, 'wb-layer'),
    notes: svgNode('g', {}, 'wb-layer'),
    units: svgNode('g', {}, 'wb-layer'),
  };
  let chrome = svgNode('g');
  svg.replaceChildren(arrowDefinitions(), chrome, layers.frames, layers.wires, layers.boxes, layers.notes, layers.units);
  const renderedById = new Map<string, RenderedElement>();
  let currentLayout: BoardLayout | null = null;
  let selectedIds: ReadonlySet<string> = new Set();

  function paintSelection(elementId: string, node: SVGGElement): void {
    node.classList.toggle('is-selected', selectedIds.has(elementId));
  }

  function render(board: Board): BoardLayout {
    const layout = layoutBoard(board);
    const nextChrome = drawChrome(layout);
    chrome.replaceWith(nextChrome);
    chrome = nextChrome;
    const seenIds = new Set<string>();
    for (const element of layout.elements) {
      seenIds.add(element.id);
      const signature = elementSignature(element);
      const rendered = renderedById.get(element.id);
      if (rendered?.signature === signature) continue;
      const node = drawElement(element);
      paintSelection(element.id, node);
      if (rendered) rendered.node.replaceWith(node);
      if (!rendered) layers[LAYER_BY_KIND[element.kind]].append(node);
      renderedById.set(element.id, { signature, node });
    }
    for (const [elementId, rendered] of renderedById) {
      if (seenIds.has(elementId)) continue;
      rendered.node.remove();
      renderedById.delete(elementId);
    }
    currentLayout = layout;
    return layout;
  }

  function elementFromTarget(target: EventTarget | null): { id: string; kind: LaidOutElement['kind'] } | null {
    if (!(target instanceof Element)) return null;
    const group = target.closest<SVGGElement>('.wb-element');
    const elementId = group?.dataset.elementId;
    const kind = ELEMENT_KINDS.find((candidate) => candidate === group?.dataset.elementKind);
    if (!elementId || !kind) return null;
    return { id: elementId, kind };
  }

  function setSelection(nextSelectedIds: ReadonlySet<string>): void {
    selectedIds = nextSelectedIds;
    for (const [elementId, rendered] of renderedById) paintSelection(elementId, rendered.node);
  }

  function clear(): void {
    for (const rendered of renderedById.values()) rendered.node.remove();
    renderedById.clear();
    const emptyChrome = svgNode('g');
    chrome.replaceWith(emptyChrome);
    chrome = emptyChrome;
    currentLayout = null;
  }

  return {
    render,
    layout: () => currentLayout,
    elementFromTarget,
    nodeOf: (elementId) => renderedById.get(elementId)?.node ?? null,
    setSelection,
    clear,
  };
}

export type { BoardRenderer };
