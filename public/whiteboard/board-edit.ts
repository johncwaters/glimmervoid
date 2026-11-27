import { BOARD_CONTEXT_MOUSE_BUTTON, BOARD_MIDDLE_MOUSE_BUTTON, BOARD_MOUSE_PAN_BUTTONS, filledBox, WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { Board, Element as BoardElement, Box, BoxMedia, Frame, Op, Wire } from '#shared/contracts/whiteboard.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { createDragPreview, isFullBleedBox, isInStepBand, pinnedOffsetYAfterLeaving } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, DragPreview, LaidOutElement, Rect } from '#shared/whiteboard-layout-core.ts';
import type { SlideChain } from '#shared/contracts/control/whiteboard-messages.ts';
import type { BoardHit, BoardRenderer, Camera } from './board-gl-renderer.ts';
import type { BoardWheel } from './board-media-layer.ts';
import { isCodemapOwnedId } from '#shared/contracts/whiteboard-ops-core.ts';
import { clock } from '#shared/clock.ts';
import { boardIndexOf, linkedIdsOf } from '#shared/whiteboard-board-index.ts';
import { carriedWiresOf, centeringOffsetOf, copiedClipboardOf, parsedClipboardOf, pastedOpsOf, pastedTextOf, shiftedWireOpOf } from './board-clipboard-core.ts';
import type { BoardClipboard } from './board-clipboard-core.ts';
import { movedSnapOf, rectAround, snapTargetsOf } from './board-snap-core.ts';
import type { SnapGuide, SnapTargets } from './board-snap-core.ts';
import { firstPresentedBoxId, presentedBoxIdAfter } from './media-walk-core.ts';
import { wheelViewWidthFactor } from './media-zoom-core.ts';
import { prefersReducedMotion } from '../attention-banner.ts';

const DRAG_THRESHOLD_PX = 4;
const BOX_LIFT_HOLD_MS = 300;
const SNAP_THRESHOLD_PX = 8;
const MIN_VIEW_WIDTH = 200;
const MAX_VIEW_WIDTH = 20000;
export const WHEEL_ZOOM_STEP = 1.1;
const REMOVAL_ORDER: readonly BoardElement['kind'][] = ['stroke', 'wire', 'frame', 'box'];
const TOOL_BY_KEY: Readonly<Record<string, BoardTool>> = {
  v: 'select', 1: 'select', p: 'pen', 7: 'pen', e: 'eraser', 0: 'eraser', h: 'hand', s: 'note',
};
const NUDGE_UNITS = 1;
const SHIFTED_NUDGE_UNITS = 5;
export const NUDGE_DIRECTION_BY_KEY: Readonly<Record<string, ViewPoint>> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
const KEY_ZOOM_STEP = 1.25;
const ZOOM_FACTOR_BY_KEY: Readonly<Record<string, number>> = { '=': 1 / KEY_ZOOM_STEP, '+': 1 / KEY_ZOOM_STEP, '-': KEY_ZOOM_STEP, _: KEY_ZOOM_STEP };

type BoardTool = 'select' | 'hand' | 'note' | 'pen' | 'eraser';
type PlacementTool = Extract<BoardTool, 'note'>;

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

type ClipboardNotice = 'cut' | 'unreadable' | 'gathered stack';

interface BoardEditorOptions {
  viewport: HTMLElement;
  world: HTMLElement;
  svg: SVGSVGElement;
  canvas: HTMLElement;
  renderer: BoardRenderer;
  currentBoard: () => Board | null;
  repaint: () => void;
  sendOps: (ops: Op[]) => Promise<boolean>;
  sendOpsReportingVersion: (ops: Op[]) => Promise<{ isSent: boolean; version: number | null }>;
  onSelectionChange: (selectedIds: ReadonlySet<string>) => void;
  onPhoneTapBox: (boxId: string) => void;
  onOpenImage: (image: PressedImage) => void;
  onStackBoxes: (targetBoxId: string, droppedBoxId: string, targetStack: Frame | null) => void;
  onOpenStack: (frameId: string) => void;
  onGatherStack: (frameId: string) => void;
  onClickBox: (boxId: string) => void;
  isOpenedStack: (frameId: string) => boolean;
  onToolChange: (tool: BoardTool) => void;
  onToolLockChange: (isToolLocked: boolean) => void;
  onClipboardNotice: (notice: ClipboardNotice) => void;
  onContextMenu: (clientX: number, clientY: number, target: ContextMenuTarget) => void;
  onPresentChange: (isPresenting: boolean) => void;
  takesWheel: (wheel: BoardWheel) => boolean;
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
  carriedWires: Wire[];
  offset: ViewPoint;
  pinnedOffsetY: number;
  sendsInFlight: number;
  awaitedVersion: number | null;
}

type BoxFields = { place: { at: ViewPoint } };

type PanButton = 'primary' | 'auxiliary' | 'context';
type StackOrder = Extract<Op, { op: 'order' }>['to'];
type ContextMenuTarget = 'selection' | 'canvas';

function rectBetween(first: ViewPoint, second: ViewPoint): Rect {
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(first.x - second.x), height: Math.abs(first.y - second.y) };
}


type Gesture =
  | { kind: 'drag'; pointerId: number; boxId: string; origin: ViewPoint; start: Rect; movingBoxes: readonly MovingBox[]; pinnedOffsetY: number; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; pressedImage: PressedImage | null; preview: DragPreview | null; previewLayout: BoardLayout | null; laidOutOffset: ViewPoint; isDuplicating: boolean; snapTargets: SnapTargets | null }
  | { kind: 'pan'; pointerId: number; lastClient: ViewPoint; hasMoved: boolean; pressedButton: PanButton; tappedBoxId: string | null; pressedImage: PressedImage | null }
  | { kind: 'marquee'; pointerId: number; origin: ViewPoint; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; baseSelection: ReadonlySet<string>; outline: SVGRectElement; placementTool: PlacementTool | null }
  | { kind: 'pinch'; distance: number; viewWidth: number }
  | { kind: 'ink'; pointerId: number; points: ViewPoint[]; draftLine: SVGPolylineElement }
  | { kind: 'erase'; pointerId: number; latest: ViewPoint; erasedIds: Set<string>; trail: SVGPolylineElement; trailPoints: ViewPoint[] }
  | null;

export function newElementId(kind: BoardElement['kind']): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${kind}-${clock.nowMs().toString(36)}${entropy}`;
}

function isPhoneLayout(): boolean {
  return document.documentElement.dataset.layout === 'phone';
}

const PLACED_NOTE: Partial<Box> = { shape: 'note', tone: 'yellow' };

function isPlacementTool(tool: BoardTool): tool is PlacementTool {
  return tool === 'note';
}

function placedBox(at: ViewPoint, title: string, overrides: Partial<Box>): Box {
  return filledBox({ kind: 'box', id: newElementId('box'), title, place: { at }, ...overrides });
}

interface BoxSize {
  width: number;
  height: number;
}

const DUPLICATE_OFFSET = { x: 20, y: 20 };

function shiftedRectOf(rect: Rect, offset: ViewPoint): Rect {
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
}

function pressedImageOf(hit: BoardHit | null): PressedImage | null {
  if (hit?.part !== 'media' || !hit.media) return null;
  return { boxId: hit.id, href: hit.media.href, alt: hit.media.alt };
}

const INK_POINT_SPACING_PX = 2;
const ERASER_SAMPLE_SPACING_PX = 4;
const ERASER_TRAIL_POINTS = 24;
const CURSOR_BY_HIT_PART: Readonly<Record<BoardHit['part'], string>> = { body: 'pointer', media: 'zoom-in' };
const MIN_TITLE_EDITOR_WIDTH_PX = 160;

interface InlineEditor {
  elementId: string | null;
  node: HTMLElement;
  rectOf: () => Rect | null;
  minWidthPx: number;
  abort: AbortController;
}

function hoverCursorOf(hit: BoardHit | null): string {
  if (!hit) return '';
  if (hit.kind === 'box' && hit.part === 'body') return 'move';
  return CURSOR_BY_HIT_PART[hit.part];
}

const MAX_FIT_ZOOM = 2;
const CAMERA_GLIDE_MS = 450;
const STACK_ORDER_BY_KEY_CODE: Readonly<Record<string, { plain: StackOrder; withShift: StackOrder }>> = {
  BracketRight: { plain: 'forward', withShift: 'front' },
  BracketLeft: { plain: 'backward', withShift: 'back' },
};
const WHOLE_BOARD_ZOOM_OUT_MARGIN = 1.25;
const PRESENT_MAX_ZOOM = 8;
const PRESENT_MARGIN_RATIO = 0.06;
const PRESENT_STEP_BY_KEY: Readonly<Record<string, 1 | -1>> = { ArrowRight: 1, ArrowDown: 1, ' ': 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 };

function unitsPerPixelShowing(area: { width: number; height: number }, canvasWidth: number, canvasHeight: number): number {
  return Math.max(area.width / canvasWidth, area.height / Math.max(1, canvasHeight));
}

export function createBoardEditor(options: BoardEditorOptions) {
  const { viewport, world, svg, canvas, renderer } = options;
  renderer.setLinkResolver((selectedBoxIds) => {
    const board = options.currentBoard();
    return board ? linkedIdsOf(board.elements, selectedBoxIds) : { wireIds: [], boxIds: [] };
  });
  const activePointers = new Map<number, ViewPoint>();
  let selectedIds = new Set<string>();
  let lastPointerClient: ViewPoint | null = null;
  let guideLines: SVGLineElement[] = [];
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let gesture: Gesture = null;
  let inlineEditor: InlineEditor | null = null;
  let previewFrameId: number | null = null;
  let activeTool: BoardTool = 'select';
  let toolKeeping: 'until placed' | 'kept' = 'until placed';
  let spaceHeldTool: 'hand' | null = null;
  let nudgeRun: NudgeRun | null = null;
  let owedFit: { bounds: Rect; maxZoom: number } | null = null;
  let glideFrameId: number | null = null;
  let presentedBoxId: string | null = null;
  let presentedSlideRectById: ReadonlyMap<string, Rect> = new Map();
  let presentedSlideWires: SlideChain['wires'] = [];

  function setTool(tool: BoardTool): void {
    activeTool = tool;
    viewport.dataset.tool = tool;
    options.onToolChange(tool);
  }

  function setToolLocked(shouldLock: boolean): void {
    toolKeeping = shouldLock ? 'kept' : 'until placed';
    options.onToolLockChange(shouldLock);
  }

  function finishToolUse(): void {
    if (toolKeeping === 'until placed') setTool('select');
  }

  function applyCamera(): void {
    world.style.transform = `translate(${-camera.x * camera.scale}px, ${-camera.y * camera.scale}px) scale(${camera.scale})`;
    renderer.setCamera(camera);
    placeInlineEditor();
    forgetSnapTargets();
  }

  function forgetSnapTargets(): void {
    if (gesture?.kind === 'drag') gesture.snapTargets = null;
    if (gesture?.kind !== 'drag') paintGuides([]);
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
    const islandRects = [...canvas.querySelectorAll<HTMLElement>('.wb-island, [data-board-island]')].filter((island) => island.checkVisibility()).map((island) => island.getBoundingClientRect());
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
    fitArea(rectAround(selectedRects), MAX_FIT_ZOOM);
  }

  function fittedCameraOf(bounds: Rect, maxZoom: number): Camera | null {
    const canvasWidth = viewport.clientWidth;
    if (canvasWidth === 0 || viewport.clientHeight === 0) return null;
    const band = islandFreeBand();
    const unitsPerPixel = Math.max(1 / maxZoom, unitsPerPixelShowing(bounds, canvasWidth, band.heightPx));
    const fittedViewWidth = canvasWidth * unitsPerPixel;
    const boardCenterY = bounds.y + bounds.height / 2;
    const bandCenterPx = band.topPx + band.heightPx / 2;
    return {
      x: bounds.x - Math.max(0, fittedViewWidth - bounds.width) / 2,
      y: boardCenterY - bandCenterPx * unitsPerPixel,
      scale: 1 / unitsPerPixel,
    };
  }

  function fitArea(bounds: Rect, maxZoom: number): void {
    stopGlide();
    const fitted = fittedCameraOf(bounds, maxZoom);
    owedFit = fitted ? null : { bounds, maxZoom };
    camera = fitted ?? { x: bounds.x, y: bounds.y, scale: 1 };
    applyCamera();
  }

  function stopGlide(): void {
    if (glideFrameId !== null) cancelAnimationFrame(glideFrameId);
    glideFrameId = null;
  }

  function glideToArea(bounds: Rect): void {
    const target = fittedCameraOf(bounds, MAX_FIT_ZOOM);
    if (!target || prefersReducedMotion()) {
      fitArea(bounds, MAX_FIT_ZOOM);
      return;
    }
    glideToCamera(target);
  }

  function showCamera(keptCamera: Camera): void {
    stopGlide();
    owedFit = null;
    camera = keptCamera;
    applyCamera();
  }

  function glideToView(view: Rect): void {
    if (viewport.clientWidth === 0 || view.width <= 0) return;
    const target = { x: view.x, y: view.y, scale: viewport.clientWidth / view.width };
    if (!prefersReducedMotion()) {
      glideToCamera(target);
      return;
    }
    stopGlide();
    camera = target;
    applyCamera();
  }

  function glideToCamera(target: Camera): void {
    stopGlide();
    const halfWidthPx = viewport.clientWidth / 2;
    const halfHeightPx = viewport.clientHeight / 2;
    const centerOf = (view: Camera) => ({ x: view.x + halfWidthPx / view.scale, y: view.y + halfHeightPx / view.scale });
    const startCenter = centerOf(camera);
    const targetCenter = centerOf(target);
    const startScale = camera.scale;
    const startedAtMs = performance.now();
    const step = (nowMs: number) => {
      const progress = Math.min(1, (nowMs - startedAtMs) / CAMERA_GLIDE_MS);
      const eased = 1 - (1 - progress) ** 3;
      const scale = startScale * (target.scale / startScale) ** eased;
      const centerX = startCenter.x + (targetCenter.x - startCenter.x) * eased;
      const centerY = startCenter.y + (targetCenter.y - startCenter.y) * eased;
      camera = { x: centerX - halfWidthPx / scale, y: centerY - halfHeightPx / scale, scale };
      applyCamera();
      glideFrameId = progress < 1 ? requestAnimationFrame(step) : null;
    };
    glideFrameId = requestAnimationFrame(step);
  }

  function toViewPoint(clientX: number, clientY: number): ViewPoint {
    const viewportRect = viewport.getBoundingClientRect();
    return { x: camera.x + (clientX - viewportRect.left - viewport.clientLeft) / camera.scale, y: camera.y + (clientY - viewportRect.top - viewport.clientTop) / camera.scale };
  }

  function viewUnitsPerPixel(): number {
    return 1 / camera.scale;
  }

  function zoomAround(anchor: ViewPoint, factor: number): void {
    stopGlide();
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
    stopGlide();
    camera = { ...camera, x: camera.x - deltaX / camera.scale, y: camera.y - deltaY / camera.scale };
    applyCamera();
  }

  function setSelection(nextSelectedIds: Set<string>): void {
    selectedIds = new Set([...nextSelectedIds].filter((elementId) => !isCodemapOwnedId(elementId)));
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

  function draggedBoxFields(drag: Extract<Gesture, { kind: 'drag' }>): { boxId: string; fields: BoxFields }[] {
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
    const carriedWires = carriedWiresOf(board.elements.values(), selectedIds, new Set(movingBoxes.map((movingBox) => movingBox.boxId)));
    return { movingBoxes, strokeStartPointsById, carriedWires, offset: { x: 0, y: 0 }, pinnedOffsetY: renderer.layout()?.pinnedOffsetY ?? 0, sendsInFlight: 0, awaitedVersion: null };
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
    const wireOps = run.carriedWires.map((wire) => shiftedWireOpOf(wire, { x: Math.round(offset.x), y: Math.round(offset.y) }));
    const nudgeOps = [...boxOps, ...strokeOps, ...wireOps];
    if (nudgeOps.length === 0) return;
    run.sendsInFlight += 1;
    void options.sendOpsReportingVersion(nudgeOps).then(({ version }) => {
      if (version !== null) run.awaitedVersion = Math.max(run.awaitedVersion ?? version, version);
    }).finally(() => {
      run.sendsInFlight -= 1;
    });
  }

  function endSettledNudgeRun(paintedVersion: number): void {
    if (!nudgeRun || nudgeRun.sendsInFlight > 0) return;
    if (nudgeRun.awaitedVersion !== null && paintedVersion < nudgeRun.awaitedVersion) return;
    nudgeRun = null;
  }

  function openContextMenuAt(clientX: number, clientY: number): void {
    const hit = hitAt(clientX, clientY);
    if (!hit) setSelection(new Set());
    if (hit && !selectedIds.has(hit.id)) setSelection(new Set([hit.id]));
    options.onContextMenu(clientX, clientY, selectedIds.size > 0 ? 'selection' : 'canvas');
  }

  function openContextMenuFromKeyboard(): void {
    const selectedRects = [...selectedIds].flatMap((elementId) => renderer.boundsOf(elementId) ?? []);
    const viewportRect = viewport.getBoundingClientRect();
    const anchor = selectedRects.length > 0 ? toClientPoint(rectAround(selectedRects)) : { x: viewportRect.left + viewportRect.width / 2, y: viewportRect.top + viewportRect.height / 2 };
    options.onContextMenu(anchor.x, anchor.y, selectedIds.size > 0 ? 'selection' : 'canvas');
  }

  function toClientPoint(area: Rect): ViewPoint {
    const viewportRect = viewport.getBoundingClientRect();
    return { x: viewportRect.left + (area.x + area.width / 2 - camera.x) * camera.scale, y: viewportRect.top + (area.y + area.height / 2 - camera.y) * camera.scale };
  }

  function orderSelected(to: StackOrder): void {
    const boardElements = options.currentBoard()?.elements;
    const ids = boardElements ? [...boardElements.keys()].filter((elementId) => selectedIds.has(elementId)) : [];
    if (ids.length === 0) return;
    void options.sendOps([{ op: 'order', ids, to }]);
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
    if (!drag.hasMoved || !layout) return false;
    const offset = dragOffsetOf(drag);
    if (!drag.preview || drag.previewLayout !== layout) {
      const anchorBox = drag.movingBoxes.find((movingBox) => movingBox.boxId === drag.boxId) ?? drag.movingBoxes[0];
      const laidOutBox = layout.elements.find((element) => element.kind === 'box' && element.id === anchorBox?.boxId);
      const laidOutOffset = laidOutBox?.kind === 'box' && anchorBox ? { x: laidOutBox.x - anchorBox.start.x, y: laidOutBox.y - anchorBox.start.y } : null;
      drag.laidOutOffset = laidOutOffset ?? { x: 0, y: 0 };
      const movingBoxIds = new Set(drag.movingBoxes.map((movingBox) => movingBox.boxId));
      const carriedWireIds = new Set(carriedWiresOf(board.elements.values(), selectedIds, movingBoxIds).map((wire) => wire.id));
      drag.preview = createDragPreview(board, layout, movingBoxIds, carriedWireIds, drag.laidOutOffset);
      drag.previewLayout = layout;
    }
    renderer.paintElements(drag.preview(offset.x - drag.laidOutOffset.x, offset.y - drag.laidOutOffset.y));
    return true;
  }

  function paintPreview(): void {
    cancelPreviewFrame();
    const board = options.currentBoard();
    if (gesture?.kind !== 'drag' || !board) {
      options.repaint();
      return;
    }
    if (paintMovePreview(gesture, board)) return;
    options.repaint();
  }

  function repaintPreview(): void {
    const board = options.currentBoard();
    if (gesture?.kind !== 'drag' || !board) return;
    paintMovePreview(gesture, board);
  }

  function requestPreviewFrame(): void {
    if (previewFrameId !== null) return;
    previewFrameId = requestAnimationFrame(paintPreview);
  }

  function pruneSelection(board: Board | null): void {
    if (gesture?.kind === 'drag' && !board?.elements.get(gesture.boxId)) gesture = null;
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
    if (gesture?.kind === 'ink') gesture.draftLine.remove();
    if (gesture?.kind === 'erase') endErase(gesture, false);
    if (gesture?.kind === 'marquee') gesture.outline.remove();
    paintGuides([]);
    gesture = { kind: 'pinch', distance: pinchDistance(), viewWidth: viewWidth() };
  }

  function startButtonPan(event: PointerEvent): void {
    event.preventDefault();
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, pressedButton: event.button === BOARD_CONTEXT_MOUSE_BUTTON ? 'context' : 'auxiliary', tappedBoxId: null, pressedImage: null };
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

  function startErase(event: PointerEvent): void {
    const trail = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    trail.setAttribute('class', 'wb-eraser-trail');
    svg.append(trail);
    const origin = toViewPoint(event.clientX, event.clientY);
    gesture = { kind: 'erase', pointerId: event.pointerId, latest: origin, erasedIds: new Set(), trail, trailPoints: [] };
    eraseAlong(gesture, origin);
  }

  function eraseAlong(erase: Extract<Gesture, { kind: 'erase' }>, point: ViewPoint): void {
    const sampleSpacing = ERASER_SAMPLE_SPACING_PX * viewUnitsPerPixel();
    const sampleCount = Math.max(1, Math.ceil(Math.hypot(point.x - erase.latest.x, point.y - erase.latest.y) / sampleSpacing));
    const erasedBefore = erase.erasedIds.size;
    for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
      const progress = sampleIndex / sampleCount;
      const hit = renderer.hitTest({ x: erase.latest.x + (point.x - erase.latest.x) * progress, y: erase.latest.y + (point.y - erase.latest.y) * progress });
      if (hit) erase.erasedIds.add(hit.id);
    }
    erase.latest = point;
    erase.trailPoints = [...erase.trailPoints, point].slice(-ERASER_TRAIL_POINTS);
    erase.trail.setAttribute('points', erase.trailPoints.map((trailPoint) => `${trailPoint.x},${trailPoint.y}`).join(' '));
    if (erase.erasedIds.size !== erasedBefore) renderer.setSelection(erase.erasedIds);
  }

  function endErase(erase: Extract<Gesture, { kind: 'erase' }>, shouldRemove: boolean): void {
    erase.trail.remove();
    renderer.setSelection(selectedIds);
    const board = options.currentBoard();
    if (!shouldRemove || !board || erase.erasedIds.size === 0) return;
    const erased = [...erase.erasedIds].flatMap((elementId) => board.elements.get(elementId) ?? []);
    const ops: Op[] = REMOVAL_ORDER.flatMap((kind) => erased.filter((element) => element.kind === kind)).map((element) => ({ op: 'remove', id: element.id }));
    setSelection(new Set([...selectedIds].filter((elementId) => !erase.erasedIds.has(elementId))));
    void options.sendOps(ops);
  }

  function startMarquee(event: PointerEvent, placementTool: PlacementTool | null): void {
    const origin = toViewPoint(event.clientX, event.clientY);
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    outline.setAttribute('class', 'wb-wire-line wb-dashed wb-wire-draft');
    const isAdditive = event.shiftKey && placementTool === null;
    gesture = { kind: 'marquee', pointerId: event.pointerId, origin, latest: origin, hasMoved: false, isAdditive, baseSelection: isAdditive ? new Set(selectedIds) : new Set(), outline, placementTool };
  }

  function boxIdsMovedBy(board: Board, elementId: string): string[] {
    const element = board.elements.get(elementId);
    if (element?.kind === 'box') return [elementId];
    if (element?.kind !== 'frame') return [];
    return element.collapsed ? element.contains.slice(0, 1) : element.contains;
  }

  function stackTopped(boxId: string): Frame | undefined {
    const board = options.currentBoard();
    return board ? stacksByTopBoxIdOf(board).get(boxId) : undefined;
  }

  function movingBoxesFor(pressedId: string, isAdditive: boolean): MovingBox[] {
    const board = options.currentBoard();
    if (!board) return [];
    const draggedIds = isAdditive || !selectedIds.has(pressedId) ? [pressedId] : [...selectedIds];
    const movedBoxIds = new Set(draggedIds.flatMap((elementId) => boxIdsMovedBy(board, elementId)));
    return [...movedBoxIds].flatMap((boxId) => {
      const start = renderer.boundsOf(boxId);
      return start ? [{ boxId, start }] : [];
    });
  }

  function onPointerDown(event: PointerEvent): void {
    if (inlineEditor) return;
    if (event.pointerType === 'mouse' && BOARD_MOUSE_PAN_BUTTONS.includes(event.button) && !gesture) {
      startButtonPan(event);
      return;
    }
    if (event.button !== 0) return;
    if ((spaceHeldTool ?? activeTool) === 'hand' && !gesture) {
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
      startMarquee(event, activeTool);
      return;
    }
    if (activeTool === 'pen') {
      startInk(event);
      return;
    }
    if (activeTool === 'eraser') {
      startErase(event);
      return;
    }
    if (hit && isCodemapOwnedId(hit.id)) {
      gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, pressedButton: 'primary', tappedBoxId: hit.id, pressedImage: pressedImageOf(hit) };
      return;
    }
    const hitBoxRect = hit?.kind === 'box' ? renderer.boundsOf(hit.id) : null;
    const frameRect = hit?.kind === 'frame' ? renderer.boundsOf(hit.id) : null;
    const boxRect = isPhoneLayout() ? null : hitBoxRect ?? frameRect;
    if (hit && boxRect) {
      const origin = toViewPoint(event.clientX, event.clientY);
      const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
      gesture = { kind: 'drag', pointerId: event.pointerId, boxId: hit.id, origin, start: boxRect, movingBoxes: movingBoxesFor(hit.id, event.shiftKey), pinnedOffsetY, latest: origin, hasMoved: false, isAdditive: event.shiftKey, pressedImage: pressedImageOf(hit), preview: null, previewLayout: null, laidOutOffset: { x: 0, y: 0 }, isDuplicating: event.altKey, snapTargets: null };
      return;
    }
    if (hit && !isPhoneLayout()) {
      toggleSelected(hit.id, event.shiftKey);
      return;
    }
    if (!hit && event.pointerType === 'mouse' && !isPhoneLayout()) {
      startMarquee(event, null);
      return;
    }
    const tappedBoxId = hit?.kind === 'box' ? hit.id : null;
    const pan: Extract<Gesture, { kind: 'pan' }> = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, pressedButton: 'primary', tappedBoxId, pressedImage: pressedImageOf(hit) };
    gesture = pan;
    if (!tappedBoxId) return;
    const pressedAt = toViewPoint(event.clientX, event.clientY);
    window.setTimeout(() => liftBoxAfterHold(pan, tappedBoxId, pressedAt), BOX_LIFT_HOLD_MS);
  }

  function liftBoxAfterHold(pan: Extract<Gesture, { kind: 'pan' }>, boxId: string, pressedAt: ViewPoint): void {
    const boxRect = renderer.boundsOf(boxId);
    if (gesture !== pan || pan.hasMoved || !boxRect) return;
    setSelection(new Set([boxId]));
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    gesture = { kind: 'drag', pointerId: pan.pointerId, boxId, origin: pressedAt, start: boxRect, movingBoxes: movingBoxesFor(boxId, false), pinnedOffsetY, latest: pressedAt, hasMoved: false, isAdditive: false, pressedImage: null, preview: null, previewLayout: null, laidOutOffset: { x: 0, y: 0 }, isDuplicating: false, snapTargets: null };
    navigator.vibrate?.(10);
  }

  async function placeNote(point: ViewPoint, size: BoxSize | null): Promise<void> {
    finishToolUse();
    const board = options.currentBoard();
    if (!board) return;
    const originBoardId = board.id;
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const element = { ...placedBox({ x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) }, 'Note', PLACED_NOTE), ...(size ?? {}) };
    const fallbackRect: Rect = { x: point.x, y: point.y, width: size?.width ?? MIN_TITLE_EDITOR_WIDTH_PX, height: 32 };
    let addPhase: 'pending' | 'accepted' | 'refused' = 'pending';
    let queuedTitle: string | null = null;
    editTitle(element, fallbackRect, (title) => {
      if (options.currentBoard()?.id !== originBoardId) return;
      if (addPhase === 'pending') {
        queuedTitle = title;
        return;
      }
      if (addPhase !== 'accepted') return;
      void options.sendOps([{ op: 'set', id: element.id, fields: { title } }]);
    });
    const isSent = await options.sendOps([{ op: 'add', element }]);
    addPhase = isSent ? 'accepted' : 'refused';
    if (!isSent) {
      if (inlineEditor?.elementId === element.id) {
        closeInlineEditor();
        viewport.focus();
      }
      return;
    }
    if (options.currentBoard()?.id !== originBoardId) return;
    setSelection(new Set([element.id]));
    if (queuedTitle !== null) void options.sendOps([{ op: 'set', id: element.id, fields: { title: queuedTitle } }]);
  }

  async function placeMediaBox(title: string, media: BoxMedia, clientPoint: ViewPoint | null): Promise<boolean> {
    const board = options.currentBoard();
    if (!board) return false;
    const point = clientPoint ? toViewPoint(clientPoint.x, clientPoint.y) : { x: camera.x + viewWidth() / 2, y: camera.y + (viewport.clientHeight || 1) / camera.scale / 2 };
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const element = placedBox({ x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) }, title, { shape: 'box', media });
    const isSent = await options.sendOps([{ op: 'add', element }]);
    if (isSent) setSelection(new Set([element.id]));
    return isSent;
  }

  function clipboardOfIds(elementIds: ReadonlySet<string>): BoardClipboard | null {
    const board = options.currentBoard();
    if (!board) return null;
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    return copiedClipboardOf({
      elements: board.elements,
      selectedIds: elementIds,
      wireIdsOf: (boxId) => boardIndexOf(board.elements).dependentIdsByBoxId.get(boxId) ?? [],
      placedRectOf: (boxId) => {
        const rect = renderer.boundsOf(boxId) ?? renderer.boundsOf(stackTopIdOf(board, boxId) ?? boxId);
        return rect ? { x: rect.x, y: rect.y - pinnedOffsetY, width: rect.width, height: rect.height } : null;
      },
    });
  }

  function stackTopIdOf(board: Board, boxId: string): string | null {
    const stack = [...board.elements.valuesOfKind('frame')].find((frame) => frame.collapsed && frame.contains.includes(boxId));
    return stack?.contains[0] ?? null;
  }

  async function sendPasted(clipboard: BoardClipboard, offset: ViewPoint): Promise<boolean> {
    const { ops, pastedIds } = pastedOpsOf(clipboard, offset, newElementId);
    const isSent = await options.sendOps(ops);
    if (isSent) setSelection(new Set(pastedIds));
    return isSent;
  }

  async function duplicateBoxes(elementIds: readonly string[], offset: ViewPoint): Promise<void> {
    const clipboard = clipboardOfIds(new Set(elementIds));
    if (clipboard) await sendPasted(clipboard, offset);
  }

  function hasUnloadedStackCards(elementIds: ReadonlySet<string>): boolean {
    const board = options.currentBoard();
    return [...elementIds].some((elementId) => {
      const frame = board?.elements.get(elementId);
      return frame?.kind === 'frame' && frame.collapsed && frame.contains.some((boxId) => !board?.elements.get(boxId));
    });
  }

  function copyableClipboard(): BoardClipboard | null {
    if (!hasUnloadedStackCards(selectedIds)) return clipboardOfIds(selectedIds);
    options.onClipboardNotice('gathered stack');
    return null;
  }

  function copySelection(): string | null {
    const clipboard = copyableClipboard();
    return clipboard ? JSON.stringify(clipboard) : null;
  }

  function cutSelection(): string | null {
    const clipboard = copyableClipboard();
    if (!clipboard) return null;
    const removeOps: Op[] = REMOVAL_ORDER.flatMap((kind) => clipboard.elements.filter((element) => element.kind === kind))
      .map((element) => ({ op: 'remove', id: element.id }));
    setSelection(new Set());
    void options.sendOps(removeOps);
    return JSON.stringify(clipboard);
  }

  function duplicateSelection(): void {
    const clipboard = copyableClipboard();
    if (clipboard) void sendPasted(clipboard, DUPLICATE_OFFSET);
  }

  function pastePlaceOf(): ViewPoint {
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const point = lastPointerClient ? toViewPoint(lastPointerClient.x, lastPointerClient.y) : viewportCenter();
    return { x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) };
  }

  async function pasteText(text: string): Promise<boolean> {
    if (!options.currentBoard()) return false;
    const place = pastePlaceOf();
    const parsed = parsedClipboardOf(text);
    if (parsed.kind === 'board') return sendPasted(parsed.clipboard, centeringOffsetOf(parsed.clipboard, place));
    if (parsed.kind === 'unreadable') {
      options.onClipboardNotice('unreadable');
      return false;
    }
    const pasted = pastedTextOf(text);
    if (!pasted) return false;
    const element = { ...placedBox(place, pasted.title, pasted.isLink ? { shape: 'box' } : { shape: 'box', borderless: true }), lines: pasted.lines };
    const isSent = await options.sendOps([{ op: 'add', element }]);
    if (isSent) setSelection(new Set([element.id]));
    if (isSent && pasted.isCut) options.onClipboardNotice('cut');
    return isSent;
  }

  function snapTargetsFor(drag: Extract<Gesture, { kind: 'drag' }>): SnapTargets {
    const board = options.currentBoard();
    const movingIds = new Set(drag.movingBoxes.map((movingBox) => movingBox.boxId));
    const visibleArea = { x: camera.x, y: camera.y, width: viewWidth(), height: (viewport.clientHeight || 1) / camera.scale };
    const visibleRects = renderer.elementsInRect(visibleArea).flatMap((elementId) => {
      const isOtherBox = !movingIds.has(elementId) && board?.elements.get(elementId)?.kind === 'box';
      const rect = isOtherBox ? renderer.boundsOf(elementId) : null;
      return rect ? [rect] : [];
    });
    return snapTargetsOf(visibleRects);
  }

  function snappedLatestOf(drag: Extract<Gesture, { kind: 'drag' }>, event: PointerEvent): ViewPoint {
    const point = toViewPoint(event.clientX, event.clientY);
    const isSnapOff = event.ctrlKey || event.metaKey || drag.movingBoxes.length === 0;
    if (isSnapOff) {
      paintGuides([]);
      return point;
    }
    drag.snapTargets ??= snapTargetsFor(drag);
    const thresholdUnits = SNAP_THRESHOLD_PX * viewUnitsPerPixel();
    const offset = { x: point.x - drag.origin.x, y: point.y - drag.origin.y };
    const moved = shiftedRectOf(rectAround(drag.movingBoxes.map((movingBox) => movingBox.start)), offset);
    const snap = movedSnapOf(drag.snapTargets, moved, thresholdUnits);
    paintGuides(snap.guides);
    return { x: point.x + snap.correction.x, y: point.y + snap.correction.y };
  }

  function paintGuides(guides: readonly SnapGuide[]): void {
    for (const line of guideLines) line.remove();
    guideLines = guides.map((guide) => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'wb-snap-guide');
      const ends = guide.axis === 'x' ? [guide.at, guide.from, guide.at, guide.to] : [guide.from, guide.at, guide.to, guide.at];
      for (const [index, attribute] of ['x1', 'y1', 'x2', 'y2'].entries()) line.setAttribute(attribute, String(ends[index]));
      svg.append(line);
      return line;
    });
  }

  function moveDrag(drag: Extract<Gesture, { kind: 'drag' }>, event: PointerEvent): void {
    const rawPoint = toViewPoint(event.clientX, event.clientY);
    if (!drag.hasMoved && Math.hypot(rawPoint.x - drag.origin.x, rawPoint.y - drag.origin.y) < DRAG_THRESHOLD_PX * viewUnitsPerPixel()) return;
    drag.hasMoved = true;
    drag.latest = snappedLatestOf(drag, event);
    renderer.setWireTarget(stackTargetOf(drag));
    requestPreviewFrame();
  }

  function stackTargetOf(drag: Extract<Gesture, { kind: 'drag' }>): string | null {
    const isFrameDrag = drag.movingBoxes[0]?.boxId !== drag.boxId;
    if (drag.movingBoxes.length !== 1 || isFrameDrag || stackTopped(drag.boxId)) return null;
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
    if (marquee.placementTool) return;
    const nextSelectedIds = new Set([...marquee.baseSelection, ...renderer.elementsInRect(area)]);
    if (nextSelectedIds.size === selectedIds.size && [...nextSelectedIds].every((elementId) => selectedIds.has(elementId))) return;
    setSelection(nextSelectedIds);
  }

  function finishMarquee(marquee: Extract<Gesture, { kind: 'marquee' }>): void {
    marquee.outline.remove();
    if (marquee.placementTool) {
      finishPlacement(marquee);
      return;
    }
    if (marquee.hasMoved || marquee.isAdditive) return;
    setSelection(new Set());
  }

  function finishPlacement(marquee: Extract<Gesture, { kind: 'marquee' }>): void {
    if (!marquee.hasMoved) {
      void placeNote(marquee.origin, null);
      return;
    }
    const area = rectBetween(marquee.origin, marquee.latest);
    const width = Math.min(WHITEBOARD_LIMITS.boxWidthMax, Math.max(WHITEBOARD_LIMITS.boxWidthMin, Math.round(area.width)));
    const height = Math.min(WHITEBOARD_LIMITS.boxHeightMax, Math.max(1, Math.round(area.height)));
    void placeNote({ x: area.x, y: area.y }, { width, height });
  }

  function cancelGesture(): boolean {
    const cancelled = gesture;
    if (!cancelled || cancelled.kind === 'pinch') return false;
    gesture = null;
    activePointers.delete(cancelled.pointerId);
    if (cancelled.kind === 'marquee') cancelled.outline.remove();
    if (cancelled.kind === 'ink') cancelled.draftLine.remove();
    if (cancelled.kind === 'erase') endErase(cancelled, false);
    if (cancelled.kind !== 'drag') return true;
    paintGuides([]);
    cancelPreviewFrame();
    renderer.setWireTarget(null);
    paintPreview();
    return true;
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
    viewport.style.cursor = (spaceHeldTool ?? activeTool) === 'select' ? hoverCursorOf(hit) : '';
  }

  function onPointerMove(event: PointerEvent): void {
    lastPointerClient = { x: event.clientX, y: event.clientY };
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
    if (gesture?.kind === 'marquee' && gesture.pointerId === event.pointerId) {
      moveMarquee(gesture, event);
      return;
    }
    if (gesture?.kind === 'ink' && gesture.pointerId === event.pointerId) {
      moveInk(gesture, event);
      return;
    }
    if (gesture?.kind === 'erase' && gesture.pointerId === event.pointerId) {
      eraseAlong(gesture, toViewPoint(event.clientX, event.clientY));
      return;
    }
    if (gesture?.kind === 'pan' && gesture.pointerId === event.pointerId) movePan(gesture, event);
  }

  async function finishDrag(drag: Extract<Gesture, { kind: 'drag' }>, event: PointerEvent): Promise<void> {
    if (!drag.hasMoved && isPhoneLayout()) return;
    if (!drag.hasMoved) {
      finishClick(drag);
      return;
    }
    cancelPreviewFrame();
    drag.latest = snappedLatestOf(drag, event);
    paintGuides([]);
    renderer.setWireTarget(null);
    if (drag.isDuplicating) {
      paintPreview();
      await duplicateBoxes(drag.movingBoxes.map((movingBox) => movingBox.boxId), dragOffsetOf(drag));
      return;
    }
    const stackTargetId = stackTargetOf(drag);
    if (stackTargetId) {
      paintPreview();
      options.onStackBoxes(stackTargetId, drag.boxId, stackTopped(stackTargetId) ?? null);
      return;
    }
    const changes = draggedBoxFields(drag);
    const board = options.currentBoard();
    if (board) paintMovePreview(drag, board);
    const boxMoveOps = changes.map(({ boxId, fields }): Op => ({ op: 'set', id: boxId, fields }));
    const carriedWires = board ? carriedWiresOf(board.elements.values(), selectedIds, new Set(drag.movingBoxes.map((movingBox) => movingBox.boxId))) : [];
    const moveOps = [...boxMoveOps, ...carriedWires.map((wire) => shiftedWireOpOf(wire, dragOffsetOf(drag)))];
    const departureOps = board ? frameDepartureOps(drag, board) : [];
    const isSent = await options.sendOps([...moveOps, ...departureOps]) || (departureOps.length > 0 && await options.sendOps(moveOps));
    if (!isSent) paintPreview();
  }

  function frameDepartureOps(drag: Extract<Gesture, { kind: 'drag' }>, board: Board): Op[] {
    const layout = renderer.layout();
    if (!layout) return [];
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

  function clickCodemapCard(elementId: string): void {
    const board = options.currentBoard();
    if (!board) return;
    const frames = [...board.elements.valuesOfKind('frame')];
    const frameTopIds = new Set(frames.map((frame) => frame.contains[0]));
    const openFramesLeft = frames.filter((frame) => !frame.collapsed && !frame.contains.includes(elementId)).map((frame) => frame.id);
    for (const frameId of openFramesLeft) if (options.isOpenedStack(frameId)) options.onGatherStack(frameId);
    const stack = stackTopped(elementId);
    if (stack) {
      options.onOpenStack(stack.id);
      return;
    }
    const openAreaTopped = frames.find((frame) => !frame.collapsed && frame.contains[0] === elementId && frame.contains.slice(1).some((boxId) => frameTopIds.has(boxId)));
    if (openAreaTopped) {
      options.onGatherStack(openAreaTopped.id);
      return;
    }
    if (board.elements.get(elementId)?.kind !== 'box') return;
    options.onClickBox(elementId);
  }

  function finishClick(drag: Extract<Gesture, { kind: 'drag' }>): void {
    toggleSelected(drag.boxId, drag.isAdditive);
    const stack = drag.isAdditive ? undefined : stackTopped(drag.boxId);
    if (stack) {
      options.onOpenStack(stack.id);
      return;
    }
    if (drag.isAdditive) return;
    if (drag.pressedImage) {
      options.onOpenImage(drag.pressedImage);
      return;
    }
    options.onClickBox(drag.boxId);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!activePointers.delete(event.pointerId)) return;
    const finished = gesture;
    if (finished?.kind === 'pinch') {
      gesture = null;
      return;
    }
    gesture = null;
    paintGuides([]);
    if (finished?.kind === 'drag' && finished.pointerId === event.pointerId) {
      void finishDrag(finished, event);
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
    if (finished?.kind === 'erase') {
      endErase(finished, finished.pointerId === event.pointerId);
      return;
    }
    if (finished?.kind === 'pan' && finished.pressedButton === 'context' && !finished.hasMoved) {
      openContextMenuAt(event.clientX, event.clientY);
      return;
    }
    if (finished?.kind !== 'pan' || finished.hasMoved || finished.pressedButton !== 'primary') return;
    if (finished.tappedBoxId && isCodemapOwnedId(finished.tappedBoxId) && finished.pressedImage) {
      options.onOpenImage(finished.pressedImage);
      return;
    }
    if (finished.tappedBoxId && isCodemapOwnedId(finished.tappedBoxId)) {
      clickCodemapCard(finished.tappedBoxId);
      return;
    }
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
    if (gesture?.kind === 'marquee') gesture.outline.remove();
    if (gesture?.kind === 'ink') gesture.draftLine.remove();
    if (gesture?.kind === 'erase') endErase(gesture, false);
    gesture = null;
    paintGuides([]);
    if (!wasDragging) return;
    renderer.setWireTarget(null);
    paintPreview();
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAround(toViewPoint(event.clientX, event.clientY), wheelViewWidthFactor(event.deltaY, event.deltaMode, WHEEL_ZOOM_STEP));
      return;
    }
    const hit = hitAt(event.clientX, event.clientY);
    const isTakenByPage = options.takesWheel({
      atMs: event.timeStamp,
      boxIdUnderPointer: hit?.kind === 'box' ? hit.id : null,
      boardPoint: toViewPoint(event.clientX, event.clientY),
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      screenPixelsPerBoardUnit: camera.scale,
    });
    if (isTakenByPage) return;
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
    openEditor?.abort.abort();
    openEditor?.node.remove();
  }

  function openInlineEditor(node: HTMLElement, rectOf: () => Rect | null, minWidthPx: number, elementId: string | null = null): AbortSignal {
    closeInlineEditor();
    const abort = new AbortController();
    inlineEditor = { elementId, node, rectOf, minWidthPx, abort };
    canvas.append(node);
    placeInlineEditor();
    return abort.signal;
  }

  function editTitle(titled: Box, fallbackRect: Rect | null, onCommit: (title: string) => void): void {
    if (titled.shape !== 'note') return;
    const elementId = titled.id;
    const initialTitle = titled.title;
    const input = markAsNotCredential(el('input', 'wb-title-input'));
    input.type = 'text';
    input.value = initialTitle;
    input.maxLength = WHITEBOARD_LIMITS.title;
    input.setAttribute('aria-label', 'Box title');
    const signal = openInlineEditor(input, () => renderer.boxTextRectsOf(elementId)?.title ?? fallbackRect, MIN_TITLE_EDITOR_WIDTH_PX, elementId);
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
      if (!title || title === initialTitle) return;
      onCommit(title);
    }, { signal });
    input.addEventListener('blur', closeInlineEditor, { signal });
    input.focus();
    input.select();
  }

  function afterBoardPaint(paintedVersion: number): void {
    endSettledNudgeRun(paintedVersion);
    forgetSnapTargets();
    placeInlineEditor();
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
    const stackOrder = STACK_ORDER_BY_KEY_CODE[event.code];
    if (stackOrder) return () => orderSelected(event.shiftKey ? stackOrder.withShift : stackOrder.plain);
    const key = event.key.toLowerCase();
    if (key === 'a') return selectAll;
    if (key === 'd') return duplicateSelection;
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
      if (cancelGesture()) return;
      setSelection(new Set());
      setTool('select');
    };
    if (event.shiftKey) return shiftedKeyAction(event);
    if (event.key === ' ') return () => holdSpace(true);
    const key = event.key.toLowerCase();
    if (key === 'q') return () => setToolLocked(toolKeeping === 'until placed');
    const tool = TOOL_BY_KEY[key];
    return tool ? () => setTool(tool) : null;
  }

  function holdSpace(isHeld: boolean): void {
    spaceHeldTool = isHeld ? 'hand' : null;
    viewport.dataset.spacePan = String(isHeld);
    if (isHeld) viewport.style.cursor = '';
  }

  function slideBoundsOf(boxId: string): Rect | null {
    const startRect = presentedSlideRectById.get(boxId);
    if (!startRect) return null;
    return renderer.boundsOf(boxId) ?? startRect;
  }

  function isFullBleedSlide(boxId: string): boolean {
    const element = options.currentBoard()?.elements.get(boxId);
    return element?.kind === 'box' && isFullBleedBox(element);
  }

  function viewCoveringCropOf(bounds: Rect): Rect {
    const viewAspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
    const width = Math.min(bounds.width, bounds.height * viewAspect);
    const height = Math.min(bounds.height, bounds.width / viewAspect);
    return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height };
  }

  function showPresentedBox(): void {
    const bounds = presentedBoxId ? slideBoundsOf(presentedBoxId) : null;
    if (!bounds || !presentedBoxId) return;
    if (isFullBleedSlide(presentedBoxId)) {
      fitArea(viewCoveringCropOf(bounds), PRESENT_MAX_ZOOM);
      return;
    }
    const marginUnits = Math.max(bounds.width, bounds.height) * PRESENT_MARGIN_RATIO;
    fitArea({ x: bounds.x - marginUnits, y: bounds.y - marginUnits, width: bounds.width + marginUnits * 2, height: bounds.height + marginUnits * 2 }, PRESENT_MAX_ZOOM);
  }

  function startPresenting(slides: SlideChain): boolean {
    presentedSlideRectById = new Map(slides.boxes.map((box) => [box.id, box.rect]));
    presentedSlideWires = slides.wires;
    const [onlySelectedId, ...otherSelectedIds] = selectedIds;
    const selectedStartId = onlySelectedId && otherSelectedIds.length === 0 && slideBoundsOf(onlySelectedId) ? onlySelectedId : null;
    const startBoxId = selectedStartId ?? firstPresentedBoxId(presentedSlideWires, slideBoundsOf);
    if (!startBoxId) return false;
    closeInlineEditor();
    setSelection(new Set());
    presentedBoxId = startBoxId;
    options.onPresentChange(true);
    viewport.focus();
    showPresentedBox();
    return true;
  }

  function stepPresenting(step: 1 | -1): void {
    if (!presentedBoxId) return;
    const nextBoxId = presentedBoxIdAfter(presentedBoxId, step, presentedSlideWires, slideBoundsOf);
    if (!nextBoxId) return;
    presentedBoxId = nextBoxId;
    showPresentedBox();
  }

  function endPresenting(): void {
    if (!presentedBoxId) return;
    presentedBoxId = null;
    options.onPresentChange(false);
  }

  function presentKeyAction(event: KeyboardEvent): (() => void) | null {
    if (event.key === 'Escape') return endPresenting;
    const step = PRESENT_STEP_BY_KEY[event.key];
    return step ? () => stepPresenting(step) : null;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== viewport || event.altKey) return;
    if (presentedBoxId) {
      const presentAction = presentKeyAction(event);
      if (!presentAction) return;
      event.preventDefault();
      presentAction();
      return;
    }
    const isCommandChord = event.metaKey || event.ctrlKey;
    const action = isCommandChord ? commandKeyAction(event) : plainKeyAction(event);
    if (!action) return;
    event.preventDefault();
    if (isCommandChord) event.stopPropagation();
    if (event.repeat && event.key === ' ') return;
    action();
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === ' ') holdSpace(false);
  }

  let cancelAuxClickSuppression: (() => void) | null = null;

  function armAuxiliaryClickSuppression(): void {
    cancelAuxClickSuppression?.();
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    const clearSuppression = () => {
      window.removeEventListener('auxclick', stopAuxiliaryClick, true);
      window.removeEventListener('paste', stopAuxiliaryPaste, true);
      window.removeEventListener('pointerup', scheduleCleanup, true);
      window.removeEventListener('mouseup', scheduleCleanup, true);
      window.removeEventListener('pointercancel', clearSuppression, true);
      window.removeEventListener('blur', clearSuppression);
      if (cleanupTimer !== null) clearTimeout(cleanupTimer);
      cleanupTimer = null;
      if (cancelAuxClickSuppression === clearSuppression) cancelAuxClickSuppression = null;
    };
    const stopAuxiliaryClick = (event: MouseEvent) => {
      if (event.button !== BOARD_MIDDLE_MOUSE_BUTTON) return;
      event.preventDefault();
    };
    const stopAuxiliaryPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const scheduleCleanup = (event: MouseEvent) => {
      if (event.button !== BOARD_MIDDLE_MOUSE_BUTTON || cleanupTimer !== null) return;
      cleanupTimer = setTimeout(clearSuppression, 0);
    };
    window.addEventListener('auxclick', stopAuxiliaryClick, true);
    window.addEventListener('paste', stopAuxiliaryPaste, true);
    window.addEventListener('pointerup', scheduleCleanup, true);
    window.addEventListener('mouseup', scheduleCleanup, true);
    window.addEventListener('pointercancel', clearSuppression, true);
    window.addEventListener('blur', clearSuppression);
    cancelAuxClickSuppression = clearSuppression;
  }

  function armOnAuxiliaryPointerDown(event: PointerEvent): void {
    if (event.button !== BOARD_MIDDLE_MOUSE_BUTTON) return;
    armAuxiliaryClickSuppression();
  }

  function preventAuxiliaryMouseDown(event: MouseEvent): void {
    if (event.button !== BOARD_MIDDLE_MOUSE_BUTTON) return;
    event.preventDefault();
    armAuxiliaryClickSuppression();
  }

  function preventAuxiliaryClick(event: MouseEvent): void {
    if (event.button !== BOARD_MIDDLE_MOUSE_BUTTON) return;
    event.preventDefault();
  }

  world.style.transition = 'none';
  viewport.tabIndex = 0;
  viewport.addEventListener('pointerdown', armOnAuxiliaryPointerDown);
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerCancel);
  viewport.addEventListener('mousedown', preventAuxiliaryMouseDown);
  viewport.addEventListener('auxclick', preventAuxiliaryClick);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (gesture || event.button === BOARD_CONTEXT_MOUSE_BUTTON || isPhoneLayout()) return;
    openContextMenuFromKeyboard();
  });
  viewport.addEventListener('keydown', onKeyDown);
  viewport.addEventListener('keyup', onKeyUp);
  viewport.addEventListener('blur', () => holdSpace(false));
  viewport.addEventListener('pointerleave', () => {
    lastPointerClient = null;
    if (gesture) return;
    renderer.setHover(null);
    viewport.dataset.hoverKind = '';
  });
  new ResizeObserver(() => {
    if (presentedBoxId) return showPresentedBox();
    if (owedFit && viewport.clientWidth > 0 && viewport.clientHeight > 0) fitArea(owedFit.bounds, owedFit.maxZoom);
  }).observe(viewport);

  return {
    fit,
    frameArea: glideToArea,
    glideToView,
    showCamera,
    startPresenting,
    endPresenting,
    selectedIds: (): ReadonlySet<string> => selectedIds,
    clearSelection: () => setSelection(new Set()),
    pruneSelection,
    repaintPreview,
    closeInlineEditor,
    setTool,
    toggleToolLock: () => setToolLocked(toolKeeping === 'until placed'),
    placeMediaBox,
    afterBoardPaint,
    focusCanvas: () => viewport.focus(),
    removeSelected,
    selectAll,
    duplicateSelection,
    orderSelected,
    copySelection,
    cutSelection,
    pasteText,
    isCanvasFocused: () => document.activeElement === viewport,
    zoomAroundClientPoint: (clientX: number, clientY: number, viewWidthFactor: number) => zoomAround(toViewPoint(clientX, clientY), viewWidthFactor),
    panByPixels,
  };
}

export type BoardEditor = ReturnType<typeof createBoardEditor>;
export type { BoardTool };
