import type { FocusLayout, Pane } from '#shared/contracts/focus-layout.ts';
import { panesOf } from '#shared/contracts/focus-layout.ts';
import { el } from '../dom-helpers.ts';
import { getFocusLayout, setFocusLayout } from '../ui-prefs.ts';
import { movePane, resizeSplit, resizeVisiblePair, visibleLayout } from './pane-layout-core.ts';
import type { VisibleNode, VisibleSplit } from './pane-layout-core.ts';
import { createPaneWindow } from './pane-window.ts';
import type { PaneWindow } from './pane-window.ts';

const DIVIDER_KEY_STEP = 0.05;

interface RenderedSplit {
  container: HTMLElement;
  dividers: HTMLElement[];
  split: VisibleSplit;
}

export interface PaneLayout {
  element: HTMLElement;
  windowOf: (pane: Pane) => PaneWindow;
  showPanes: (shownPanes: ReadonlySet<Pane>) => void;
  onPaneDrag: (listener: (draggedPane: Pane | null) => void) => void;
  draggedPane: () => Pane | null;
  acceptOutsideDrops: (source: OutsidePaneDrop) => void;
  panesInOrder: () => Pane[];
}

interface OutsidePaneDrop {
  paneOfDrag: (event: DragEvent) => Pane | null;
  onDrop: (pane: Pane, event: DragEvent) => void;
}

function structureKeyOf(node: VisibleNode | null): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  return `${node.direction}(${node.children.map(structureKeyOf).join(',')})`;
}

export function createPaneLayout(): PaneLayout {
  let layout: FocusLayout = getFocusLayout();
  let shownPanes: ReadonlySet<Pane> = new Set<Pane>(['terminal']);
  let draggedPane: Pane | null = null;
  let renderedStructureKey: string | null = null;
  let renderedSplits: RenderedSplit[] = [];
  const paneDragListeners: ((draggedPane: Pane | null) => void)[] = [];
  let outsideDrop: OutsidePaneDrop | null = null;

  const element = el('div', 'pane-layout');
  const windowByPane = new Map<Pane, PaneWindow>();
  const windowOf = (pane: Pane): PaneWindow => {
    const existing = windowByPane.get(pane);
    if (existing) return existing;
    const created = createPaneWindow(pane, {
      onDragStart: (startedPane) => setDraggedPane(startedPane),
      onDragEnd: () => setDraggedPane(null),
      canAcceptDrop: (targetPane, event) => {
        const incomingPane = paneOfDrag(event);
        return incomingPane !== null && incomingPane !== targetPane;
      },
      onDrop: (targetPane, zone, event) => {
        const movedPane = paneOfDrag(event);
        const isOutsideDrop = draggedPane === null;
        setDraggedPane(null);
        if (!movedPane) return;
        if (isOutsideDrop) outsideDrop?.onDrop(movedPane, event);
        commit(movePane(layout, movedPane, targetPane, zone));
      },
    });
    windowByPane.set(pane, created);
    return created;
  };

  function paneOfDrag(event: DragEvent): Pane | null {
    if (draggedPane !== null) return draggedPane;
    return outsideDrop?.paneOfDrag(event) ?? null;
  }

  function setDraggedPane(pane: Pane | null) {
    if (draggedPane === pane) return;
    draggedPane = pane;
    element.toggleAttribute('data-dragging', pane !== null);
    if (pane === null) for (const paneWindow of windowByPane.values()) paneWindow.clearDropZone();
    for (const listener of paneDragListeners) listener(pane);
  }

  function commit(next: FocusLayout) {
    if (next === layout) return;
    layout = next;
    setFocusLayout(layout);
    render();
  }

  function replaceChildrenIfChanged(parent: HTMLElement, children: HTMLElement[]) {
    const isUnchanged = parent.children.length === children.length && children.every((child, index) => parent.children[index] === child);
    if (!isUnchanged) parent.replaceChildren(...children);
  }

  function buildDivider(rendered: RenderedSplit, dividerIndex: number): HTMLElement {
    const divider = el('div', 'pane-divider');
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', 'Resize panes');
    divider.tabIndex = 0;
    const resizeTo = (shares: number[]) => {
      layout = resizeSplit(layout, rendered.split, shares);
      render();
    };
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      divider.setPointerCapture(event.pointerId);
      divider.dataset.dragging = 'true';
      event.preventDefault();
    });
    divider.addEventListener('pointermove', (event) => {
      if (!divider.hasPointerCapture(event.pointerId)) return;
      const rect = rendered.container.getBoundingClientRect();
      const isRow = rendered.split.direction === 'row';
      const positionFraction = isRow ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
      resizeTo(resizeVisiblePair(rendered.split.shares, dividerIndex, positionFraction));
    });
    const finishResize = (event: PointerEvent) => {
      if (!divider.hasPointerCapture(event.pointerId)) return;
      divider.releasePointerCapture(event.pointerId);
      delete divider.dataset.dragging;
      setFocusLayout(layout);
    };
    divider.addEventListener('pointerup', finishResize);
    divider.addEventListener('pointercancel', finishResize);
    divider.addEventListener('keydown', (event) => {
      const stepByKey: Record<string, number> = { ArrowLeft: -DIVIDER_KEY_STEP, ArrowUp: -DIVIDER_KEY_STEP, ArrowRight: DIVIDER_KEY_STEP, ArrowDown: DIVIDER_KEY_STEP };
      const step = stepByKey[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const shares = rendered.split.shares;
      const start = shares.slice(0, dividerIndex).reduce((sum, share) => sum + share, 0);
      layout = resizeSplit(layout, rendered.split, resizeVisiblePair(shares, dividerIndex, start + (shares[dividerIndex] ?? 0) + step));
      setFocusLayout(layout);
      render();
    });
    return divider;
  }

  function buildNode(node: VisibleNode): HTMLElement {
    if (typeof node === 'string') return windowOf(node).element;
    const container = el('div', 'pane-split');
    const rendered: RenderedSplit = { container, dividers: [], split: node };
    renderedSplits.push(rendered);
    const childElements = node.children.map(buildNode);
    rendered.dividers = childElements.slice(1).map((_, index) => buildDivider(rendered, index));
    replaceChildrenIfChanged(container, childElements.flatMap((child, index) => {
      const divider = rendered.dividers[index - 1];
      return divider ? [divider, child] : [child];
    }));
    return container;
  }

  function collectSplits(node: VisibleNode | null, splits: VisibleSplit[]): VisibleSplit[] {
    if (node === null || typeof node === 'string') return splits;
    splits.push(node);
    for (const child of node.children) collectSplits(child, splits);
    return splits;
  }

  function paintSplit(rendered: RenderedSplit) {
    const { container, dividers, split } = rendered;
    container.dataset.direction = split.direction;
    split.children.forEach((child, index) => {
      const childElement = typeof child === 'string' ? windowOf(child).element : renderedSplits.find((candidate) => candidate.split === child)?.container;
      if (childElement) childElement.style.flex = `${split.shares[index] ?? 0} 1 0`;
    });
    dividers.forEach((divider, index) => {
      divider.setAttribute('aria-orientation', split.direction === 'row' ? 'vertical' : 'horizontal');
      divider.setAttribute('aria-valuenow', String(Math.round((split.shares[index] ?? 0) * 100)));
    });
  }

  function render() {
    const visible = visibleLayout(layout, shownPanes);
    const structureKey = structureKeyOf(visible);
    if (structureKey !== renderedStructureKey) {
      renderedStructureKey = structureKey;
      renderedSplits = [];
      replaceChildrenIfChanged(element, visible === null ? [] : [buildNode(visible)]);
    }
    const visibleSplits = collectSplits(visible, []);
    renderedSplits.forEach((rendered, index) => {
      const split = visibleSplits[index];
      if (split) rendered.split = split;
    });
    const rootElement = element.firstElementChild;
    if (rootElement instanceof HTMLElement) rootElement.style.flex = '1 1 0';
    for (const rendered of renderedSplits) paintSplit(rendered);
  }

  render();

  return {
    element,
    windowOf,
    showPanes: (nextShownPanes) => {
      shownPanes = nextShownPanes;
      render();
    },
    onPaneDrag: (listener) => { paneDragListeners.push(listener); },
    draggedPane: () => draggedPane,
    acceptOutsideDrops: (source) => { outsideDrop = source; },
    panesInOrder: () => panesOf(layout),
  };
}
