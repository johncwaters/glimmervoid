import { z } from 'zod';
import { BOX_CHANGES, UNIT_STATUSES, Wire } from './whiteboard.ts';

export const TILE_LODS = ['full', 'titles', 'blocks'] as const;
export const BLOCK_RASTER_PX = 64;

const LINE_STYLES = ['text', 'code', 'item', 'numbered', 'kv'] as const;
const MEDIA_KINDS = ['image', 'video', 'page'] as const;
const MEDIA_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm', 'text/html'] as const;

const LayoutPoint = z.object({ x: z.number(), y: z.number() });
const rectShape = { x: z.number(), y: z.number(), width: z.number(), height: z.number() };
export const LayoutRect = z.object(rectShape);

const LaidOutLane = z.object({ label: z.string(), hex: z.string() });

export const LaidOutLine = z.object({
  text: z.string(),
  muted: z.boolean(),
  style: z.enum(LINE_STYLES),
  marker: z.string().nullable(),
  indentChars: z.number(),
  isFirstRow: z.boolean(),
});

export const LaidOutMedia = z.object({
  ...rectShape,
  kind: z.enum(MEDIA_KINDS),
  asset: z.string(),
  mime: z.enum(MEDIA_MIMES),
  hasPreview: z.boolean(),
  alt: z.string(),
});

const LaidOutOutput = z.object({ id: z.string(), label: z.string(), port: LayoutPoint });

export const LaidOutBox = z.object({
  ...rectShape,
  kind: z.literal('box'),
  id: z.string(),
  titleLines: z.array(z.string()),
  bodyLines: z.array(LaidOutLine),
  lane: LaidOutLane.nullable(),
  showsLanePill: z.boolean(),
  change: z.enum(BOX_CHANGES),
  wasLines: z.array(z.string()),
  shape: z.enum(['box', 'decision']),
  headerHeight: z.number(),
  outputs: z.array(LaidOutOutput),
  media: LaidOutMedia.nullable(),
});

export const LaidOutFrame = z.object({ ...rectShape, kind: z.literal('frame'), id: z.string(), title: z.string(), isLoop: z.boolean() });

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
  strokeHex: z.string().nullable(),
  tone: Wire.shape.tone.unwrap(),
  hasArrowhead: z.boolean(),
  joinAt: LayoutPoint.nullable(),
});

export const LaidOutNote = z.object({ ...rectShape, kind: z.literal('note'), id: z.string(), lines: z.array(z.string()), byline: z.string(), isResolved: z.boolean() });

export const LaidOutUnit = z.object({
  ...rectShape,
  kind: z.literal('unit'),
  id: z.string(),
  label: z.string(),
  status: z.enum(UNIT_STATUSES),
  titleLines: z.array(z.string()),
  bodyLines: z.array(LaidOutLine),
  linkedBoardId: z.string().nullable(),
});

export const LaidOutPanel = z.object({ ...rectShape, kind: z.literal('panel'), id: z.string(), titleLines: z.array(z.string()), bodyLines: z.array(LaidOutLine) });

export const LaidOutElement = z.discriminatedUnion('kind', [LaidOutBox, LaidOutFrame, LaidOutWire, LaidOutNote, LaidOutUnit, LaidOutPanel]);

const LegendSwatch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lane'), hex: z.string() }),
  z.object({ kind: z.literal('wire'), tone: Wire.shape.tone.unwrap(), isDashed: z.boolean(), isBack: z.boolean() }),
  z.object({ kind: z.literal('change'), change: z.enum(['added', 'removed', 'relabeled']) }),
  z.object({ kind: z.literal('status'), status: z.enum(UNIT_STATUSES) }),
]);

export const LegendRow = z.object({ label: z.string(), x: z.number(), y: z.number(), swatch: LegendSwatch });
export const PlanBand = z.object({ titleAt: LayoutPoint, arrowPaths: z.array(z.string()) });
export const LaidOutBand = z.object({ ...rectShape, id: z.string(), label: z.string(), hex: z.string() });
export const LaidOutColumn = z.object({ id: z.string(), titleLines: z.array(z.string()), titleBaselineY: z.number(), ruleY: z.number(), x: z.number(), width: z.number() });

export const BoardChrome = z.object({
  columns: z.array(LaidOutColumn),
  bands: z.array(LaidOutBand),
  legend: z.array(LegendRow),
  caption: z.object({ text: z.string(), x: z.number(), y: z.number() }).nullable(),
  plan: PlanBand.nullable(),
  pinnedOffsetY: z.number(),
  bounds: LayoutRect,
});

export const TileKey = z.object({ chunkX: z.number().int(), chunkY: z.number().int(), lod: z.enum(TILE_LODS), level: z.number().int().min(0).max(30) });

export const PaintedElement = z.object({ paintOrder: z.number().int().min(0), element: LaidOutElement });

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
export type LaidOutBox = z.infer<typeof LaidOutBox>;
export type LaidOutFrame = z.infer<typeof LaidOutFrame>;
export type LaidOutWire = z.infer<typeof LaidOutWire>;
export type LaidOutNote = z.infer<typeof LaidOutNote>;
export type LaidOutUnit = z.infer<typeof LaidOutUnit>;
export type LaidOutPanel = z.infer<typeof LaidOutPanel>;
export type LaidOutElement = z.infer<typeof LaidOutElement>;
export type LegendRow = z.infer<typeof LegendRow>;
export type PlanBand = z.infer<typeof PlanBand>;
export type LaidOutBand = z.infer<typeof LaidOutBand>;
export type LaidOutColumn = z.infer<typeof LaidOutColumn>;
export type BoardChrome = z.infer<typeof BoardChrome>;
export type TileKey = z.infer<typeof TileKey>;
export type TileLod = TileKey['lod'];
export type PaintedElement = z.infer<typeof PaintedElement>;
export type Tile = z.infer<typeof Tile>;
export type TileDiff = z.infer<typeof TileDiff>;
