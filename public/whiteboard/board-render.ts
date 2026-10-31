import type { Board } from '#shared/contracts/whiteboard.ts';
import { elementSignature, layoutBoard } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutElement } from '#shared/whiteboard-layout-core.ts';
import { arrowDefinitionsMarkup, chromeMarkup, elementMarkup, SVG_NAMESPACE } from '#shared/whiteboard-svg-core.ts';

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

const LAYER_BY_KIND: Record<LaidOutElement['kind'], LayerName> = { frame: 'frames', wire: 'wires', box: 'boxes', panel: 'boxes', note: 'notes', unit: 'units' };
const ELEMENT_KINDS = ['box', 'frame', 'wire', 'note', 'unit', 'panel'] as const;

export function createBoardRenderer(svg: SVGSVGElement): BoardRenderer {
  const layers: Record<LayerName, SVGGElement> = {
    frames: svgNode('g', 'wb-layer'),
    wires: svgNode('g', 'wb-layer'),
    boxes: svgNode('g', 'wb-layer'),
    notes: svgNode('g', 'wb-layer'),
    units: svgNode('g', 'wb-layer'),
  };
  let chrome = svgNode('g');
  svg.replaceChildren(...nodesFromMarkup(arrowDefinitionsMarkup()), chrome, layers.frames, layers.wires, layers.boxes, layers.notes, layers.units);
  const renderedById = new Map<string, RenderedElement>();
  let currentLayout: BoardLayout | null = null;
  let selectedIds: ReadonlySet<string> = new Set();

  function paintSelection(elementId: string, node: SVGGElement): void {
    node.classList.toggle('is-selected', selectedIds.has(elementId));
  }

  function render(board: Board): BoardLayout {
    const layout = layoutBoard(board);
    const nextChrome = nodeFromMarkup(chromeMarkup(layout));
    chrome.replaceWith(nextChrome);
    chrome = nextChrome;
    const seenIds = new Set<string>();
    for (const element of layout.elements) {
      seenIds.add(element.id);
      const signature = elementSignature(element);
      const rendered = renderedById.get(element.id);
      if (rendered?.signature === signature) continue;
      const node = nodeFromMarkup(elementMarkup(element));
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
