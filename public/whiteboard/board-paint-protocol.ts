import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { DeviceFit } from '#shared/whiteboard-devices.ts';
import type { FlowWire } from './board-flow-layer.ts';
import type { GeometryPart, Point, Rgba } from './board-gl-scene.ts';

interface PaintCamera {
  x: number;
  y: number;
  scale: number;
}

interface DrawnMedia {
  href: string;
  rect: Rect;
  fit: DeviceFit;
  clipRadius: number;
  turn: { pivot: Point; radians: number };
}

interface PaintedGeometry {
  geometryId: number;
  partsByLayer: [number, GeometryPart[]][];
}

interface PaintedBlock {
  id: string;
  rect: Rect;
  raster: Uint8Array;
}

interface PreviewEntry {
  layer: number;
  parts: GeometryPart[];
  depth: number;
  media: DrawnMedia | null;
}

type PaintCommand =
  | { kind: 'canvases'; board: OffscreenCanvas; decorations: OffscreenCanvas; flow: OffscreenCanvas }
  | { kind: 'view'; camera: PaintCamera; pixelRatio: number; cssWidth: number; cssHeight: number }
  | { kind: 'fonts'; fontFamily: string; faces: { family: string; source: string; weight: string; style: string; unicodeRange: string }[] }
  | { kind: 'scene'; geometryIdByIndex: Uint32Array; depthByIndex: Float32Array; boundsByIndex: Float32Array; newGeometries: PaintedGeometry[]; chrome: [number, GeometryPart[]][] }
  | { kind: 'gather'; sceneIndexes: Uint32Array; mediaByIndex: [number, DrawnMedia][]; hiddenIndexes: Uint32Array }
  | { kind: 'preview'; entries: PreviewEntry[] }
  | { kind: 'blocks'; blocks: PaintedBlock[]; tint: Rgba; rasterPx: number }
  | { kind: 'decorations'; part: GeometryPart | null }
  | { kind: 'flows'; wires: FlowWire[]; isMotionReduced: boolean }
  | { kind: 'media'; href: string; bitmap: ImageBitmap }
  | { kind: 'media-dropped'; hrefs: string[] }
  | { kind: 'clear' };

interface PaintReport {
  kind: 'painted';
  drawnElements: number;
  drawnBlocks: number;
  mediaTextures: number;
}

export type { DrawnMedia, PaintCamera, PaintCommand, PaintedBlock, PaintedGeometry, PaintReport, PreviewEntry };
