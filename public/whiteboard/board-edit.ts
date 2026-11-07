import { WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { Board, Element as BoardElement, Op } from '#shared/contracts/whiteboard.ts';
import { el } from '../dom-helpers.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { BoardHit, BoardRenderer, Camera } from './board-gl-renderer.ts';

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

interface MovingBox {
  boxId: string;
  start: Rect;
}

type BoxFields = { at: ViewPoint } | { width: number };

const MOUSE_PAN_BUTTONS: ReadonlySet<number> = new Set([1, 2]);

function rectBetween(first: ViewPoint, second: ViewPoint): Rect {
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(first.x - second.x), height: Math.abs(first.y - second.y) };
}

type BoxMedia = NonNullable<Extract<BoardElement, { kind: 'box' }>['media']>;

type Gesture =
  | { kind: 'drag'; mode: 'move' | 'resize'; pointerId: number; boxId: string; origin: ViewPoint; start: Rect; movingBoxes: readonly MovingBox[]; pinnedOffsetY: number; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; pressedImage: PressedImage | null }
  | { kind: 'wire'; pointerId: number; fromBoxId: string; start: ViewPoint; draftLine: SVGPathElement; targetBoxId: string | null }
  | { kind: 'pan'; pointerId: number; lastClient: ViewPoint; hasMoved: boolean; isAuxiliaryButton: boolean; tappedBoxId: string | null; pressedImage: PressedImage | null }
  | { kind: 'marquee'; pointerId: number; origin: ViewPoint; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; baseSelection: ReadonlySet<string>; outline: SVGRectElement }
  | { kind: 'pinch'; distance: number; viewWidth: number }
  | null;

export function newElementId(kind: BoardElement['kind']): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${kind}-${Date.now().toString(36)}${entropy}`;
}

function isPhoneLayout(): boolean {
  return document.documentElement.dataset.layout === 'phone';
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

function pressedImageOf(hit: BoardHit | null): PressedImage | null {
  if (hit?.part !== 'media' || !hit.media) return null;
  return { boxId: hit.id, href: hit.media.href, alt: hit.media.alt };
}

const CURSOR_BY_HIT_PART: Readonly<Record<BoardHit['part'], string>> = { body: 'pointer', port: 'crosshair', resize: 'ew-resize', link: 'pointer', media: 'zoom-in' };

function hoverCursorOf(hit: BoardHit | null): string {
  if (!hit) return '';
  if (hit.part === 'body' && hit.kind === 'box') return 'move';
  return CURSOR_BY_HIT_PART[hit.part];
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
    renderer.setCamera(camera);
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

  function draggedAt(drag: Extract<Gesture, { kind: 'drag' }>, start: Rect): ViewPoint {
    return {
      x: Math.round(start.x + drag.latest.x - drag.origin.x),
      y: Math.round(start.y + drag.latest.y - drag.origin.y - drag.pinnedOffsetY),
    };
  }

  function draggedWidth(drag: Extract<Gesture, { kind: 'drag' }>): number {
    const width = Math.round(drag.start.width + drag.latest.x - drag.origin.x);
    return Math.min(WHITEBOARD_LIMITS.boxWidthMax, Math.max(WHITEBOARD_LIMITS.boxWidthMin, width));
  }

  function draggedBoxFields(drag: Extract<Gesture, { kind: 'drag' }>): { boxId: string; fields: BoxFields }[] {
    if (drag.mode === 'resize') return [{ boxId: drag.boxId, fields: { width: draggedWidth(drag) } }];
    return drag.movingBoxes.map((movingBox) => ({ boxId: movingBox.boxId, fields: { at: draggedAt(drag, movingBox.start) } }));
  }

  function withBoxFields(board: Board, changes: readonly { boxId: string; fields: BoxFields }[]): Board {
    const elements = { ...board.elements };
    for (const { boxId, fields } of changes) {
      const box = elements[boxId];
      if (box?.kind === 'box') elements[boxId] = { ...box, ...fields };
    }
    return { ...board, elements };
  }

  function previewOf(board: Board): Board {
    if (gesture?.kind !== 'drag' || !gesture.hasMoved) return board;
    return withBoxFields(board, draggedBoxFields(gesture));
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

  function hitAt(clientX: number, clientY: number): BoardHit | null {
    return renderer.hitTest(toViewPoint(clientX, clientY));
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

  function startButtonPan(event: PointerEvent): void {
    event.preventDefault();
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, isAuxiliaryButton: true, tappedBoxId: null, pressedImage: null };
  }

  function startMarquee(event: PointerEvent): void {
    const origin = toViewPoint(event.clientX, event.clientY);
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    outline.setAttribute('class', 'wb-wire-line wb-dashed wb-wire-draft');
    gesture = { kind: 'marquee', pointerId: event.pointerId, origin, latest: origin, hasMoved: false, isAdditive: event.shiftKey, baseSelection: event.shiftKey ? new Set(selectedIds) : new Set(), outline };
  }

  function movingBoxesFor(pressedBoxId: string, pressedRect: Rect, isAdditive: boolean): MovingBox[] {
    if (isAdditive || !selectedIds.has(pressedBoxId)) return [{ boxId: pressedBoxId, start: pressedRect }];
    const board = options.currentBoard();
    return [...selectedIds].flatMap((elementId) => {
      const start = board?.elements[elementId]?.kind === 'box' ? renderer.boundsOf(elementId) : null;
      return start ? [{ boxId: elementId, start }] : [];
    });
  }

  function onPointerDown(event: PointerEvent): void {
    if (titleInput) return;
    if (event.pointerType === 'mouse' && MOUSE_PAN_BUTTONS.has(event.button) && !gesture) {
      startButtonPan(event);
      return;
    }
    if (event.button !== 0) return;
    const hit = hitAt(event.clientX, event.clientY);
    if (hit?.part === 'link' && hit.linkedBoardId) {
      options.onOpenLinkedBoard(hit.linkedBoardId);
      return;
    }
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    if (activePointers.size === 2) {
      startPinch();
      return;
    }
    if (isPlacementTool(activeTool)) {
      void placeElement(activeTool, toViewPoint(event.clientX, event.clientY));
      return;
    }
    const hitBoxRect = hit?.kind === 'box' ? renderer.boundsOf(hit.id) : null;
    const resizeRect = hit?.part === 'resize' && !isPhoneLayout() ? hitBoxRect : null;
    if (hit && resizeRect) {
      const origin = toViewPoint(event.clientX, event.clientY);
      gesture = { kind: 'drag', mode: 'resize', pointerId: event.pointerId, boxId: hit.id, origin, start: resizeRect, movingBoxes: [], pinnedOffsetY: 0, latest: origin, hasMoved: false, isAdditive: false, pressedImage: null };
      return;
    }
    if (hit?.kind === 'box' && hit.port && !isPhoneLayout()) {
      startWire(event.pointerId, hit.id, hit.port);
      return;
    }
    const wireToolRect = activeTool === 'wire' ? hitBoxRect : null;
    if (hit && wireToolRect) {
      startWire(event.pointerId, hit.id, { x: wireToolRect.x + wireToolRect.width / 2, y: wireToolRect.y + wireToolRect.height / 2 });
      return;
    }
    const boxRect = isPhoneLayout() ? null : hitBoxRect;
    if (hit && boxRect) {
      const origin = toViewPoint(event.clientX, event.clientY);
      const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
      gesture = { kind: 'drag', mode: 'move', pointerId: event.pointerId, boxId: hit.id, origin, start: boxRect, movingBoxes: movingBoxesFor(hit.id, boxRect, event.shiftKey), pinnedOffsetY, latest: origin, hasMoved: false, isAdditive: event.shiftKey, pressedImage: pressedImageOf(hit) };
      return;
    }
    if (hit && !isPhoneLayout()) {
      toggleSelected(hit.id, event.shiftKey);
      return;
    }
    if (!hit && event.pointerType === 'mouse' && !isPhoneLayout()) {
      startMarquee(event);
      return;
    }
    const tappedBoxId = hit?.kind === 'box' ? hit.id : null;
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, isAuxiliaryButton: false, tappedBoxId, pressedImage: pressedImageOf(hit) };
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
    if (!pendingTitleEditId || !renderer.boundsOf(pendingTitleEditId) || !options.currentBoard()?.elements[pendingTitleEditId]) return;
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
    wire.targetBoxId = targetBoxId;
    renderer.setWireTarget(targetBoxId);
  }

  function moveWire(wire: Extract<Gesture, { kind: 'wire' }>, event: PointerEvent): void {
    const point = toViewPoint(event.clientX, event.clientY);
    wire.draftLine.setAttribute('d', `M ${wire.start.x} ${wire.start.y} L ${point.x} ${point.y}`);
    const hit = renderer.hitTest(point);
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

  function moveMarquee(marquee: Extract<Gesture, { kind: 'marquee' }>, event: PointerEvent): void {
    const point = toViewPoint(event.clientX, event.clientY);
    if (!marquee.hasMoved && Math.hypot(point.x - marquee.origin.x, point.y - marquee.origin.y) < DRAG_THRESHOLD_PX * viewUnitsPerPixel()) return;
    if (!marquee.hasMoved) svg.append(marquee.outline);
    marquee.hasMoved = true;
    marquee.latest = point;
    const area = rectBetween(marquee.origin, point);
    marquee.outline.setAttribute('x', String(area.x));
    marquee.outline.setAttribute('y', String(area.y));
    marquee.outline.setAttribute('width', String(area.width));
    marquee.outline.setAttribute('height', String(area.height));
    const nextSelectedIds = new Set([...marquee.baseSelection, ...renderer.elementsInRect(area)]);
    if (nextSelectedIds.size === selectedIds.size && [...nextSelectedIds].every((elementId) => selectedIds.has(elementId))) return;
    setSelection(nextSelectedIds);
  }

  function finishMarquee(marquee: Extract<Gesture, { kind: 'marquee' }>): void {
    marquee.outline.remove();
    if (marquee.hasMoved || marquee.isAdditive) return;
    setSelection(new Set());
  }

  function movePinch(pinch: Extract<Gesture, { kind: 'pinch' }>): void {
    const distance = pinchDistance();
    if (distance <= 0 || pinch.distance <= 0) return;
    const points = [...activePointers.values()];
    const midpoint = toViewPoint(points.reduce((sum, point) => sum + point.x, 0) / points.length, points.reduce((sum, point) => sum + point.y, 0) / points.length);
    const targetWidth = pinch.viewWidth * (pinch.distance / distance);
    zoomAround(midpoint, targetWidth / viewWidth());
  }

  function showHover(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || isPhoneLayout()) return;
    const hit = hitAt(event.clientX, event.clientY);
    renderer.setHover(hit?.kind === 'box' ? hit.id : null);
    viewport.dataset.hoverKind = hit?.kind ?? '';
    viewport.style.cursor = activeTool === 'select' ? hoverCursorOf(hit) : '';
  }

  function onPointerMove(event: PointerEvent): void {
    if (!gesture) showHover(event);
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
    if (gesture?.kind === 'marquee' && gesture.pointerId === event.pointerId) {
      moveMarquee(gesture, event);
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
    const changes = draggedBoxFields(drag);
    const board = options.currentBoard();
    if (board) renderer.render(withBoxFields(board, changes));
    const isSent = await options.sendOps(changes.map(({ boxId, fields }) => ({ op: 'set', id: boxId, fields })));
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
    if (finished?.kind === 'marquee') {
      finishMarquee(finished);
      return;
    }
    if (finished?.kind !== 'pan' || finished.hasMoved || finished.isAuxiliaryButton) return;
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
    if (gesture?.kind === 'marquee') gesture.outline.remove();
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
    const bounds = renderer.boundsOf(elementId);
    if ((titled?.kind !== 'box' && titled?.kind !== 'panel') || !bounds) return;
    closeTitleInput();
    const canvasRect = canvas.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const boxRect = { left: viewportRect.left + viewport.clientLeft + (bounds.x - camera.x) * camera.scale, top: viewportRect.top + viewport.clientTop + (bounds.y - camera.y) * camera.scale, width: bounds.width * camera.scale };
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

  function onDoubleClick(event: MouseEvent): void {
    if (isPhoneLayout()) return;
    const hit = hitAt(event.clientX, event.clientY);
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
  viewport.addEventListener('contextmenu', (event) => event.preventDefault());
  viewport.addEventListener('keydown', onKeyDown);
  viewport.addEventListener('pointerleave', () => {
    if (gesture) return;
    renderer.setHover(null);
    viewport.dataset.hoverKind = '';
  });
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
