import { filledElement, LINE_STYLES, WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { Board, Element as BoardElement, Box, BoxLine, BoxMedia, ElementInput, Frame, Op } from '#shared/contracts/whiteboard.ts';
import { PLACED_DEVICE } from '#shared/whiteboard-devices.ts';
import { PLACED_ICON } from '#shared/whiteboard-icons.ts';
import { SHAPE_TRAITS } from '#shared/whiteboard-shapes.ts';
import { BODY_LINE_HEIGHT } from '#shared/whiteboard-svg-core.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { buildMenuItem, wirePopupMenuKeys } from '../menu.ts';
import { menuButton } from '../ui/button.ts';
import { CLOSED_LINE_EDIT, EMPTY_LINE, isSameLines, LINE_STYLE_LABELS, lineWithStyle, linesAfter, nextLineEdit } from './board-line-edit.ts';
import type { LineEditEvent, LineEditState, LineOp } from './board-line-edit.ts';
import { createDragPreview, isInStepBand, layoutBoard, movedBox, pinnedOffsetYAfterLeaving } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, DragPreview, LaidOutElement, Rect } from '#shared/whiteboard-layout-core.ts';
import type { BoardHit, BoardRenderer, Camera } from './board-gl-renderer.ts';
import { elementTableOf } from '#shared/whiteboard-element-table.ts';
import { clock } from '#shared/clock.ts';

const DRAG_THRESHOLD_PX = 4;
const MIN_VIEW_WIDTH = 200;
const MAX_VIEW_WIDTH = 20000;
export const WHEEL_ZOOM_STEP = 1.1;
const REMOVAL_ORDER: readonly BoardElement['kind'][] = ['stroke', 'wire', 'frame', 'box'];
const TOOL_BY_KEY: Readonly<Record<string, BoardTool>> = {
  v: 'select', 1: 'select', r: 'box', 2: 'box', d: 'decision', 3: 'decision', a: 'wire', 5: 'wire', p: 'pen', 7: 'pen', t: 'text', 8: 'text',
  h: 'hand', s: 'note', i: 'icon', m: 'device',
};
const NUDGE_UNITS = 1;
const SHIFTED_NUDGE_UNITS = 5;
const NUDGE_DIRECTION_BY_KEY: Readonly<Record<string, ViewPoint>> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
const KEY_ZOOM_STEP = 1.25;
const ZOOM_FACTOR_BY_KEY: Readonly<Record<string, number>> = { '=': 1 / KEY_ZOOM_STEP, '+': 1 / KEY_ZOOM_STEP, '-': KEY_ZOOM_STEP, _: KEY_ZOOM_STEP };

type BoardTool = 'select' | 'hand' | 'box' | 'decision' | 'note' | 'text' | 'icon' | 'device' | 'wire' | 'pen';
type PlacementTool = Extract<BoardTool, 'box' | 'decision' | 'note' | 'text' | 'icon' | 'device'>;
const NON_PLACEMENT_TOOLS: ReadonlySet<BoardTool> = new Set(['select', 'hand', 'wire', 'pen']);

interface ViewPoint {
  x: number;
  y: number;
}

function isDroppedOutside(laidOutBox: LaidOutElement | undefined, dropOffset: ViewPoint, frameArea: Rect): boolean {
  if (laidOutBox?.kind !== 'box') return false;
  const centerX = laidOutBox.x + laidOutBox.width / 2 + dropOffset.x;
  const centerY = laidOutBox.y + laidOutBox.height / 2 + dropOffset.y;
  return centerX < frameArea.x || centerX > frameArea.x + frameArea.width || centerY < frameArea.y || centerY > frameArea.y + frameArea.height;
}

const stacksByTopBoxIdByBoard = new WeakMap<Board, Map<string, Frame>>();

export function stacksByTopBoxIdOf(board: Board): Map<string, Frame> {
  const cached = stacksByTopBoxIdByBoard.get(board);
  if (cached) return cached;
  const stacksByTopBoxId = new Map<string, Frame>();
  for (const frame of board.elements.valuesOfKind('frame')) {
    const topBoxId = frame.collapsed ? frame.contains[0] : undefined;
    if (topBoxId !== undefined) stacksByTopBoxId.set(topBoxId, frame);
  }
  stacksByTopBoxIdByBoard.set(board, stacksByTopBoxId);
  return stacksByTopBoxId;
}

interface BoardEditorOptions {
  viewport: HTMLElement;
  world: HTMLElement;
  svg: SVGSVGElement;
  canvas: HTMLElement;
  renderer: BoardRenderer;
  currentBoard: () => Board | null;
  repaint: () => void;
  sendOps: (ops: Op[]) => Promise<boolean>;
  onSelectionChange: (selectedIds: ReadonlySet<string>) => void;
  onPhoneTapBox: (boxId: string) => void;
  onOpenImage: (image: PressedImage) => void;
  onConnectBoxes: (fromBoxId: string, toBoxId: string) => void;
  onStackBoxes: (targetBoxId: string, droppedBoxId: string, targetStack: Frame | null) => void;
  onOpenStack: (frameId: string) => void;
  isOpenedStack: (frameId: string) => boolean;
  onToolChange: (tool: BoardTool) => void;
  onToolLockChange: (isToolLocked: boolean) => void;
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

interface NudgeRun {
  movingBoxes: MovingBox[];
  strokeStartPointsById: Map<string, number[]>;
  offset: ViewPoint;
  pinnedOffsetY: number;
  sendsInFlight: number;
}

type BoxFields = { place: { at: ViewPoint } } | { width: number };

const MOUSE_PAN_BUTTONS: ReadonlySet<number> = new Set([1, 2]);

function rectBetween(first: ViewPoint, second: ViewPoint): Rect {
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(first.x - second.x), height: Math.abs(first.y - second.y) };
}


type Gesture =
  | { kind: 'drag'; mode: 'move' | 'resize'; pointerId: number; boxId: string; origin: ViewPoint; start: Rect; movingBoxes: readonly MovingBox[]; pinnedOffsetY: number; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; pressedImage: PressedImage | null; preview: DragPreview | null; previewLayout: BoardLayout | null; laidOutOffset: ViewPoint }
  | { kind: 'wire'; pointerId: number; fromBoxId: string; start: ViewPoint; draftLine: SVGPathElement; targetBoxId: string | null }
  | { kind: 'pan'; pointerId: number; lastClient: ViewPoint; hasMoved: boolean; isAuxiliaryButton: boolean; tappedBoxId: string | null; pressedImage: PressedImage | null }
  | { kind: 'marquee'; pointerId: number; origin: ViewPoint; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; baseSelection: ReadonlySet<string>; outline: SVGRectElement }
  | { kind: 'pinch'; distance: number; viewWidth: number }
  | { kind: 'ink'; pointerId: number; points: ViewPoint[]; draftLine: SVGPolylineElement }
  | null;

export function newElementId(kind: BoardElement['kind']): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${kind}-${clock.nowMs().toString(36)}${entropy}`;
}

function isPhoneLayout(): boolean {
  return document.documentElement.dataset.layout === 'phone';
}

function isPlacementTool(tool: BoardTool): tool is PlacementTool {
  return !NON_PLACEMENT_TOOLS.has(tool);
}

const PLACED_TITLE_BY_TOOL: Readonly<Record<PlacementTool, string>> = { box: 'Box', decision: 'Decision', note: 'Note', text: 'Text', icon: 'Icon', device: 'Device' };

function placedShapeOf(tool: PlacementTool, media: BoxMedia | null): Partial<Box> {
  switch (tool) {
    case 'icon': return { shape: 'icon', icon: PLACED_ICON };
    case 'device': return { shape: 'device', device: PLACED_DEVICE, media };
    case 'note': return { shape: 'note', tone: 'yellow', media };
    case 'text': return { shape: 'box', borderless: true };
    case 'decision': return { shape: 'decision', media };
    case 'box': return { shape: 'box', media };
  }
}

function placedBox(at: ViewPoint, title: string, media: BoxMedia | null, tool: PlacementTool): ElementInput {
  const sparseBox = { kind: 'box' as const, id: newElementId('box'), title, place: { at }, ...placedShapeOf(tool, media) };
  return filledElement(sparseBox);
}

function pressedImageOf(hit: BoardHit | null): PressedImage | null {
  if (hit?.part !== 'media' || !hit.media) return null;
  return { boxId: hit.id, href: hit.media.href, alt: hit.media.alt };
}

const VERTICAL_RESIZE_THRESHOLD_PX = 4;
const INK_POINT_SPACING_PX = 2;
const CURSOR_BY_HIT_PART: Readonly<Record<BoardHit['part'], string>> = { body: 'pointer', line: 'pointer', emptyBody: 'pointer', port: 'crosshair', resize: 'nwse-resize', media: 'zoom-in' };
const MOVABLE_BOX_PARTS: ReadonlySet<BoardHit['part']> = new Set(['body', 'line', 'emptyBody']);
const MIN_TITLE_EDITOR_WIDTH_PX = 160;
const MIN_LINE_EDITOR_WIDTH_PX = 240;

type LineEditing = Extract<LineEditState, { mode: 'editing' }>;

interface InlineEditor {
  node: HTMLElement;
  rectOf: () => Rect | null;
  minWidthPx: number;
  abort: AbortController;
}

interface UnconfirmedLines {
  boardId: string;
  boxId: string;
  linesOnTheWay: readonly (readonly BoxLine[])[];
  lines: readonly BoxLine[];
}

function hoverCursorOf(hit: BoardHit | null): string {
  if (!hit) return '';
  if (hit.kind === 'box' && MOVABLE_BOX_PARTS.has(hit.part)) return 'move';
  return CURSOR_BY_HIT_PART[hit.part];
}

const MAX_FIT_ZOOM = 2;
const WHOLE_BOARD_ZOOM_OUT_MARGIN = 1.25;

function unitsPerPixelShowing(area: { width: number; height: number }, canvasWidth: number, canvasHeight: number): number {
  return Math.max(area.width / canvasWidth, area.height / Math.max(1, canvasHeight));
}

export function createBoardEditor(options: BoardEditorOptions) {
  const { viewport, world, svg, canvas, renderer } = options;
  const activePointers = new Map<number, ViewPoint>();
  let selectedIds = new Set<string>();
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let gesture: Gesture = null;
  let inlineEditor: InlineEditor | null = null;
  let lineEdit: LineEditState = CLOSED_LINE_EDIT;
  let unconfirmedLines: UnconfirmedLines | null = null;
  let linesUnderLineEdit: readonly BoxLine[] | null = null;
  let previewFrameId: number | null = null;
  let activeTool: BoardTool = 'select';
  let isToolLocked = false;
  let isSpaceHeld = false;
  let nudgeRun: NudgeRun | null = null;
  let pendingTitleEditId: string | null = null;
  let isFitOwedOnceSized = false;

  function setTool(tool: BoardTool): void {
    activeTool = tool;
    viewport.dataset.tool = tool;
    options.onToolChange(tool);
  }

  function setToolLocked(shouldLock: boolean): void {
    isToolLocked = shouldLock;
    options.onToolLockChange(shouldLock);
  }

  function finishToolUse(): void {
    if (!isToolLocked) setTool('select');
  }

  function applyCamera(): void {
    world.style.transform = `translate(${-camera.x * camera.scale}px, ${-camera.y * camera.scale}px) scale(${camera.scale})`;
    renderer.setCamera(camera);
    placeInlineEditor();
  }

  function viewWidth(): number {
    return (viewport.clientWidth || 1) / camera.scale;
  }

  function maxViewWidth(): number {
    const layout = renderer.layout();
    const canvasWidth = viewport.clientWidth || 1;
    if (!layout) return MAX_VIEW_WIDTH;
    const wholeBoardViewWidth = canvasWidth * unitsPerPixelShowing(layout.bounds, canvasWidth, viewport.clientHeight) * WHOLE_BOARD_ZOOM_OUT_MARGIN;
    return Math.max(MAX_VIEW_WIDTH, wholeBoardViewWidth);
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
    fitArea(layout.bounds, layout.elements.length === 0 ? 1 : MAX_FIT_ZOOM);
  }

  function fitSelection(): void {
    const selectedRects = [...selectedIds].flatMap((elementId) => renderer.boundsOf(elementId) ?? []);
    if (selectedRects.length === 0) return;
    const left = Math.min(...selectedRects.map((rect) => rect.x));
    const top = Math.min(...selectedRects.map((rect) => rect.y));
    const right = Math.max(...selectedRects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...selectedRects.map((rect) => rect.y + rect.height));
    fitArea({ x: left, y: top, width: right - left, height: bottom - top }, MAX_FIT_ZOOM);
  }

  function fitArea(bounds: Rect, maxZoom: number): void {
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
    const unitsPerPixel = Math.max(1 / maxZoom, unitsPerPixelShowing(bounds, canvasWidth, band.heightPx));
    const fittedViewWidth = canvasWidth * unitsPerPixel;
    const boardCenterY = bounds.y + bounds.height / 2;
    const bandCenterPx = band.topPx + band.heightPx / 2;
    camera = {
      x: bounds.x - Math.max(0, fittedViewWidth - bounds.width) / 2,
      y: boardCenterY - bandCenterPx * unitsPerPixel,
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
    const nextViewWidth = Math.min(maxViewWidth(), Math.max(MIN_VIEW_WIDTH, currentViewWidth * factor));
    const appliedFactor = nextViewWidth / currentViewWidth;
    camera = {
      x: anchor.x - (anchor.x - camera.x) * appliedFactor,
      y: anchor.y - (anchor.y - camera.y) * appliedFactor,
      scale: camera.scale / appliedFactor,
    };
    applyCamera();
  }

  function viewportCenter(): ViewPoint {
    const viewportRect = viewport.getBoundingClientRect();
    return toViewPoint(viewportRect.left + viewportRect.width / 2, viewportRect.top + viewportRect.height / 2);
  }

  function panByPixels(deltaX: number, deltaY: number): void {
    camera = { ...camera, x: camera.x - deltaX / camera.scale, y: camera.y - deltaY / camera.scale };
    applyCamera();
  }

  function setSelection(nextSelectedIds: Set<string>): void {
    selectedIds = nextSelectedIds;
    nudgeRun = null;
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

  function draggedWidth(drag: Extract<Gesture, { kind: 'drag' }>, start: Rect): number {
    const width = Math.round(start.width + drag.latest.x - drag.origin.x);
    return Math.min(WHITEBOARD_LIMITS.boxWidthMax, Math.max(WHITEBOARD_LIMITS.boxWidthMin, width));
  }

  function isResizedVertically(drag: Extract<Gesture, { kind: 'drag' }>): boolean {
    return Math.abs(drag.latest.y - drag.origin.y) >= VERTICAL_RESIZE_THRESHOLD_PX * viewUnitsPerPixel();
  }

  function draggedHeight(drag: Extract<Gesture, { kind: 'drag' }>, start: Rect): number {
    const height = Math.round(start.height + drag.latest.y - drag.origin.y);
    return Math.min(WHITEBOARD_LIMITS.boxHeightMax, Math.max(1, height));
  }

  function draggedBoxFields(drag: Extract<Gesture, { kind: 'drag' }>): { boxId: string; fields: BoxFields }[] {
    if (drag.mode === 'resize') return drag.movingBoxes.map((movingBox) => ({ boxId: movingBox.boxId, fields: { width: draggedWidth(drag, movingBox.start), ...(isResizedVertically(drag) ? { height: draggedHeight(drag, movingBox.start) } : {}) } }));
    return movedPlaceFields(drag.movingBoxes, (start) => draggedAt(drag, start), drag.pinnedOffsetY);
  }

  function movedPlaceFields(movingBoxes: readonly MovingBox[], droppedAtOf: (start: Rect) => ViewPoint, pinnedOffsetY: number): { boxId: string; fields: BoxFields }[] {
    const board = options.currentBoard();
    const leavingBand = movingBoxes.filter((movingBox) => {
      const record = board?.elements.get(movingBox.boxId);
      return record?.kind === 'box' && isInStepBand(record);
    });
    const bandShrinkY = pinnedOffsetY - pinnedOffsetYAfterLeaving(renderer.layout()?.plan ?? null, leavingBand.map((movingBox) => movingBox.start));
    return movingBoxes.map((movingBox) => {
      const at = droppedAtOf(movingBox.start);
      return { boxId: movingBox.boxId, fields: { place: { at: { x: at.x, y: at.y + bandShrinkY } } } };
    });
  }

  function startNudgeRun(board: Board): NudgeRun {
    const movingBoxes = [...selectedIds].flatMap((elementId) => {
      const start = board.elements.get(elementId)?.kind === 'box' ? renderer.boundsOf(elementId) : null;
      return start ? [{ boxId: elementId, start }] : [];
    });
    const strokeStartPointsById = new Map([...selectedIds].flatMap((elementId) => {
      const stroke = board.elements.get(elementId);
      return stroke?.kind === 'stroke' ? [[elementId, stroke.points] as const] : [];
    }));
    return { movingBoxes, strokeStartPointsById, offset: { x: 0, y: 0 }, pinnedOffsetY: renderer.layout()?.pinnedOffsetY ?? 0, sendsInFlight: 0 };
  }

  function nudgeSelected(direction: ViewPoint, distance: number): void {
    const board = options.currentBoard();
    if (!board || selectedIds.size === 0) return;
    const run = nudgeRun ?? startNudgeRun(board);
    nudgeRun = run;
    run.offset = { x: run.offset.x + direction.x * distance, y: run.offset.y + direction.y * distance };
    const { offset, pinnedOffsetY } = run;
    const boxOps = movedPlaceFields(run.movingBoxes, (start) => ({ x: Math.round(start.x + offset.x), y: Math.round(start.y + offset.y - pinnedOffsetY) }), pinnedOffsetY)
      .map(({ boxId, fields }): Op => ({ op: 'set', id: boxId, fields }));
    const strokeOps = [...run.strokeStartPointsById].map(([strokeId, startPoints]): Op => {
      const points = startPoints.map((coordinate, index) => coordinate + Math.round(index % 2 === 0 ? offset.x : offset.y));
      return { op: 'set', id: strokeId, fields: { points } };
    });
    const nudgeOps = [...boxOps, ...strokeOps];
    if (nudgeOps.length === 0) return;
    run.sendsInFlight += 1;
    void options.sendOps(nudgeOps).finally(() => {
      run.sendsInFlight -= 1;
    });
  }

  function endSettledNudgeRun(): void {
    if (nudgeRun?.sendsInFlight === 0) nudgeRun = null;
  }

  function selectAll(): void {
    const board = options.currentBoard();
    if (!board) return;
    setSelection(new Set(board.elements.keys()));
  }

  function resetZoom(): void {
    zoomAround(viewportCenter(), (viewport.clientWidth || 1) / viewWidth());
  }

  function cancelPreviewFrame(): void {
    if (previewFrameId !== null) cancelAnimationFrame(previewFrameId);
    previewFrameId = null;
  }

  function dragOffsetOf(drag: Extract<Gesture, { kind: 'drag' }>): ViewPoint {
    return { x: Math.round(drag.latest.x - drag.origin.x), y: Math.round(drag.latest.y - drag.origin.y) };
  }

  function paintMovePreview(drag: Extract<Gesture, { kind: 'drag' }>, board: Board): boolean {
    const layout = renderer.layout();
    if (drag.mode !== 'move' || !drag.hasMoved || !layout) return false;
    const offset = dragOffsetOf(drag);
    if (!drag.preview || drag.previewLayout !== layout) {
      const laidOutBox = layout.elements.find((element) => element.kind === 'box' && element.id === drag.boxId);
      const laidOutStart = laidOutBox?.kind === 'box' ? laidOutBox : null;
      drag.laidOutOffset = laidOutStart ? { x: laidOutStart.x - drag.start.x, y: laidOutStart.y - drag.start.y } : { x: 0, y: 0 };
      drag.preview = createDragPreview(board, layout, new Set(drag.movingBoxes.map((movingBox) => movingBox.boxId)));
      drag.previewLayout = layout;
    }
    renderer.paintElements(drag.preview(offset.x - drag.laidOutOffset.x, offset.y - drag.laidOutOffset.y));
    return true;
  }

  function resizedElementsOf(drag: Extract<Gesture, { kind: 'drag' }>, board: Board, layout: BoardLayout): LaidOutElement[] {
    const resizedIds = new Set(drag.movingBoxes.map((movingBox) => movingBox.boxId));
    const laidOutById = new Map(layout.elements.flatMap((element) => (element.kind === 'box' && resizedIds.has(element.id) ? [[element.id, element]] : [])));
    const resizedElements = elementTableOf();
    for (const { boxId, fields } of draggedBoxFields(drag)) {
      const box = board.elements.get(boxId);
      const laidOut = laidOutById.get(boxId);
      if (box?.kind !== 'box' || !laidOut) continue;
      resizedElements.put({ ...box, ...fields, step: null, place: { at: { x: laidOut.x, y: laidOut.y } } });
    }
    const resizedById = new Map<string, LaidOutElement>();
    for (const element of layoutBoard({ ...board, elements: resizedElements }).elements) {
      const laidOut = laidOutById.get(element.id);
      if (element.kind === 'box' && laidOut) resizedById.set(element.id, movedBox(element, laidOut.x - element.x, laidOut.y - element.y));
    }
    const resizedLayout = { ...layout, elements: layout.elements.map((element) => resizedById.get(element.id) ?? element) };
    return createDragPreview(board, resizedLayout, new Set(resizedById.keys()))(0, 0);
  }

  function paintResizePreview(drag: Extract<Gesture, { kind: 'drag' }>, board: Board): boolean {
    const layout = renderer.layout();
    if (drag.mode !== 'resize' || !drag.hasMoved || !layout) return false;
    renderer.paintElements(resizedElementsOf(drag, board, layout));
    return true;
  }

  function paintPreview(): void {
    cancelPreviewFrame();
    const board = options.currentBoard();
    if (gesture?.kind !== 'drag' || !board) {
      options.repaint();
      return;
    }
    if (paintMovePreview(gesture, board) || paintResizePreview(gesture, board)) return;
    options.repaint();
  }

  function repaintPreview(): void {
    const board = options.currentBoard();
    if (gesture?.kind !== 'drag' || !board) return;
    if (paintMovePreview(gesture, board)) return;
    paintResizePreview(gesture, board);
  }

  function requestPreviewFrame(): void {
    if (previewFrameId !== null) return;
    previewFrameId = requestAnimationFrame(paintPreview);
  }

  function pruneSelection(board: Board | null): void {
    if (gesture?.kind === 'drag' && board?.elements.get(gesture.boxId)?.kind !== 'box') gesture = null;
    if (gesture?.kind === 'drag' && gesture.hasMoved) gesture.movingBoxes = gesture.movingBoxes.filter((movingBox) => board?.elements.get(movingBox.boxId)?.kind === 'box');
    const surviving = new Set([...selectedIds].filter((elementId) => board?.elements.get(elementId)));
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
    if (gesture?.kind === 'ink') gesture.draftLine.remove();
    gesture = { kind: 'pinch', distance: pinchDistance(), viewWidth: viewWidth() };
  }

  function startButtonPan(event: PointerEvent): void {
    event.preventDefault();
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, isAuxiliaryButton: true, tappedBoxId: null, pressedImage: null };
  }

  function startInk(event: PointerEvent): void {
    const draftLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    draftLine.setAttribute('class', 'wb-ink-draft');
    svg.append(draftLine);
    gesture = { kind: 'ink', pointerId: event.pointerId, points: [toViewPoint(event.clientX, event.clientY)], draftLine };
    drawInkDraft(gesture);
  }

  function drawInkDraft(ink: Extract<Gesture, { kind: 'ink' }>): void {
    ink.draftLine.setAttribute('points', ink.points.map((point) => `${point.x},${point.y}`).join(' '));
  }

  function moveInk(ink: Extract<Gesture, { kind: 'ink' }>, event: PointerEvent): void {
    const point = toViewPoint(event.clientX, event.clientY);
    const lastPoint = ink.points[ink.points.length - 1];
    if (ink.points.length >= WHITEBOARD_LIMITS.strokePoints) return;
    if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < INK_POINT_SPACING_PX * viewUnitsPerPixel()) return;
    ink.points.push(point);
    drawInkDraft(ink);
  }

  async function finishInk(ink: Extract<Gesture, { kind: 'ink' }>): Promise<void> {
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const points = ink.points.length === 1 && ink.points[0] ? [ink.points[0], ink.points[0]] : ink.points;
    const flatPoints = points.flatMap((point) => [Math.round(point.x), Math.round(point.y - pinnedOffsetY)]);
    const isSent = await options.sendOps([{ op: 'add', element: { kind: 'stroke', id: newElementId('stroke'), points: flatPoints, width: 3, tone: 'ink' } }]);
    ink.draftLine.remove();
    if (!isSent) paintPreview();
  }

  function startMarquee(event: PointerEvent): void {
    const origin = toViewPoint(event.clientX, event.clientY);
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    outline.setAttribute('class', 'wb-wire-line wb-dashed wb-wire-draft');
    gesture = { kind: 'marquee', pointerId: event.pointerId, origin, latest: origin, hasMoved: false, isAdditive: event.shiftKey, baseSelection: event.shiftKey ? new Set(selectedIds) : new Set(), outline };
  }

  function stackTopped(boxId: string): Frame | undefined {
    const board = options.currentBoard();
    return board ? stacksByTopBoxIdOf(board).get(boxId) : undefined;
  }

  function movingBoxesFor(pressedBoxId: string, pressedRect: Rect, isAdditive: boolean): MovingBox[] {
    if (isAdditive || !selectedIds.has(pressedBoxId)) return [{ boxId: pressedBoxId, start: pressedRect }];
    const board = options.currentBoard();
    return [...selectedIds].flatMap((elementId) => {
      const start = board?.elements.get(elementId)?.kind === 'box' ? renderer.boundsOf(elementId) : null;
      return start ? [{ boxId: elementId, start }] : [];
    });
  }

  function onPointerDown(event: PointerEvent): void {
    if (inlineEditor) return;
    if (event.pointerType === 'mouse' && MOUSE_PAN_BUTTONS.has(event.button) && !gesture) {
      startButtonPan(event);
      return;
    }
    if (event.button !== 0) return;
    if ((isSpaceHeld || activeTool === 'hand') && !gesture) {
      startButtonPan(event);
      return;
    }
    const hit = hitAt(event.clientX, event.clientY);
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
    if (activeTool === 'pen') {
      startInk(event);
      return;
    }
    const hitBoxRect = hit?.kind === 'box' ? renderer.boundsOf(hit.id) : null;
    const resizeRect = hit?.part === 'resize' && !isPhoneLayout() ? hitBoxRect : null;
    if (hit && resizeRect) {
      const origin = toViewPoint(event.clientX, event.clientY);
      gesture = { kind: 'drag', mode: 'resize', pointerId: event.pointerId, boxId: hit.id, origin, start: resizeRect, movingBoxes: movingBoxesFor(hit.id, resizeRect, false), pinnedOffsetY: 0, latest: origin, hasMoved: false, isAdditive: false, pressedImage: null, preview: null, previewLayout: null, laidOutOffset: { x: 0, y: 0 } };
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
      gesture = { kind: 'drag', mode: 'move', pointerId: event.pointerId, boxId: hit.id, origin, start: boxRect, movingBoxes: movingBoxesFor(hit.id, boxRect, event.shiftKey), pinnedOffsetY, latest: origin, hasMoved: false, isAdditive: event.shiftKey, pressedImage: pressedImageOf(hit), preview: null, previewLayout: null, laidOutOffset: { x: 0, y: 0 } };
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
    finishToolUse();
    if (!options.currentBoard()) return;
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const element = placedBox({ x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) }, PLACED_TITLE_BY_TOOL[tool], null, tool);
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
    const element = placedBox({ x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) }, title, media, 'box');
    const isSent = await options.sendOps([{ op: 'add', element }]);
    if (isSent) setSelection(new Set([element.id]));
    return isSent;
  }

  function openPendingTitleEdit(): void {
    if (!pendingTitleEditId || !renderer.boundsOf(pendingTitleEditId) || !options.currentBoard()?.elements.get(pendingTitleEditId)) return;
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
    renderer.setWireTarget(stackTargetOf(drag));
    requestPreviewFrame();
  }

  function stackTargetOf(drag: Extract<Gesture, { kind: 'drag' }>): string | null {
    if (drag.mode !== 'move' || drag.movingBoxes.length !== 1 || stackTopped(drag.boxId)) return null;
    return renderer.boxIdsAt(drag.latest).find((boxId) => boxId !== drag.boxId) ?? null;
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
    viewport.style.cursor = activeTool === 'select' && !isSpaceHeld ? hoverCursorOf(hit) : '';
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
    if (gesture?.kind === 'ink' && gesture.pointerId === event.pointerId) {
      moveInk(gesture, event);
      return;
    }
    if (gesture?.kind === 'pan' && gesture.pointerId === event.pointerId) movePan(gesture, event);
  }

  async function finishDrag(drag: Extract<Gesture, { kind: 'drag' }>, event: PointerEvent): Promise<void> {
    if (!drag.hasMoved && drag.mode === 'resize') return;
    if (!drag.hasMoved) {
      finishClick(drag);
      return;
    }
    cancelPreviewFrame();
    drag.latest = toViewPoint(event.clientX, event.clientY);
    renderer.setWireTarget(null);
    const stackTargetId = stackTargetOf(drag);
    if (stackTargetId) {
      paintPreview();
      options.onStackBoxes(stackTargetId, drag.boxId, stackTopped(stackTargetId) ?? null);
      return;
    }
    const changes = draggedBoxFields(drag);
    const board = options.currentBoard();
    if (board && !paintMovePreview(drag, board)) paintResizePreview(drag, board);
    const moveOps = changes.map(({ boxId, fields }): Op => ({ op: 'set', id: boxId, fields }));
    const departureOps = board ? frameDepartureOps(drag, board) : [];
    const isSent = await options.sendOps([...moveOps, ...departureOps]) || (departureOps.length > 0 && await options.sendOps(moveOps));
    if (!isSent) paintPreview();
  }

  function frameDepartureOps(drag: Extract<Gesture, { kind: 'drag' }>, board: Board): Op[] {
    const layout = renderer.layout();
    if (drag.mode !== 'move' || !layout) return [];
    const dropOffset = dragOffsetOf(drag);
    const laidOutById = new Map(layout.elements.map((element) => [element.id, element] as const));
    const movingBoxIds = new Set(drag.movingBoxes.map((movingBox) => movingBox.boxId));
    const topCardIdByHiddenId = new Map([...stacksByTopBoxIdOf(board).values()].flatMap((stack) => stack.contains.slice(1).map((hiddenId) => [hiddenId, stack.contains[0]] as const)));
    const cardIdOf = (boxId: string) => topCardIdByHiddenId.get(boxId) ?? boxId;
    const isMoving = (boxId: string) => movingBoxIds.has(cardIdOf(boxId));
    return [...board.elements.valuesOfKind('frame')].flatMap((frame): Op[] => {
      const frameArea = laidOutById.get(frame.id);
      if (frame.collapsed || frameArea?.kind !== 'frame' || frame.contains.every(isMoving)) return [];
      const remainingBoxIds = frame.contains.filter((boxId) => !isMoving(boxId) || !isDroppedOutside(laidOutById.get(cardIdOf(boxId)), dropOffset, frameArea));
      if (remainingBoxIds.length === frame.contains.length) return [];
      const isFrameDissolved = remainingBoxIds.length === 0 || (remainingBoxIds.length === 1 && options.isOpenedStack(frame.id));
      return [isFrameDissolved ? { op: 'remove', id: frame.id } : { op: 'set', id: frame.id, fields: { contains: remainingBoxIds } }];
    });
  }

  function finishClick(drag: Extract<Gesture, { kind: 'drag' }>): void {
    toggleSelected(drag.boxId, drag.isAdditive);
    const stack = drag.isAdditive ? undefined : stackTopped(drag.boxId);
    if (stack) {
      options.onOpenStack(stack.id);
      return;
    }
    if (drag.pressedImage && !drag.isAdditive) options.onOpenImage(drag.pressedImage);
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
      if (activeTool === 'wire') finishToolUse();
      return;
    }
    if (finished?.kind === 'marquee') {
      finishMarquee(finished);
      return;
    }
    if (finished?.kind === 'ink') {
      void finishInk(finished);
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
    if (gesture?.kind === 'ink') gesture.draftLine.remove();
    gesture = null;
    if (!wasDragging) return;
    renderer.setWireTarget(null);
    paintPreview();
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAround(toViewPoint(event.clientX, event.clientY), event.deltaY > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP);
      return;
    }
    panByPixels(-event.deltaX, -event.deltaY);
  }

  function placeInlineEditor(): void {
    const rect = inlineEditor?.rectOf();
    if (!inlineEditor || !rect) return;
    const canvasRect = canvas.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const { style } = inlineEditor.node;
    style.left = `${viewportRect.left + viewport.clientLeft + (rect.x - camera.x) * camera.scale - canvasRect.left}px`;
    style.top = `${viewportRect.top + viewport.clientTop + (rect.y - camera.y) * camera.scale - canvasRect.top}px`;
    style.width = `${Math.max(inlineEditor.minWidthPx, rect.width * camera.scale)}px`;
  }

  function closeInlineEditor(): void {
    const openEditor = inlineEditor;
    inlineEditor = null;
    lineEdit = CLOSED_LINE_EDIT;
    linesUnderLineEdit = null;
    openEditor?.abort.abort();
    openEditor?.node.remove();
  }

  function openInlineEditor(node: HTMLElement, rectOf: () => Rect | null, minWidthPx: number): AbortSignal {
    closeInlineEditor();
    const abort = new AbortController();
    inlineEditor = { node, rectOf, minWidthPx, abort };
    canvas.append(node);
    placeInlineEditor();
    return abort.signal;
  }

  function editTitle(elementId: string): void {
    const titled = options.currentBoard()?.elements.get(elementId);
    if (titled?.kind !== 'box' || !renderer.boxTextRectsOf(elementId)) return;
    const input = markAsNotCredential(el('input', 'wb-title-input'));
    input.type = 'text';
    input.value = titled.title;
    input.maxLength = WHITEBOARD_LIMITS.title;
    input.setAttribute('aria-label', 'Box title');
    const signal = openInlineEditor(input, () => renderer.boxTextRectsOf(elementId)?.title ?? null, MIN_TITLE_EDITOR_WIDTH_PX);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeInlineEditor();
        viewport.focus();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const title = input.value.trim();
      closeInlineEditor();
      viewport.focus();
      if (!title || title === titled.title) return;
      void options.sendOps([{ op: 'set', id: elementId, fields: { title } }]);
    }, { signal });
    input.addEventListener('blur', closeInlineEditor, { signal });
    input.focus();
    input.select();
  }

  function editedBox(boxId: string): Box | null {
    const element = options.currentBoard()?.elements.get(boxId);
    return element?.kind === 'box' ? element : null;
  }

  function unconfirmedLinesOf(box: Box): UnconfirmedLines | null {
    const isThisBox = unconfirmedLines?.boxId === box.id && unconfirmedLines.boardId === options.currentBoard()?.id;
    return isThisBox ? unconfirmedLines : null;
  }

  function linesOfBox(box: Box): readonly BoxLine[] {
    return unconfirmedLinesOf(box)?.lines ?? box.lines;
  }

  function settleUnconfirmedLines(): void {
    if (!unconfirmedLines) return;
    const box = editedBox(unconfirmedLines.boxId);
    const unconfirmed = box ? unconfirmedLinesOf(box) : null;
    const isOwnSendStillLanding = box !== null && unconfirmed !== null && !isSameLines(box.lines, unconfirmed.lines) && unconfirmed.linesOnTheWay.some((lines) => isSameLines(box.lines, lines));
    if (!isOwnSendStillLanding) unconfirmedLines = null;
  }

  function sendLineOps(lineOps: readonly LineOp[]): void {
    const [firstOp] = lineOps;
    const boardId = options.currentBoard()?.id;
    const box = firstOp ? editedBox(firstOp.boxId) : null;
    if (!box || !boardId) return;
    const currentLines = linesOfBox(box);
    const lines = linesAfter(currentLines, lineOps);
    if (isSameLines(lines, currentLines)) return;
    const linesOnTheWay = unconfirmedLinesOf(box)?.linesOnTheWay ?? [box.lines];
    unconfirmedLines = { boardId, boxId: box.id, linesOnTheWay: [...linesOnTheWay, lines], lines };
    void options.sendOps([{ op: 'set', id: box.id, fields: { lines } }]).then((isSent) => {
      if (isSent || unconfirmedLines?.boxId !== box.id || unconfirmedLines.boardId !== boardId) return;
      unconfirmedLines = null;
      closeStaleLineEdit();
    });
  }

  function lineSlotRect(editing: LineEditing): Rect | null {
    const textRects = renderer.boxTextRectsOf(editing.boxId);
    if (!textRects) return null;
    const drawnIndex = Math.min(editing.isNewLine ? editing.lineIndex - 1 : editing.lineIndex, textRects.lines.length - 1);
    const drawnRect = textRects.lines[drawnIndex] ?? textRects.title;
    if (!editing.isNewLine) return drawnRect;
    return { x: drawnRect.x, y: drawnRect.y + drawnRect.height, width: drawnRect.width, height: BODY_LINE_HEIGHT };
  }

  function applyLineEdit(event: LineEditEvent): void {
    const { state, lineOps } = nextLineEdit(lineEdit, event);
    sendLineOps(lineOps);
    if (state === lineEdit) return;
    if (state.mode === 'closed') {
      closeInlineEditor();
      return;
    }
    editLine(state);
  }

  function draftLineOf(editing: LineEditing, box: Box): BoxLine {
    const lines = linesOfBox(box);
    const editedLine = editing.isNewLine ? null : lines[editing.lineIndex];
    if (editedLine) return editedLine;
    const lineAbove = lines[editing.lineIndex - 1];
    return lineAbove ? lineWithStyle({ ...EMPTY_LINE, muted: lineAbove.muted }, lineAbove.style) : EMPTY_LINE;
  }

  function lineStyleMenu(chooseStyle: (style: BoxLine['style']) => void, toggleMuted: () => void, signal: AbortSignal) {
    const menu = el('div', 'popup-menu wb-line-style-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Line style');
    const isOpen = () => menu.classList.contains('open');
    const setOpen = (shouldOpen: boolean) => {
      menu.classList.toggle('open', shouldOpen);
      trigger.setAttribute('aria-expanded', String(shouldOpen));
    };
    const trigger = menuButton({ label: 'Line style', action: 'line-style', onClick: () => setOpen(!isOpen()) });
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    const styleItems = LINE_STYLES.map((style) => {
      const item = buildMenuItem(LINE_STYLE_LABELS[style], 'wb-line-style-item');
      item.setAttribute('role', 'menuitemradio');
      item.addEventListener('click', () => {
        setOpen(false);
        chooseStyle(style);
      }, { signal });
      return { style, item };
    });
    const mutedItem = buildMenuItem('Muted', 'wb-line-style-item');
    mutedItem.setAttribute('role', 'menuitemcheckbox');
    mutedItem.addEventListener('click', () => {
      setOpen(false);
      toggleMuted();
    }, { signal });
    menu.append(...styleItems.map(({ item }) => item), mutedItem);
    wirePopupMenuKeys({ trigger, menu, menuItems: () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')], isOpen, open: () => setOpen(true), close: () => setOpen(false), signal });
    const paint = (line: BoxLine) => {
      for (const { style, item } of styleItems) item.setAttribute('aria-checked', String(style === line.style));
      mutedItem.setAttribute('aria-checked', String(line.muted));
    };
    return { trigger, menu, paint };
  }

  function editLine(editing: LineEditing): void {
    const box = editedBox(editing.boxId);
    if (!box || !lineSlotRect(editing)) {
      closeInlineEditor();
      return;
    }
    let draftLine = draftLineOf(editing, box);
    const storedText = draftLine.text;
    let shownKey = '';
    const editor = el('div', 'wb-line-editor');
    const keyInput = markAsNotCredential(el('input', 'wb-line-key'));
    keyInput.type = 'text';
    keyInput.maxLength = WHITEBOARD_LIMITS.lineKey;
    keyInput.setAttribute('aria-label', 'Line key');
    const textInput = markAsNotCredential(el('input', 'wb-line-text'));
    textInput.type = 'text';
    textInput.maxLength = WHITEBOARD_LIMITS.line;
    textInput.value = storedText;
    const shownText = textInput.value;
    textInput.setAttribute('aria-label', 'Box line');
    const signal = openInlineEditor(editor, () => lineSlotRect(editing), MIN_LINE_EDITOR_WIDTH_PX);
    lineEdit = editing;
    linesUnderLineEdit = linesOfBox(box);
    const typedKey = () => {
      if (draftLine.style !== 'kv' || keyInput.value === shownKey) return draftLine.key;
      return keyInput.value.trim() || draftLine.key;
    };
    const typedLine = (): BoxLine => ({ ...draftLine, text: textInput.value === shownText ? storedText : textInput.value, key: typedKey() });
    const paintDraft = () => {
      editor.dataset.lineStyle = draftLine.style;
      editor.dataset.muted = String(draftLine.muted);
      keyInput.hidden = draftLine.style !== 'kv';
      keyInput.value = draftLine.key ?? '';
      shownKey = keyInput.value;
      styleMenu.paint(draftLine);
    };
    const styleMenu = lineStyleMenu((style) => {
      draftLine = lineWithStyle(typedLine(), style);
      paintDraft();
      textInput.focus();
    }, () => {
      draftLine = { ...typedLine(), muted: !draftLine.muted };
      paintDraft();
      textInput.focus();
    }, signal);
    const onFieldKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        applyLineEdit({ kind: 'escape' });
        viewport.focus();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const enteredBox = editedBox(editing.boxId);
        applyLineEdit({ kind: 'enter', draft: typedLine(), lineCount: enteredBox ? linesOfBox(enteredBox).length : 0 });
        if (lineEdit.mode === 'closed') viewport.focus();
        return;
      }
      if (event.key !== 'Backspace' || event.target !== textInput || textInput.value) return;
      event.preventDefault();
      applyLineEdit({ kind: 'backspaceOnEmptyLine' });
      if (lineEdit.mode === 'closed') viewport.focus();
    };
    keyInput.addEventListener('keydown', onFieldKey, { signal });
    textInput.addEventListener('keydown', onFieldKey, { signal });
    editor.addEventListener('mousedown', (event) => {
      if (event.target !== keyInput && event.target !== textInput) event.preventDefault();
    }, { signal });
    editor.addEventListener('focusout', (event) => {
      if (event.relatedTarget instanceof Node && editor.contains(event.relatedTarget)) return;
      applyLineEdit({ kind: 'blur', draft: typedLine() });
    }, { signal });
    editor.append(keyInput, textInput, styleMenu.trigger, styleMenu.menu);
    paintDraft();
    textInput.focus();
  }

  function closeStaleLineEdit(): void {
    if (lineEdit.mode !== 'editing') return;
    const box = editedBox(lineEdit.boxId);
    if (box && linesUnderLineEdit && isSameLines(linesOfBox(box), linesUnderLineEdit)) return;
    applyLineEdit({ kind: 'linesChangedUnderEditor' });
  }

  function afterBoardPaint(): void {
    endSettledNudgeRun();
    settleUnconfirmedLines();
    closeStaleLineEdit();
    placeInlineEditor();
    openPendingTitleEdit();
  }

  function onDoubleClick(event: MouseEvent): void {
    if (isPhoneLayout()) return;
    const hit = hitAt(event.clientX, event.clientY);
    const box = hit?.kind === 'box' ? editedBox(hit.id) : null;
    if (!hit || !box) return;
    const lineCount = linesOfBox(box).length;
    const { lineIndex } = hit;
    if (hit.part === 'line' && lineIndex !== null && lineIndex < lineCount) {
      applyLineEdit({ kind: 'doubleClickLine', boxId: box.id, lineIndex });
      return;
    }
    const isBelowStoredLines = hit.part === 'emptyBody' || hit.part === 'line';
    if (isBelowStoredLines && SHAPE_TRAITS[box.shape].holdsLines) {
      applyLineEdit({ kind: 'doubleClickEmptyBody', boxId: box.id, lineCount });
      return;
    }
    editTitle(box.id);
  }

  function removeSelected(): void {
    const board = options.currentBoard();
    if (!board || selectedIds.size === 0) return;
    const selected = [...selectedIds].flatMap((elementId) => board.elements.get(elementId) ?? []);
    const ops: Op[] = REMOVAL_ORDER.flatMap((kind) => selected.filter((element) => element.kind === kind))
      .map((element) => ({ op: 'remove', id: element.id }));
    setSelection(new Set());
    void options.sendOps(ops);
  }

  function commandKeyAction(event: KeyboardEvent): (() => void) | null {
    const key = event.key.toLowerCase();
    if (key === 'a') return selectAll;
    if (key === '0') return resetZoom;
    const zoomFactor = ZOOM_FACTOR_BY_KEY[key];
    if (zoomFactor === undefined) return null;
    return () => zoomAround(viewportCenter(), zoomFactor);
  }

  function shiftedKeyAction(event: KeyboardEvent): (() => void) | null {
    if (event.code === 'Digit1') return fit;
    if (event.code === 'Digit2') return fitSelection;
    return null;
  }

  function plainKeyAction(event: KeyboardEvent): (() => void) | null {
    const nudgeDirection = NUDGE_DIRECTION_BY_KEY[event.key];
    if (nudgeDirection) return () => nudgeSelected(nudgeDirection, event.shiftKey ? SHIFTED_NUDGE_UNITS : NUDGE_UNITS);
    if (event.key === 'Delete' || event.key === 'Backspace') return removeSelected;
    if (event.key === 'Escape') return () => {
      setSelection(new Set());
      setTool('select');
    };
    if (event.shiftKey) return shiftedKeyAction(event);
    if (event.key === ' ') return () => holdSpace(true);
    const key = event.key.toLowerCase();
    if (key === 'q') return () => setToolLocked(!isToolLocked);
    const tool = TOOL_BY_KEY[key];
    return tool ? () => setTool(tool) : null;
  }

  function holdSpace(isHeld: boolean): void {
    isSpaceHeld = isHeld;
    viewport.dataset.spacePan = String(isHeld);
    if (isHeld) viewport.style.cursor = '';
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== viewport || event.altKey) return;
    const action = event.metaKey || event.ctrlKey ? commandKeyAction(event) : plainKeyAction(event);
    if (!action) return;
    event.preventDefault();
    if (event.repeat && event.key === ' ') return;
    action();
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === ' ') holdSpace(false);
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
  viewport.addEventListener('keyup', onKeyUp);
  viewport.addEventListener('blur', () => holdSpace(false));
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
    repaintPreview,
    closeInlineEditor,
    setTool,
    toggleToolLock: () => setToolLocked(!isToolLocked),
    placeMediaBox,
    afterBoardPaint,
    focusCanvas: () => viewport.focus(),
    removeSelected,
    zoomAroundClientPoint: (clientX: number, clientY: number, viewWidthFactor: number) => zoomAround(toViewPoint(clientX, clientY), viewWidthFactor),
    panByPixels,
  };
}

export type BoardEditor = ReturnType<typeof createBoardEditor>;
export type { BoardTool };
