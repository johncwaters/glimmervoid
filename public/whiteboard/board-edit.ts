import type { Board, Op } from '#shared/contracts/whiteboard.ts';
import { el } from '../dom-helpers.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { BoardRenderer } from './board-render.ts';

const DRAG_THRESHOLD_PX = 4;
const MIN_VIEW_WIDTH = 200;
const MAX_VIEW_WIDTH = 20000;
const WHEEL_ZOOM_STEP = 1.1;
const REMOVAL_ORDER = ['wire', 'note', 'frame', 'box', 'unit'] as const;

interface ViewPoint {
  x: number;
  y: number;
}

interface BoardEditorOptions {
  svg: SVGSVGElement;
  canvas: HTMLElement;
  renderer: BoardRenderer;
  currentBoard: () => Board | null;
  sendOps: (ops: Op[]) => Promise<boolean>;
  onSelectionChange: (selectedIds: ReadonlySet<string>) => void;
  onPhoneTapBox: (boxId: string) => void;
  onOpenLinkedBoard: (boardId: string) => void;
  onConnectBoxes: (fromBoxId: string, toBoxId: string) => void;
}

type Gesture =
  | { kind: 'drag'; pointerId: number; boxId: string; origin: ViewPoint; start: Rect; pinnedOffsetY: number; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean }
  | { kind: 'wire'; pointerId: number; fromBoxId: string; start: ViewPoint; draftLine: SVGPathElement; targetBoxId: string | null }
  | { kind: 'pan'; pointerId: number; lastClient: ViewPoint; hasMoved: boolean; tappedBoxId: string | null }
  | { kind: 'pinch'; distance: number; viewWidth: number }
  | null;

export function newElementId(kind: 'box' | 'wire' | 'note' | 'frame' | 'unit'): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${kind}-${Date.now().toString(36)}${entropy}`;
}

function isPhoneLayout(): boolean {
  return document.documentElement.dataset.layout === 'phone';
}

function portOf(target: EventTarget | null): SVGCircleElement | null {
  return target instanceof SVGCircleElement && target.classList.contains('wb-port') ? target : null;
}

function linkedBoardIdOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<SVGElement>('[data-linked-board-id]')?.dataset.linkedBoardId ?? null;
}

export function createBoardEditor(options: BoardEditorOptions) {
  const { svg, canvas, renderer } = options;
  const activePointers = new Map<number, ViewPoint>();
  let selectedIds = new Set<string>();
  let viewBox: Rect = { x: 0, y: 0, width: 1000, height: 600 };
  let gesture: Gesture = null;
  let titleInput: HTMLInputElement | null = null;
  let previewFrameId: number | null = null;

  function applyViewBox(): void {
    svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  }

  function fit(): void {
    const layout = renderer.layout();
    if (!layout) return;
    const { bounds } = layout;
    const canvasWidth = svg.clientWidth;
    const canvasHeight = svg.clientHeight;
    if (canvasWidth === 0 || canvasHeight === 0) {
      viewBox = { ...bounds };
      applyViewBox();
      return;
    }
    const unitsPerPixel = Math.max(1, bounds.width / canvasWidth, bounds.height / canvasHeight);
    const viewWidth = canvasWidth * unitsPerPixel;
    viewBox = { x: bounds.x - (viewWidth - bounds.width) / 2, y: bounds.y, width: viewWidth, height: canvasHeight * unitsPerPixel };
    applyViewBox();
  }

  function toViewPoint(clientX: number, clientY: number): ViewPoint {
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: clientX, y: clientY };
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  function viewUnitsPerPixel(): number {
    const width = svg.clientWidth || 1;
    const height = svg.clientHeight || 1;
    return Math.max(viewBox.width / width, viewBox.height / height);
  }

  function zoomAround(anchor: ViewPoint, factor: number): void {
    const nextWidth = Math.min(MAX_VIEW_WIDTH, Math.max(MIN_VIEW_WIDTH, viewBox.width * factor));
    const appliedFactor = nextWidth / viewBox.width;
    viewBox = {
      x: anchor.x - (anchor.x - viewBox.x) * appliedFactor,
      y: anchor.y - (anchor.y - viewBox.y) * appliedFactor,
      width: nextWidth,
      height: viewBox.height * appliedFactor,
    };
    applyViewBox();
  }

  function panByPixels(deltaX: number, deltaY: number): void {
    const unitsPerPixel = viewUnitsPerPixel();
    viewBox = { ...viewBox, x: viewBox.x - deltaX * unitsPerPixel, y: viewBox.y - deltaY * unitsPerPixel };
    applyViewBox();
  }

  function setSelection(nextSelectedIds: Set<string>): void {
    selectedIds = nextSelectedIds;
    renderer.setSelection(selectedIds);
    options.onSelectionChange(selectedIds);
  }

  function toggleSelected(elementId: string, isAdditive: boolean): void {
    if (!isAdditive) {
      setSelection(selectedIds.has(elementId) && selectedIds.size === 1 ? new Set() : new Set([elementId]));
      return;
    }
    const next = new Set(selectedIds);
    if (!next.delete(elementId)) next.add(elementId);
    setSelection(next);
  }

  function draggedAt(drag: Extract<Gesture, { kind: 'drag' }>): ViewPoint {
    return {
      x: Math.round(drag.start.x + drag.latest.x - drag.origin.x),
      y: Math.round(drag.start.y + drag.latest.y - drag.origin.y - drag.pinnedOffsetY),
    };
  }

  function withBoxAt(board: Board, boxId: string, at: ViewPoint): Board {
    const box = board.elements[boxId];
    if (box?.kind !== 'box') return board;
    return { ...board, elements: { ...board.elements, [boxId]: { ...box, at } } };
  }

  function previewOf(board: Board): Board {
    if (gesture?.kind !== 'drag' || !gesture.hasMoved) return board;
    return withBoxAt(board, gesture.boxId, draggedAt(gesture));
  }

  function cancelPreviewFrame(): void {
    if (previewFrameId !== null) cancelAnimationFrame(previewFrameId);
    previewFrameId = null;
  }

  function paintPreview(): void {
    cancelPreviewFrame();
    const board = options.currentBoard();
    if (board) renderer.render(previewOf(board));
  }

  function requestPreviewFrame(): void {
    if (previewFrameId !== null) return;
    previewFrameId = requestAnimationFrame(paintPreview);
  }

  function pruneSelection(board: Board | null): void {
    if (gesture?.kind === 'drag' && board?.elements[gesture.boxId]?.kind !== 'box') gesture = null;
    const surviving = new Set([...selectedIds].filter((elementId) => board?.elements[elementId]));
    if (surviving.size === selectedIds.size) return;
    setSelection(surviving);
  }

  function boxRectOf(boxId: string): Rect | null {
    const laidOut = renderer.layout()?.elements.find((element) => element.id === boxId);
    if (laidOut?.kind !== 'box') return null;
    return laidOut;
  }

  function pinchDistance(): number {
    const [first, second] = [...activePointers.values()];
    if (!first || !second) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function startPinch(): void {
    if (gesture?.kind === 'wire') endWire(gesture, false);
    gesture = { kind: 'pinch', distance: pinchDistance(), viewWidth: viewBox.width };
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || titleInput) return;
    const linkedBoardId = linkedBoardIdOf(event.target);
    if (linkedBoardId) {
      options.onOpenLinkedBoard(linkedBoardId);
      return;
    }
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    svg.setPointerCapture(event.pointerId);
    if (activePointers.size === 2) {
      startPinch();
      return;
    }
    const hit = renderer.elementFromTarget(event.target);
    const port = portOf(event.target);
    if (hit?.kind === 'box' && port && !isPhoneLayout()) {
      startWire(event.pointerId, hit.id, port);
      return;
    }
    const boxRect = hit?.kind === 'box' && !isPhoneLayout() ? boxRectOf(hit.id) : null;
    if (hit && boxRect) {
      const origin = toViewPoint(event.clientX, event.clientY);
      const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
      gesture = { kind: 'drag', pointerId: event.pointerId, boxId: hit.id, origin, start: boxRect, pinnedOffsetY, latest: origin, hasMoved: false, isAdditive: event.shiftKey };
      return;
    }
    if (hit && !isPhoneLayout()) {
      toggleSelected(hit.id, event.shiftKey);
      return;
    }
    const tappedBoxId = hit?.kind === 'box' ? hit.id : null;
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, tappedBoxId };
  }

  function startWire(pointerId: number, fromBoxId: string, port: SVGCircleElement): void {
    const start = { x: port.cx.baseVal.value, y: port.cy.baseVal.value };
    const draftLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    draftLine.setAttribute('class', 'wb-wire-line wb-dashed wb-wire-draft');
    draftLine.setAttribute('d', `M ${start.x} ${start.y} L ${start.x} ${start.y}`);
    svg.append(draftLine);
    gesture = { kind: 'wire', pointerId, fromBoxId, start, draftLine, targetBoxId: null };
  }

  function markWireTarget(wire: Extract<Gesture, { kind: 'wire' }>, targetBoxId: string | null): void {
    if (wire.targetBoxId) renderer.nodeOf(wire.targetBoxId)?.classList.remove('is-wire-target');
    wire.targetBoxId = targetBoxId;
    if (targetBoxId) renderer.nodeOf(targetBoxId)?.classList.add('is-wire-target');
  }

  function moveWire(wire: Extract<Gesture, { kind: 'wire' }>, event: PointerEvent): void {
    const point = toViewPoint(event.clientX, event.clientY);
    wire.draftLine.setAttribute('d', `M ${wire.start.x} ${wire.start.y} L ${point.x} ${point.y}`);
    const hit = renderer.elementFromTarget(document.elementFromPoint(event.clientX, event.clientY));
    const isOtherBox = hit?.kind === 'box' && hit.id !== wire.fromBoxId;
    markWireTarget(wire, isOtherBox ? hit.id : null);
  }

  function endWire(wire: Extract<Gesture, { kind: 'wire' }>, shouldConnect: boolean): void {
    const targetBoxId = wire.targetBoxId;
    markWireTarget(wire, null);
    wire.draftLine.remove();
    if (shouldConnect && targetBoxId) options.onConnectBoxes(wire.fromBoxId, targetBoxId);
  }

  function moveDrag(drag: Extract<Gesture, { kind: 'drag' }>, event: PointerEvent): void {
    const point = toViewPoint(event.clientX, event.clientY);
    if (!drag.hasMoved && Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) < DRAG_THRESHOLD_PX * viewUnitsPerPixel()) return;
    drag.hasMoved = true;
    drag.latest = point;
    requestPreviewFrame();
  }

  function movePan(pan: Extract<Gesture, { kind: 'pan' }>, event: PointerEvent): void {
    const deltaX = event.clientX - pan.lastClient.x;
    const deltaY = event.clientY - pan.lastClient.y;
    if (!pan.hasMoved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;
    pan.hasMoved = true;
    pan.lastClient = { x: event.clientX, y: event.clientY };
    panByPixels(deltaX, deltaY);
  }

  function movePinch(pinch: Extract<Gesture, { kind: 'pinch' }>): void {
    const distance = pinchDistance();
    if (distance <= 0 || pinch.distance <= 0) return;
    const points = [...activePointers.values()];
    const midpoint = toViewPoint(points.reduce((sum, point) => sum + point.x, 0) / points.length, points.reduce((sum, point) => sum + point.y, 0) / points.length);
    const targetWidth = pinch.viewWidth * (pinch.distance / distance);
    zoomAround(midpoint, targetWidth / viewBox.width);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture?.kind === 'pinch') {
      movePinch(gesture);
      return;
    }
    if (gesture?.kind === 'drag' && gesture.pointerId === event.pointerId) {
      moveDrag(gesture, event);
      return;
    }
    if (gesture?.kind === 'wire' && gesture.pointerId === event.pointerId) {
      moveWire(gesture, event);
      return;
    }
    if (gesture?.kind === 'pan' && gesture.pointerId === event.pointerId) movePan(gesture, event);
  }

  async function finishDrag(drag: Extract<Gesture, { kind: 'drag' }>, event: PointerEvent): Promise<void> {
    if (!drag.hasMoved) {
      toggleSelected(drag.boxId, drag.isAdditive);
      return;
    }
    cancelPreviewFrame();
    drag.latest = toViewPoint(event.clientX, event.clientY);
    const at = draggedAt(drag);
    const board = options.currentBoard();
    if (board) renderer.render(withBoxAt(board, drag.boxId, at));
    const isSent = await options.sendOps([{ op: 'set', id: drag.boxId, fields: { at } }]);
    if (!isSent) paintPreview();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!activePointers.delete(event.pointerId)) return;
    const finished = gesture;
    if (finished?.kind === 'pinch') {
      gesture = null;
      return;
    }
    gesture = null;
    if (finished?.kind === 'drag' && finished.pointerId === event.pointerId) {
      void finishDrag(finished, event);
      return;
    }
    if (finished?.kind === 'wire') {
      endWire(finished, finished.pointerId === event.pointerId);
      return;
    }
    if (finished?.kind !== 'pan' || finished.hasMoved) return;
    if (finished.tappedBoxId && isPhoneLayout()) {
      options.onPhoneTapBox(finished.tappedBoxId);
      return;
    }
    if (!finished.tappedBoxId) setSelection(new Set());
  }

  function onPointerCancel(event: PointerEvent): void {
    activePointers.delete(event.pointerId);
    const wasDragging = gesture?.kind === 'drag';
    if (gesture?.kind === 'wire') endWire(gesture, false);
    gesture = null;
    if (wasDragging) paintPreview();
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAround(toViewPoint(event.clientX, event.clientY), event.deltaY > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP);
      return;
    }
    panByPixels(-event.deltaX, -event.deltaY);
  }

  function closeTitleInput(): void {
    const openInput = titleInput;
    titleInput = null;
    openInput?.remove();
  }

  function editTitle(boxId: string): void {
    const board = options.currentBoard();
    const box = board?.elements[boxId];
    const node = renderer.nodeOf(boxId);
    if (box?.kind !== 'box' || !node) return;
    closeTitleInput();
    const canvasRect = canvas.getBoundingClientRect();
    const boxRect = node.getBoundingClientRect();
    const input = el('input', 'wb-title-input');
    input.type = 'text';
    input.value = box.title;
    input.maxLength = 80;
    input.setAttribute('aria-label', 'Box title');
    input.style.left = `${boxRect.left - canvasRect.left}px`;
    input.style.top = `${boxRect.top - canvasRect.top}px`;
    input.style.width = `${Math.max(160, boxRect.width)}px`;
    titleInput = input;
    canvas.append(input);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTitleInput();
        svg.focus();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const title = input.value.trim();
      closeTitleInput();
      svg.focus();
      if (!title || title === box.title) return;
      void options.sendOps([{ op: 'set', id: boxId, fields: { title } }]);
    });
    input.addEventListener('blur', closeTitleInput);
    input.focus();
    input.select();
  }

  function onDoubleClick(event: MouseEvent): void {
    if (isPhoneLayout()) return;
    const hit = renderer.elementFromTarget(document.elementFromPoint(event.clientX, event.clientY));
    if (hit?.kind !== 'box') return;
    editTitle(hit.id);
  }

  function removeSelected(): void {
    const board = options.currentBoard();
    if (!board || selectedIds.size === 0) return;
    const selected = [...selectedIds].flatMap((elementId) => board.elements[elementId] ?? []);
    const ops: Op[] = REMOVAL_ORDER.flatMap((kind) => selected.filter((element) => element.kind === kind))
      .map((element) => ({ op: 'remove', id: element.id }));
    setSelection(new Set());
    void options.sendOps(ops);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== svg) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelected();
      return;
    }
    if (event.key === 'Escape') setSelection(new Set());
  }

  svg.tabIndex = 0;
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', onDoubleClick);
  svg.addEventListener('keydown', onKeyDown);

  return {
    fit,
    selectedIds: (): ReadonlySet<string> => selectedIds,
    clearSelection: () => setSelection(new Set()),
    pruneSelection,
    previewOf,
    closeTitleInput,
  };
}

export type BoardEditor = ReturnType<typeof createBoardEditor>;
