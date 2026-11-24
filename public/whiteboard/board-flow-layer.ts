import type { Point, Rgba } from './board-gl-scene.ts';

interface FlowWire {
  points: readonly Point[];
  color: Rgba;
  width: number;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface FlowView {
  camera: Camera;
  pixelRatio: number;
  cssWidth: number;
  cssHeight: number;
}

interface MeasuredWire extends FlowWire {
  lengthsAlong: number[];
  totalLength: number;
}

interface FlowPainter {
  sync(wires: readonly FlowWire[], isMotionReduced: boolean): void;
  paint(view: FlowView, timeMs: number): boolean;
}

const PARTICLE_SPACING_WORLD = 56;
const MIN_PARTICLE_SPACING_PX = 28;
const PARTICLE_SPEED_WORLD_PER_SECOND = 90;
const PARTICLE_RADIUS_PX = 2.6;
const GLOW_BLUR_PX = 14;
const GLOW_WIDTH_FACTOR = 2.4;

function cssColorOf(color: Rgba, alpha: number): string {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${alpha})`;
}

function measuredWireOf(wire: FlowWire): MeasuredWire {
  const lengthsAlong = [0];
  let totalLength = 0;
  for (let index = 1; index < wire.points.length; index += 1) {
    const previous = wire.points[index - 1];
    const current = wire.points[index];
    if (previous && current) totalLength += Math.hypot(current.x - previous.x, current.y - previous.y);
    lengthsAlong.push(totalLength);
  }
  return { ...wire, lengthsAlong, totalLength };
}

function pointAlong(wire: MeasuredWire, distance: number): Point | null {
  for (let index = 1; index < wire.points.length; index += 1) {
    const segmentEnd = wire.lengthsAlong[index] ?? 0;
    if (segmentEnd < distance) continue;
    const segmentStart = wire.lengthsAlong[index - 1] ?? 0;
    const from = wire.points[index - 1];
    const to = wire.points[index];
    if (!from || !to) return null;
    const share = segmentEnd === segmentStart ? 0 : (distance - segmentStart) / (segmentEnd - segmentStart);
    return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
  }
  return null;
}

function particleSpacingFor(scale: number): number {
  let spacing = PARTICLE_SPACING_WORLD;
  while (spacing * scale < MIN_PARTICLE_SPACING_PX) spacing *= 2;
  return spacing;
}

function createFlowPainter(canvas: OffscreenCanvas): FlowPainter {
  const context = canvas.getContext('2d');
  let wires: MeasuredWire[] = [];
  let isMotionReduced = false;

  function screenPointOf(point: Point, camera: Camera): Point {
    return { x: (point.x - camera.x) * camera.scale, y: (point.y - camera.y) * camera.scale };
  }

  function fitCanvas(drawing: OffscreenCanvasRenderingContext2D, view: FlowView): void {
    const width = Math.max(1, Math.round(view.cssWidth * view.pixelRatio));
    const height = Math.max(1, Math.round(view.cssHeight * view.pixelRatio));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    drawing.setTransform(view.pixelRatio, 0, 0, view.pixelRatio, 0, 0);
    drawing.clearRect(0, 0, view.cssWidth, view.cssHeight);
  }

  function drawGlow(drawing: OffscreenCanvasRenderingContext2D, wire: MeasuredWire, camera: Camera): void {
    const [first, ...rest] = wire.points.map((point) => screenPointOf(point, camera));
    if (!first) return;
    drawing.beginPath();
    drawing.moveTo(first.x, first.y);
    for (const point of rest) drawing.lineTo(point.x, point.y);
    drawing.strokeStyle = cssColorOf(wire.color, 0.55);
    drawing.lineWidth = Math.max(1.5, wire.width * camera.scale * GLOW_WIDTH_FACTOR);
    drawing.shadowColor = cssColorOf(wire.color, 0.9);
    drawing.shadowBlur = GLOW_BLUR_PX;
    drawing.stroke();
  }

  function drawParticles(drawing: OffscreenCanvasRenderingContext2D, wire: MeasuredWire, camera: Camera, timeMs: number): void {
    const spacing = particleSpacingFor(camera.scale);
    const offset = ((timeMs / 1000) * PARTICLE_SPEED_WORLD_PER_SECOND) % spacing;
    drawing.fillStyle = cssColorOf([1, 1, 1, 1], 0.95);
    drawing.shadowColor = cssColorOf(wire.color, 1);
    drawing.shadowBlur = GLOW_BLUR_PX;
    for (let distance = offset; distance <= wire.totalLength; distance += spacing) {
      const worldPoint = pointAlong(wire, distance);
      if (!worldPoint) continue;
      const point = screenPointOf(worldPoint, camera);
      drawing.beginPath();
      drawing.arc(point.x, point.y, PARTICLE_RADIUS_PX, 0, Math.PI * 2);
      drawing.fill();
    }
  }

  return {
    sync: (nextWires, nextIsMotionReduced) => {
      wires = nextWires.map(measuredWireOf);
      isMotionReduced = nextIsMotionReduced;
    },
    paint: (view, timeMs) => {
      if (!context) return false;
      fitCanvas(context, view);
      for (const wire of wires) drawGlow(context, wire, view.camera);
      const isFlowing = wires.length > 0 && view.cssWidth > 0 && view.cssHeight > 0 && !isMotionReduced;
      if (!isFlowing) return false;
      for (const wire of wires) drawParticles(context, wire, view.camera, timeMs);
      return true;
    },
  };
}

export { createFlowPainter };
export type { FlowPainter, FlowWire };
