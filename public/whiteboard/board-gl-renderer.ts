import { boardMediaDrawnFilename, NOTE_TONE_HEX, TITLE_GRADIENT_HEX, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { NoteTone } from '#shared/contracts/whiteboard.ts';
import { BLOCK_RASTER_PX } from '#shared/contracts/whiteboard-tiles.ts';
import type { Board } from '#shared/contracts/whiteboard.ts';
import { elementSignature, layoutBoard } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutMedia, Rect, ResizeHandle } from '#shared/whiteboard-layout-core.ts';
import { forEachSlotTouching, gridOfRects } from '#shared/spatial-grid-core.ts';
import { BOARD_GRID_SPACING, PORT_RADIUS } from '#shared/whiteboard-svg-core.ts';
import { DEVICE_CATALOG } from '#shared/whiteboard-devices.ts';
import { rotatedAbout, rotatedBoundsOf, wireHandlesOf } from '#shared/whiteboard-route-core.ts';
import type { WireHandle } from '#shared/whiteboard-route-core.ts';
import type { LinkedIds } from '#shared/whiteboard-board-index.ts';
import type { BoardMediaLayer } from './board-media-layer.ts';
import type { FlowWire } from './board-flow-layer.ts';
import type { BlockTile } from './board-tile-store.ts';
import {
  BOX_LAYER,
  boxPortCenters, decorationPart, resizeHandleRectsOf, sceneOf,
} from './board-gl-scene.ts';
import type { BoardPalette, BoxTextRects, Decoration, ElementGeometry, GeometryPart, Point, Rgba, SceneContext } from './board-gl-scene.ts';
import { FANNED_STACK_SPREAD, STACK_FAN_MS, STACK_MOTION_MS, easedProgress, movedBoxesAt, stackFrameOfTopCard, stackMovesBetween } from './stack-motion-core.ts';
import { STACK_SPREAD } from '#shared/whiteboard-layout-core.ts';
import { rectAround } from './board-snap-core.ts';
import type { StackMove } from './stack-motion-core.ts';
import { prefersReducedMotion } from '../attention-banner.ts';
import type { DrawnMedia, PaintCommand, PaintedGeometry, PaintReport, PreviewEntry } from './board-paint-protocol.ts';

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface ReviewMarks {
  worthALookIds: ReadonlySet<string>;
  flaggedStepIds: ReadonlySet<string>;
  agentChangedIds: ReadonlySet<string>;
}

type HitPart = 'body' | 'line' | 'emptyBody' | 'port' | 'resize' | 'media' | 'end' | 'bend' | 'rotate';
type WireEndName = 'from' | 'to';

interface BoardHit {
  id: string;
  kind: LaidOutElement['kind'];
  part: HitPart;
  lineIndex: number | null;
  port: Point | null;
  media: { href: string; alt: string } | null;
  handle: ResizeHandle | null;
  end: WireEndName | null;
  bend: WireHandle | null;
}

interface BoardRenderer {
  render(board: Board): BoardLayout;
  renderLayout(layout: BoardLayout, blocks: readonly BlockTile[]): void;
  paintElements(elements: readonly LaidOutElement[]): void;
  layout(): BoardLayout | null;
  setCamera(camera: Camera): void;
  resendView(): void;
  hitTest(point: Point): BoardHit | null;
  boundsOf(elementId: string): Rect | null;
  boxTextRectsOf(boxId: string): BoxTextRects | null;
  elementsInRect(area: Rect): string[];
  boxIdsAt(point: Point): string[];
  setSelection(selectedIds: ReadonlySet<string>): void;
  setReviewMarks(marks: ReviewMarks): void;
  setWireTarget(boxId: string | null): void;
  setHover(boxId: string | null): void;
  setLinkResolver(resolve: (selectedBoxIds: readonly string[]) => LinkedIds): void;
  clear(): void;
}

const NO_LINKED_IDS: LinkedIds = { wireIds: [], boxIds: [] };

interface RendererOptions {
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  fontSource: Element;
  mediaLayer: BoardMediaLayer;
  flowCanvas: HTMLCanvasElement;
  onViewChange?: (view: Rect, scale: number) => void;
}

interface MediaImage {
  href: string;
  width: number;
  height: number;
  image: HTMLImageElement | null;
  state: 'loading' | 'ready' | 'failed';
  imageBytes: number;
  lastGatherNumber: number;
}

interface GlScene {
  layout: BoardLayout;
  chrome: ElementGeometry;
  geometries: ElementGeometry[];
  geometryIndexById: Map<string, number>;
  elementById: Map<string, LaidOutElement>;
  grid: ReturnType<typeof gridOfRects>;
  hasPageMedia: boolean;
}

interface ScenePreview {
  hiddenIds: ReadonlySet<string>;
  geometries: ElementGeometry[];
  elementById: Map<string, LaidOutElement>;
}

const NO_REVIEW_MARKS: ReviewMarks = { worthALookIds: new Set(), flaggedStepIds: new Set(), agentChangedIds: new Set() };
const CULL_CELL_SIZE = 512;
const GRID_HIDDEN_PITCH_PX = 8;
const GRID_FULL_PITCH_PX = 16;
const GATHER_MARGIN_FACTOR = 0.75;
const LOD_STEPS_PER_OCTAVE = 4;
const HIT_TOLERANCE_PX = 7;
const FRAME_EDGE_TOLERANCE_PX = 6;
const PORT_HIT_SLOP_PX = 3;
const ROTATE_HANDLE_GAP = 28;

const UNSIZED_MEDIA_EDGE_PX = 1024;
const MEDIA_IMAGE_BUDGET_BYTES = 128 * 1024 * 1024;
const BYTES_PER_PIXEL = 4;

function servedAssetHref(media: LaidOutMedia): string | null {
  const drawnFilename = boardMediaDrawnFilename(media);
  return drawnFilename ? `${WHITEBOARD_ASSET_ROUTE}/${drawnFilename}` : null;
}

function pointToSegmentDistance(point: Point, from: Point, to: Point): number {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * deltaX + (point.y - from.y) * deltaY) / lengthSquared));
  return Math.hypot(point.x - (from.x + along * deltaX), point.y - (from.y + along * deltaY));
}

function isInside(point: Point, rect: Rect, slop = 0): boolean {
  return point.x >= rect.x - slop && point.x <= rect.x + rect.width + slop && point.y >= rect.y - slop && point.y <= rect.y + rect.height + slop;
}

function isRectInside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function createColorReader(host: HTMLElement): { colorOf: (expression: string) => Rgba; sizeOf: (expression: string) => number; dispose: () => void } {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.append(probe);
  const swatch = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  function rgbaOf(cssColor: string): Rgba {
    if (!swatch) return [0, 0, 0, 1];
    swatch.clearRect(0, 0, 1, 1);
    swatch.fillStyle = '#000';
    swatch.fillStyle = cssColor;
    swatch.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = swatch.getImageData(0, 0, 1, 1).data;
    return [red / 255, green / 255, blue / 255, alpha / 255];
  }
  return {
    colorOf: (expression) => {
      probe.style.color = '';
      probe.style.color = expression;
      return rgbaOf(getComputedStyle(probe).color);
    },
    sizeOf: (expression) => {
      probe.style.fontSize = expression;
      return Number.parseFloat(getComputedStyle(probe).fontSize) || 12;
    },
    dispose: () => probe.remove(),
  };
}

function toneColorsOf(colorOfTone: (tone: NoteTone) => Rgba): Record<NoteTone, Rgba> {
  return { yellow: colorOfTone('yellow'), pink: colorOfTone('pink'), green: colorOfTone('green'), blue: colorOfTone('blue'), violet: colorOfTone('violet') };
}

function resolvePalette(host: HTMLElement): BoardPalette {
  const reader = createColorReader(host);
  const palette: BoardPalette = {
    board: reader.colorOf('var(--wb-board)'),
    canvas: reader.colorOf('var(--wb-canvas)'),
    ink: reader.colorOf('var(--wb-ink)'),
    inkDim: reader.colorOf('var(--wb-ink-dim)'),
    line: reader.colorOf('var(--wb-line)'),
    accent: reader.colorOf('var(--accent)'),
    running: reader.colorOf('var(--state-running)'),
    failed: reader.colorOf('var(--state-failed)'),
    waiting: reader.colorOf('var(--state-waiting)'),
    muted: reader.colorOf('var(--text-muted)'),
    cardBackground: reader.colorOf('var(--bg-card)'),
    noteStroke: reader.colorOf('var(--wb-note)'),
    noteCard: reader.colorOf('#2a2213'),
    codeBand: reader.colorOf('color-mix(in oklab, var(--accent) 14%, var(--wb-board))'),
    fillByTone: toneColorsOf((tone) => reader.colorOf(`color-mix(in oklab, ${NOTE_TONE_HEX[tone]} 30%, var(--wb-board))`)),
    edgeByTone: toneColorsOf((tone) => reader.colorOf(`color-mix(in oklab, ${NOTE_TONE_HEX[tone]} 70%, var(--wb-board))`)),
    frameFill: reader.colorOf('color-mix(in srgb, var(--accent) 4%, transparent)'),
    placeholderFill: reader.colorOf('color-mix(in oklab, var(--accent) 8%, var(--wb-board))'),
    titleGradient: TITLE_GRADIENT_HEX.map((hex) => reader.colorOf(hex)),
    metaSize: reader.sizeOf('var(--type-meta)'),
    bodySize: reader.sizeOf('var(--type-body)'),
    titleSize: reader.sizeOf('var(--type-title)'),
  };
  reader.dispose();
  return palette;
}

function paletteKey(host: HTMLElement): string {
  const root = document.documentElement;
  return [root.className, root.dataset.theme ?? '', root.getAttribute('style') ?? '', host.className, host.isConnected].join('|');
}

function partsByLayerOf(parts: readonly { layer: number; part: GeometryPart }[]): [number, GeometryPart[]][] {
  const byLayer = new Map<number, GeometryPart[]>();
  for (const layered of parts) byLayer.set(layered.layer, [...(byLayer.get(layered.layer) ?? []), layered.part]);
  return [...byLayer];
}

function unquotedFamilyNames(fontFamilyStack: string): Set<string> {
  return new Set(fontFamilyStack.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, '')));
}

function fontRulesIn(rules: CSSRuleList, found: CSSFontFaceRule[]): void {
  for (const rule of rules) {
    if (rule instanceof CSSFontFaceRule) found.push(rule);
    if (rule instanceof CSSGroupingRule) fontRulesIn(rule.cssRules, found);
    if (rule instanceof CSSImportRule && rule.styleSheet) fontRulesIn(rule.styleSheet.cssRules, found);
  }
}

function boardFontFacesOf(fontFamilyStack: string): Extract<PaintCommand, { kind: 'fonts' }>['faces'] {
  const families = unquotedFamilyNames(fontFamilyStack);
  const faces: Extract<PaintCommand, { kind: 'fonts' }>['faces'] = [];
  for (const sheet of document.styleSheets) {
    const sheetBase = sheet.href ?? document.baseURI;
    if (new URL(sheetBase).origin !== location.origin) continue;
    const rules: CSSFontFaceRule[] = [];
    fontRulesIn(sheet.cssRules, rules);
    for (const rule of rules) {
      const family = rule.style.getPropertyValue('font-family').trim().replace(/^['"]|['"]$/g, '');
      const sourceUrl = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(rule.style.getPropertyValue('src'))?.[1];
      if (!families.has(family) || !sourceUrl) continue;
      faces.push({
        family,
        source: new URL(sourceUrl, sheetBase).href,
        weight: rule.style.getPropertyValue('font-weight') || '400',
        style: rule.style.getPropertyValue('font-style') || 'normal',
        unicodeRange: rule.style.getPropertyValue('unicode-range') || 'U+0-10FFFF',
      });
    }
  }
  return faces;
}

function rasterizedBitmapOf(image: HTMLImageElement, fallbackSize: { width: number; height: number }): ImageBitmap {
  const raster = new OffscreenCanvas(image.naturalWidth || fallbackSize.width, image.naturalHeight || fallbackSize.height);
  raster.getContext('2d')?.drawImage(image, 0, 0, raster.width, raster.height);
  return raster.transferToImageBitmap();
}

export function createBoardRenderer(options: RendererOptions): BoardRenderer {
  const { canvas, viewport, mediaLayer, flowCanvas, onViewChange } = options;
  const decorationCanvas = Object.assign(document.createElement('canvas'), { className: 'wb-gl-decorations' });
  decorationCanvas.setAttribute('aria-hidden', 'true');
  canvas.after(decorationCanvas);
  const paintWorker = new Worker(new URL('./board-paint-worker.ts', import.meta.url), { type: 'module', name: 'board-paint' });
  const boardSurface = canvas.transferControlToOffscreen();
  const decorationSurface = decorationCanvas.transferControlToOffscreen();
  const flowSurface = flowCanvas.transferControlToOffscreen();
  postPaint({ kind: 'canvases', board: boardSurface, decorations: decorationSurface, flow: flowSurface }, [boardSurface, decorationSurface, flowSurface]);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const geometryIdOf = new WeakMap<ElementGeometry, number>();
  let nextGeometryId = 1;
  let geometryIdsInWorker = new Set<number>();
  let blocks: readonly BlockTile[] = [];
  let postedBlocks: readonly BlockTile[] | null = null;
  let postedBlockTint = '';
  let lastViewKey = '';
  let lastRendered: { source: Board | BoardLayout; layout: BoardLayout; blocks: readonly BlockTile[] } | null = null;
  const signatureOfElement = new WeakMap<LaidOutElement, string>();
  let palette: BoardPalette | null = null;
  let resolvedPaletteKey = '';
  let boardFontFamily = '';
  let scene: GlScene | null = null;
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let selectedIds: ReadonlySet<string> = new Set();
  let reviewMarks = NO_REVIEW_MARKS;
  let wireTargetId: string | null = null;
  let hoveredBoxId: string | null = null;
  let resolveLinkedIds: (selectedBoxIds: readonly string[]) => LinkedIds = () => NO_LINKED_IDS;
  let frameRequest: number | null = null;
  let isGatherDirty = true;
  let gatheredArea: Rect | null = null;
  let gatheredLodStep = Number.NaN;
  let preview: ScenePreview | null = null;
  let gatheredFlows: FlowWire[] = [];
  let stackMotion: { moves: readonly StackMove[]; startMs: number; frameRequest: number } | null = null;
  let stackFan: { frameId: string; fromSpread: number; toSpread: number; spread: number; startMs: number; frameRequest: number | null } | null = null;
  const geometryBySignature = new Map<string, ElementGeometry>();
  const mediaImages = new Map<string, MediaImage>();
  let gatherNumber = 0;
  let sceneBuildCount = 0;

  function postPaint(command: PaintCommand, transfer: Transferable[] = []): void {
    paintWorker.postMessage(command, transfer);
  }

  function postBoardFont(): void {
    const fontFamily = getComputedStyle(options.fontSource).fontFamily || 'monospace';
    if (fontFamily === boardFontFamily) return;
    boardFontFamily = fontFamily;
    postPaint({ kind: 'fonts', fontFamily, faces: boardFontFacesOf(fontFamily) });
  }

  function postView(): void {
    postPaint({ kind: 'view', camera, pixelRatio: window.devicePixelRatio || 1, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight });
  }

  function postBlocks(tint: Rgba): void {
    const tintKey = tint.join(',');
    if (postedBlocks === blocks && postedBlockTint === tintKey) return;
    postedBlocks = blocks;
    postedBlockTint = tintKey;
    postPaint({ kind: 'blocks', blocks: blocks.map((block) => ({ id: block.id, rect: block.rect, raster: block.raster })), tint, rasterPx: BLOCK_RASTER_PX });
  }

  function geometryIdFor(geometry: ElementGeometry): number {
    const known = geometryIdOf.get(geometry);
    if (known !== undefined) return known;
    const assigned = nextGeometryId;
    nextGeometryId += 1;
    geometryIdOf.set(geometry, assigned);
    return assigned;
  }

  function postScene(current: GlScene): void {
    const count = current.geometries.length;
    const geometryIdByIndex = new Uint32Array(count);
    const depthByIndex = new Float32Array(count);
    const boundsByIndex = new Float32Array(count * 4);
    const newGeometries: PaintedGeometry[] = [];
    for (const [index, geometry] of current.geometries.entries()) {
      const geometryId = geometryIdFor(geometry);
      geometryIdByIndex[index] = geometryId;
      depthByIndex[index] = depthOf(geometry.paintRank, current);
      boundsByIndex.set([geometry.bounds.x, geometry.bounds.y, geometry.bounds.width, geometry.bounds.height], index * 4);
      if (!geometryIdsInWorker.has(geometryId)) newGeometries.push({ geometryId, partsByLayer: partsByLayerOf(geometry.parts) });
    }
    geometryIdsInWorker = new Set(geometryIdByIndex);
    postPaint({ kind: 'scene', geometryIdByIndex, depthByIndex, boundsByIndex, newGeometries, chrome: partsByLayerOf(current.chrome.parts) }, [geometryIdByIndex.buffer, depthByIndex.buffer, boundsByIndex.buffer]);
  }

  function ensurePalette(): BoardPalette {
    const key = paletteKey(viewport);
    if (palette && key === resolvedPaletteKey) return palette;
    palette = resolvePalette(viewport);
    resolvedPaletteKey = key;
    geometryBySignature.clear();
    return palette;
  }

  function viewArea(): Rect {
    const width = (canvas.clientWidth || 1) / camera.scale;
    const height = (canvas.clientHeight || 1) / camera.scale;
    return { x: camera.x, y: camera.y, width, height };
  }

  function lodStepOf(scale: number): number {
    return Math.floor(Math.log2(scale) * LOD_STEPS_PER_OCTAVE);
  }


  function depthOf(paintRank: number, current: GlScene): number {
    return (paintRank + 1) / (current.geometries.length + 1);
  }

  function visibleGeometryIndexes(current: GlScene, area: Rect): number[] {
    const indexes: number[] = [];
    forEachSlotTouching(current.grid, area, (slot) => {
      indexes.push(slot);
    });
    return indexes.sort((left, right) => left - right);
  }

  function elementOf(current: GlScene, elementId: string): LaidOutElement | undefined {
    return preview?.elementById.get(elementId) ?? current.elementById.get(elementId);
  }

  function selectionHandleArea(current: GlScene): { area: Rect; angle: number; boxId: string } | null {
    const selectedBoxes = [...selectedIds].flatMap((elementId) => {
      const element = elementOf(current, elementId);
      return element?.kind === 'box' ? [element] : [];
    });
    const [firstBox] = selectedBoxes;
    if (!firstBox) return null;
    if (selectedBoxes.length === 1) return { area: { x: firstBox.x, y: firstBox.y, width: firstBox.width, height: firstBox.height }, angle: firstBox.angle, boxId: firstBox.id };
    return { area: rectAround(selectedBoxes.map(rotatedBoundsOf)), angle: 0, boxId: firstBox.id };
  }

  function rotateHandleOf(current: GlScene): { boxId: string; at: Point } | null {
    if (selectedIds.size !== 1) return null;
    const [selectedId] = selectedIds;
    const box = selectedId ? elementOf(current, selectedId) : undefined;
    if (box?.kind !== 'box') return null;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    return { boxId: box.id, at: rotatedAbout({ x: center.x, y: box.y - ROTATE_HANDLE_GAP }, center, box.angle) };
  }

  function handleHitAt(current: GlScene, point: Point, slop: number): BoardHit | null {
    const rotateHandle = rotateHandleOf(current);
    const rotateReach = PORT_RADIUS + (PORT_HIT_SLOP_PX / HIT_TOLERANCE_PX) * slop;
    if (rotateHandle && Math.hypot(rotateHandle.at.x - point.x, rotateHandle.at.y - point.y) <= rotateReach) {
      return { id: rotateHandle.boxId, kind: 'box', part: 'rotate', lineIndex: null, port: null, media: null, handle: null, end: null, bend: null };
    }
    const handleArea = selectionHandleArea(current);
    if (!handleArea) return null;
    const handleSlop = (PORT_HIT_SLOP_PX / HIT_TOLERANCE_PX) * slop;
    const { area, angle } = handleArea;
    const pointInAreaFrame = rotatedAbout(point, { x: area.x + area.width / 2, y: area.y + area.height / 2 }, -angle);
    const pressed = resizeHandleRectsOf(area).find(({ rect }) => isInside(pointInAreaFrame, rect, handleSlop));
    return pressed ? { id: handleArea.boxId, kind: 'box', part: 'resize', lineIndex: null, port: null, media: null, handle: pressed.handle, end: null, bend: null } : null;
  }

  function linkedDecorationsOf(current: GlScene): Decoration[] {
    const selectedBoxIds = [...selectedIds].filter((elementId) => elementOf(current, elementId)?.kind === 'box');
    if (selectedBoxIds.length === 0) return [];
    const linked = resolveLinkedIds(selectedBoxIds);
    const wireDecorations = linked.wireIds.flatMap((wireId): Decoration[] => {
      const wire = elementOf(current, wireId);
      return wire?.kind === 'wire' ? [{ kind: 'linked-wire', wire }] : [];
    });
    const boxDecorations = linked.boxIds.flatMap((boxId): Decoration[] => {
      const box = elementOf(current, boxId);
      return box?.kind === 'box' ? [{ kind: 'linked-box', box }] : [];
    });
    return [...wireDecorations, ...boxDecorations];
  }

  function selectedWiresOf(current: GlScene): Extract<LaidOutElement, { kind: 'wire' }>[] {
    return [...selectedIds].flatMap((elementId) => {
      const element = elementOf(current, elementId);
      return element?.kind === 'wire' ? [element] : [];
    });
  }

  function wireEndHitAt(current: GlScene, point: Point, slop: number): BoardHit | null {
    const reach = PORT_RADIUS + (PORT_HIT_SLOP_PX / HIT_TOLERANCE_PX) * slop;
    for (const wire of selectedWiresOf(current)) {
      const ends: [WireEndName, Point][] = [['from', wire.start], ['to', wire.end]];
      const pressed = ends.find(([, center]) => Math.hypot(center.x - point.x, center.y - point.y) <= reach);
      if (pressed) return { id: wire.id, kind: 'wire', part: 'end', lineIndex: null, port: null, media: null, handle: null, end: pressed[0], bend: null };
    }
    return null;
  }

  function wireBendHitAt(current: GlScene, point: Point, slop: number): BoardHit | null {
    const reach = PORT_RADIUS + (PORT_HIT_SLOP_PX / HIT_TOLERANCE_PX) * slop;
    for (const wire of selectedWiresOf(current)) {
      const pressed = wireHandlesOf(wire).find(({ at }) => Math.hypot(at.x - point.x, at.y - point.y) <= reach);
      if (pressed) return { id: wire.id, kind: 'wire', part: 'bend', lineIndex: null, port: null, media: null, handle: null, end: null, bend: pressed };
    }
    return null;
  }

  function decorations(current: GlScene): Decoration[] {
    const listed: Decoration[] = preview ? [] : linkedDecorationsOf(current);
    for (const elementId of reviewMarks.flaggedStepIds) {
      const element = elementOf(current, elementId);
      if (element) listed.push({ kind: 'flagged', element });
    }
    for (const elementId of reviewMarks.agentChangedIds) {
      const element = elementOf(current, elementId);
      if (element) listed.push({ kind: 'agent-changed', element });
    }
    for (const elementId of selectedIds) {
      const element = elementOf(current, elementId);
      if (element) listed.push({ kind: 'selected', element });
    }
    const target = wireTargetId ? elementOf(current, wireTargetId) : undefined;
    if (target) listed.push({ kind: 'wire-target', element: target });
    const isPhone = document.documentElement.dataset.layout === 'phone';
    const hoveredBox = !isPhone && hoveredBoxId && !selectedIds.has(hoveredBoxId) ? elementOf(current, hoveredBoxId) : undefined;
    if (hoveredBox?.kind === 'box') listed.push({ kind: 'hover-handles', box: hoveredBox });
    const handleArea = selectionHandleArea(current);
    if (handleArea) listed.push({ kind: 'resize-handles', area: handleArea.area, angle: handleArea.angle });
    const rotateHandle = rotateHandleOf(current);
    if (rotateHandle) listed.push({ kind: 'rotate-handle', at: rotateHandle.at });
    for (const wire of selectedWiresOf(current)) listed.push({ kind: 'wire-ends', wire });
    for (const elementId of reviewMarks.worthALookIds) {
      const element = elementOf(current, elementId);
      if (element && element.kind !== 'wire') listed.push({ kind: 'look', element });
    }
    return listed;
  }

  function writePreview(current: GlScene, currentPalette: BoardPalette): void {
    const entries: PreviewEntry[] = [];
    for (const geometry of preview?.geometries ?? []) {
      const depth = depthOf(geometry.paintRank, current);
      const media = drawnMediaOf(current, geometry);
      const byLayer = new Map(partsByLayerOf(geometry.parts));
      if (media && !byLayer.has(BOX_LAYER)) byLayer.set(BOX_LAYER, []);
      for (const [layer, parts] of byLayer) entries.push({ layer, parts, depth, media: layer === BOX_LAYER ? media : null });
    }
    postPaint({ kind: 'preview', entries });
    writeDecorations(current, currentPalette);
  }

  function writeDecorations(current: GlScene, currentPalette: BoardPalette): void {
    postPaint({ kind: 'decorations', part: decorationPart(decorations(current), { palette: currentPalette, hasDrawnMedia: () => false }) });
  }

  function gather(current: GlScene, currentPalette: BoardPalette): void {
    const view = viewArea();
    const lodStep = lodStepOf(camera.scale);
    const area = { x: view.x - view.width * GATHER_MARGIN_FACTOR, y: view.y - view.height * GATHER_MARGIN_FACTOR, width: view.width * (1 + GATHER_MARGIN_FACTOR * 2), height: view.height * (1 + GATHER_MARGIN_FACTOR * 2) };
    const visible = visibleGeometryIndexes(current, area);
    gatherNumber += 1;
    gatheredFlows = [];
    for (const index of visible) {
      const geometry = current.geometries[index];
      if (geometry?.flow && !preview?.hiddenIds.has(geometry.id)) gatheredFlows.push(geometry.flow);
    }
    syncFlowLayer();
    const mediaByIndex: [number, DrawnMedia][] = [];
    for (const index of visible) {
      const geometry = current.geometries[index];
      const media = geometry && !preview?.hiddenIds.has(geometry.id) ? drawnMediaOf(current, geometry) : null;
      if (media) mediaByIndex.push([index, media]);
    }
    const hiddenIndexes = Uint32Array.from([...(preview?.hiddenIds ?? [])].flatMap((elementId) => {
      const index = current.geometryIndexById.get(elementId);
      return index === undefined ? [] : [index];
    }));
    const sceneIndexes = Uint32Array.from(visible);
    postPaint({ kind: 'gather', sceneIndexes, mediaByIndex, hiddenIndexes }, [sceneIndexes.buffer, hiddenIndexes.buffer]);
    gatheredArea = area;
    gatheredLodStep = lodStep;
    isGatherDirty = false;
    writePreview(current, currentPalette);
    evictMediaImagesOverBudget();
    mediaLayer.showArea(area);
  }

  function drawnMediaOf(current: GlScene, geometry: ElementGeometry): DrawnMedia | null {
    if (geometry.hitShape.kind !== 'rect' || !geometry.hitShape.hasDrawnMedia) return null;
    const box = elementOf(current, geometry.id);
    if (box?.kind !== 'box' || !box.media) return null;
    const href = servedAssetHref(box.media);
    if (!href) return null;
    ensureMediaImage(href, box.media);
    const clipRadius = box.device ? DEVICE_CATALOG[box.device.name].bezel.screenRadius * box.device.scale : 0;
    return { href, rect: box.media, fit: box.media.fit, clipRadius, turn: { pivot: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, radians: (box.angle * Math.PI) / 180 } };
  }

  function ensureMediaImage(href: string, mediaRect: Rect): void {
    const known = mediaImages.get(href);
    if (known) {
      known.lastGatherNumber = gatherNumber;
      return;
    }
    const fallbackFit = UNSIZED_MEDIA_EDGE_PX / Math.max(mediaRect.width, mediaRect.height, 1);
    const image = new Image();
    const entry: MediaImage = { href, width: Math.round(mediaRect.width * fallbackFit), height: Math.round(mediaRect.height * fallbackFit), image, state: 'loading', imageBytes: 0, lastGatherNumber: gatherNumber };
    mediaImages.set(href, entry);
    image.decoding = 'async';
    image.src = href;
    void image.decode().then(() => createImageBitmap(image).catch(() => rasterizedBitmapOf(image, entry))).then((bitmap) => {
      if (mediaImages.get(href) !== entry) {
        bitmap.close();
        return;
      }
      entry.width = bitmap.width || entry.width;
      entry.height = bitmap.height || entry.height;
      entry.state = 'ready';
      entry.image = null;
      entry.imageBytes = entry.width * entry.height * BYTES_PER_PIXEL;
      postPaint({ kind: 'media', href, bitmap }, [bitmap]);
      evictMediaImagesOverBudget();
    }, () => {
      markMediaFailed(entry);
    });
  }

  function markMediaFailed(entry: MediaImage): void {
    entry.state = 'failed';
    const current = scene;
    if (!current) return;
    geometryBySignature.clear();
    buildScene(current.layout);
    requestDraw();
  }

  function evictMediaImagesOverBudget(): void {
    let heldBytes = 0;
    for (const entry of mediaImages.values()) heldBytes += entry.imageBytes;
    if (heldBytes <= MEDIA_IMAGE_BUDGET_BYTES) return;
    const leastRecentlyDrawnFirst = [...mediaImages].filter(([, entry]) => entry.lastGatherNumber !== gatherNumber).sort(([, first], [, second]) => first.lastGatherNumber - second.lastGatherNumber);
    const droppedHrefs: string[] = [];
    for (const [href, entry] of leastRecentlyDrawnFirst) {
      if (heldBytes <= MEDIA_IMAGE_BUDGET_BYTES) break;
      heldBytes -= entry.imageBytes;
      mediaImages.delete(href);
      droppedHrefs.push(href);
    }
    if (droppedHrefs.length > 0) postPaint({ kind: 'media-dropped', hrefs: droppedHrefs });
  }

  function forgetMediaNotIn(layout: BoardLayout): void {
    const hrefsInUse = new Set(layout.elements.flatMap((element) => {
      if (element.kind !== 'box' || !element.media) return [];
      const href = servedAssetHref(element.media);
      return href ? [href] : [];
    }));
    const droppedHrefs = [...mediaImages.keys()].filter((href) => !hrefsInUse.has(href));
    for (const href of droppedHrefs) mediaImages.delete(href);
    if (droppedHrefs.length > 0) postPaint({ kind: 'media-dropped', hrefs: droppedHrefs });
  }

  function placeGrid(): void {
    const spacingPx = BOARD_GRID_SPACING * camera.scale;
    const strength = Math.min(1, Math.max(0, (spacingPx - GRID_HIDDEN_PITCH_PX) / (GRID_FULL_PITCH_PX - GRID_HIDDEN_PITCH_PX)));
    viewport.style.setProperty('--wb-grid-size', `${spacingPx}px`);
    viewport.style.setProperty('--wb-grid-x', `${-((camera.x * camera.scale) % spacingPx)}px`);
    viewport.style.setProperty('--wb-grid-y', `${-((camera.y * camera.scale) % spacingPx)}px`);
    viewport.style.setProperty('--wb-grid-strength', String(strength));
  }

  function reportView(): void {
    if (!onViewChange || camera.scale <= 0) return;
    const view = { x: camera.x, y: camera.y, width: canvas.clientWidth / camera.scale, height: canvas.clientHeight / camera.scale };
    const viewKey = `${view.x}:${view.y}:${view.width}:${view.height}`;
    if (viewKey === lastViewKey) return;
    lastViewKey = viewKey;
    onViewChange(view, camera.scale);
  }

  function isGatherStale(): boolean {
    if (isGatherDirty || !gatheredArea) return true;
    if (lodStepOf(camera.scale) !== gatheredLodStep) return true;
    return !isRectInside(viewArea(), gatheredArea);
  }

  function draw(): void {
    frameRequest = null;
    if (scene && paletteKey(viewport) !== resolvedPaletteKey) buildScene(scene.layout);
    postBoardFont();
    const current = scene;
    if (current) {
      const currentPalette = ensurePalette();
      postBlocks(currentPalette.inkDim);
      if (isGatherStale()) gather(current, currentPalette);
    }
    postView();
  }

  function requestDraw(): void {
    if (frameRequest !== null) return;
    frameRequest = requestAnimationFrame(draw);
  }

  function refreshDecorations(): void {
    const current = scene;
    if (!current || isGatherDirty) {
      requestDraw();
      return;
    }
    writeDecorations(current, ensurePalette());
  }

  function isMediaDrawable(box: LaidOutBox): boolean {
    if (!box.media) return false;
    const href = servedAssetHref(box.media);
    return href !== null && mediaImages.get(href)?.state !== 'failed';
  }

  function signatureOf(element: LaidOutElement): string {
    const known = signatureOfElement.get(element);
    if (known !== undefined) return known;
    const signature = elementSignature(element);
    signatureOfElement.set(element, signature);
    return signature;
  }

  function render(board: Board): BoardLayout {
    if (lastRendered?.source === board && scene?.layout === lastRendered.layout) return lastRendered.layout;
    const layout = layoutBoard(board);
    drawLayout(layout, []);
    lastRendered = { source: board, layout, blocks: [] };
    return layout;
  }

  function dropPreview(current: GlScene): void {
    if (!preview) return;
    preview = null;
    isGatherDirty = true;
    if (current.hasPageMedia) mediaLayer.sync(current.layout, current.geometries.map((geometry) => geometry.id));
    requestDraw();
  }

  function renderLayout(layout: BoardLayout, nextBlocks: readonly BlockTile[]): void {
    const current = scene;
    if (lastRendered?.source === layout && lastRendered.blocks === nextBlocks && current?.layout === layout) {
      if (!stackMotion) dropPreview(current);
      return;
    }
    const previousById = current?.elementById ?? null;
    drawLayout(layout, nextBlocks);
    lastRendered = { source: layout, layout, blocks: nextBlocks };
    if (previousById) startStackMotion(stackMovesBetween(previousById, layout));
  }

  function hoveredStackFrameId(boxId: string | null): string | null {
    const current = scene;
    const hovered = boxId === null ? undefined : current?.elementById.get(boxId);
    if (!current || hovered?.kind !== 'box') return null;
    return stackFrameOfTopCard(current.layout, hovered)?.id ?? null;
  }

  function fanStack(frameId: string | null): void {
    if (stackMotion || (preview && !stackFan)) return;
    const restingFan = stackFan;
    const targetFrameId = frameId ?? restingFan?.frameId ?? null;
    if (targetFrameId === null) return;
    if (restingFan && restingFan.frameId !== targetFrameId) dropStackFan();
    const fromSpread = stackFan?.spread ?? STACK_SPREAD;
    const toSpread = frameId === null ? STACK_SPREAD : FANNED_STACK_SPREAD;
    if (stackFan?.frameRequest != null) cancelAnimationFrame(stackFan.frameRequest);
    stackFan = { frameId: targetFrameId, fromSpread, toSpread, spread: fromSpread, startMs: performance.now(), frameRequest: null };
    if (prefersReducedMotion()) {
      paintStackFan(stackFan.startMs + STACK_FAN_MS);
      return;
    }
    stackFan.frameRequest = requestAnimationFrame(paintStackFan);
  }

  function dropStackFan(): void {
    if (!stackFan) return;
    if (stackFan.frameRequest !== null) cancelAnimationFrame(stackFan.frameRequest);
    stackFan = null;
    if (scene) dropPreview(scene);
  }

  function paintStackFan(nowMs: number): void {
    const fan = stackFan;
    const frame = fan ? scene?.elementById.get(fan.frameId) : undefined;
    if (!fan || frame?.kind !== 'frame') {
      dropStackFan();
      return;
    }
    const progress = easedProgress(nowMs - fan.startMs, STACK_FAN_MS);
    fan.spread = fan.fromSpread + (fan.toSpread - fan.fromSpread) * progress;
    fan.frameRequest = null;
    if (progress >= 1 && fan.toSpread === STACK_SPREAD) {
      dropStackFan();
      return;
    }
    paintElements([frame], () => fan.spread);
    if (progress < 1) fan.frameRequest = requestAnimationFrame(paintStackFan);
  }

  function stopStackMotion(): void {
    if (!stackMotion) return;
    cancelAnimationFrame(stackMotion.frameRequest);
    stackMotion = null;
  }

  function startStackMotion(moves: readonly StackMove[]): void {
    if (moves.length === 0 || prefersReducedMotion()) return;
    stackMotion = { moves, startMs: performance.now(), frameRequest: requestAnimationFrame(paintStackMotion) };
    paintElements(movedBoxesAt(moves, 0));
  }

  function paintStackMotion(nowMs: number): void {
    const motion = stackMotion;
    if (!motion) return;
    const progress = easedProgress(nowMs - motion.startMs, STACK_MOTION_MS);
    if (progress >= 1) {
      stackMotion = null;
      if (scene) dropPreview(scene);
      return;
    }
    paintElements(movedBoxesAt(motion.moves, progress));
    motion.frameRequest = requestAnimationFrame(paintStackMotion);
  }

  function isSameIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    if (left.size !== right.size) return false;
    for (const elementId of left) {
      if (!right.has(elementId)) return false;
    }
    return true;
  }

  function syncFlowLayer(): void {
    const previewFlows = preview?.geometries.flatMap((geometry) => (geometry.flow ? [geometry.flow] : [])) ?? [];
    postPaint({ kind: 'flows', wires: [...gatheredFlows, ...previewFlows], isMotionReduced: reducedMotion.matches });
  }

  function paintElements(elements: readonly LaidOutElement[], stackSpreadOf?: (frameId: string) => number): void {
    if (scene && paletteKey(viewport) !== resolvedPaletteKey) buildScene(scene.layout);
    const current = scene;
    if (!current) return;
    const currentPalette = ensurePalette();
    const context: SceneContext = { palette: currentPalette, hasDrawnMedia: isMediaDrawable, ...(stackSpreadOf ? { stackSpreadOf } : {}) };
    const built = sceneOf({ ...current.layout, elements: [...elements], legend: [], caption: null, plan: null }, context, () => null);
    const geometries = built.elements.map((geometry) => ({ ...geometry, paintRank: current.geometries[current.geometryIndexById.get(geometry.id) ?? -1]?.paintRank ?? 0 }));
    const hiddenIds = new Set(elements.map((element) => element.id));
    const isSameHidden = preview !== null && isSameIdSet(preview.hiddenIds, hiddenIds);
    preview = { hiddenIds: isSameHidden && preview ? preview.hiddenIds : hiddenIds, geometries, elementById: new Map(elements.map((element) => [element.id, element])) };
    if (!isSameHidden) isGatherDirty = true;
    syncFlowLayer();
    if (current.hasPageMedia) mediaLayer.sync({ ...current.layout, elements: current.layout.elements.map((element) => preview?.elementById.get(element.id) ?? element) }, current.geometries.map((geometry) => geometry.id));
    if (!isGatherDirty && gatheredArea) writePreview(current, currentPalette);
    requestDraw();
  }

  function drawLayout(layout: BoardLayout, nextBlocks: readonly BlockTile[]): void {
    stopStackMotion();
    if (stackFan?.frameRequest != null) cancelAnimationFrame(stackFan.frameRequest);
    stackFan = null;
    preview = null;
    postPaint({ kind: 'preview', entries: [] });
    blocks = nextBlocks;
    buildScene(layout);
    requestDraw();
  }

  function buildScene(layout: BoardLayout): void {
    const currentPalette = ensurePalette();
    const context: SceneContext = { palette: currentPalette, hasDrawnMedia: isMediaDrawable };
    const signatureByElement = new Map(layout.elements.map((element) => [element, signatureOf(element)]));
    const built = sceneOf(layout, context, (element) => geometryBySignature.get(signatureByElement.get(element) ?? '') ?? null);
    geometryBySignature.clear();
    const elementById = new Map(layout.elements.map((element) => [element.id, element]));
    for (const geometry of built.elements) {
      const element = elementById.get(geometry.id);
      if (element) geometryBySignature.set(signatureByElement.get(element) ?? '', geometry);
    }
    scene = {
      layout,
      chrome: built.chrome,
      geometries: built.elements,
      geometryIndexById: new Map(built.elements.map((geometry, index) => [geometry.id, index])),
      elementById,
      grid: gridOfRects(built.elements.map((geometry) => geometry.bounds), CULL_CELL_SIZE),
      hasPageMedia: layout.elements.some((element) => element.kind === 'box' && (element.isAutoplay || element.media?.kind === 'page' || element.media?.kind === 'doc' || element.media?.kind === 'sheet')),
    };
    forgetMediaNotIn(layout);
    mediaLayer.sync(layout, built.elements.map((geometry) => geometry.id));
    postScene(scene);
    gather(scene, currentPalette);
    sceneBuildCount += 1;
    canvas.dataset.sceneBuilds = String(sceneBuildCount);
  }

  function hitPartOf(current: GlScene, geometry: ElementGeometry, point: Point, slop: number): BoardHit | null {
    const element = elementOf(current, geometry.id);
    if (!element) return null;
    const hit: BoardHit = { id: geometry.id, kind: geometry.kind, part: 'body', lineIndex: null, port: null, media: null, handle: null, end: null, bend: null };
    const shape = geometry.hitShape;
    const boxCenter = element.kind === 'box' ? { x: element.x + element.width / 2, y: element.y + element.height / 2 } : null;
    const boxAngle = element.kind === 'box' ? element.angle : 0;
    const localPoint = boxCenter ? rotatedAbout(point, boxCenter, -boxAngle) : point;
    if (shape.kind === 'path') {
      for (let index = 1; index < shape.points.length; index += 1) {
        const from = shape.points[index - 1];
        const to = shape.points[index];
        if (from && to && pointToSegmentDistance(point, from, to) <= slop) return hit;
      }
      return null;
    }
    if (shape.kind === 'outline') {
      if (isInside(point, shape.titleRect)) return hit;
      const edgeSlop = (FRAME_EDGE_TOLERANCE_PX / HIT_TOLERANCE_PX) * slop;
      const isNearEdge = isInside(point, shape.rect, edgeSlop) && !isInside({ x: point.x, y: point.y }, { x: shape.rect.x + edgeSlop, y: shape.rect.y + edgeSlop, width: shape.rect.width - edgeSlop * 2, height: shape.rect.height - edgeSlop * 2 });
      return isNearEdge ? hit : null;
    }
    const portSlop = PORT_RADIUS + (PORT_HIT_SLOP_PX / HIT_TOLERANCE_PX) * slop;
    const hasResizeHandles = selectedIds.has(element.id);
    if (element.kind === 'box' && !hasResizeHandles) {
      const port = boxPortCenters(element).find((center) => Math.hypot(center.x - localPoint.x, center.y - localPoint.y) <= portSlop);
      if (port && boxCenter) return { ...hit, part: 'port', port: rotatedAbout(port, boxCenter, boxAngle) };
    }
    if (!isInside(localPoint, shape.rect)) return null;
    if (shape.mediaRect && element.kind === 'box' && element.media && isInside(localPoint, shape.mediaRect)) {
      const href = element.media.kind === 'image' ? servedAssetHref(element.media) ?? '' : '';
      return { ...hit, part: 'media', media: { href, alt: element.media.alt } };
    }
    const lineIndex = shape.text.lines.findIndex((lineRect) => isInside(localPoint, lineRect));
    if (lineIndex >= 0) return { ...hit, part: 'line', lineIndex };
    if (shape.text.emptyBody && isInside(localPoint, shape.text.emptyBody)) return { ...hit, part: 'emptyBody' };
    return hit;
  }

  function hitTest(point: Point): BoardHit | null {
    const current = scene;
    if (!current) return null;
    const slop = HIT_TOLERANCE_PX / camera.scale;
    const handleHit = handleHitAt(current, point, slop);
    if (handleHit) return handleHit;
    const wireEndHit = wireEndHitAt(current, point, slop);
    if (wireEndHit) return wireEndHit;
    const wireBendHit = wireBendHitAt(current, point, slop);
    if (wireBendHit) return wireBendHit;
    const portReach = PORT_RADIUS + slop;
    let best: BoardHit | null = null;
    let bestRank = -1;
    const considerHit = (geometry: ElementGeometry): void => {
      if (geometry.paintRank <= bestRank) return;
      const hit = hitPartOf(current, geometry, point, slop);
      if (!hit) return;
      best = hit;
      bestRank = geometry.paintRank;
    };
    forEachSlotTouching(current.grid, { x: point.x - portReach, y: point.y - portReach, width: portReach * 2, height: portReach * 2 }, (slot) => {
      const geometry = current.geometries[slot];
      if (geometry && !preview?.hiddenIds.has(geometry.id)) considerHit(geometry);
    });
    for (const geometry of preview?.geometries ?? []) considerHit(geometry);
    return best;
  }

  function boundsOf(elementId: string): Rect | null {
    const current = scene;
    if (!current) return null;
    const element = elementOf(current, elementId);
    if (element && element.kind !== 'wire') return { x: element.x, y: element.y, width: element.width, height: element.height };
    const previewGeometry = preview?.geometries.find((geometry) => geometry.id === elementId);
    if (previewGeometry) return previewGeometry.bounds;
    const index = current.geometryIndexById.get(elementId);
    return index === undefined ? null : (current.geometries[index]?.bounds ?? null);
  }

  function boxTextRectsOf(boxId: string): BoxTextRects | null {
    const current = scene;
    const index = current?.geometryIndexById.get(boxId);
    const hitShape = index === undefined ? null : current?.geometries[index]?.hitShape;
    return hitShape?.kind === 'rect' ? hitShape.text : null;
  }

  function boxIdsAt(point: Point): string[] {
    const current = scene;
    if (!current) return [];
    const boxIds: string[] = [];
    forEachSlotTouching(current.grid, { x: point.x, y: point.y, width: 1, height: 1 }, (slot) => {
      const element = current.elementById.get(current.geometries[slot]?.id ?? '');
      const isUnderPoint = element?.kind === 'box' && point.x >= element.x && point.x <= element.x + element.width && point.y >= element.y && point.y <= element.y + element.height;
      if (element && isUnderPoint && !boxIds.includes(element.id)) boxIds.push(element.id);
    });
    return boxIds;
  }

  function elementsInRect(area: Rect): string[] {
    const current = scene;
    if (!current) return [];
    const inside: string[] = [];
    forEachSlotTouching(current.grid, area, (slot) => {
      const elementId = current.geometries[slot]?.id ?? '';
      const element = preview?.hiddenIds.has(elementId) ? undefined : current.elementById.get(elementId);
      if (element && element.kind !== 'wire' && isRectInside(element, area)) inside.push(element.id);
    });
    for (const element of preview?.elementById.values() ?? []) {
      if (element.kind !== 'wire' && isRectInside(element, area)) inside.push(element.id);
    }
    return inside;
  }

  function clear(): void {
    stopStackMotion();
    if (stackFan?.frameRequest != null) cancelAnimationFrame(stackFan.frameRequest);
    stackFan = null;
    scene = null;
    preview = null;
    lastRendered = null;
    blocks = [];
    postedBlocks = null;
    geometryIdsInWorker = new Set();
    postPaint({ kind: 'clear' });
    lastViewKey = '';
    reportView();
    geometryBySignature.clear();
    mediaImages.clear();
    mediaLayer.clear();
    hoveredBoxId = null;
    wireTargetId = null;
    isGatherDirty = true;
    requestDraw();
  }

  const canvasResizeObserver = new ResizeObserver(() => {
    reportView();
    isGatherDirty = true;
    requestDraw();
  });

  paintWorker.addEventListener('message', (event: MessageEvent<PaintReport>) => {
    canvas.dataset.drawnElements = String(event.data.drawnElements);
    canvas.dataset.drawnBlocks = String(event.data.drawnBlocks);
    canvas.dataset.mediaTextures = String(event.data.mediaTextures);
  });
  reducedMotion.addEventListener('change', syncFlowLayer);
  canvasResizeObserver.observe(canvas);
  const requestDrawOnThemeChange = (): void => {
    if (scene && paletteKey(viewport) !== resolvedPaletteKey) requestDraw();
  };
  new MutationObserver(requestDrawOnThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  new MutationObserver(requestDrawOnThemeChange).observe(viewport, { attributes: true, attributeFilter: ['class'] });

  return {
    render,
    renderLayout,
    layout: () => lastRendered?.layout ?? null,
    paintElements: (elements) => {
      stopStackMotion();
      if (stackFan?.frameRequest != null) cancelAnimationFrame(stackFan.frameRequest);
      stackFan = null;
      paintElements(elements);
    },
    setCamera: (nextCamera) => {
      camera = nextCamera;
      placeGrid();
      reportView();
      requestDraw();
    },
    resendView: () => {
      lastViewKey = '';
      reportView();
    },
    hitTest,
    boundsOf,
    boxTextRectsOf,
    elementsInRect,
    boxIdsAt,
    setSelection: (nextSelectedIds) => {
      selectedIds = nextSelectedIds;
      refreshDecorations();
    },
    setReviewMarks: (marks) => {
      reviewMarks = marks;
      refreshDecorations();
    },
    setWireTarget: (boxId) => {
      if (wireTargetId === boxId) return;
      wireTargetId = boxId;
      refreshDecorations();
    },
    setLinkResolver: (resolve) => {
      resolveLinkedIds = resolve;
      refreshDecorations();
    },
    setHover: (boxId) => {
      if (hoveredBoxId === boxId) return;
      hoveredBoxId = boxId;
      refreshDecorations();
      fanStack(hoveredStackFrameId(boxId));
    },
    clear,
  };
}

export type { BoardHit, BoardRenderer, Camera, WireEndName };
