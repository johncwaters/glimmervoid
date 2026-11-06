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

interface BoardRenderer {
  render(board: Board): BoardLayout;
  paintElements(elements: readonly LaidOutElement[]): void;
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

  function paintElement(element: LaidOutElement): void {
    const signature = elementSignature(element);
    const rendered = renderedById.get(element.id);
    if (rendered?.signature === signature) return;
    const node = nodeFromMarkup(elementMarkup(element, servedAssetHref));
    paintSelection(element.id, node);
    paintReviewMarks(element, node);
    if (rendered) rendered.node.replaceWith(node);
    if (!rendered) layers[LAYER_BY_KIND[element.kind]].append(node);
    renderedById.set(element.id, { signature, node });
  }

  function paintElements(elements: readonly LaidOutElement[]): void {
    for (const element of elements) paintElement(element);
    if (!currentLayout || !elements.some((element) => element.kind === 'box' && element.media)) return;
    const paintedById = new Map(elements.map((element) => [element.id, element]));
    mediaLayer.sync({ ...currentLayout, elements: currentLayout.elements.map((element) => paintedById.get(element.id) ?? element) }, elementIdsInPaintOrder);
  }

  function render(board: Board): BoardLayout {
    const layout = layoutBoardRemembered(board);
    placeInWorld(layout.bounds);
    const nextChrome = nodeFromMarkup(chromeMarkup(layout));
    chrome.replaceWith(nextChrome);
    chrome = nextChrome;
    const seenIds = new Set<string>();
    for (const element of layout.elements) {
      seenIds.add(element.id);
      paintElement(element);
    }
    for (const [elementId, rendered] of renderedById) {
      if (seenIds.has(elementId)) continue;
      rendered.node.remove();
      renderedById.delete(elementId);
    }
    elementIdsInPaintOrder = PAINT_ORDER.flatMap((layerName) => [...layers[layerName].children].flatMap((node) => node instanceof SVGGElement && node.dataset.elementId ? [node.dataset.elementId] : []));
    mediaLayer.sync(layout, elementIdsInPaintOrder);
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
  }

  return {
    render,
    paintElements,
    layout: () => currentLayout,
    elementFromTarget,
    nodeOf: (elementId) => renderedById.get(elementId)?.node ?? null,
    setSelection,
    setReviewMarks,
    clear,
  };
}

export type { BoardRenderer };
