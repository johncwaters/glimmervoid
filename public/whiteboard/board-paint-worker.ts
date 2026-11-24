import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { forgetMeasuredFonts, paintImage, paintRects, paintSegments, paintTexts, paintTriangles, setWorldTransform } from './board-canvas-painter.ts';
import type { PaintView } from './board-canvas-painter.ts';
import { createFlowPainter } from './board-flow-layer.ts';
import type { FlowPainter } from './board-flow-layer.ts';
import { BOX_LAYER, LAYER_COUNT } from './board-gl-scene.ts';
import type { GeometryPart, Rgba } from './board-gl-scene.ts';
import type { DrawnMedia, PaintCamera, PaintCommand, PaintedBlock, PaintReport, PreviewEntry } from './board-paint-protocol.ts';

interface PaintEntry {
  parts: GeometryPart[];
  depth: number;
  bounds: Rect | null;
  media: DrawnMedia | null;
}

interface WorkerCanvases {
  board: OffscreenCanvas;
  boardContext: OffscreenCanvasRenderingContext2D;
  decorations: OffscreenCanvas;
  decorationContext: OffscreenCanvasRenderingContext2D;
  flowPainter: FlowPainter;
}

type PaintedCanvas = 'board' | 'decorations' | 'flow';

interface TintedBlock {
  raster: Uint8Array;
  tintKey: string;
  surface: OffscreenCanvas;
}

const BLOCK_ALPHA = 0.85;
const NO_INDEXES: Uint32Array = new Uint32Array(0);

let canvases: WorkerCanvases | null = null;
let camera: PaintCamera = { x: 0, y: 0, scale: 1 };
let pixelRatio = 1;
let cssWidth = 1;
let cssHeight = 1;
let fontFamily = 'monospace';
const addedFontFaces = new Set<string>();
const partsByLayerById = new Map<number, Map<number, GeometryPart[]>>();
let geometryIdByIndex: Uint32Array = NO_INDEXES;
let depthByIndex: Float32Array = new Float32Array(0);
let boundsByIndex: Float32Array = new Float32Array(0);
let chromeByLayer = new Map<number, GeometryPart[]>();
let gatheredIndexes: Uint32Array = NO_INDEXES;
let pendingScene: Extract<PaintCommand, { kind: 'scene' }> | null = null;
let hiddenIndexes = new Set<number>();
let mediaByIndex = new Map<number, DrawnMedia>();
let previewEntries: PreviewEntry[] = [];
let entriesByLayer: PaintEntry[][] = emptyLayers();
let blocks: PaintedBlock[] = [];
let blockTint: Rgba = [0, 0, 0, 0];
let blockRasterPx = 0;
const tintedBlocks = new Map<string, TintedBlock>();
let decorationPart: GeometryPart | null = null;
const mediaBitmaps = new Map<string, ImageBitmap>();
const pendingPaints = new Set<PaintedCanvas>(['board', 'decorations', 'flow']);
let frameRequest: number | null = null;
let lastReportKey = '';

function emptyLayers(): PaintEntry[][] {
  return Array.from({ length: LAYER_COUNT }, () => []);
}

function boundsAt(index: number): Rect {
  const at = index * 4;
  return { x: boundsByIndex[at] ?? 0, y: boundsByIndex[at + 1] ?? 0, width: boundsByIndex[at + 2] ?? 0, height: boundsByIndex[at + 3] ?? 0 };
}

function isTouching(bounds: Rect, area: Rect): boolean {
  return bounds.x <= area.x + area.width && bounds.x + bounds.width >= area.x && bounds.y <= area.y + area.height && bounds.y + bounds.height >= area.y;
}

function rebuildEntries(): void {
  const rebuilt = emptyLayers();
  for (const [layer, parts] of chromeByLayer) rebuilt[layer]?.push({ parts, depth: 0, bounds: null, media: null });
  for (const index of gatheredIndexes) {
    if (hiddenIndexes.has(index)) continue;
    const partsByLayer = partsByLayerById.get(geometryIdByIndex[index] ?? -1);
    if (!partsByLayer) continue;
    const depth = depthByIndex[index] ?? 0;
    const bounds = boundsAt(index);
    const media = mediaByIndex.get(index) ?? null;
    for (let layer = 0; layer < LAYER_COUNT; layer += 1) {
      const parts = partsByLayer.get(layer) ?? [];
      const layerMedia = layer === BOX_LAYER ? media : null;
      if (parts.length === 0 && !layerMedia) continue;
      rebuilt[layer]?.push({ parts, depth, bounds, media: layerMedia });
    }
  }
  for (const preview of previewEntries) {
    const target = rebuilt[preview.layer];
    if (!target) continue;
    target.push({ parts: preview.parts, depth: preview.depth, bounds: null, media: preview.media });
  }
  if (previewEntries.length > 0) {
    for (const layerEntries of rebuilt) layerEntries.sort((first, second) => first.depth - second.depth);
  }
  entriesByLayer = rebuilt;
}

function paintView(): PaintView {
  return { cameraX: camera.x, cameraY: camera.y, deviceScale: camera.scale * pixelRatio, lodScale: camera.scale };
}

function viewArea(): Rect {
  return { x: camera.x, y: camera.y, width: Math.max(cssWidth, 1) / camera.scale, height: Math.max(cssHeight, 1) / camera.scale };
}

function fitCanvas(canvas: OffscreenCanvas): void {
  const width = Math.max(1, Math.round(cssWidth * pixelRatio));
  const height = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
}

function tintedBlockOf(block: PaintedBlock): OffscreenCanvas | null {
  const tintKey = blockTint.join(',');
  const known = tintedBlocks.get(block.id);
  if (known?.raster === block.raster && known.tintKey === tintKey) return known.surface;
  if (block.raster.length !== blockRasterPx * blockRasterPx * 4) return null;
  const surface = known?.surface ?? new OffscreenCanvas(blockRasterPx, blockRasterPx);
  const surfaceContext = surface.getContext('2d');
  if (!surfaceContext) return null;
  surfaceContext.globalCompositeOperation = 'source-over';
  surfaceContext.clearRect(0, 0, blockRasterPx, blockRasterPx);
  surfaceContext.putImageData(new ImageData(new Uint8ClampedArray(block.raster), blockRasterPx, blockRasterPx), 0, 0);
  surfaceContext.globalCompositeOperation = 'source-in';
  surfaceContext.fillStyle = `rgba(${Math.round(blockTint[0] * 255)},${Math.round(blockTint[1] * 255)},${Math.round(blockTint[2] * 255)},${BLOCK_ALPHA})`;
  surfaceContext.fillRect(0, 0, blockRasterPx, blockRasterPx);
  surfaceContext.globalCompositeOperation = 'source-over';
  tintedBlocks.set(block.id, { raster: block.raster, tintKey, surface });
  return surface;
}

function placedMediaOf(drawn: DrawnMedia, image: { width: number; height: number }): { rect: Rect; uv: Rect } {
  const widthRatio = drawn.rect.width / image.width;
  const heightRatio = drawn.rect.height / image.height;
  if (drawn.fit === 'fill') {
    const cover = Math.max(widthRatio, heightRatio);
    const uvWidth = drawn.rect.width / (image.width * cover);
    const uvHeight = drawn.rect.height / (image.height * cover);
    return { rect: drawn.rect, uv: { x: (1 - uvWidth) / 2, y: (1 - uvHeight) / 2, width: uvWidth, height: uvHeight } };
  }
  const contain = Math.min(widthRatio, heightRatio);
  const width = image.width * contain;
  const height = image.height * contain;
  return { rect: { x: drawn.rect.x + (drawn.rect.width - width) / 2, y: drawn.rect.y + (drawn.rect.height - height) / 2, width, height }, uv: { x: 0, y: 0, width: 1, height: 1 } };
}

function paintEntry(target: OffscreenCanvasRenderingContext2D, entry: PaintEntry, view: PaintView): void {
  for (const part of entry.parts) paintTriangles(target, part.triangles, view);
  for (const part of entry.parts) paintRects(target, part.rects, view);
  for (const part of entry.parts) paintSegments(target, part.segments, view);
  const bitmap = entry.media ? mediaBitmaps.get(entry.media.href) : undefined;
  if (entry.media && bitmap) paintImage(target, bitmap, bitmap.width, bitmap.height, placedMediaOf(entry.media, bitmap), entry.media.clipRadius, entry.media.turn);
  for (const part of entry.parts) {
    if (part.texts.length === 0 || part.textMinScale > view.lodScale) continue;
    paintTexts(target, part.texts, fontFamily, view);
  }
}

function paintBoard(target: WorkerCanvases): void {
  fitCanvas(target.board);
  const context = target.boardContext;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, target.board.width, target.board.height);
  const view = paintView();
  setWorldTransform(context, view);
  if (blocks.length > 0) {
    context.imageSmoothingEnabled = false;
    for (const block of blocks) {
      const surface = tintedBlockOf(block);
      if (surface) context.drawImage(surface, block.rect.x, block.rect.y, block.rect.width, block.rect.height);
    }
    context.imageSmoothingEnabled = true;
  }
  const visibleArea = viewArea();
  for (const layerEntries of entriesByLayer) {
    for (const entry of layerEntries) {
      if (entry.bounds && !isTouching(entry.bounds, visibleArea)) continue;
      paintEntry(context, entry, view);
    }
  }
  reportPainted();
}

function paintDecorations(target: WorkerCanvases): void {
  fitCanvas(target.decorations);
  const context = target.decorationContext;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, target.decorations.width, target.decorations.height);
  if (!decorationPart || geometryIdByIndex.length === 0) return;
  const view = paintView();
  setWorldTransform(context, view);
  paintEntry(context, { parts: [decorationPart], depth: 1, bounds: null, media: null }, view);
}

function reportPainted(): void {
  const report: PaintReport = { kind: 'painted', drawnElements: geometryIdByIndex.length, drawnBlocks: blocks.length, mediaTextures: mediaBitmaps.size };
  const reportKey = `${report.drawnElements}:${report.drawnBlocks}:${report.mediaTextures}`;
  if (reportKey === lastReportKey) return;
  lastReportKey = reportKey;
  self.postMessage(report);
}

function paintFrame(nowMs: number): void {
  frameRequest = null;
  const target = canvases;
  if (!target) return;
  const painting = new Set(pendingPaints);
  pendingPaints.clear();
  if (painting.has('board')) paintBoard(target);
  if (painting.has('board') || painting.has('decorations')) paintDecorations(target);
  const isFlowMoving = painting.has('flow') && target.flowPainter.paint({ camera, pixelRatio, cssWidth, cssHeight }, nowMs);
  if (!isFlowMoving) return;
  pendingPaints.add('flow');
  requestFrame();
}

function requestFrame(): void {
  if (frameRequest !== null) return;
  frameRequest = requestAnimationFrame(paintFrame);
}

function markAllDirty(): void {
  pendingPaints.add('board');
  pendingPaints.add('decorations');
  pendingPaints.add('flow');
  requestFrame();
}

function workerFontSet(): FontFaceSet | null {
  const fonts: unknown = Reflect.get(self, 'fonts');
  return fonts instanceof FontFaceSet ? fonts : null;
}

function loadFonts(command: Extract<PaintCommand, { kind: 'fonts' }>): void {
  fontFamily = command.fontFamily;
  const fonts = workerFontSet();
  if (!fonts) return;
  for (const face of command.faces) {
    const faceKey = `${face.family}|${face.weight}|${face.style}|${face.unicodeRange}|${face.source}`;
    if (addedFontFaces.has(faceKey)) continue;
    addedFontFaces.add(faceKey);
    fonts.add(new FontFace(face.family, `url("${face.source}")`, { weight: face.weight, style: face.style, unicodeRange: face.unicodeRange }));
  }
  void Promise.all([fonts.load(`400 16px ${fontFamily}`), fonts.load(`700 16px ${fontFamily}`)]).then(() => {
    forgetMeasuredFonts();
    markAllDirty();
  }, () => {});
}

function adoptCanvases(command: Extract<PaintCommand, { kind: 'canvases' }>): void {
  const boardContext = command.board.getContext('2d');
  const decorationContext = command.decorations.getContext('2d');
  if (!boardContext || !decorationContext) return;
  canvases = { board: command.board, boardContext, decorations: command.decorations, decorationContext, flowPainter: createFlowPainter(command.flow) };
  command.board.addEventListener('contextrestored', () => {
    tintedBlocks.clear();
    markAllDirty();
  });
  command.decorations.addEventListener('contextrestored', markAllDirty);
  command.flow.addEventListener('contextrestored', markAllDirty);
}

function adoptScene(command: Extract<PaintCommand, { kind: 'scene' }>): void {
  for (const geometry of command.newGeometries) partsByLayerById.set(geometry.geometryId, new Map(geometry.partsByLayer));
  const keptIds = new Set(command.geometryIdByIndex);
  for (const geometryId of partsByLayerById.keys()) {
    if (!keptIds.has(geometryId)) partsByLayerById.delete(geometryId);
  }
  geometryIdByIndex = command.geometryIdByIndex;
  depthByIndex = command.depthByIndex;
  boundsByIndex = command.boundsByIndex;
  chromeByLayer = new Map(command.chrome);
}

function clearAll(): void {
  pendingScene = null;
  partsByLayerById.clear();
  geometryIdByIndex = NO_INDEXES;
  depthByIndex = new Float32Array(0);
  boundsByIndex = new Float32Array(0);
  chromeByLayer = new Map();
  gatheredIndexes = NO_INDEXES;
  hiddenIndexes = new Set();
  mediaByIndex = new Map();
  previewEntries = [];
  blocks = [];
  tintedBlocks.clear();
  decorationPart = null;
  for (const bitmap of mediaBitmaps.values()) bitmap.close();
  mediaBitmaps.clear();
  canvases?.flowPainter.sync([], false);
  rebuildEntries();
}

function apply(command: PaintCommand): void {
  switch (command.kind) {
    case 'canvases':
      adoptCanvases(command);
      markAllDirty();
      return;
    case 'view':
      camera = command.camera;
      pixelRatio = command.pixelRatio;
      cssWidth = command.cssWidth;
      cssHeight = command.cssHeight;
      markAllDirty();
      return;
    case 'fonts':
      loadFonts(command);
      return;
    case 'scene':
      pendingScene = command;
      return;
    case 'gather':
      if (pendingScene) adoptScene(pendingScene);
      pendingScene = null;
      gatheredIndexes = command.sceneIndexes;
      mediaByIndex = new Map(command.mediaByIndex);
      hiddenIndexes = new Set(command.hiddenIndexes);
      rebuildEntries();
      pendingPaints.add('board');
      return;
    case 'preview':
      previewEntries = command.entries;
      rebuildEntries();
      pendingPaints.add('board');
      return;
    case 'blocks': {
      const keptIds = new Set(command.blocks.map((block) => block.id));
      for (const blockId of tintedBlocks.keys()) {
        if (!keptIds.has(blockId)) tintedBlocks.delete(blockId);
      }
      blocks = command.blocks;
      blockTint = command.tint;
      blockRasterPx = command.rasterPx;
      pendingPaints.add('board');
      return;
    }
    case 'decorations':
      decorationPart = command.part;
      pendingPaints.add('decorations');
      return;
    case 'flows':
      canvases?.flowPainter.sync(command.wires, command.isMotionReduced);
      pendingPaints.add('flow');
      return;
    case 'media':
      mediaBitmaps.get(command.href)?.close();
      mediaBitmaps.set(command.href, command.bitmap);
      pendingPaints.add('board');
      return;
    case 'media-dropped':
      for (const href of command.hrefs) {
        mediaBitmaps.get(href)?.close();
        mediaBitmaps.delete(href);
      }
      pendingPaints.add('board');
      return;
    case 'clear':
      clearAll();
      markAllDirty();
      return;
  }
}

self.addEventListener('message', (event: MessageEvent<PaintCommand>) => {
  apply(event.data);
  requestFrame();
});
