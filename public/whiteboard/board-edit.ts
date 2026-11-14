import { filledBox, LINE_STYLES, WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { Board, Element as BoardElement, Box, BoxLine, BoxMedia, Frame, Op } from '#shared/contracts/whiteboard.ts';
import { PLACED_DEVICE } from '#shared/whiteboard-devices.ts';
import { PLACED_ICON } from '#shared/whiteboard-icons.ts';
import { SHAPE_TRAITS } from '#shared/whiteboard-shapes.ts';
import { BODY_LINE_HEIGHT } from '#shared/whiteboard-svg-core.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { buildMenuItem, wirePopupMenuKeys } from '../menu.ts';
import { menuButton } from '../ui/button.ts';
import { CLOSED_LINE_EDIT, EMPTY_LINE, isSameLines, LINE_STYLE_LABELS, lineWithStyle, linesAfter, nextLineEdit } from './board-line-edit.ts';
import type { LineEditEvent, LineEditState, LineOp } from './board-line-edit.ts';
import { createDragPreview, handleSidesOf, isInStepBand, layoutBoard, movedBox, pinnedOffsetYAfterLeaving, resizedRectOf, scaledRectWithin } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, DragPreview, LaidOutElement, Rect, ResizeHandle, ResizeStretch } from '#shared/whiteboard-layout-core.ts';
import type { BoardHit, BoardRenderer, Camera } from './board-gl-renderer.ts';
import { elementTableOf } from '#shared/whiteboard-element-table.ts';
import { clock } from '#shared/clock.ts';
import { boardIndexOf } from '#shared/whiteboard-board-index.ts';
import { centeringOffsetOf, copiedClipboardOf, parsedClipboardOf, pastedOpsOf, pastedTextOf } from './board-clipboard-core.ts';
import type { BoardClipboard } from './board-clipboard-core.ts';
import { rectAround, snappedCorrectionOf, snapTargetsOf } from './board-snap-core.ts';
import type { SnapGuide, SnapTargets } from './board-snap-core.ts';
import { alignedRectsOf, distributedRectsOf } from './board-context-menu.ts';
import type { AlignEdge, ArrangedRect, DistributeAxis } from './board-context-menu.ts';

const DRAG_THRESHOLD_PX = 4;
const SNAP_THRESHOLD_PX = 8;
const MIN_VIEW_WIDTH = 200;
const MAX_VIEW_WIDTH = 20000;
export const WHEEL_ZOOM_STEP = 1.1;
const REMOVAL_ORDER: readonly BoardElement['kind'][] = ['stroke', 'wire', 'frame', 'box'];
const TOOL_BY_KEY: Readonly<Record<string, BoardTool>> = {
  v: 'select', 1: 'select', r: 'box', 2: 'box', d: 'decision', 3: 'decision', a: 'wire', 5: 'wire', o: 'ellipse', 4: 'ellipse', p: 'pen', 7: 'pen', t: 'text', 8: 'text', e: 'eraser', 0: 'eraser',
  h: 'hand', s: 'note', i: 'icon', m: 'device',
};
const NUDGE_UNITS = 1;
const SHIFTED_NUDGE_UNITS = 5;
const NUDGE_DIRECTION_BY_KEY: Readonly<Record<string, ViewPoint>> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
const KEY_ZOOM_STEP = 1.25;
const ZOOM_FACTOR_BY_KEY: Readonly<Record<string, number>> = { '=': 1 / KEY_ZOOM_STEP, '+': 1 / KEY_ZOOM_STEP, '-': KEY_ZOOM_STEP, _: KEY_ZOOM_STEP };

type BoardTool = 'select' | 'hand' | 'box' | 'decision' | 'ellipse' | 'note' | 'text' | 'icon' | 'device' | 'wire' | 'pen' | 'eraser';
type PlacementTool = Extract<BoardTool, 'box' | 'decision' | 'ellipse' | 'note' | 'text' | 'icon' | 'device'>;
const NON_PLACEMENT_TOOLS: ReadonlySet<BoardTool> = new Set(['select', 'hand', 'wire', 'pen', 'eraser']);

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
  onSelectionChange: (selectedIds: ReadonlySet<string>) => void;
  onPhoneTapBox: (boxId: string) => void;
  onOpenImage: (image: PressedImage) => void;
  onConnectBoxes: (fromBoxId: string, toBoxId: string) => void;
  onStackBoxes: (targetBoxId: string, droppedBoxId: string, targetStack: Frame | null) => void;
  onOpenStack: (frameId: string) => void;
  isOpenedStack: (frameId: string) => boolean;
  onToolChange: (tool: BoardTool) => void;
  onToolLockChange: (isToolLocked: boolean) => void;
  onClipboardNotice: (notice: ClipboardNotice) => void;
  onContextMenu: (clientX: number, clientY: number, target: ContextMenuTarget) => void;
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

const CONTEXT_MENU_BUTTON = 2;
const MOUSE_PAN_BUTTONS: ReadonlySet<number> = new Set([1, CONTEXT_MENU_BUTTON]);

type PanButton = 'primary' | 'auxiliary' | 'context';
type StackOrder = Extract<Op, { op: 'order' }>['to'];
type ContextMenuTarget = 'selection' | 'canvas';

function rectBetween(first: ViewPoint, second: ViewPoint): Rect {
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(first.x - second.x), height: Math.abs(first.y - second.y) };
}


type Gesture =
  | { kind: 'drag'; mode: 'move' | 'resize'; pointerId: number; boxId: string; origin: ViewPoint; start: Rect; movingBoxes: readonly MovingBox[]; pinnedOffsetY: number; latest: ViewPoint; hasMoved: boolean; isAdditive: boolean; pressedImage: PressedImage | null; preview: DragPreview | null; previewLayout: BoardLayout | null; laidOutOffset: ViewPoint; isDuplicating: boolean; snapTargets: SnapTargets | null; resize: { handle: ResizeHandle; keepsRatio: boolean } | null }
  | { kind: 'wire'; pointerId: number; fromBoxId: string; start: ViewPoint; draftLine: SVGPathElement; targetBoxId: string | null }
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

function isPlacementTool(tool: BoardTool): tool is PlacementTool {
  return !NON_PLACEMENT_TOOLS.has(tool);
}

const PLACED_TITLE_BY_TOOL: Readonly<Record<PlacementTool, string>> = { box: 'Box', decision: 'Decision', ellipse: 'Ellipse', note: 'Note', text: 'Text', icon: 'Icon', device: 'Device' };

function placedShapeOf(tool: PlacementTool, media: BoxMedia | null): Partial<Box> {
  switch (tool) {
    case 'icon': return { shape: 'icon', icon: PLACED_ICON };
    case 'device': return { shape: 'device', device: PLACED_DEVICE, media };
    case 'note': return { shape: 'note', tone: 'yellow', media };
    case 'text': return { shape: 'box', borderless: true };
    case 'decision': return { shape: 'decision', media };
    case 'ellipse': return { shape: 'ellipse', media };
    case 'box': return { shape: 'box', media };
  }
}

function placedBox(at: ViewPoint, title: string, media: BoxMedia | null, tool: PlacementTool): Box {
  return filledBox({ kind: 'box', id: newElementId('box'), title, place: { at }, ...placedShapeOf(tool, media) });
}

interface BoxSize {
  width: number;
  height: number;
}

const DUPLICATE_OFFSET = { x: 20, y: 20 };

function shiftedRectOf(rect: Rect, offset: ViewPoint): Rect {
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
}

interface ResizedBox {
  boxId: string;
  start: Rect;
  rect: Rect;
  changesHeight: boolean;
}

function clampedSize(size: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, size));
}

function clampedBoxRect(rect: Rect, side: { x: -1 | 0 | 1; y: -1 | 0 | 1 }): Rect {
  const width = clampedSize(rect.width, WHITEBOARD_LIMITS.boxWidthMin, WHITEBOARD_LIMITS.boxWidthMax);
  const height = clampedSize(rect.height, 1, WHITEBOARD_LIMITS.boxHeightMax);
  const keptStart = (start: number, size: number, clamped: number, sideSign: -1 | 0 | 1) => (sideSign === -1 ? start + size - clamped : sideSign === 0 ? start + (size - clamped) / 2 : start);
  return { x: keptStart(rect.x, rect.width, width, side.x), y: keptStart(rect.y, rect.height, height, side.y), width, height };
}

const BLANK_TEXT_LINE: BoxLine = { text: '', muted: false, style: 'text', key: null };

function isTextBox(box: Box): boolean {
  return box.shape === 'box' && box.borderless === true && !box.media;
}

function typedRowsOf(typedText: string): string[] {
  const rows = typedText.replace(/\s+$/, '').split('\n');
  const firstWrittenRow = rows.findIndex((row) => row.trim() !== '');
  return firstWrittenRow === -1 ? [] : rows.slice(firstWrittenRow);
}

function fittedTextOf(typedText: string): string {
  const rows = typedText.split('\n').slice(0, WHITEBOARD_LIMITS.linesPerBox + 1);
  return rows.map((row, index) => row.slice(0, index === 0 ? WHITEBOARD_LIMITS.title : WHITEBOARD_LIMITS.line)).join('\n');
}

function textEditOps(openedBox: Box, liveBox: Box, typedText: string): Op[] {
  const [titleRow, ...lineRows] = typedRowsOf(typedText);
  const title = titleRow?.trim();
  if (!title) return [{ op: 'remove', id: openedBox.id }];
  const isLinesEdited = lineRows.length !== openedBox.lines.length || lineRows.some((row, index) => row !== openedBox.lines[index]?.text);
  const lines = lineRows.map((row, index) => ({ ...(liveBox.lines[index] ?? BLANK_TEXT_LINE), text: row }));
  const fields = { ...(title === openedBox.title ? {} : { title }), ...(isLinesEdited ? { lines } : {}) };
  return Object.keys(fields).length === 0 ? [] : [{ op: 'set', id: openedBox.id, fields }];
}

function pressedImageOf(hit: BoardHit | null): PressedImage | null {
  if (hit?.part !== 'media' || !hit.media) return null;
  return { boxId: hit.id, href: hit.media.href, alt: hit.media.alt };
}

const VERTICAL_RESIZE_THRESHOLD_PX = 4;
const INK_POINT_SPACING_PX = 2;
const ERASER_SAMPLE_SPACING_PX = 4;
const ERASER_TRAIL_POINTS = 24;
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

const CURSOR_BY_RESIZE_HANDLE: Readonly<Record<ResizeHandle, string>> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function hoverCursorOf(hit: BoardHit | null): string {
  if (!hit) return '';
  if (hit.handle) return CURSOR_BY_RESIZE_HANDLE[hit.handle];
  if (hit.kind === 'box' && MOVABLE_BOX_PARTS.has(hit.part)) return 'move';
  return CURSOR_BY_HIT_PART[hit.part];
}

const MAX_FIT_ZOOM = 2;
const STACK_ORDER_BY_KEY_CODE: Readonly<Record<string, { plain: StackOrder; withShift: StackOrder }>> = {
  BracketRight: { plain: 'forward', withShift: 'front' },
  BracketLeft: { plain: 'backward', withShift: 'back' },
};
const WHOLE_BOARD_ZOOM_OUT_MARGIN = 1.25;

function unitsPerPixelShowing(area: { width: number; height: number }, canvasWidth: number, canvasHeight: number): number {
  return Math.max(area.width / canvasWidth, area.height / Math.max(1, canvasHeight));
}

export function createBoardEditor(options: BoardEditorOptions) {
  const { viewport, world, svg, canvas, renderer } = options;
  const activePointers = new Map<number, ViewPoint>();
  let selectedIds = new Set<string>();
  let lastPointerClient: ViewPoint | null = null;
  let guideLines: SVGLineElement[] = [];
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let gesture: Gesture = null;
  let inlineEditor: InlineEditor | null = null;
  let lineEdit: LineEditState = CLOSED_LINE_EDIT;
  let unconfirmedLines: UnconfirmedLines | null = null;
  let linesUnderLineEdit: readonly BoxLine[] | null = null;
  let previewFrameId: number | null = null;
  let activeTool: BoardTool = 'select';
  let toolKeeping: 'until placed' | 'kept' = 'until placed';
  let spaceHeldTool: 'hand' | null = null;
  let nudgeRun: NudgeRun | null = null;
  let pendingTitleEditId: string | null = null;
  let isFitOwedOnceSized = false;

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
    fitArea(rectAround(selectedRects), MAX_FIT_ZOOM);
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

  function resizeStretchOf(drag: Extract<Gesture, { kind: 'drag' }>, latest: ViewPoint): ResizeStretch | null {
    if (!drag.resize) return null;
    const offset = { x: latest.x - drag.origin.x, y: latest.y - drag.origin.y };
    const side = handleSidesOf(drag.resize.handle);
    const isPastVerticalThreshold = Math.abs(offset.y) >= VERTICAL_RESIZE_THRESHOLD_PX * viewUnitsPerPixel();
    const changesHeight = drag.resize.keepsRatio || (side.y !== 0 && (side.x === 0 || isPastVerticalThreshold));
    return { handle: drag.resize.handle, offset, keepsRatio: drag.resize.keepsRatio, changesHeight };
  }

  function resizedBoxesOf(drag: Extract<Gesture, { kind: 'drag' }>): ResizedBox[] {
    const stretch = resizeStretchOf(drag, drag.latest);
    if (!stretch) return [];
    const target = resizedRectOf(drag.start, stretch);
    const side = handleSidesOf(stretch.handle);
    return drag.movingBoxes.map((movingBox) => {
      const stretched = drag.movingBoxes.length === 1 ? target : scaledRectWithin(movingBox.start, drag.start, target);
      return { boxId: movingBox.boxId, start: movingBox.start, rect: clampedBoxRect(stretched, side), changesHeight: stretch.changesHeight };
    });
  }

  function resizedBoxFields(drag: Extract<Gesture, { kind: 'drag' }>): { boxId: string; fields: BoxFields }[] {
    const board = options.currentBoard();
    const resizedBoxes = resizedBoxesOf(drag);
    const shiftedBoxes = resizedBoxes.filter(({ start, rect }) => Math.round(rect.x) !== Math.round(start.x) || Math.round(rect.y) !== Math.round(start.y));
    const leavingBand = shiftedBoxes.filter(({ boxId }) => {
      const record = board?.elements.get(boxId);
      return record?.kind === 'box' && isInStepBand(record);
    });
    const bandShrinkY = drag.pinnedOffsetY - pinnedOffsetYAfterLeaving(renderer.layout()?.plan ?? null, leavingBand.map((resized) => resized.start));
    const shiftedIds = new Set(shiftedBoxes.map((resized) => resized.boxId));
    return resizedBoxes.map(({ boxId, rect, changesHeight }) => {
      const place = { at: { x: Math.round(rect.x), y: Math.round(rect.y - drag.pinnedOffsetY + bandShrinkY) } };
      return { boxId, fields: { width: Math.round(rect.width), ...(changesHeight ? { height: Math.round(rect.height) } : {}), ...(shiftedIds.has(boxId) ? { place } : {}) } };
    });
  }

  function draggedBoxFields(drag: Extract<Gesture, { kind: 'drag' }>): { boxId: string; fields: BoxFields }[] {
    if (drag.mode === 'resize') return resizedBoxFields(drag);
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

  function selectedBoxRects(): ArrangedRect[] {
    const board = options.currentBoard();
    return [...selectedIds].flatMap((elementId) => {
      const bounds = board?.elements.get(elementId)?.kind === 'box' ? renderer.boundsOf(elementId) : null;
      return bounds ? [{ id: elementId, ...bounds }] : [];
    });
  }

  function arrangeSelected(arrangedRectsOf: (rects: readonly ArrangedRect[]) => ArrangedRect[]): void {
    const startRects = selectedBoxRects();
    const arrangedById = new Map(arrangedRectsOf(startRects).map((arranged) => [arranged.id, arranged] as const));
    const movingBoxes = startRects.flatMap((start) => {
      const arranged = arrangedById.get(start.id);
      const hasMoved = arranged && (Math.round(arranged.x) !== Math.round(start.x) || Math.round(arranged.y) !== Math.round(start.y));
      return hasMoved ? [{ boxId: start.id, start }] : [];
    });
    if (movingBoxes.length === 0) return;
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const arrangedAtOf = (boxId: string): ViewPoint => {
      const arranged = arrangedById.get(boxId);
      return { x: Math.round(arranged?.x ?? 0), y: Math.round((arranged?.y ?? 0) - pinnedOffsetY) };
    };
    const boxIdByStart = new Map<Rect, string>(movingBoxes.map((movingBox) => [movingBox.start, movingBox.boxId]));
    const fields = movedPlaceFields(movingBoxes, (start) => arrangedAtOf(boxIdByStart.get(start) ?? ''), pinnedOffsetY);
    void options.sendOps(fields.map(({ boxId, fields: boxFields }): Op => ({ op: 'set', id: boxId, fields: boxFields })));
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
    const resizedRectsById = new Map(resizedBoxesOf(drag).map((resized) => [resized.boxId, resized.rect] as const));
    for (const { boxId, fields } of draggedBoxFields(drag)) {
      const box = board.elements.get(boxId);
      const rect = resizedRectsById.get(boxId);
      if (box?.kind !== 'box' || !laidOutById.has(boxId) || !rect) continue;
      resizedElements.put({ ...box, ...fields, step: null, place: { at: { x: Math.round(rect.x), y: Math.round(rect.y) } } });
    }
    const resizedById = new Map<string, LaidOutElement>();
    for (const element of layoutBoard({ ...board, elements: resizedElements }).elements) {
      const rect = resizedRectsById.get(element.id);
      if (element.kind === 'box' && rect) resizedById.set(element.id, movedBox(element, Math.round(rect.x) - element.x, Math.round(rect.y) - element.y));
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
    if (gesture?.kind === 'erase') endErase(gesture, false);
    if (gesture?.kind === 'marquee') gesture.outline.remove();
    paintGuides([]);
    gesture = { kind: 'pinch', distance: pinchDistance(), viewWidth: viewWidth() };
  }

  function startButtonPan(event: PointerEvent): void {
    event.preventDefault();
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, pressedButton: event.button === CONTEXT_MENU_BUTTON ? 'context' : 'auxiliary', tappedBoxId: null, pressedImage: null };
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
    const hitBoxRect = hit?.kind === 'box' ? renderer.boundsOf(hit.id) : null;
    const resizeHandle = hit?.part === 'resize' && !isPhoneLayout() ? hit.handle : null;
    if (hit && hitBoxRect && resizeHandle) {
      const origin = toViewPoint(event.clientX, event.clientY);
      const movingBoxes = movingBoxesFor(hit.id, hitBoxRect, false);
      const start = rectAround(movingBoxes.map((movingBox) => movingBox.start));
      const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
      gesture = { kind: 'drag', mode: 'resize', pointerId: event.pointerId, boxId: hit.id, origin, start, movingBoxes, pinnedOffsetY, latest: origin, hasMoved: false, isAdditive: false, pressedImage: null, preview: null, previewLayout: null, laidOutOffset: { x: 0, y: 0 }, isDuplicating: false, snapTargets: null, resize: { handle: resizeHandle, keepsRatio: event.shiftKey } };
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
      gesture = { kind: 'drag', mode: 'move', pointerId: event.pointerId, boxId: hit.id, origin, start: boxRect, movingBoxes: movingBoxesFor(hit.id, boxRect, event.shiftKey), pinnedOffsetY, latest: origin, hasMoved: false, isAdditive: event.shiftKey, pressedImage: pressedImageOf(hit), preview: null, previewLayout: null, laidOutOffset: { x: 0, y: 0 }, isDuplicating: event.altKey, snapTargets: null, resize: null };
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
    gesture = { kind: 'pan', pointerId: event.pointerId, lastClient: { x: event.clientX, y: event.clientY }, hasMoved: false, pressedButton: 'primary', tappedBoxId, pressedImage: pressedImageOf(hit) };
  }

  async function placeElement(tool: PlacementTool, point: ViewPoint, size: BoxSize | null): Promise<void> {
    finishToolUse();
    if (!options.currentBoard()) return;
    const pinnedOffsetY = renderer.layout()?.pinnedOffsetY ?? 0;
    const element = { ...placedBox({ x: Math.round(point.x), y: Math.round(point.y - pinnedOffsetY) }, PLACED_TITLE_BY_TOOL[tool], null, tool), ...(size ?? {}) };
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
    const element = { ...placedBox(place, pasted.title, null, pasted.isLink ? 'box' : 'text'), lines: pasted.lines };
    const isSent = await options.sendOps([{ op: 'add', element }]);
    if (isSent) setSelection(new Set([element.id]));
    if (isSent && pasted.isCut) options.onClipboardNotice('cut');
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
    const stretch = resizeStretchOf(drag, point);
    if (stretch?.keepsRatio) {
      paintGuides([]);
      return point;
    }
    if (stretch) {
      const moved = resizedRectOf(drag.start, stretch);
      const side = handleSidesOf(stretch.handle);
      const edgeOf = (start: number, size: number, sideSign: -1 | 0 | 1) => (sideSign === 0 ? [] : [sideSign === 1 ? start + size : start]);
      const xs = edgeOf(moved.x, moved.width, side.x);
      const firstSnap = snappedCorrectionOf(drag.snapTargets, { xs, ys: stretch.changesHeight ? edgeOf(moved.y, moved.height, side.y) : [] }, moved, thresholdUnits);
      const snappedStretch = resizeStretchOf(drag, { x: point.x, y: point.y + firstSnap.correction.y });
      const losesHeightChange = stretch.changesHeight && !snappedStretch?.changesHeight;
      const resizeSnap = losesHeightChange ? snappedCorrectionOf(drag.snapTargets, { xs, ys: [] }, moved, thresholdUnits) : firstSnap;
      paintGuides(resizeSnap.guides);
      return { x: point.x + resizeSnap.correction.x, y: point.y + resizeSnap.correction.y };
    }
    const offset = { x: point.x - drag.origin.x, y: point.y - drag.origin.y };
    const moved = shiftedRectOf(rectAround(drag.movingBoxes.map((movingBox) => movingBox.start)), offset);
    const edges = { xs: [moved.x, moved.x + moved.width / 2, moved.x + moved.width], ys: [moved.y, moved.y + moved.height / 2, moved.y + moved.height] };
    const snap = snappedCorrectionOf(drag.snapTargets, edges, moved, thresholdUnits);
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
    if (drag.resize) drag.resize.keepsRatio = event.shiftKey;
    drag.latest = snappedLatestOf(drag, event);
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
    if (marquee.placementTool) return;
    const nextSelectedIds = new Set([...marquee.baseSelection, ...renderer.elementsInRect(area)]);
    if (nextSelectedIds.size === selectedIds.size && [...nextSelectedIds].every((elementId) => selectedIds.has(elementId))) return;
    setSelection(nextSelectedIds);
  }

  function finishMarquee(marquee: Extract<Gesture, { kind: 'marquee' }>): void {
    marquee.outline.remove();
    if (marquee.placementTool) {
      finishPlacement(marquee, marquee.placementTool);
      return;
    }
    if (marquee.hasMoved || marquee.isAdditive) return;
    setSelection(new Set());
  }

  function finishPlacement(marquee: Extract<Gesture, { kind: 'marquee' }>, tool: PlacementTool): void {
    if (!marquee.hasMoved) {
      void placeElement(tool, marquee.origin, null);
      return;
    }
    const area = rectBetween(marquee.origin, marquee.latest);
    const width = Math.min(WHITEBOARD_LIMITS.boxWidthMax, Math.max(WHITEBOARD_LIMITS.boxWidthMin, Math.round(area.width)));
    const height = Math.min(WHITEBOARD_LIMITS.boxHeightMax, Math.max(1, Math.round(area.height)));
    void placeElement(tool, { x: area.x, y: area.y }, { width, height });
  }

  function cancelGesture(): boolean {
    const cancelled = gesture;
    if (!cancelled || cancelled.kind === 'pinch') return false;
    gesture = null;
    activePointers.delete(cancelled.pointerId);
    if (cancelled.kind === 'marquee') cancelled.outline.remove();
    if (cancelled.kind === 'wire') endWire(cancelled, false);
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
    if (gesture?.kind === 'erase' && gesture.pointerId === event.pointerId) {
      eraseAlong(gesture, toViewPoint(event.clientX, event.clientY));
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
    drag.latest = snappedLatestOf(drag, event);
    paintGuides([]);
    renderer.setWireTarget(null);
    if (drag.isDuplicating && drag.mode === 'move') {
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
    paintGuides([]);
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
    if (finished?.kind === 'erase') {
      endErase(finished, finished.pointerId === event.pointerId);
      return;
    }
    if (finished?.kind === 'pan' && finished.pressedButton === 'context' && !finished.hasMoved) {
      openContextMenuAt(event.clientX, event.clientY);
      return;
    }
    if (finished?.kind !== 'pan' || finished.hasMoved || finished.pressedButton !== 'primary') return;
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
    if (isTextBox(titled)) {
      editText(titled);
      return;
    }
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

  function editText(box: Box): void {
    const textArea = el('textarea', 'wb-text-input');
    textArea.value = [box.title, ...box.lines.map((line) => line.text)].join('\n');
    textArea.rows = Math.max(2, box.lines.length + 1);
    textArea.setAttribute('aria-label', 'Text');
    const signal = openInlineEditor(textArea, () => renderer.boundsOf(box.id), MIN_TITLE_EDITOR_WIDTH_PX);
    const commit = () => {
      const typedText = textArea.value;
      closeInlineEditor();
      viewport.focus();
      const liveBox = editedBox(box.id);
      const editOps = liveBox ? textEditOps(box, liveBox, typedText) : [];
      if (editOps.length > 0) void options.sendOps(editOps);
    };
    textArea.addEventListener('keydown', (event) => {
      const isCommitKey = event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey));
      if (!isCommitKey) return;
      event.preventDefault();
      commit();
    }, { signal });
    textArea.addEventListener('input', () => {
      const fittedText = fittedTextOf(textArea.value);
      if (fittedText !== textArea.value) {
        const caret = Math.min(textArea.selectionStart, fittedText.length);
        textArea.value = fittedText;
        textArea.setSelectionRange(caret, caret);
      }
      textArea.rows = Math.max(2, textArea.value.split('\n').length);
    }, { signal });
    textArea.addEventListener('blur', commit, { signal });
    textArea.focus();
    textArea.select();
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
    forgetSnapTargets();
    settleUnconfirmedLines();
    closeStaleLineEdit();
    placeInlineEditor();
    openPendingTitleEdit();
  }

  function onDoubleClick(event: MouseEvent): void {
    if (isPhoneLayout()) return;
    const hit = hitAt(event.clientX, event.clientY);
    if (!hit) {
      void placeElement('text', toViewPoint(event.clientX, event.clientY), null);
      return;
    }
    const box = hit.kind === 'box' ? editedBox(hit.id) : null;
    if (!box) return;
    if (isTextBox(box)) {
      editText(box);
      return;
    }
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
  viewport.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (gesture || event.button === CONTEXT_MENU_BUTTON || isPhoneLayout()) return;
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
    toggleToolLock: () => setToolLocked(toolKeeping === 'until placed'),
    placeMediaBox,
    afterBoardPaint,
    focusCanvas: () => viewport.focus(),
    removeSelected,
    selectAll,
    duplicateSelection,
    orderSelected,
    alignSelected: (edge: AlignEdge) => arrangeSelected((rects) => alignedRectsOf(rects, edge)),
    distributeSelected: (axis: DistributeAxis) => arrangeSelected((rects) => distributedRectsOf(rects, axis)),
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
