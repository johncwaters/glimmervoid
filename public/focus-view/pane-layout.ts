import type { FocusLayout, Pane } from '#shared/contracts/focus-layout.ts';
import { el } from '../dom-helpers.ts';
import { getFocusLayout, setFocusLayout } from '../ui-prefs.ts';
import { dropZoneAt, moveBoard, resizeSplit } from './pane-layout-core.ts';

const PANES: readonly Pane[] = ['terminal', 'board'];
const DIVIDER_KEY_STEP = 0.05;
const BOARD_DRAG_MIME = 'application/x-glimmervoid-board-pane';

interface HeaderHost {
  parent: HTMLElement;
  before: Element | null;
}

interface PaneParts {
  section: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
}

export interface PaneLayout {
  element: HTMLElement;
  trailSlot: HTMLElement;
  bodyOf: (pane: Pane) => HTMLElement;
  boardTitleSlot: HTMLElement;
  setHeaderHost: (pane: Pane, host: HeaderHost | null) => void;
  showPanes: (shownPanes: ReadonlySet<Pane>) => void;
  onBoardDrag: (listener: (isDragging: boolean) => void) => void;
}

const UNEDITABLE_DRAG_TARGETS = 'input, textarea, select, button, [contenteditable="true"]';

export function createPaneLayout(): PaneLayout {
  let layout: FocusLayout = getFocusLayout();
  let shownPanes: ReadonlySet<Pane> = new Set<Pane>(['terminal']);
  let isBoardDragging = false;
  const boardDragListeners: ((isDragging: boolean) => void)[] = [];

  const element = el('div', 'pane-layout');
  const trailSlot = el('div', 'pane-trail');
  const divider = el('div', 'pane-divider');
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', 'Resize panes');
  divider.tabIndex = 0;

  const partsByPane: Record<Pane, PaneParts> = { terminal: buildPane('terminal'), board: buildPane('board') };
  const boardTitleSlot = el('div', 'pane-title');
  const headerHostByPane = new Map<Pane, HeaderHost>();
  partsByPane.board.header.append(boardTitleSlot);
  partsByPane.terminal.header.append(trailSlot);
  wireBoardHeaderDrag(partsByPane.board.header);
  wireTerminalDropZones(partsByPane.terminal.section);

  function buildPane(pane: Pane): PaneParts {
    const section = el('section', 'pane-group');
    section.dataset.pane = pane;
    const header = el('div', 'pane-strip pane-header');
    const body = el('div', 'pane-body');
    body.id = `focus-pane-${pane}`;
    section.append(header, body);
    return { section, header, body };
  }

  function setBoardDragging(isDragging: boolean) {
    if (isBoardDragging === isDragging) return;
    isBoardDragging = isDragging;
    element.toggleAttribute('data-dragging', isDragging);
    if (!isDragging) delete partsByPane.terminal.section.dataset.dropZone;
    for (const listener of boardDragListeners) listener(isDragging);
  }

  function wireBoardHeaderDrag(header: HTMLElement) {
    header.draggable = true;
    header.addEventListener('dragstart', (event) => {
      if (event.target instanceof Element && event.target.closest(UNEDITABLE_DRAG_TARGETS)) {
        event.preventDefault();
        return;
      }
      event.dataTransfer?.setData(BOARD_DRAG_MIME, 'board');
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      setBoardDragging(true);
    });
    header.addEventListener('dragend', () => setBoardDragging(false));
  }

  function wireTerminalDropZones(section: HTMLElement) {
    const zoneOf = (event: DragEvent) => {
      const rect = section.getBoundingClientRect();
      return dropZoneAt(event.clientX - rect.left, event.clientY - rect.top, rect);
    };
    section.addEventListener('dragover', (event) => {
      if (!isBoardDragging) return;
      event.preventDefault();
      section.dataset.dropZone = zoneOf(event);
    });
    section.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && section.contains(event.relatedTarget)) return;
      delete section.dataset.dropZone;
    });
    section.addEventListener('drop', (event) => {
      if (!isBoardDragging) return;
      event.preventDefault();
      const zone = zoneOf(event);
      setBoardDragging(false);
      commit(moveBoard(layout, zone));
    });
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

  function placeHeader(pane: Pane) {
    const { section, header } = partsByPane[pane];
    const host = headerHostByPane.get(pane);
    if (!host) {
      if (section.firstElementChild !== header) section.prepend(header);
      return;
    }
    const isPlaced = header.parentElement === host.parent && (host.before === null || header.nextElementSibling === host.before);
    if (!isPlaced) host.parent.insertBefore(header, host.before);
  }

  function render() {
    const visiblePanes = [layout.first, layout.second].filter((pane) => shownPanes.has(pane));
    const isSplit = visiblePanes.length === 2;
    element.dataset.direction = isSplit ? layout.direction : 'single';
    for (const pane of PANES) placeHeader(pane);
    const [firstPane, secondPane] = visiblePanes;
    const sections = visiblePanes.map((pane) => partsByPane[pane].section);
    replaceChildrenIfChanged(element, isSplit ? sections.toSpliced(1, 0, divider) : sections);
    const firstShare = isSplit ? layout.firstShare : 1;
    if (firstPane) partsByPane[firstPane].section.style.flex = `${firstShare} 1 0`;
    if (secondPane) partsByPane[secondPane].section.style.flex = `${1 - firstShare} 1 0`;
    divider.setAttribute('aria-orientation', layout.direction === 'row' ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-valuenow', String(Math.round(firstShare * 100)));
  }

  function shareAt(event: PointerEvent): number {
    const rect = element.getBoundingClientRect();
    if (layout.direction === 'row') return (event.clientX - rect.left) / rect.width;
    return (event.clientY - rect.top) / rect.height;
  }

  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    divider.setPointerCapture(event.pointerId);
    divider.dataset.dragging = 'true';
    event.preventDefault();
  });
  divider.addEventListener('pointermove', (event) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    layout = resizeSplit(layout, shareAt(event));
    render();
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
    commit(resizeSplit(layout, layout.firstShare + step));
  });

  render();

  return {
    element,
    trailSlot,
    bodyOf: (pane) => partsByPane[pane].body,
    boardTitleSlot,
    setHeaderHost: (pane, host) => {
      if (host) headerHostByPane.set(pane, host);
      if (!host) headerHostByPane.delete(pane);
      render();
    },
    showPanes: (nextShownPanes) => {
      shownPanes = nextShownPanes;
      render();
    },
    onBoardDrag: (listener) => { boardDragListeners.push(listener); },
  };
}
