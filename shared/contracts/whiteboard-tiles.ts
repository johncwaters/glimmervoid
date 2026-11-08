import { z } from 'zod';
import { DEVICE_FITS } from '../whiteboard-devices.ts';
import { BOX_CHANGES, BOX_SHAPES, BoxMedia, DeviceName, DialValue, Element, IconName, STEP_STATUSES, Wire } from './whiteboard.ts';

export const TILE_LODS = ['full', 'titles', 'blocks'] as const;
export const BLOCK_RASTER_PX = 64;

const LINE_STYLES = ['text', 'code', 'item', 'numbered', 'kv'] as const;

const LayoutPoint = z.object({ x: z.number(), y: z.number() });
const rectShape = { x: z.number(), y: z.number(), width: z.number(), height: z.number() };
export const LayoutRect = z.object(rectShape);

export const LaidOutLine = z.object({
  text: z.string(),
  muted: z.boolean(),
  style: z.enum(LINE_STYLES),
  marker: z.string().nullable(),
  indentChars: z.number(),
  isFirstRow: z.boolean(),
  icon: IconName.nullable(),
});

export const LaidOutMedia = z.object({
  ...rectShape,
  kind: BoxMedia.shape.kind,
  asset: z.string(),
  mime: BoxMedia.shape.mime,
  hasPreview: z.boolean(),
  alt: z.string(),
  fit: z.enum(DEVICE_FITS),
  dialValues: z.record(z.string(), DialValue),
});

export const LaidOutDevice = z.object({ ...rectShape, name: DeviceName, scale: z.number(), screen: LayoutRect });

const LaidOutOutput = z.object({ id: z.string(), label: z.string(), port: LayoutPoint });

export const LaidOutBox = z.object({
  ...rectShape,
  kind: z.literal('box'),
  id: z.string(),
  titleLines: z.array(z.string()),
  icon: IconName.nullable(),
  bodyLines: z.array(LaidOutLine),
  change: z.enum(BOX_CHANGES),
  wasLines: z.array(z.string()),
  shape: z.enum(BOX_SHAPES),
  headerHeight: z.number(),
  outputs: z.array(LaidOutOutput),
  media: LaidOutMedia.nullable(),
  device: LaidOutDevice.nullable(),
  step: z.object({ label: z.string(), status: z.enum(STEP_STATUSES), linkedBoardId: z.string().nullable() }).nullable(),
});

export const LaidOutFrame = z.object({ ...rectShape, kind: z.literal('frame'), id: z.string(), title: z.string(), isLoop: z.boolean(), stackedBoxCount: z.number().int().nullable().default(null) });

export const LaidOutWire = z.object({
  kind: z.literal('wire'),
  id: z.string(),
  path: z.string(),
  start: LayoutPoint,
  end: LayoutPoint,
  label: z.string().nullable(),
  labelAt: LayoutPoint,
  isDashed: z.boolean(),
  isBack: z.boolean(),
  tone: Wire.shape.tone.unwrap(),
  hasArrowhead: z.boolean(),
  joinAt: LayoutPoint.nullable(),
});

export const LaidOutNote = z.object({ ...rectShape, kind: z.literal('note'), id: z.string(), lines: z.array(z.string()), byline: z.string(), isResolved: z.boolean() });

export const LaidOutElement = z.discriminatedUnion('kind', [LaidOutBox, LaidOutFrame, LaidOutWire, LaidOutNote]);

const LegendSwatch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wire'), tone: Wire.shape.tone.unwrap(), isDashed: z.boolean(), isBack: z.boolean() }),
  z.object({ kind: z.literal('change'), change: z.enum(['added', 'removed', 'relabeled']) }),
  z.object({ kind: z.literal('status'), status: z.enum(STEP_STATUSES) }),
]);

export const LegendRow = z.object({ label: z.string(), x: z.number(), y: z.number(), swatch: LegendSwatch });
export const PlanColumn = z.object({ x: z.number(), bottom: z.number(), boxCount: z.number().int().positive() });
export const PlanBand = z.object({ titleAt: LayoutPoint, columns: z.array(PlanColumn) });

export const BoardChrome = z.object({
  legend: z.array(LegendRow),
  caption: z.object({ text: z.string(), x: z.number(), y: z.number() }).nullable(),
  plan: PlanBand.nullable(),
  pinnedOffsetY: z.number(),
  bounds: LayoutRect,
});

export const TileKey = z.object({ chunkX: z.number().int(), chunkY: z.number().int(), lod: z.enum(TILE_LODS), level: z.number().int().min(0).max(30) });

export const PaintedElement = z.object({ paintOrder: z.number().int().min(0), element: LaidOutElement, record: Element.optional() });

export const Tile = z.object({
  key: TileKey,
  elements: z.array(PaintedElement),
  raster: z.string().max(Math.ceil((BLOCK_RASTER_PX * BLOCK_RASTER_PX * 4) / 3) * 4 + 4).nullable(),
});

export const TileDiff = z.object({
  changed: z.array(PaintedElement),
  removedIds: z.array(z.string()),
  rasters: z.array(Tile),
  chrome: BoardChrome.nullable(),
});

export type LaidOutLine = z.infer<typeof LaidOutLine>;
export type LaidOutMedia = z.infer<typeof LaidOutMedia>;
export type LaidOutDevice = z.infer<typeof LaidOutDevice>;
export type LaidOutBox = z.infer<typeof LaidOutBox>;
export type LaidOutFrame = z.infer<typeof LaidOutFrame>;
export type LaidOutWire = z.infer<typeof LaidOutWire>;
export type LaidOutNote = z.infer<typeof LaidOutNote>;
export type LaidOutElement = z.infer<typeof LaidOutElement>;
export type LegendRow = z.infer<typeof LegendRow>;
export type PlanBand = z.infer<typeof PlanBand>;
export type PlanColumn = z.infer<typeof PlanColumn>;
export type BoardChrome = z.infer<typeof BoardChrome>;
export type TileKey = z.infer<typeof TileKey>;
export type TileLod = TileKey['lod'];
export type PaintedElement = z.infer<typeof PaintedElement>;
export type Tile = z.infer<typeof Tile>;
export type TileDiff = z.infer<typeof TileDiff>;
export type LaidOutStep = NonNullable<LaidOutBox['step']>;
