import { WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { Board, Element as BoardElement, Op } from '#shared/contracts/whiteboard.ts';
import { el } from '../dom-helpers.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { BoardRenderer } from './board-render.ts';

const DRAG_THRESHOLD_PX = 4;
const MIN_VIEW_WIDTH = 200;
const MAX_VIEW_WIDTH = 20000;
const WHEEL_ZOOM_STEP = 1.1;
const REMOVAL_ORDER = ['wire', 'note', 'frame', 'box', 'panel', 'unit'] as const;
const TOOL_BY_KEY: Readonly<Record<string, BoardTool>> = { v: 'select', r: 'box', d: 'decision', p: 'panel', a: 'wire' };

type BoardTool = 'select' | 'box' | 'decision' | 'panel' | 'wire';
type PlacementTool = Extract<BoardTool, 'box' | 'decision' | 'panel'>;

interface ViewPoint {
  x: number;
  y: number;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface BoardEditorOptions {
  viewport: HTMLElement;
  world: HTMLElement;
  svg: SVGSVGElement;
  canvas: HTMLElement;
  renderer: BoardRenderer;
  currentBoard: () => Board | null;
  sendOps: (ops: Op[]) => Promise<boolean>;
  onSelectionChange: (selectedIds: ReadonlySet<string>) => void;
  onPhoneTapBox: (boxId: string) => void;
  onOpenLinkedBoard: (boardId: string) => void;
  onOpenImage: (image: PressedImage) => void;
  onConnectBoxes: (fromBoxId: string, toBoxId: string) => void;
  onToolChange: (tool: BoardTool) => void;
}

export interface PressedImage {
  boxId: string | null;
  href: string;
  alt: string;
}

type BoxMedia = NonNullable<Extract<BoardElement, { kind: 'box' }>['media']>;

type Gesture =
  | { kind: 'drag'; mode: 'move' | 'resize'; pointerId: number; boxId: string; origin: ViewPoint; start: Rect; pinnedOffsetY: number; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; pressedImage: PressedImage | null }
  | { kind: 'wire'; pointerId: number; fromBoxId: string; start: ViewPoint; draftLine: SVGPathElement; targetBoxId: string | null }
  | { kind: 'pan'; pointerId: number; lastClient: ViewPoint; hasMoved: boolean; tappedBoxId: string | null; pressedImage: PressedImage | null }
  | { kind: 'pinch'; distance: number; viewWidth: number }
  | null;

export function newElementId(kind: BoardElement['kind']): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${kind}-${Date.now().toString(36)}${entropy}`;
}

function isPhoneLayout(): boolean {
  return document.documentElement.dataset.layout === 'phone';
}

function portOf(target: EventTarget | null): SVGCircleElement | null {
  return target instanceof SVGCircleElement && target.classList.contains('wb-port') ? target : null;
}

function isPlacementTool(tool: BoardTool): tool is PlacementTool {
  return tool === 'box' || tool === 'decision' || tool === 'panel';
}

function placedElement(tool: PlacementTool, board: Board, at: ViewPoint): BoardElement {
  if (tool === 'panel') {
    const lastOrder = Math.max(-1, ...Object.values(board.elements).map((element) => (element.kind === 'panel' ? element.order : -1)));
    return { kind: 'panel', id: newElementId('panel'), title: 'Panel', lines: [], order: lastOrder + 1 };
  }
  if (tool === 'decision') return placedBox(at, 'Decision', null, true);
  return placedBox(at, 'Box', null, false);
}

function placedBox(at: ViewPoint, title: string, media: BoxMedia | null, isDecision: boolean): BoardElement {
  return {
    kind: 'box', id: newElementId('box'), title, lines: [], lane: null, refs: [], change: 'none', was: null, column: null, near: null, order: 0, at,
    shape: isDecision ? 'decision' : 'box', outputs: isDecision ? [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }] : [], media, width: null,
  };
}

function pressedImageOf(target: EventTarget | null): PressedImage | null {
  if (!(target instanceof Element)) return null;
  const image = target.closest<SVGImageElement>('image.wb-image');
  const href = image?.getAttribute('href');
  if (!image || !href) return null;
  const boxId = image.closest<SVGElement>('[data-element-id]')?.dataset.elementId ?? null;
  return { boxId, href, alt: image.querySelector('title')?.textContent ?? '' };
}

function isResizeHandle(target: EventTarget | null): boolean {
  return target instanceof SVGRectElement && target.classList.contains('wb-resize-handle');
}

function linkedBoardIdOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<SVGElement>('[data-linked-board-id]')?.dataset.linkedBoardId ?? null;
}

const MAX_FIT_ZOOM = 2;
const BOX_LINE_FONT_UNITS = 12;
const MIN_READABLE_FONT_PX = 10;
const MAX_READABLE_UNITS_PER_PIXEL = BOX_LINE_FONT_UNITS / MIN_READABLE_FONT_PX;

export function createBoardEditor(options: BoardEditorOptions) {
  const { viewport, world, svg, canvas, renderer } = options;
  const activePointers = new Map<number, ViewPoint>();
  let selectedIds = new Set<string>();
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let gesture: Gesture = null;
  let titleInput: HTMLInputElement | null = null;
  let previewFrameId: number | null = null;
  let activeTool: BoardTool = 'select';
  let pendingTitleEditId: string | null = null;
  let isFitOwedOnceSized = false;

  function setTool(tool: BoardTool): void {
    activeTool = tool;
    viewport.dataset.tool = tool;
    options.onToolChange(tool);
  }

  function applyCamera(): void {
    world.style.transform = `translate(${-camera.x * camera.scale}px, ${-camera.y * camera.scale}px) scale(${camera.scale})`;
  }

  function viewWidth(): number {
    return (viewport.clientWidth || 1) / camera.scale;
  }

  function islandFreeBand(): { topPx: number; heightPx: number } {
    const viewportRect = viewport.getBoundingClientRect();
    const islandRects = [...canvas.querySelectorAll<HTMLElement>('.wb-island')].filter((island) => island.checkVisibility()).map((island) => island.getBoundingClientRect());
    const midlinePx = viewportRect.top + viewportRect.height / 2;
    const upperIslandBottoms = islandRects.filter((rect) => rect.top + rect.height / 2 < midlinePx).map((rect) => rect.bottom - viewportRect.top);
    const lowerIslandTops = islandRects.filter((rect) => rect.top + rect.height / 2 >= midlinePx).map((rect) => rect.top - viewportRect.top);
    const topPx = Math.max(0, ...upperIslandBottoms);
    const bottomPx = Math.min(viewportRect.height, ...lowerIslandTops);
    const heightPx = bottomPx - topPx;
    if (heightPx < viewportRect.height / 2) return { topPx: 0, heightPx: viewportRect.height };
    return { topPx, heightPx };
  }

  function fit(): void {
    const layout = renderer.layout();
    if (!layout) return;
    const { bounds } = layout;
    const canvasWidth = viewport.clientWidth;
    const canvasHeight = viewport.clientHeight;
    if (canvasWidth === 0 || canvasHeight === 0) {
      camera = { x: bounds.x, y: bounds.y, scale: 1 };
      applyCamera();
      isFitOwedOnceSized = true;
      return;
    }
    isFitOwedOnceSized = false;
    const band = islandFreeBand();
    const maxZoom = layout.elements.length === 0 ? 1 : MAX_FIT_ZOOM;
    const wholeBoardUnitsPerPixel = Math.max(1 / maxZoom, bounds.width / canvasWidth, bounds.height / band.heightPx);
    const isWholeBoardTooSmallToRead = wholeBoardUnitsPerPixel > MAX_READABLE_UNITS_PER_PIXEL;
    const unitsPerPixel = isWholeBoardTooSmallToRead ? MAX_READABLE_UNITS_PER_PIXEL : wholeBoardUnitsPerPixel;
    const fittedViewWidth = canvasWidth * unitsPerPixel;
    const boardCenterY = bounds.y + bounds.height / 2;
    const bandCenterPx = band.topPx + band.heightPx / 2;
    camera = {
      x: bounds.x - Math.max(0, fittedViewWidth - bounds.width) / 2,
      y: isWholeBoardTooSmallToRead ? bounds.y - band.topPx * unitsPerPixel : boardCenterY - bandCenterPx * unitsPerPixel,
      scale: 1 / unitsPerPixel,
    };
    applyCamera();
  }

  function toViewPoint(clientX: number, clientY: number): ViewPoint {
    const viewportRect = viewport.getBoundingClientRect();
    return { x: camera.x + (clientX - viewportRect.left - viewport.clientLeft) / camera.scale, y: camera.y + (clientY - viewportRect.top - viewport.clientTop) / camera.scale };
  }

  function viewUnitsPerPixel(): number {
    return 1 / camera.scale;
  }

  function zoomAround(anchor: ViewPoint, factor: number): void {
    const currentViewWidth = viewWidth();
    const nextViewWidth = Math.min(MAX_VIEW_WIDTH, Math.max(MIN_VIEW_WIDTH, currentViewWidth * factor));
    const appliedFactor = nextViewWidth / currentViewWidth;
    camera = {
      x: anchor.x - (anchor.x - camera.x) * appliedFactor,
      y: anchor.y - (anchor.y - camera.y) * appliedFactor,
      scale: camera.scale / appliedFactor,
    };
    applyCamera();
  }

  function panByPixels(deltaX: number, deltaY: number): void {
    camera = { ...camera, x: camera.x - deltaX / camera.scale, y: camera.y - deltaY / camera.scale };
    applyCamera();
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

  function draggedWidth(drag: Extract<Gesture, { kind: 'drag' }>): number {
    const width = Math.round(drag.start.width + drag.latest.x - drag.origin.x);
    return Math.min(WHITEBOARD_LIMITS.boxWidthMax, Math.max(WHITEBOARD_LIMITS.boxWidthMin, width));
  }

  function draggedFields(drag: Extract<Gesture, { kind: 'drag' }>): { at: ViewPoint } | { width: number } {
    return drag.mode === 'resize' ? { width: draggedWidth(drag) } : { at: draggedAt(drag) };
  }

  function withBoxFields(board: Board, boxId: string, fields: { at: ViewPoint } | { width: number }): Board {
    const box = board.elements[boxId];
    if (box?.kind !== 'box') return board;
    return { ...board, elements: { ...board.elements, [boxId]: { ...box, ...fields } } };
  }

  function previewOf(board: Board): Board {
    if (gesture?.kind !== 'drag' || !gesture.hasMoved) return board;
    return withBoxFields(board, gesture.boxId, draggedFields(gesture));
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
    gesture = { kind: 'pinch', distance: pinchDistance(), viewWidth: viewWidth() };
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || titleInput) return;
    const linkedBoardId = linkedBoardIdOf(event.target);
    if (linkedBoardId) {
      options.onOpenLinkedBoard(linkedBoardId);
      return;
    }
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    if (activePointers.size === 2) {
      startPinch();
      return;
    }
    const hit = renderer.elementFromTarget(event.target);
    if (isPlacementTool(activeTool)) {
      void placeElement(activeTool, toViewPoint(event.clientX, event.clientY));
      return;
    }
    const resizeRect = hit?.kind === 'box' && isResizeHandle(event.target) && !isPhoneLayout() ? boxRectOf(hit.id) : null;
    if (hit && resizeRect) {
      const origin = toViewPoint(event.clientX, event.clientY);
      gesture = { kind: 'drag', mode: 'resize', pointerId: event.pointerId, boxId: hit.id, origin, start: resizeRect, pinnedOffsetY: 0, latest: origin, hasMoved: false, isAdditive: false, pressedImage: null };
      return;
    }
    const port = portOf(event.target);
    if (hit?.kind === 'box' && port && !isPhoneLayout()) {
      startWire(event.pointerId, hit.id, { x: port.cx.baseVal.value, y: port.cy.baseVal.value });
      return;
    }
    const wireToolRect = activeTool === 'wire' && hit?.kind === 'box' ? boxRectOf(hit.id) : null;
    if (hit && wireToolRect) {
      startWire(event.pointerId, hit.id, { x: wireToolRect.x + wireToolRect.width / 2, y: wireToolRect.y + wireToolRect.height / 2 });
      return;
    }
    const boxRect = hit?.kind === 'box' && !isPhoneLayout() ? boxRectOf(hit.id) : null;
    if (hit && boxRect) {
      const origin = toViewPoint(event.clientX, event.clientY);
      const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
      gesture = { kind: 'drag', mode: 'move', pointerId: event.pointerId, boxId: hit.id, origin, start: boxRect, pinnedOffsetY, latest: origin, hasMoved: false, isAdditive: event.shiftKey, pressedImage: pressedMediaOf(event) };
      return;
    }
    if (hit && !isPhoneLayout()) {
      toggleSelected(hit.id, event.shiftKey);
      return;
    }
    const tappedBoxId = hit?.kind === 'box' ? hit.id : null;
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, tappedBoxId, pressedImage: pressedMediaOf(event) };
  }

  async function placeElement(tool: PlacementTool, point: ViewPoint): Promise<void> {
    setTool('select');
    const board = options.currentBoard();
    if (!board) return;
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const element = placedElement(tool, board, { x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) });
    pendingTitleEditId = element.id;
    const isSent = await options.sendOps([{ op: 'add', element }]);
    if (!isSent) pendingTitleEditId = null;
    if (isSent) setSelection(new Set([element.id]));
    openPendingTitleEdit();
  }

  async function placeMediaBox(title: string, media: BoxMedia, clientPoint: ViewPoint | null): Promise<boolean> {
    const board = options.currentBoard();
    if (!board) return false;
    const point = clientPoint ? toViewPoint(clientPoint.x, clientPoint.y) : { x: camera.x + viewWidth() / 2, y: camera.y + (viewport.clientHeight || 1) / camera.scale / 2 };
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const element = placedBox({ x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) }, title, media, false);
    const isSent = await options.sendOps([{ op: 'add', element }]);
    if (isSent) setSelection(new Set([element.id]));
    return isSent;
  }

  function openPendingTitleEdit(): void {
    if (!pendingTitleEditId || !renderer.nodeOf(pendingTitleEditId)) return;
    const elementId = pendingTitleEditId;
    pendingTitleEditId = null;
    editTitle(elementId);
  }

  function startWire(pointerId: number, fromBoxId: string, start: ViewPoint): void {
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
    zoomAround(midpoint, targetWidth / viewWidth());
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
    if (!drag.hasMoved && drag.mode === 'resize') return;
    if (!drag.hasMoved) {
      toggleSelected(drag.boxId, drag.isAdditive);
      if (drag.pressedImage && !drag.isAdditive) options.onOpenImage(drag.pressedImage);
      return;
    }
    cancelPreviewFrame();
    drag.latest = toViewPoint(event.clientX, event.clientY);
    const fields = draggedFields(drag);
    const board = options.currentBoard();
    if (board) renderer.render(withBoxFields(board, drag.boxId, fields));
    const isSent = await options.sendOps([{ op: 'set', id: drag.boxId, fields }]);
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
      if (activeTool === 'wire') setTool('select');
      return;
    }
    if (finished?.kind !== 'pan' || finished.hasMoved) return;
    if (finished.pressedImage && isPhoneLayout()) {
      options.onOpenImage(finished.pressedImage);
      return;
    }
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

  function editTitle(elementId: string): void {
    const board = options.currentBoard();
    const titled = board?.elements[elementId];
    const node = renderer.nodeOf(elementId);
    if ((titled?.kind !== 'box' && titled?.kind !== 'panel') || !node) return;
    closeTitleInput();
    const canvasRect = canvas.getBoundingClientRect();
    const boxRect = node.getBoundingClientRect();
    const input = el('input', 'wb-title-input');
    input.type = 'text';
    input.value = titled.title;
    input.maxLength = 80;
    input.setAttribute('aria-label', titled.kind === 'panel' ? 'Panel title' : 'Box title');
    input.style.left = `${boxRect.left - canvasRect.left}px`;
    input.style.top = `${boxRect.top - canvasRect.top}px`;
    input.style.width = `${Math.max(160, boxRect.width)}px`;
    titleInput = input;
    canvas.append(input);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTitleInput();
        viewport.focus();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const title = input.value.trim();
      closeTitleInput();
      viewport.focus();
      if (!title || title === titled.title) return;
      void options.sendOps([{ op: 'set', id: elementId, fields: { title } }]);
    });
    input.addEventListener('blur', closeTitleInput);
    input.focus();
    input.select();
  }

  function pressedMediaOf(event: PointerEvent): PressedImage | null {
    const point = toViewPoint(event.clientX, event.clientY);
    const liveMediaBox = renderer.layout()?.elements.find((element) => element.kind === 'box' && element.media && element.media.kind !== 'image'
      && point.x >= element.media.x && point.x <= element.media.x + element.media.width && point.y >= element.media.y && point.y <= element.media.y + element.media.height);
    if (liveMediaBox?.kind === 'box' && liveMediaBox.media) return { boxId: liveMediaBox.id, href: '', alt: liveMediaBox.media.alt };
    return pressedImageOf(event.target);
  }

  function onDoubleClick(event: MouseEvent): void {
    if (isPhoneLayout()) return;
    const hit = renderer.elementFromTarget(document.elementFromPoint(event.clientX, event.clientY));
    if (hit?.kind !== 'box' && hit?.kind !== 'panel') return;
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
    if (event.target !== viewport) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelected();
      return;
    }
    const tool = TOOL_BY_KEY[event.key.toLowerCase()];
    if (tool && !event.shiftKey) {
      event.preventDefault();
      setTool(tool);
      return;
    }
    if (event.key !== 'Escape') return;
    setSelection(new Set());
    setTool('select');
  }

  world.style.transition = 'none';
  viewport.tabIndex = 0;
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerCancel);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('dblclick', onDoubleClick);
  viewport.addEventListener('keydown', onKeyDown);
  new ResizeObserver(() => {
    if (isFitOwedOnceSized && viewport.clientWidth > 0 && viewport.clientHeight > 0) fit();
  }).observe(viewport);

  return {
    fit,
    selectedIds: (): ReadonlySet<string> => selectedIds,
    clearSelection: () => setSelection(new Set()),
    pruneSelection,
    previewOf,
    closeTitleInput,
    setTool,
    placeMediaBox,
    openPendingTitleEdit,
    focusCanvas: () => viewport.focus(),
  };
}

export type BoardEditor = ReturnType<typeof createBoardEditor>;
export type { BoardTool };
