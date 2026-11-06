import { boardMediaDrawnFilename, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { Board } from '#shared/contracts/whiteboard.ts';
import { layoutBoardRemembered } from '#shared/whiteboard-layout-cache.ts';
import { elementSignature } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutElement, LaidOutMedia } from '#shared/whiteboard-layout-core.ts';
import type { BoardMediaLayer } from './board-media-layer.ts';
import { arrowDefinitionsMarkup, chromeMarkup, elementMarkup, SVG_NAMESPACE } from '#shared/whiteboard-svg-core.ts';

type LayerName = 'frames' | 'wires' | 'boxes' | 'notes' | 'units';

interface RenderedElement {
  signature: string;
  node: SVGGElement;
}

interface ReviewMarks {
  worthALookIds: ReadonlySet<string>;
  flaggedUnitIds: ReadonlySet<string>;
}

const NO_REVIEW_MARKS: ReviewMarks = { worthALookIds: new Set(), flaggedUnitIds: new Set() };
const LOOK_MARKER_RADIUS = 9;

interface WorldArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const PAINT_MARGIN_IN_VIEWS = 1;
const ELEMENT_AREA_PAD = 40;
const WIRE_LABEL_PAD = 320;
const PATH_NUMBER = /-?\d+(?:\.\d+)?/g;

function areaOfElement(element: LaidOutElement): WorldArea {
  if (element.kind !== 'wire') return { left: element.x - ELEMENT_AREA_PAD, top: element.y - ELEMENT_AREA_PAD, right: element.x + element.width + ELEMENT_AREA_PAD, bottom: element.y + element.height + ELEMENT_AREA_PAD };
  const area = { left: Math.min(element.start.x, element.end.x), top: Math.min(element.start.y, element.end.y), right: Math.max(element.start.x, element.end.x), bottom: Math.max(element.start.y, element.end.y) };
  const numbers = element.path.match(PATH_NUMBER) ?? [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    const x = Number(numbers[index]);
    const y = Number(numbers[index + 1]);
    area.left = Math.min(area.left, x);
    area.right = Math.max(area.right, x);
    area.top = Math.min(area.top, y);
    area.bottom = Math.max(area.bottom, y);
  }
  const labelPad = element.label ? WIRE_LABEL_PAD : 0;
  return {
    left: Math.min(area.left, element.labelAt.x - labelPad) - ELEMENT_AREA_PAD,
    top: Math.min(area.top, element.labelAt.y) - ELEMENT_AREA_PAD,
    right: Math.max(area.right, element.labelAt.x + labelPad) + ELEMENT_AREA_PAD,
    bottom: Math.max(area.bottom, element.labelAt.y) + ELEMENT_AREA_PAD,
  };
}

function doAreasTouch(first: WorldArea, second: WorldArea): boolean {
  return first.left <= second.right && second.left <= first.right && first.top <= second.bottom && second.top <= first.bottom;
}

function isAreaInside(inner: WorldArea, outer: WorldArea): boolean {
  return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
}

function paintAreaAround(view: WorldArea): WorldArea {
  const marginX = (view.right - view.left) * PAINT_MARGIN_IN_VIEWS;
  const marginY = (view.bottom - view.top) * PAINT_MARGIN_IN_VIEWS;
  return { left: view.left - marginX, top: view.top - marginY, right: view.right + marginX, bottom: view.bottom + marginY };
}

interface BoardRenderer {
  render(board: Board): BoardLayout;
  paintElements(elements: readonly LaidOutElement[]): void;
  setView(view: WorldArea): void;
  layout(): BoardLayout | null;
  elementFromTarget(target: EventTarget | null): { id: string; kind: LaidOutElement['kind'] } | null;
  nodeOf(elementId: string): SVGGElement | null;
  setSelection(selectedIds: ReadonlySet<string>): void;
  setReviewMarks(marks: ReviewMarks): void;
  clear(): void;
}

function svgNode<Tag extends keyof SVGElementTagNameMap>(tag: Tag, className = ''): SVGElementTagNameMap[Tag] {
  const node = document.createElementNS(SVG_NAMESPACE, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function nodesFromMarkup(trustedMarkup: string): Element[] {
  const holder = svgNode('g');
  holder.innerHTML = trustedMarkup;
  return [...holder.children];
}

function nodeFromMarkup(trustedMarkup: string): SVGGElement {
  const [node] = nodesFromMarkup(trustedMarkup);
  if (!(node instanceof SVGGElement)) throw new Error('the whiteboard markup did not draw a group');
  return node;
}

function servedAssetHref(media: LaidOutMedia): string | null {
  const drawnFilename = boardMediaDrawnFilename(media);
  return drawnFilename ? `${WHITEBOARD_ASSET_ROUTE}/${drawnFilename}` : null;
}

const LAYER_BY_KIND: Record<LaidOutElement['kind'], LayerName> = { frame: 'frames', wire: 'wires', box: 'boxes', panel: 'boxes', note: 'notes', unit: 'units' };
const PAINT_ORDER: readonly LayerName[] = ['frames', 'wires', 'boxes', 'notes', 'units'];
const ELEMENT_KINDS = ['box', 'frame', 'wire', 'note', 'unit', 'panel'] as const;

export function createBoardRenderer(svg: SVGSVGElement, mediaLayer: BoardMediaLayer): BoardRenderer {
  const layers: Record<LayerName, SVGGElement> = {
    frames: svgNode('g', 'wb-layer'),
    wires: svgNode('g', 'wb-layer'),
    boxes: svgNode('g', 'wb-layer'),
    notes: svgNode('g', 'wb-layer'),
    units: svgNode('g', 'wb-layer'),
  };
  let chrome = svgNode('g');
  svg.replaceChildren(...nodesFromMarkup(arrowDefinitionsMarkup()), chrome, ...PAINT_ORDER.map((layerName) => layers[layerName]));
  const renderedById = new Map<string, RenderedElement>();
  let currentLayout: BoardLayout | null = null;
  let elementIdsInPaintOrder: string[] = [];
  let viewArea: WorldArea | null = null;
  let paintedArea: WorldArea | null = null;
  let areaById = new Map<string, WorldArea>();
  let areaPaintFrame: number | null = null;
  let previewById = new Map<string, LaidOutElement>();
  let selectedIds: ReadonlySet<string> = new Set();
  let reviewMarks = NO_REVIEW_MARKS;

  function paintSelection(elementId: string, node: SVGGElement): void {
    node.classList.toggle('is-selected', selectedIds.has(elementId));
  }

  function lookMarker(element: Exclude<LaidOutElement, { kind: 'wire' }>): SVGGElement {
    const marker = svgNode('g', 'wb-look-marker');
    const centerX = element.x + element.width;
    const centerY = element.y;
    const circle = svgNode('circle');
    circle.setAttribute('cx', String(centerX));
    circle.setAttribute('cy', String(centerY));
    circle.setAttribute('r', String(LOOK_MARKER_RADIUS));
    const mark = svgNode('text');
    mark.setAttribute('x', String(centerX));
    mark.setAttribute('y', String(centerY + 4));
    mark.setAttribute('text-anchor', 'middle');
    mark.textContent = '!';
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', 'worth a look in review');
    marker.append(circle, mark);
    return marker;
  }

  function paintReviewMarks(element: LaidOutElement, node: SVGGElement): void {
    node.classList.toggle('is-flagged', reviewMarks.flaggedUnitIds.has(element.id));
    const existingMarker = node.querySelector(':scope > .wb-look-marker');
    if (element.kind === 'wire' || !reviewMarks.worthALookIds.has(element.id)) {
      existingMarker?.remove();
      return;
    }
    if (!existingMarker) node.append(lookMarker(element));
  }

  function placeInWorld(bounds: BoardLayout['bounds']): void {
    svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    svg.setAttribute('width', String(bounds.width));
    svg.setAttribute('height', String(bounds.height));
    svg.style.left = `${bounds.x}px`;
    svg.style.top = `${bounds.y}px`;
  }

  function decorate(element: LaidOutElement, node: SVGGElement): void {
    paintSelection(element.id, node);
    paintReviewMarks(element, node);
  }

  function paintElement(element: LaidOutElement): void {
    const signature = elementSignature(element);
    const rendered = renderedById.get(element.id);
    if (rendered?.signature === signature) return;
    const node = nodeFromMarkup(elementMarkup(element, servedAssetHref));
    decorate(element, node);
    if (rendered) rendered.node.replaceWith(node);
    if (!rendered) layers[LAYER_BY_KIND[element.kind]].append(node);
    renderedById.set(element.id, { signature, node });
  }

  function syncMedia(layout: BoardLayout): void {
    elementIdsInPaintOrder = PAINT_ORDER.flatMap((layerName) => [...layers[layerName].children].flatMap((node) => node instanceof SVGGElement && node.dataset.elementId ? [node.dataset.elementId] : []));
    mediaLayer.sync(layout, elementIdsInPaintOrder);
  }

  function shownLayoutOf(layout: BoardLayout): BoardLayout {
    if (previewById.size === 0) return layout;
    return { ...layout, elements: layout.elements.map((element) => previewById.get(element.id) ?? element) };
  }

  function paintElements(elements: readonly LaidOutElement[]): void {
    for (const element of elements) {
      previewById.set(element.id, element);
      areaById.set(element.id, areaOfElement(element));
      paintElement(element);
    }
    if (!currentLayout || !elements.some((element) => element.kind === 'box' && element.media)) return;
    mediaLayer.sync(shownLayoutOf(currentLayout), elementIdsInPaintOrder);
  }

  function insertRun(run: readonly LaidOutElement[], layer: SVGGElement, anchor: Element | null): Element | null {
    if (run.length === 0) return anchor;
    const nodes = nodesFromMarkup(run.map((element) => elementMarkup(element, servedAssetHref)).join(''));
    if (nodes.length !== run.length) throw new Error('the whiteboard markup did not draw one group per element');
    const fragment = document.createDocumentFragment();
    run.forEach((element, index) => {
      const node = nodes[index];
      if (!(node instanceof SVGGElement)) throw new Error('the whiteboard markup did not draw a group');
      decorate(element, node);
      renderedById.set(element.id, { signature: elementSignature(element), node });
      fragment.append(node);
    });
    const lastNode = fragment.lastElementChild;
    if (anchor) anchor.after(fragment);
    if (!anchor) layer.prepend(fragment);
    return lastNode;
  }

  function paintLayer(layerName: LayerName, elements: readonly LaidOutElement[]): void {
    const layer = layers[layerName];
    let anchor: Element | null = null;
    let run: LaidOutElement[] = [];
    for (const element of elements) {
      const rendered = renderedById.get(element.id);
      if (!rendered) {
        run.push(element);
        continue;
      }
      anchor = insertRun(run, layer, anchor);
      run = [];
      paintElement(element);
      anchor = renderedById.get(element.id)?.node ?? anchor;
    }
    insertRun(run, layer, anchor);
  }

  function paintArea(layout: BoardLayout): void {
    const elementsByLayer = new Map<LayerName, LaidOutElement[]>(PAINT_ORDER.map((layerName) => [layerName, []]));
    const shownIds = new Set<string>();
    for (const element of layout.elements) {
      const area = areaById.get(element.id);
      if (paintedArea && area && !doAreasTouch(area, paintedArea)) continue;
      shownIds.add(element.id);
      elementsByLayer.get(LAYER_BY_KIND[element.kind])?.push(element);
    }
    for (const [elementId, rendered] of renderedById) {
      if (shownIds.has(elementId)) continue;
      rendered.node.remove();
      renderedById.delete(elementId);
    }
    for (const [layerName, elements] of elementsByLayer) paintLayer(layerName, elements);
    syncMedia(layout);
  }

  function setView(view: WorldArea): void {
    viewArea = view;
    if (paintedArea && isAreaInside(view, paintedArea)) return;
    if (areaPaintFrame !== null) return;
    areaPaintFrame = requestAnimationFrame(() => {
      areaPaintFrame = null;
      if (!currentLayout || !viewArea) return;
      paintedArea = paintAreaAround(viewArea);
      paintArea(shownLayoutOf(currentLayout));
    });
  }

  function render(board: Board): BoardLayout {
    const layout = layoutBoardRemembered(board);
    placeInWorld(layout.bounds);
    const nextChrome = nodeFromMarkup(chromeMarkup(layout));
    chrome.replaceWith(nextChrome);
    chrome = nextChrome;
    previewById = new Map();
    areaById = new Map(layout.elements.map((element) => [element.id, areaOfElement(element)]));
    currentLayout = layout;
    paintedArea = viewArea ? paintAreaAround(viewArea) : null;
    paintArea(layout);
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

  function setReviewMarks(marks: ReviewMarks): void {
    reviewMarks = marks;
    for (const element of currentLayout?.elements ?? []) {
      const node = renderedById.get(element.id)?.node;
      if (node) paintReviewMarks(element, node);
    }
  }

  function clear(): void {
    for (const rendered of renderedById.values()) rendered.node.remove();
    renderedById.clear();
    const emptyChrome = svgNode('g');
    chrome.replaceWith(emptyChrome);
    chrome = emptyChrome;
    mediaLayer.clear();
    currentLayout = null;
    areaById = new Map();
    previewById = new Map();
  }

  return {
    render,
    paintElements,
    layout: () => currentLayout,
    elementFromTarget,
    nodeOf: (elementId) => renderedById.get(elementId)?.node ?? null,
    setSelection,
    setReviewMarks,
    setView,
    clear,
  };
}

export type { BoardRenderer };
