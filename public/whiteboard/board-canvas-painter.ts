import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { RECT_FLOATS, SEGMENT_FLOATS, TRIANGLE_VERTEX_FLOATS } from './board-gl-scene.ts';
import type { Point, TextRun } from './board-gl-scene.ts';


type PaintTarget = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface PaintView {
  cameraX: number;
  cameraY: number;
  deviceScale: number;
  lodScale: number;
}

interface Turn {
  pivot: Point;
  radians: number;
}

interface PlacedImage {
  rect: Rect;
  uv: Rect;
}

const MAX_COLOR_TEXTS = 4096;
const ADVANCE_PROBE = '0000000000';
const colorTextByKey = new Map<number, string>();

function byteOf(share: number): number {
  return Math.round(Math.min(1, Math.max(0, share)) * 255);
}

function colorText(red: number, green: number, blue: number, alpha: number): string {
  const redByte = byteOf(red);
  const greenByte = byteOf(green);
  const blueByte = byteOf(blue);
  const alphaByte = byteOf(alpha);
  const key = ((redByte * 256 + greenByte) * 256 + blueByte) * 256 + alphaByte;
  const known = colorTextByKey.get(key);
  if (known) return known;
  if (colorTextByKey.size >= MAX_COLOR_TEXTS) colorTextByKey.clear();
  const text = `rgba(${redByte},${greenByte},${blueByte},${alphaByte / 255})`;
  colorTextByKey.set(key, text);
  return text;
}

function setWorldTransform(target: PaintTarget, view: PaintView): void {
  target.setTransform(view.deviceScale, 0, 0, view.deviceScale, -view.cameraX * view.deviceScale, -view.cameraY * view.deviceScale);
}

function applyTurn(target: PaintTarget, pivotX: number, pivotY: number, radians: number): void {
  target.translate(pivotX, pivotY);
  target.rotate(radians);
  target.translate(-pivotX, -pivotY);
}

function paintRects(target: PaintTarget, rects: Float32Array, view: PaintView): void {
  for (let at = 0; at < rects.length; at += RECT_FLOATS) {
    if (view.lodScale < (rects[at + 17] ?? 0)) continue;
    const left = rects[at] ?? 0;
    const top = rects[at + 1] ?? 0;
    const width = rects[at + 2] ?? 0;
    const height = rects[at + 3] ?? 0;
    const cornerRadius = Math.max(0, Math.min(rects[at + 4] ?? 0, width / 2, height / 2));
    const strokeWidth = rects[at + 5] ?? 0;
    const fillAlpha = rects[at + 9] ?? 0;
    const strokeAlpha = rects[at + 13] ?? 0;
    const radians = rects[at + 16] ?? 0;
    if (radians !== 0) {
      target.save();
      applyTurn(target, rects[at + 14] ?? 0, rects[at + 15] ?? 0, radians);
    }
    target.beginPath();
    target.roundRect(left, top, width, height, cornerRadius);
    if (fillAlpha > 0) {
      target.fillStyle = colorText(rects[at + 6] ?? 0, rects[at + 7] ?? 0, rects[at + 8] ?? 0, fillAlpha);
      target.fill();
    }
    if (strokeWidth > 0 && strokeAlpha > 0) {
      const strokeDevicePx = strokeWidth * view.deviceScale;
      target.lineWidth = Math.max(strokeDevicePx, 1) / view.deviceScale;
      target.strokeStyle = colorText(rects[at + 10] ?? 0, rects[at + 11] ?? 0, rects[at + 12] ?? 0, strokeAlpha * Math.min(strokeDevicePx, 1));
      target.stroke();
    }
    if (radians !== 0) target.restore();
  }
}

function isSameSegmentStyle(segments: Float32Array, firstAt: number, at: number): boolean {
  for (const offset of [4, 5, 6, 8, 9, 10, 11]) {
    if (segments[firstAt + offset] !== segments[at + offset]) return false;
  }
  return true;
}

function continuesPrevious(segments: Float32Array, previousAt: number, at: number): boolean {
  if (previousAt < 0) return false;
  return segments[previousAt + 2] === segments[at] && segments[previousAt + 3] === segments[at + 1];
}

function strokeSegmentRun(target: PaintTarget, segments: Float32Array, firstAt: number, endAt: number, view: PaintView): void {
  const width = segments[firstAt + 4] ?? 0;
  const dashOn = segments[firstAt + 5] ?? 0;
  const dashOff = segments[firstAt + 6] ?? 0;
  const widthDevicePx = width * view.deviceScale;
  target.lineWidth = Math.max(widthDevicePx, 1) / view.deviceScale;
  target.strokeStyle = colorText(segments[firstAt + 8] ?? 0, segments[firstAt + 9] ?? 0, segments[firstAt + 10] ?? 0, (segments[firstAt + 11] ?? 0) * Math.min(widthDevicePx, 1));
  target.lineCap = dashOn > 0 ? 'butt' : 'square';
  target.setLineDash(dashOn > 0 ? [dashOn, dashOff] : []);
  target.lineDashOffset = segments[firstAt + 7] ?? 0;
  target.beginPath();
  let previousAt = -1;
  for (let at = firstAt; at < endAt; at += SEGMENT_FLOATS) {
    if (view.lodScale < (segments[at + 12] ?? 0)) continue;
    if (!continuesPrevious(segments, previousAt, at)) {
      if (dashOn > 0 && previousAt >= 0) {
        target.stroke();
        target.beginPath();
        target.lineDashOffset = segments[at + 7] ?? 0;
      }
      target.moveTo(segments[at] ?? 0, segments[at + 1] ?? 0);
    }
    target.lineTo(segments[at + 2] ?? 0, segments[at + 3] ?? 0);
    previousAt = at;
  }
  target.stroke();
}

function paintSegments(target: PaintTarget, segments: Float32Array, view: PaintView): void {
  if (segments.length === 0) return;
  target.lineJoin = 'miter';
  let firstAt = 0;
  for (let at = SEGMENT_FLOATS; at <= segments.length; at += SEGMENT_FLOATS) {
    if (at < segments.length && isSameSegmentStyle(segments, firstAt, at)) continue;
    strokeSegmentRun(target, segments, firstAt, at, view);
    firstAt = at;
  }
  target.setLineDash([]);
}

function isSameTriangleColor(triangles: Float32Array, firstAt: number, at: number): boolean {
  for (let offset = 2; offset <= 5; offset += 1) {
    if (triangles[firstAt + offset] !== triangles[at + offset]) return false;
  }
  return true;
}

function paintTriangles(target: PaintTarget, triangles: Float32Array, view: PaintView): void {
  const triangleFloats = TRIANGLE_VERTEX_FLOATS * 3;
  let runAt = 0;
  while (runAt < triangles.length) {
    target.beginPath();
    let at = runAt;
    for (; at < triangles.length && isSameTriangleColor(triangles, runAt, at); at += triangleFloats) {
      if (view.lodScale < (triangles[at + 6] ?? 0)) continue;
      target.moveTo(triangles[at] ?? 0, triangles[at + 1] ?? 0);
      target.lineTo(triangles[at + TRIANGLE_VERTEX_FLOATS] ?? 0, triangles[at + TRIANGLE_VERTEX_FLOATS + 1] ?? 0);
      target.lineTo(triangles[at + TRIANGLE_VERTEX_FLOATS * 2] ?? 0, triangles[at + TRIANGLE_VERTEX_FLOATS * 2 + 1] ?? 0);
      target.closePath();
    }
    target.fillStyle = colorText(triangles[runAt + 2] ?? 0, triangles[runAt + 3] ?? 0, triangles[runAt + 4] ?? 0, triangles[runAt + 5] ?? 0);
    target.fill();
    runAt = at;
  }
}

const naturalAdvanceByFont = new Map<string, number>();

function naturalAdvanceOf(target: PaintTarget, font: string): number {
  const known = naturalAdvanceByFont.get(font);
  if (known !== undefined) return known;
  target.letterSpacing = '0px';
  const measured = target.measureText(ADVANCE_PROBE).width / ADVANCE_PROBE.length;
  naturalAdvanceByFont.set(font, measured);
  return measured;
}

function forgetMeasuredFonts(): void {
  naturalAdvanceByFont.clear();
}

function textFillOf(target: PaintTarget, run: TextRun): string | CanvasGradient {
  if (!run.gradient || run.gradient.length < 2) return colorText(run.color[0], run.color[1], run.color[2], run.color[3]);
  const width = [...run.text].length * run.advance;
  const gradient = target.createLinearGradient(run.left, 0, run.left + width, 0);
  const lastIndex = run.gradient.length - 1;
  for (const [index, stop] of run.gradient.entries()) gradient.addColorStop(index / lastIndex, colorText(stop[0], stop[1], stop[2], stop[3]));
  return gradient;
}

function paintTexts(target: PaintTarget, texts: readonly TextRun[], fontFamily: string, view: PaintView): void {
  if (texts.length === 0) return;
  target.textBaseline = 'alphabetic';
  target.textAlign = 'left';
  for (const run of texts) {
    if (view.lodScale < run.minScale) continue;
    const font = `${run.isBold ? 700 : 400} ${run.size}px ${fontFamily}`;
    if (target.font !== font) target.font = font;
    target.letterSpacing = `${run.advance - naturalAdvanceOf(target, font)}px`;
    target.fillStyle = textFillOf(target, run);
    if (run.turn) {
      target.save();
      applyTurn(target, run.turn.pivot.x, run.turn.pivot.y, run.turn.radians);
    }
    target.fillText(run.text, run.left, run.baseline);
    if (run.turn) target.restore();
  }
  target.letterSpacing = '0px';
}

function paintImage(target: PaintTarget, image: CanvasImageSource, imageWidth: number, imageHeight: number, placed: PlacedImage, clipRadius: number, turn: Turn): void {
  target.save();
  if (turn.radians !== 0) applyTurn(target, turn.pivot.x, turn.pivot.y, turn.radians);
  const { rect, uv } = placed;
  if (clipRadius > 0) {
    target.beginPath();
    target.roundRect(rect.x, rect.y, rect.width, rect.height, Math.min(clipRadius, rect.width / 2, rect.height / 2));
    target.clip();
  }
  target.drawImage(image, uv.x * imageWidth, uv.y * imageHeight, uv.width * imageWidth, uv.height * imageHeight, rect.x, rect.y, rect.width, rect.height);
  target.restore();
}

export { forgetMeasuredFonts, paintImage, paintRects, paintSegments, paintTexts, paintTriangles, setWorldTransform };
export type { PaintView };
