import { boardMediaDrawnFilename, NOTE_TONE_HEX, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { NoteTone } from '#shared/contracts/whiteboard.ts';
import { BLOCK_RASTER_PX } from '#shared/contracts/whiteboard-tiles.ts';
import type { Board } from '#shared/contracts/whiteboard.ts';
import { elementSignature, layoutBoard } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutMedia, Rect, ResizeHandle } from '#shared/whiteboard-layout-core.ts';
import { forEachSlotTouching, gridOfRects } from '#shared/spatial-grid-core.ts';
import { PORT_RADIUS } from '#shared/whiteboard-svg-core.ts';
import { DEVICE_CATALOG } from '#shared/whiteboard-devices.ts';
import { wireHandlesOf } from '#shared/whiteboard-route-core.ts';
import type { WireHandle } from '#shared/whiteboard-route-core.ts';
import type { DeviceFit } from '#shared/whiteboard-devices.ts';
import type { BoardMediaLayer } from './board-media-layer.ts';
import type { BlockTile } from './board-tile-store.ts';
import { createGlyphAtlas, RASTER_PX } from './board-gl-glyphs.ts';
import type { GlyphAtlas } from './board-gl-glyphs.ts';
import {
  BOX_LAYER, GLYPH_FLOATS, LAYER_COUNT, RECT_FLOATS, SEGMENT_FLOATS, TRIANGLE_VERTEX_FLOATS,
  boxPortCenters, decorationPart, resizeHandleRectsOf, sceneOf,
} from './board-gl-scene.ts';
import type { BoardPalette, BoxTextRects, Decoration, ElementGeometry, GeometryPart, Point, Rgba, SceneContext } from './board-gl-scene.ts';
import { FANNED_STACK_SPREAD, STACK_FAN_MS, STACK_MOTION_MS, easedProgress, movedBoxesAt, stackFrameOfTopCard, stackMovesBetween } from './stack-motion-core.ts';
import { STACK_SPREAD } from '#shared/whiteboard-layout-core.ts';
import { rectAround } from './board-snap-core.ts';
import type { StackMove } from './stack-motion-core.ts';
import { prefersReducedMotion } from '../attention-banner.ts';
import type { BoardGraphicsEvent, BoardGraphicsEventKind } from './board-graphics-report-core.ts';

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface ReviewMarks {
  worthALookIds: ReadonlySet<string>;
  flaggedStepIds: ReadonlySet<string>;
}

type HitPart = 'body' | 'line' | 'emptyBody' | 'port' | 'resize' | 'media' | 'end' | 'bend';
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
  hitTest(point: Point): BoardHit | null;
  boundsOf(elementId: string): Rect | null;
  boxTextRectsOf(boxId: string): BoxTextRects | null;
  elementsInRect(area: Rect): string[];
  boxIdsAt(point: Point): string[];
  setSelection(selectedIds: ReadonlySet<string>): void;
  setReviewMarks(marks: ReviewMarks): void;
  setWireTarget(boxId: string | null): void;
  setHover(boxId: string | null): void;
  clear(): void;
}

interface RendererOptions {
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  fontSource: Element;
  mediaLayer: BoardMediaLayer;
  notice: HTMLElement;
  onViewChange?: (view: Rect, scale: number) => void;
  onGraphicsEvent?: (event: BoardGraphicsEvent) => void;
}

interface AttributeSpec {
  location: number;
  size: number;
  offset: number;
}

interface PrimitiveProgram {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  bufferFloats: number;
  strideFloats: number;
  attributes: readonly AttributeSpec[];
  isInstanced: boolean;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface GrowableFloats {
  data: Float32Array;
  length: number;
}

interface LayerRange {
  rectStart: number;
  rectCount: number;
  segmentStart: number;
  segmentCount: number;
  triangleStart: number;
  triangleCount: number;
  glyphStart: number;
  glyphCount: number;
}

interface MediaTexture {
  href: string;
  texture: WebGLTexture | null;
  width: number;
  height: number;
  image: HTMLImageElement | null;
  isFailed: boolean;
  textureBytes: number;
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

const NO_REVIEW_MARKS: ReviewMarks = { worthALookIds: new Set(), flaggedStepIds: new Set() };
const CULL_CELL_SIZE = 512;
const CONTEXT_RETRY_MS = 5000;
const REFUSAL_MAX_RETRIES = 30;
const NOTICES = {
  redrawing: 'The board is redrawing after the graphics card reset.',
  paused: 'The browser paused graphics for this site, often after graphics card resets. The board keeps trying and draws again as soon as the browser allows it.',
  blocked: 'The browser refused graphics for this site. Turn on graphics acceleration in the browser settings, or restart the browser, to draw boards again.',
  unsupported: 'This browser cannot draw boards: WebGL2 is turned off or unavailable.',
} as const;
type NoticeKind = keyof typeof NOTICES;
const GATHER_MARGIN_FACTOR = 0.75;
const LOD_STEPS_PER_OCTAVE = 4;
const HIT_TOLERANCE_PX = 7;
const FRAME_EDGE_TOLERANCE_PX = 6;
const PORT_HIT_SLOP_PX = 3;
const DECORATION_LAYER = LAYER_COUNT;
const INITIAL_FLOATS = 4096;

const VERTEX_HEADER = `#version 300 es
precision highp float;
uniform vec2 uCamera;
uniform float uScale;
uniform vec2 uResolution;
uniform float uLodScale;
vec4 clipOf(vec2 world, float depth) {
  vec2 device = (world - uCamera) * uScale;
  return vec4(device.x / uResolution.x * 2.0 - 1.0, 1.0 - device.y / uResolution.y * 2.0, depth * 2.0 - 1.0, 1.0);
}
const vec4 HIDDEN = vec4(2.0, 2.0, 2.0, 1.0);
`;

const RECT_VERTEX = `${VERTEX_HEADER}
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec2 aShape;
layout(location = 3) in vec4 aFill;
layout(location = 4) in vec4 aStroke;
layout(location = 5) in float aMinScale;
layout(location = 6) in float aDepth;
out vec2 vLocal;
out vec2 vHalf;
out vec2 vShape;
out vec4 vFill;
out vec4 vStroke;
void main() {
  if (uLodScale < aMinScale) { gl_Position = HIDDEN; return; }
  vec2 halfSize = aRect.zw * 0.5;
  float pad = aShape.y * 0.5 + 2.0 / uScale;
  vec2 local = (aCorner * 2.0 - 1.0) * (halfSize + pad);
  vLocal = local * uScale;
  vHalf = halfSize * uScale;
  vShape = aShape * uScale;
  vFill = aFill;
  vStroke = aStroke;
  gl_Position = clipOf(aRect.xy + halfSize + local, aDepth);
}`;

const RECT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vHalf;
in vec2 vShape;
in vec4 vFill;
in vec4 vStroke;
out vec4 outColor;
void main() {
  float radius = min(vShape.x, min(vHalf.x, vHalf.y));
  vec2 corner = abs(vLocal) - vHalf + radius;
  float distance = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - radius;
  float strokePx = vShape.y > 0.0 ? max(vShape.y, 1.0) : 0.0;
  float strokeFade = min(vShape.y, 1.0);
  float fillAlpha = clamp(0.5 - distance, 0.0, 1.0);
  float strokeAlpha = strokePx > 0.0 ? clamp(strokePx * 0.5 + 0.5 - abs(distance), 0.0, 1.0) * strokeFade : 0.0;
  vec4 stroke = vec4(vStroke.rgb * vStroke.a, vStroke.a) * strokeAlpha;
  vec4 fill = vec4(vFill.rgb * vFill.a, vFill.a) * fillAlpha;
  outColor = stroke + fill * (1.0 - stroke.a);
  if (outColor.a <= 0.0) discard;
}`;

const SEGMENT_VERTEX = `${VERTEX_HEADER}
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aEnds;
layout(location = 2) in vec4 aStyle;
layout(location = 3) in vec4 aColor;
layout(location = 4) in float aMinScale;
layout(location = 5) in float aDepth;
out float vAlong;
out float vAcross;
out float vWidthPx;
out float vFade;
out vec2 vDash;
out vec4 vColor;
void main() {
  if (uLodScale < aMinScale) { gl_Position = HIDDEN; return; }
  vec2 delta = aEnds.zw - aEnds.xy;
  float segmentLength = length(delta);
  vec2 direction = segmentLength > 0.0 ? delta / segmentLength : vec2(1.0, 0.0);
  vec2 normal = vec2(-direction.y, direction.x);
  float widthPx = max(aStyle.x * uScale, 1.0);
  float halfWorld = (widthPx * 0.5 + 1.0) / uScale;
  float cap = aStyle.x * 0.5;
  float along = mix(-cap, segmentLength + cap, aCorner.x);
  float across = (aCorner.y * 2.0 - 1.0) * halfWorld;
  vAlong = along + aStyle.w;
  vAcross = across * uScale;
  vWidthPx = widthPx;
  vFade = min(aStyle.x * uScale, 1.0);
  vDash = aStyle.yz;
  vColor = aColor;
  gl_Position = clipOf(aEnds.xy + direction * along + normal * across, aDepth);
}`;

const SEGMENT_FRAGMENT = `#version 300 es
precision highp float;
in float vAlong;
in float vAcross;
in float vWidthPx;
in float vFade;
in vec2 vDash;
in vec4 vColor;
out vec4 outColor;
void main() {
  if (vDash.x > 0.0 && mod(vAlong, vDash.x + vDash.y) > vDash.x) discard;
  float alpha = clamp(vWidthPx * 0.5 + 0.5 - abs(vAcross), 0.0, 1.0) * vFade * vColor.a;
  if (alpha <= 0.0) discard;
  outColor = vec4(vColor.rgb * alpha, alpha);
}`;

const TRIANGLE_VERTEX = `${VERTEX_HEADER}
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec4 aColor;
layout(location = 2) in float aMinScale;
layout(location = 3) in float aDepth;
out vec4 vColor;
void main() {
  if (uLodScale < aMinScale) { gl_Position = HIDDEN; return; }
  vColor = aColor;
  gl_Position = clipOf(aPosition, aDepth);
}`;

const TRIANGLE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor.rgb * vColor.a, vColor.a);
}`;

const GLYPH_VERTEX = `${VERTEX_HEADER}
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aQuad;
layout(location = 2) in vec4 aUv;
layout(location = 3) in float aPage;
layout(location = 4) in vec4 aColor;
layout(location = 5) in float aMinScale;
layout(location = 6) in float aDepth;
out vec3 vUv;
out vec4 vColor;
void main() {
  if (uLodScale < aMinScale) { gl_Position = HIDDEN; return; }
  vUv = vec3(mix(aUv.xy, aUv.zw, aCorner), aPage);
  vColor = aColor;
  gl_Position = clipOf(aQuad.xy + aCorner * aQuad.zw, aDepth);
}`;

const GLYPH_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
in vec3 vUv;
in vec4 vColor;
out vec4 outColor;
void main() {
  float coverage = texture(uAtlas, vUv).r * vColor.a;
  if (coverage <= 0.0) discard;
  outColor = vec4(vColor.rgb * coverage, coverage);
}`;

const IMAGE_VERTEX = `${VERTEX_HEADER}
layout(location = 0) in vec2 aCorner;
uniform vec4 uRect;
uniform vec4 uUvRect;
uniform float uDepth;
out vec2 vUv;
out vec2 vCorner;
void main() {
  vUv = uUvRect.xy + aCorner * uUvRect.zw;
  vCorner = aCorner;
  gl_Position = clipOf(uRect.xy + aCorner * uRect.zw, uDepth);
}`;

const IMAGE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec4 uRect;
uniform float uScale;
uniform float uClipRadius;
in vec2 vUv;
in vec2 vCorner;
out vec4 outColor;
void main() {
  vec2 halfSize = uRect.zw * 0.5;
  float radius = min(uClipRadius, min(halfSize.x, halfSize.y));
  vec2 corner = abs((vCorner - 0.5) * uRect.zw) - halfSize + radius;
  float distance = (length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - radius) * uScale;
  float clipAlpha = clamp(0.5 - distance, 0.0, 1.0);
  vec4 color = texture(uImage, vUv) * clipAlpha;
  if (color.a <= 0.0) discard;
  outColor = vec4(color.rgb * color.a, color.a);
}`;

const BLOCK_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec4 uTint;
in vec2 vUv;
out vec4 outColor;
void main() {
  float alpha = texture(uImage, vUv).a * uTint.a;
  outColor = vec4(uTint.rgb * alpha, alpha);
}`;

const BLOCK_ALPHA = 0.85;

const RECT_ATTRIBUTES: readonly AttributeSpec[] = [{ location: 1, size: 4, offset: 0 }, { location: 2, size: 2, offset: 4 }, { location: 3, size: 4, offset: 6 }, { location: 4, size: 4, offset: 10 }, { location: 5, size: 1, offset: 14 }, { location: 6, size: 1, offset: 15 }];
const SEGMENT_ATTRIBUTES: readonly AttributeSpec[] = [{ location: 1, size: 4, offset: 0 }, { location: 2, size: 4, offset: 4 }, { location: 3, size: 4, offset: 8 }, { location: 4, size: 1, offset: 12 }, { location: 5, size: 1, offset: 13 }];
const TRIANGLE_ATTRIBUTES: readonly AttributeSpec[] = [{ location: 0, size: 2, offset: 0 }, { location: 1, size: 4, offset: 2 }, { location: 2, size: 1, offset: 6 }, { location: 3, size: 1, offset: 7 }];
const GLYPH_ATTRIBUTES: readonly AttributeSpec[] = [{ location: 1, size: 4, offset: 0 }, { location: 2, size: 4, offset: 4 }, { location: 3, size: 1, offset: 8 }, { location: 4, size: 4, offset: 9 }, { location: 5, size: 1, offset: 13 }, { location: 6, size: 1, offset: 14 }];
const UNIFORM_NAMES = ['uCamera', 'uScale', 'uResolution', 'uLodScale', 'uAtlas', 'uRect', 'uImage', 'uDepth', 'uTint', 'uUvRect', 'uClipRadius'] as const;

const UNSIZED_MEDIA_EDGE_PX = 1024;
const MEDIA_TEXTURE_BUDGET_BYTES = 128 * 1024 * 1024;
const MIPMAPPED_BYTES_PER_PIXEL = 4 * (4 / 3);

interface DrawnMedia {
  href: string;
  rect: Rect;
  fit: DeviceFit;
  clipRadius: number;
  depth: number;
}

function placedMediaOf(drawn: DrawnMedia, image: { width: number; height: number }): { rect: Rect; uv: Rect } {
  const fullUv = { x: 0, y: 0, width: 1, height: 1 };
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
  return { rect: { x: drawn.rect.x + (drawn.rect.width - width) / 2, y: drawn.rect.y + (drawn.rect.height - height) / 2, width, height }, uv: fullUv };
}

function servedAssetHref(media: LaidOutMedia): string | null {
  const drawnFilename = boardMediaDrawnFilename(media);
  return drawnFilename ? `${WHITEBOARD_ASSET_ROUTE}/${drawnFilename}` : null;
}

function growableFloats(): GrowableFloats {
  return { data: new Float32Array(INITIAL_FLOATS), length: 0 };
}

function appendFloats(target: GrowableFloats, values: Float32Array, strideFloats: number, depth: number): void {
  const start = target.length;
  const needed = start + values.length;
  if (needed > target.data.length) {
    const grown = new Float32Array(Math.max(needed, target.data.length * 2));
    grown.set(target.data.subarray(0, start));
    target.data = grown;
  }
  target.data.set(values, start);
  for (let depthIndex = start + strideFloats - 1; depthIndex < needed; depthIndex += strideFloats) target.data[depthIndex] = depth;
  target.length = needed;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('the GPU refused a whiteboard shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) || gl.isContextLost()) return shader;
  throw new Error(`a whiteboard shader did not compile: ${gl.getShaderInfoLog(shader) ?? ''}`);
}

function linkProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) || gl.isContextLost()) return program;
  throw new Error(`a whiteboard shader did not link: ${gl.getProgramInfoLog(program) ?? ''}`);
}

function createPrimitive(gl: WebGL2RenderingContext, corners: WebGLBuffer, sources: readonly [string, string], strideFloats: number, attributes: readonly AttributeSpec[], isInstanced: boolean): PrimitiveProgram {
  const program = linkProgram(gl, sources[0], sources[1]);
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  if (isInstanced) {
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const attribute of attributes) {
    gl.enableVertexAttribArray(attribute.location);
    if (isInstanced) gl.vertexAttribDivisor(attribute.location, 1);
  }
  gl.bindVertexArray(null);
  const uniforms = new Map(UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)] as const));
  return { program, vao, buffer, bufferFloats: 0, strideFloats, attributes, isInstanced, uniforms };
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

function glyphMinScaleOf(part: GeometryPart): number {
  let lowest = Infinity;
  for (let offset = GLYPH_FLOATS - 2; offset < part.glyphs.length; offset += GLYPH_FLOATS) lowest = Math.min(lowest, part.glyphs[offset] ?? Infinity);
  return lowest;
}

function emptyRange(): LayerRange {
  return { rectStart: 0, rectCount: 0, segmentStart: 0, segmentCount: 0, triangleStart: 0, triangleCount: 0, glyphStart: 0, glyphCount: 0 };
}

function createWebgl2Context(target: HTMLCanvasElement, attributes: WebGLContextAttributes): { context: WebGL2RenderingContext | null; creationError: string | null } {
  let creationError: string | null = null;
  target.addEventListener('webglcontextcreationerror', (event) => {
    if (event instanceof WebGLContextEvent && event.statusMessage) creationError = event.statusMessage;
  }, { once: true });
  const context = target.getContext('webgl2', attributes);
  return { context, creationError };
}

function isWebgl2Missing(): boolean {
  return typeof WebGL2RenderingContext === 'undefined';
}

export function createBoardRenderer(options: RendererOptions): BoardRenderer {
  const { viewport, mediaLayer, notice, onViewChange, onGraphicsEvent } = options;
  let canvas = options.canvas;
  const contextAttributes: WebGLContextAttributes = { alpha: true, antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: false };
  const initialContext = createWebgl2Context(canvas, contextAttributes);
  let gl: WebGL2RenderingContext | null = initialContext.context;
  let primitives: { rect: PrimitiveProgram; segment: PrimitiveProgram; triangle: PrimitiveProgram; glyph: PrimitiveProgram; image: PrimitiveProgram; block: PrimitiveProgram } | null = null;
  let blocks: readonly BlockTile[] = [];
  const blockTextures = new Map<string, { raster: Uint8Array; texture: WebGLTexture }>();
  let lastViewKey = '';
  let lastRendered: { source: Board | BoardLayout; layout: BoardLayout; blocks: readonly BlockTile[] } | null = null;
  const signatureOfElement = new WeakMap<LaidOutElement, string>();
  let palette: BoardPalette | null = null;
  let resolvedPaletteKey = '';
  let atlas: GlyphAtlas | null = null;
  let atlasFontFamily = '';
  let pendingAtlasFontLoad: Promise<void> | null = null;
  let scene: GlScene | null = null;
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let selectedIds: ReadonlySet<string> = new Set();
  let reviewMarks = NO_REVIEW_MARKS;
  let wireTargetId: string | null = null;
  let hoveredBoxId: string | null = null;
  let frameRequest: number | null = null;
  let isGatherDirty = true;
  let gatheredArea: Rect | null = null;
  let gatheredLodStep = Number.NaN;
  let decorationStart: LayerRange = emptyRange();
  let previewStart: LayerRange = emptyRange();
  let preview: ScenePreview | null = null;
  let stackMotion: { moves: readonly StackMove[]; startMs: number; frameRequest: number } | null = null;
  let stackFan: { frameId: string; fromSpread: number; toSpread: number; spread: number; startMs: number; frameRequest: number | null } | null = null;
  let baseDrawnMediaCount = 0;
  const previewRanges: LayerRange[] = Array.from({ length: LAYER_COUNT }, emptyRange);
  let visibleDrawnMedia: DrawnMedia[] = [];
  const geometryBySignature = new Map<string, ElementGeometry>();
  const glyphMinScaleByPart = new WeakMap<GeometryPart, number>();
  const rects = growableFloats();
  const segments = growableFloats();
  const triangles = growableFloats();
  const glyphs = growableFloats();
  const layerRanges: LayerRange[] = Array.from({ length: LAYER_COUNT + 1 }, emptyRange);
  const mediaTextures = new Map<string, MediaTexture>();
  let gatherNumber = 0;
  let sceneBuildCount = 0;
  let contextRetryTimer: number | null = null;
  let contextState: 'live' | 'lost' | 'blocked' = 'live';
  let lossCount = 0;
  let lastLossAtMs: number | null = null;
  let contextRetries = 0;
  let gpuRenderer: string | null = null;

  function showNotice(kind: NoticeKind | null): void {
    notice.hidden = kind === null;
    if (!kind) return;
    notice.textContent = NOTICES[kind];
  }

  function showRefusal(): void {
    if (isWebgl2Missing()) {
      showNotice('unsupported');
      return;
    }
    if (contextRetries >= REFUSAL_MAX_RETRIES) {
      showNotice('blocked');
      return;
    }
    showNotice('paused');
    scheduleContextRetry();
  }

  function rememberGpuRenderer(context: WebGL2RenderingContext): void {
    const debugRendererInfo = context.getExtension('WEBGL_debug_renderer_info');
    const rendererName: unknown = context.getParameter(debugRendererInfo ? debugRendererInfo.UNMASKED_RENDERER_WEBGL : context.RENDERER);
    if (typeof rendererName === 'string' && rendererName) gpuRenderer = rendererName;
  }

  function reportGraphics(kind: BoardGraphicsEventKind, details: { msSinceLastLoss: number | null; blankMs: number | null; creationError: string | null }): void {
    if (!onGraphicsEvent) return;
    let mediaTextureBytes = 0;
    for (const entry of mediaTextures.values()) mediaTextureBytes += entry.textureBytes;
    onGraphicsEvent({
      kind,
      lossCount,
      ...details,
      retries: contextRetries,
      mediaTextureCount: mediaTextures.size,
      mediaTextureBytes,
      canvasWidthPx: canvas.width,
      canvasHeightPx: canvas.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      isPageVisible: document.visibilityState === 'visible',
      gpuRenderer,
    });
  }

  function settleContextLive(kind: 'restored' | 'recreated'): void {
    const blankMs = lastLossAtMs === null ? null : performance.now() - lastLossAtMs;
    contextState = 'live';
    reportGraphics(kind, { msSinceLastLoss: null, blankMs, creationError: null });
    contextRetries = 0;
  }

  function ensureAtlas(): GlyphAtlas {
    if (atlas) return atlas;
    return createAtlas(getComputedStyle(options.fontSource).fontFamily || 'monospace');
  }

  function ensureAtlasInBoardFont(): GlyphAtlas {
    const fontFamily = getComputedStyle(options.fontSource).fontFamily || 'monospace';
    if (atlas && (atlasFontFamily === fontFamily || !options.fontSource.isConnected)) {
      if (!pendingAtlasFontLoad && !isFontLoaded(atlasFontFamily)) loadAtlasFont(atlas, atlasFontFamily);
      return atlas;
    }
    if (atlas && gl) atlas.release(gl);
    geometryBySignature.clear();
    return createAtlas(fontFamily);
  }

  function createAtlas(fontFamily: string): GlyphAtlas {
    const created = createGlyphAtlas(fontFamily);
    atlas = created;
    atlasFontFamily = fontFamily;
    loadAtlasFont(created, fontFamily);
    return created;
  }

  function isFontLoaded(fontFamily: string): boolean {
    return document.fonts.check(`400 ${RASTER_PX}px ${fontFamily}`) && document.fonts.check(`700 ${RASTER_PX}px ${fontFamily}`);
  }

  function loadAtlasFont(target: GlyphAtlas, fontFamily: string): void {
    const fontLoad = Promise.all([document.fonts.load(`400 ${RASTER_PX}px ${fontFamily}`), document.fonts.load(`700 ${RASTER_PX}px ${fontFamily}`)]).then(() => {
      target.rasterizeAgain();
      requestDraw();
    }, () => {}).finally(() => {
      if (pendingAtlasFontLoad === fontLoad) pendingAtlasFontLoad = null;
    });
    pendingAtlasFontLoad = fontLoad;
  }

  function ensurePalette(): BoardPalette {
    const key = paletteKey(viewport);
    if (palette && key === resolvedPaletteKey) return palette;
    palette = resolvePalette(viewport);
    resolvedPaletteKey = key;
    geometryBySignature.clear();
    return palette;
  }

  function setUpGl(context: WebGL2RenderingContext): void {
    const corners = context.createBuffer();
    context.bindBuffer(context.ARRAY_BUFFER, corners);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), context.STATIC_DRAW);
    primitives = {
      rect: createPrimitive(context, corners, [RECT_VERTEX, RECT_FRAGMENT], RECT_FLOATS, RECT_ATTRIBUTES, true),
      segment: createPrimitive(context, corners, [SEGMENT_VERTEX, SEGMENT_FRAGMENT], SEGMENT_FLOATS, SEGMENT_ATTRIBUTES, true),
      triangle: createPrimitive(context, corners, [TRIANGLE_VERTEX, TRIANGLE_FRAGMENT], TRIANGLE_VERTEX_FLOATS, TRIANGLE_ATTRIBUTES, false),
      glyph: createPrimitive(context, corners, [GLYPH_VERTEX, GLYPH_FRAGMENT], GLYPH_FLOATS, GLYPH_ATTRIBUTES, true),
      image: createPrimitive(context, corners, [IMAGE_VERTEX, IMAGE_FRAGMENT], 2, [], true),
      block: createPrimitive(context, corners, [IMAGE_VERTEX, BLOCK_FRAGMENT], 2, [], true),
    };
    for (const quad of [primitives.image, primitives.block]) {
      context.bindVertexArray(quad.vao);
      context.bindBuffer(context.ARRAY_BUFFER, corners);
      context.enableVertexAttribArray(0);
      context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0);
    }
    context.bindVertexArray(null);
    context.enable(context.BLEND);
    context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
    isGatherDirty = true;
  }

  function createGlOrNotice(): void {
    if (!gl) {
      showRefusal();
      return;
    }
    rememberGpuRenderer(gl);
    setUpGl(gl);
  }

  function viewArea(): Rect {
    const width = (canvas.clientWidth || 1) / camera.scale;
    const height = (canvas.clientHeight || 1) / camera.scale;
    return { x: camera.x, y: camera.y, width, height };
  }

  function lodStepOf(scale: number): number {
    return Math.floor(Math.log2(scale) * LOD_STEPS_PER_OCTAVE);
  }

  function lodUpperScale(step: number): number {
    return 2 ** ((step + 1) / LOD_STEPS_PER_OCTAVE);
  }

  function shouldIncludeGlyphs(part: GeometryPart, upperScale: number): boolean {
    if (part.glyphs.length === 0) return false;
    let lowest = glyphMinScaleByPart.get(part);
    if (lowest === undefined) {
      lowest = glyphMinScaleOf(part);
      glyphMinScaleByPart.set(part, lowest);
    }
    return lowest <= upperScale;
  }

  function appendPart(part: GeometryPart, upperScale: number, depth: number): void {
    appendFloats(rects, part.rects, RECT_FLOATS, depth);
    appendFloats(segments, part.segments, SEGMENT_FLOATS, depth);
    appendFloats(triangles, part.triangles, TRIANGLE_VERTEX_FLOATS, depth);
    if (shouldIncludeGlyphs(part, upperScale)) appendFloats(glyphs, part.glyphs, GLYPH_FLOATS, depth);
  }

  function depthOf(paintRank: number, current: GlScene): number {
    return (paintRank + 1) / (current.geometries.length + 1);
  }

  function startRange(range: LayerRange): void {
    range.rectStart = rects.length / RECT_FLOATS;
    range.segmentStart = segments.length / SEGMENT_FLOATS;
    range.triangleStart = triangles.length / TRIANGLE_VERTEX_FLOATS;
    range.glyphStart = glyphs.length / GLYPH_FLOATS;
  }

  function endRange(range: LayerRange): void {
    range.rectCount = rects.length / RECT_FLOATS - range.rectStart;
    range.segmentCount = segments.length / SEGMENT_FLOATS - range.segmentStart;
    range.triangleCount = triangles.length / TRIANGLE_VERTEX_FLOATS - range.triangleStart;
    range.glyphCount = glyphs.length / GLYPH_FLOATS - range.glyphStart;
  }

  function truncateTo(range: LayerRange): void {
    rects.length = range.rectStart * RECT_FLOATS;
    segments.length = range.segmentStart * SEGMENT_FLOATS;
    triangles.length = range.triangleStart * TRIANGLE_VERTEX_FLOATS;
    glyphs.length = range.glyphStart * GLYPH_FLOATS;
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

  function selectionHandleArea(current: GlScene): { area: Rect; boxId: string } | null {
    const selectedBoxes = [...selectedIds].flatMap((elementId) => {
      const element = elementOf(current, elementId);
      return element?.kind === 'box' ? [element] : [];
    });
    const [firstBox] = selectedBoxes;
    if (!firstBox) return null;
    return { area: rectAround(selectedBoxes), boxId: firstBox.id };
  }

  function handleHitAt(current: GlScene, point: Point, slop: number): BoardHit | null {
    const handleArea = selectionHandleArea(current);
    if (!handleArea) return null;
    const handleSlop = (PORT_HIT_SLOP_PX / HIT_TOLERANCE_PX) * slop;
    const pressed = resizeHandleRectsOf(handleArea.area).find(({ rect }) => isInside(point, rect, handleSlop));
    return pressed ? { id: handleArea.boxId, kind: 'box', part: 'resize', lineIndex: null, port: null, media: null, handle: pressed.handle, end: null, bend: null } : null;
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
    const listed: Decoration[] = [];
    for (const elementId of reviewMarks.flaggedStepIds) {
      const element = elementOf(current, elementId);
      if (element) listed.push({ kind: 'flagged', element });
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
    if (handleArea) listed.push({ kind: 'resize-handles', area: handleArea.area });
    for (const wire of selectedWiresOf(current)) listed.push({ kind: 'wire-ends', wire });
    for (const elementId of reviewMarks.worthALookIds) {
      const element = elementOf(current, elementId);
      if (element && element.kind !== 'wire') listed.push({ kind: 'look', element });
    }
    return listed;
  }

  function writePreview(current: GlScene, currentPalette: BoardPalette, glyphSource: GlyphAtlas): void {
    truncateTo(previewStart);
    visibleDrawnMedia.length = baseDrawnMediaCount;
    const upperScale = lodUpperScale(gatheredLodStep);
    for (let layer = 0; layer < LAYER_COUNT; layer += 1) {
      const range = previewRanges[layer] ?? emptyRange();
      startRange(range);
      for (const geometry of preview?.geometries ?? []) {
        for (const layered of geometry.parts) {
          if (layered.layer === layer) appendPart(layered.part, upperScale, depthOf(geometry.paintRank, current));
        }
        if (layer === BOX_LAYER) collectDrawnMedia(current, geometry);
      }
      endRange(range);
    }
    decorationStart = rangeMarkHere();
    writeDecorations(current, currentPalette, glyphSource);
  }

  function rangeMarkHere(): LayerRange {
    return { ...emptyRange(), rectStart: rects.length / RECT_FLOATS, segmentStart: segments.length / SEGMENT_FLOATS, triangleStart: triangles.length / TRIANGLE_VERTEX_FLOATS, glyphStart: glyphs.length / GLYPH_FLOATS };
  }

  function writeDecorations(current: GlScene, currentPalette: BoardPalette, glyphSource: GlyphAtlas): void {
    truncateTo(decorationStart);
    const range = layerRanges[DECORATION_LAYER] ?? emptyRange();
    startRange(range);
    const part = decorationPart(decorations(current), { palette: currentPalette, glyphs: glyphSource, hasDrawnMedia: () => false });
    appendPart(part, Infinity, 1);
    endRange(range);
  }

  function gather(current: GlScene, currentPalette: BoardPalette, glyphSource: GlyphAtlas): void {
    const view = viewArea();
    const lodStep = lodStepOf(camera.scale);
    const upperScale = lodUpperScale(lodStep);
    const area = { x: view.x - view.width * GATHER_MARGIN_FACTOR, y: view.y - view.height * GATHER_MARGIN_FACTOR, width: view.width * (1 + GATHER_MARGIN_FACTOR * 2), height: view.height * (1 + GATHER_MARGIN_FACTOR * 2) };
    const visible = visibleGeometryIndexes(current, area);
    rects.length = 0;
    segments.length = 0;
    triangles.length = 0;
    glyphs.length = 0;
    visibleDrawnMedia = [];
    gatherNumber += 1;
    for (let layer = 0; layer < LAYER_COUNT; layer += 1) {
      const range = layerRanges[layer] ?? emptyRange();
      startRange(range);
      for (const layered of current.chrome.parts) {
        if (layered.layer === layer) appendPart(layered.part, upperScale, 0);
      }
      for (const index of visible) {
        const geometry = current.geometries[index];
        if (!geometry || preview?.hiddenIds.has(geometry.id)) continue;
        for (const layered of geometry.parts) {
          if (layered.layer === layer) appendPart(layered.part, upperScale, depthOf(geometry.paintRank, current));
        }
        if (layer === BOX_LAYER) collectDrawnMedia(current, geometry);
      }
      endRange(range);
    }
    previewStart = rangeMarkHere();
    baseDrawnMediaCount = visibleDrawnMedia.length;
    gatheredArea = area;
    gatheredLodStep = lodStep;
    isGatherDirty = false;
    writePreview(current, currentPalette, glyphSource);
    evictMediaTexturesOverBudget();
    mediaLayer.showArea(area);
  }

  function collectDrawnMedia(current: GlScene, geometry: ElementGeometry): void {
    if (geometry.hitShape.kind !== 'rect' || !geometry.hitShape.hasDrawnMedia) return;
    const box = elementOf(current, geometry.id);
    if (box?.kind !== 'box' || !box.media) return;
    const href = servedAssetHref(box.media);
    if (!href) return;
    const clipRadius = box.device ? DEVICE_CATALOG[box.device.name].bezel.screenRadius * box.device.scale : 0;
    visibleDrawnMedia.push({ href, rect: box.media, fit: box.media.fit, clipRadius, depth: depthOf(geometry.paintRank, current) });
    ensureMediaTexture(href, box.media);
  }

  function ensureMediaTexture(href: string, mediaRect: Rect): void {
    const known = mediaTextures.get(href);
    if (known) {
      known.lastGatherNumber = gatherNumber;
      return;
    }
    const fallbackFit = UNSIZED_MEDIA_EDGE_PX / Math.max(mediaRect.width, mediaRect.height, 1);
    const entry: MediaTexture = { href, texture: null, width: Math.round(mediaRect.width * fallbackFit), height: Math.round(mediaRect.height * fallbackFit), image: new Image(), isFailed: false, textureBytes: 0, lastGatherNumber: gatherNumber };
    mediaTextures.set(href, entry);
    const image = entry.image;
    if (!image) return;
    image.decoding = 'async';
    image.src = href;
    void image.decode().then(() => {
      if (mediaTextures.get(href) !== entry) return;
      entry.width = image.naturalWidth || entry.width;
      entry.height = image.naturalHeight || entry.height;
      uploadMediaTexture(entry);
      requestDraw();
    }, () => {
      markMediaFailed(entry);
    });
  }

  function markMediaFailed(entry: MediaTexture): void {
    entry.isFailed = true;
    const current = scene;
    if (!current) return;
    geometryBySignature.clear();
    buildScene(current.layout);
    requestDraw();
  }

  function rasterOf(image: HTMLImageElement, width: number, height: number, maxEdge: number): HTMLCanvasElement | null {
    const fit = Math.min(1, maxEdge / Math.max(width, height));
    const raster = document.createElement('canvas');
    raster.width = Math.max(1, Math.floor(width * fit));
    raster.height = Math.max(1, Math.floor(height * fit));
    const context = raster.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, raster.width, raster.height);
    return raster;
  }

  function uploadMediaTexture(entry: MediaTexture): void {
    if (!gl || !entry.image || entry.isFailed) return;
    const maxEdge = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const raster = rasterOf(entry.image, entry.width, entry.height, maxEdge);
    if (!raster) {
      markMediaFailed(entry);
      return;
    }
    while (gl.getError() !== gl.NO_ERROR);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, raster);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      markMediaFailed(entry);
      return;
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    entry.texture = texture;
    entry.textureBytes = Math.round(raster.width * raster.height * MIPMAPPED_BYTES_PER_PIXEL);
    evictMediaTexturesOverBudget();
  }

  function forgetMediaTexture(href: string, entry: MediaTexture): void {
    if (gl && entry.texture) gl.deleteTexture(entry.texture);
    mediaTextures.delete(href);
  }

  function evictMediaTexturesOverBudget(): void {
    let heldBytes = 0;
    for (const entry of mediaTextures.values()) heldBytes += entry.textureBytes;
    if (heldBytes <= MEDIA_TEXTURE_BUDGET_BYTES) return;
    const leastRecentlyDrawnFirst = [...mediaTextures].filter(([, entry]) => entry.lastGatherNumber !== gatherNumber).sort(([, first], [, second]) => first.lastGatherNumber - second.lastGatherNumber);
    for (const [href, entry] of leastRecentlyDrawnFirst) {
      if (heldBytes <= MEDIA_TEXTURE_BUDGET_BYTES) return;
      heldBytes -= entry.textureBytes;
      forgetMediaTexture(href, entry);
    }
  }

  function forgetMediaNotIn(layout: BoardLayout): void {
    const hrefsInUse = new Set(layout.elements.flatMap((element) => {
      if (element.kind !== 'box' || !element.media) return [];
      const href = servedAssetHref(element.media);
      return href ? [href] : [];
    }));
    for (const [href, entry] of mediaTextures) {
      if (!hrefsInUse.has(href)) forgetMediaTexture(href, entry);
    }
  }

  function forgetAllMediaTextures(): void {
    for (const [href, entry] of mediaTextures) forgetMediaTexture(href, entry);
  }

  function upload(program: PrimitiveProgram, values: GrowableFloats): void {
    if (!gl || values.length === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, program.buffer);
    if (values.length > program.bufferFloats) {
      program.bufferFloats = values.data.length;
      gl.bufferData(gl.ARRAY_BUFFER, values.data.byteLength, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, values.data, 0, values.length);
  }

  function pointAttributesAt(context: WebGL2RenderingContext, program: PrimitiveProgram, first: number): void {
    context.bindBuffer(context.ARRAY_BUFFER, program.buffer);
    const strideBytes = program.strideFloats * 4;
    for (const attribute of program.attributes) {
      context.vertexAttribPointer(attribute.location, attribute.size, context.FLOAT, false, strideBytes, (first * program.strideFloats + attribute.offset) * 4);
    }
  }

  function setSharedUniforms(context: WebGL2RenderingContext, program: PrimitiveProgram): void {
    const pixelRatio = window.devicePixelRatio || 1;
    context.useProgram(program.program);
    context.uniform2f(program.uniforms.get('uCamera') ?? null, camera.x, camera.y);
    context.uniform1f(program.uniforms.get('uScale') ?? null, camera.scale * pixelRatio);
    context.uniform2f(program.uniforms.get('uResolution') ?? null, canvas.width, canvas.height);
    context.uniform1f(program.uniforms.get('uLodScale') ?? null, camera.scale);
  }

  function drawInstances(context: WebGL2RenderingContext, program: PrimitiveProgram, first: number, count: number): void {
    if (count === 0) return;
    setSharedUniforms(context, program);
    context.bindVertexArray(program.vao);
    pointAttributesAt(context, program, first);
    context.drawArraysInstanced(context.TRIANGLE_STRIP, 0, 4, count);
  }

  function drawTriangles(context: WebGL2RenderingContext, program: PrimitiveProgram, first: number, count: number): void {
    if (count === 0) return;
    setSharedUniforms(context, program);
    context.bindVertexArray(program.vao);
    pointAttributesAt(context, program, 0);
    context.drawArrays(context.TRIANGLES, first, count);
  }

  function drawMedia(context: WebGL2RenderingContext, program: PrimitiveProgram): void {
    const ready = visibleDrawnMedia.flatMap((drawn) => {
      const entry = mediaTextures.get(drawn.href);
      return entry?.texture ? [{ drawn, entry }] : [];
    });
    if (ready.length === 0) return;
    setSharedUniforms(context, program);
    context.bindVertexArray(program.vao);
    context.uniform1i(program.uniforms.get('uImage') ?? null, 1);
    context.activeTexture(context.TEXTURE1);
    for (const { drawn, entry } of ready) {
      const placed = placedMediaOf(drawn, entry);
      context.bindTexture(context.TEXTURE_2D, entry.texture);
      context.uniform1f(program.uniforms.get('uDepth') ?? null, drawn.depth);
      context.uniform1f(program.uniforms.get('uClipRadius') ?? null, drawn.clipRadius);
      context.uniform4f(program.uniforms.get('uRect') ?? null, placed.rect.x, placed.rect.y, placed.rect.width, placed.rect.height);
      context.uniform4f(program.uniforms.get('uUvRect') ?? null, placed.uv.x, placed.uv.y, placed.uv.width, placed.uv.height);
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    }
  }

  function blockTextureOf(context: WebGL2RenderingContext, block: BlockTile): WebGLTexture | null {
    const known = blockTextures.get(block.id);
    if (known?.raster === block.raster) return known.texture;
    const texture = known?.texture ?? context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, BLOCK_RASTER_PX, BLOCK_RASTER_PX, 0, context.RGBA, context.UNSIGNED_BYTE, block.raster);
    blockTextures.set(block.id, { raster: block.raster, texture });
    return texture;
  }

  function forgetBlockTexturesNotIn(nextBlocks: readonly BlockTile[]): void {
    const keptIds = new Set(nextBlocks.map((block) => block.id));
    for (const [id, entry] of blockTextures) {
      if (keptIds.has(id)) continue;
      gl?.deleteTexture(entry.texture);
      blockTextures.delete(id);
    }
  }

  function drawBlocks(context: WebGL2RenderingContext, program: PrimitiveProgram, tint: Rgba): void {
    if (blocks.length === 0) return;
    context.disable(context.DEPTH_TEST);
    context.depthMask(false);
    setSharedUniforms(context, program);
    context.bindVertexArray(program.vao);
    context.uniform1i(program.uniforms.get('uImage') ?? null, 1);
    context.uniform1f(program.uniforms.get('uDepth') ?? null, 0);
    context.uniform4f(program.uniforms.get('uTint') ?? null, tint[0], tint[1], tint[2], BLOCK_ALPHA);
    context.uniform4f(program.uniforms.get('uUvRect') ?? null, 0, 0, 1, 1);
    context.activeTexture(context.TEXTURE1);
    for (const block of blocks) {
      context.bindTexture(context.TEXTURE_2D, blockTextureOf(context, block));
      context.uniform4f(program.uniforms.get('uRect') ?? null, block.rect.x, block.rect.y, block.rect.width, block.rect.height);
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    }
    context.enable(context.DEPTH_TEST);
  }

  function reportView(): void {
    if (!onViewChange || camera.scale <= 0) return;
    const view = { x: camera.x, y: camera.y, width: canvas.clientWidth / camera.scale, height: canvas.clientHeight / camera.scale };
    const viewKey = `${view.x}:${view.y}:${view.width}:${view.height}`;
    if (viewKey === lastViewKey) return;
    lastViewKey = viewKey;
    onViewChange(view, camera.scale);
  }

  function drawLayer(context: WebGL2RenderingContext, programs: NonNullable<typeof primitives>, glyphSource: GlyphAtlas, layer: number): void {
    const baseRange = layerRanges[layer];
    if (!baseRange) return;
    const ranges = [baseRange, ...(previewRanges[layer] ? [previewRanges[layer]] : [])];
    if (layer === DECORATION_LAYER) context.disable(context.DEPTH_TEST);
    context.depthMask(true);
    for (const range of ranges) drawTriangles(context, programs.triangle, range.triangleStart, range.triangleCount);
    for (const range of ranges) drawInstances(context, programs.rect, range.rectStart, range.rectCount);
    context.depthMask(false);
    for (const range of ranges) drawInstances(context, programs.segment, range.segmentStart, range.segmentCount);
    if (layer === BOX_LAYER) drawMedia(context, programs.image);
    const glyphRanges = ranges.filter((range) => range.glyphCount > 0);
    if (glyphRanges.length === 0) return;
    glyphSource.bind(context, 0);
    setSharedUniforms(context, programs.glyph);
    context.uniform1i(programs.glyph.uniforms.get('uAtlas') ?? null, 0);
    context.bindVertexArray(programs.glyph.vao);
    for (const range of glyphRanges) {
      pointAttributesAt(context, programs.glyph, range.glyphStart);
      context.drawArraysInstanced(context.TRIANGLE_STRIP, 0, 4, range.glyphCount);
    }
  }

  function isGatherStale(): boolean {
    if (isGatherDirty || !gatheredArea) return true;
    if (lodStepOf(camera.scale) !== gatheredLodStep) return true;
    return !isRectInside(viewArea(), gatheredArea);
  }

  function resizeCanvas(): void {
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
  }

  function draw(): void {
    frameRequest = null;
    const context = gl;
    const programs = primitives;
    if (!context || !programs || context.isContextLost()) return;
    resizeCanvas();
    context.viewport(0, 0, canvas.width, canvas.height);
    context.clearColor(0, 0, 0, 0);
    context.clearDepth(0);
    context.depthMask(true);
    context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
    context.enable(context.DEPTH_TEST);
    context.depthFunc(context.GEQUAL);
    if (scene && paletteKey(viewport) !== resolvedPaletteKey) buildScene(scene.layout);
    const current = scene;
    if (!current) return;
    const currentPalette = ensurePalette();
    drawBlocks(context, programs.block, currentPalette.inkDim);
    const glyphSource = ensureAtlas();
    if (isGatherStale()) gather(current, currentPalette, glyphSource);
    upload(programs.rect, rects);
    upload(programs.segment, segments);
    upload(programs.triangle, triangles);
    upload(programs.glyph, glyphs);
    for (let layer = 0; layer <= LAYER_COUNT; layer += 1) drawLayer(context, programs, glyphSource, layer);
    canvas.dataset.drawnElements = String(current.geometries.length);
    canvas.dataset.drawnBlocks = String(blocks.length);
    canvas.dataset.mediaTextures = String(mediaTextures.size);
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
    writeDecorations(current, ensurePalette(), ensureAtlas());
    requestDraw();
  }

  function isMediaDrawable(box: LaidOutBox): boolean {
    if (!box.media) return false;
    const href = servedAssetHref(box.media);
    return href !== null && mediaTextures.get(href)?.isFailed !== true;
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

  function paintElements(elements: readonly LaidOutElement[], stackSpreadOf?: (frameId: string) => number): void {
    if (scene && paletteKey(viewport) !== resolvedPaletteKey) buildScene(scene.layout);
    const current = scene;
    if (!current) return;
    const currentPalette = ensurePalette();
    const glyphSource = ensureAtlasInBoardFont();
    const context: SceneContext = { palette: currentPalette, glyphs: glyphSource, hasDrawnMedia: isMediaDrawable, ...(stackSpreadOf ? { stackSpreadOf } : {}) };
    const built = sceneOf({ ...current.layout, elements: [...elements], legend: [], caption: null, plan: null }, context, () => null);
    const geometries = built.elements.map((geometry) => ({ ...geometry, paintRank: current.geometries[current.geometryIndexById.get(geometry.id) ?? -1]?.paintRank ?? 0 }));
    const hiddenIds = new Set(elements.map((element) => element.id));
    const isSameHidden = preview !== null && isSameIdSet(preview.hiddenIds, hiddenIds);
    preview = { hiddenIds: isSameHidden && preview ? preview.hiddenIds : hiddenIds, geometries, elementById: new Map(elements.map((element) => [element.id, element])) };
    if (!isSameHidden) isGatherDirty = true;
    if (current.hasPageMedia) mediaLayer.sync({ ...current.layout, elements: current.layout.elements.map((element) => preview?.elementById.get(element.id) ?? element) }, current.geometries.map((geometry) => geometry.id));
    if (!isGatherDirty && gatheredArea) writePreview(current, currentPalette, glyphSource);
    requestDraw();
  }

  function drawLayout(layout: BoardLayout, nextBlocks: readonly BlockTile[]): void {
    stopStackMotion();
    if (stackFan?.frameRequest != null) cancelAnimationFrame(stackFan.frameRequest);
    stackFan = null;
    preview = null;
    if (atlas?.isFull()) {
      atlas.forgetUnusedGlyphs();
      geometryBySignature.clear();
    }
    forgetBlockTexturesNotIn(nextBlocks);
    blocks = nextBlocks;
    buildScene(layout);
    requestDraw();
  }

  function buildScene(layout: BoardLayout): void {
    const currentPalette = ensurePalette();
    const glyphSource = ensureAtlasInBoardFont();
    const context: SceneContext = { palette: currentPalette, glyphs: glyphSource, hasDrawnMedia: isMediaDrawable };
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
      hasPageMedia: layout.elements.some((element) => element.kind === 'box' && (element.media?.kind === 'page' || element.media?.kind === 'doc')),
    };
    forgetMediaNotIn(layout);
    mediaLayer.sync(layout, built.elements.map((geometry) => geometry.id));
    isGatherDirty = true;
    sceneBuildCount += 1;
    canvas.dataset.sceneBuilds = String(sceneBuildCount);
  }

  function hitPartOf(current: GlScene, geometry: ElementGeometry, point: Point, slop: number): BoardHit | null {
    const element = elementOf(current, geometry.id);
    if (!element) return null;
    const hit: BoardHit = { id: geometry.id, kind: geometry.kind, part: 'body', lineIndex: null, port: null, media: null, handle: null, end: null, bend: null };
    const shape = geometry.hitShape;
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
      const port = boxPortCenters(element).find((center) => Math.hypot(center.x - point.x, center.y - point.y) <= portSlop);
      if (port) return { ...hit, part: 'port', port };
    }
    if (!isInside(point, shape.rect)) return null;
    if (shape.mediaRect && element.kind === 'box' && element.media && isInside(point, shape.mediaRect)) {
      const href = element.media.kind === 'image' ? servedAssetHref(element.media) ?? '' : '';
      return { ...hit, part: 'media', media: { href, alt: element.media.alt } };
    }
    const lineIndex = shape.text.lines.findIndex((lineRect) => isInside(point, lineRect));
    if (lineIndex >= 0) return { ...hit, part: 'line', lineIndex };
    if (shape.text.emptyBody && isInside(point, shape.text.emptyBody)) return { ...hit, part: 'emptyBody' };
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
    forgetBlockTexturesNotIn([]);
    blocks = [];
    lastViewKey = '';
    reportView();
    geometryBySignature.clear();
    forgetAllMediaTextures();
    mediaLayer.clear();
    hoveredBoxId = null;
    wireTargetId = null;
    isGatherDirty = true;
    requestDraw();
  }

  function adoptContext(context: WebGL2RenderingContext | null): void {
    gl = context;
    createGlOrNotice();
    if (!gl) return;
    for (const entry of mediaTextures.values()) uploadMediaTexture(entry);
    showNotice(null);
    requestDraw();
  }

  function scheduleContextRetry(): void {
    if (contextRetryTimer !== null) clearTimeout(contextRetryTimer);
    contextRetryTimer = window.setTimeout(retryWithFreshCanvas, CONTEXT_RETRY_MS);
  }

  function cancelContextRetry(): void {
    if (contextRetryTimer === null) return;
    clearTimeout(contextRetryTimer);
    contextRetryTimer = null;
  }

  function retryWithFreshCanvas(): void {
    contextRetryTimer = null;
    contextRetries += 1;
    const freshCanvas = canvas.cloneNode(false);
    if (!(freshCanvas instanceof HTMLCanvasElement)) return;
    const { context: freshContext, creationError } = createWebgl2Context(freshCanvas, contextAttributes);
    if (!freshContext) {
      if (contextState === 'lost') reportGraphics('blocked', { msSinceLastLoss: null, blankMs: null, creationError });
      contextState = 'blocked';
      showRefusal();
      return;
    }
    unwatchCanvas(canvas);
    canvas.replaceWith(freshCanvas);
    canvas = freshCanvas;
    watchCanvas(freshCanvas);
    adoptContext(freshContext);
    settleContextLive('recreated');
  }

  function onContextLost(event: Event): void {
    event.preventDefault();
    const lostAtMs = performance.now();
    lossCount += 1;
    reportGraphics('lost', { msSinceLastLoss: lastLossAtMs === null ? null : lostAtMs - lastLossAtMs, blankMs: null, creationError: null });
    lastLossAtMs = lostAtMs;
    contextState = 'lost';
    contextRetries = 0;
    primitives = null;
    atlas?.forgetTexture();
    for (const entry of mediaTextures.values()) entry.texture = null;
    blockTextures.clear();
    showNotice('redrawing');
    scheduleContextRetry();
  }

  function onContextRestored(): void {
    cancelContextRetry();
    adoptContext(canvas.getContext('webgl2', contextAttributes));
    if (gl) settleContextLive('restored');
  }

  const canvasResizeObserver = new ResizeObserver(() => {
    reportView();
    isGatherDirty = true;
    requestDraw();
  });

  function watchCanvas(target: HTMLCanvasElement): void {
    target.addEventListener('webglcontextlost', onContextLost);
    target.addEventListener('webglcontextrestored', onContextRestored);
    canvasResizeObserver.observe(target);
  }

  function unwatchCanvas(target: HTMLCanvasElement): void {
    target.removeEventListener('webglcontextlost', onContextLost);
    target.removeEventListener('webglcontextrestored', onContextRestored);
    canvasResizeObserver.unobserve(target);
  }

  watchCanvas(canvas);
  const requestDrawOnThemeChange = (): void => {
    if (scene && paletteKey(viewport) !== resolvedPaletteKey) requestDraw();
  };
  new MutationObserver(requestDrawOnThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  new MutationObserver(requestDrawOnThemeChange).observe(viewport, { attributes: true, attributeFilter: ['class'] });
  createGlOrNotice();
  if (!gl && !isWebgl2Missing()) {
    contextState = 'blocked';
    reportGraphics('blocked', { msSinceLastLoss: null, blankMs: null, creationError: initialContext.creationError });
  }

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
      reportView();
      requestDraw();
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
