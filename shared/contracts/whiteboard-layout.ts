import { z } from 'zod';

import type { BoardLayout } from '../whiteboard-layout-core.ts';
import { BOX_CHANGES, Box, BoxLine, BoxMedia, UNIT_STATUSES, Wire } from './whiteboard.ts';

const Point = z.object({ x: z.number(), y: z.number() }).strict();
const RectFields = { x: z.number(), y: z.number(), width: z.number(), height: z.number() };
const BoxChange = z.enum(BOX_CHANGES);
const WireTone = Wire.shape.tone.unwrap();
const UnitStatus = z.enum(UNIT_STATUSES);

const LaidOutLine = z.object({
  text: z.string(),
  muted: z.boolean(),
  style: BoxLine.shape.style.unwrap(),
  marker: z.string().nullable(),
  indentChars: z.number(),
  isFirstRow: z.boolean(),
}).strict();

const LaidOutBox = z.object({
  kind: z.literal('box'),
  id: z.string(),
  ...RectFields,
  titleLines: z.array(z.string()),
  bodyLines: z.array(LaidOutLine),
  lane: z.object({ label: z.string(), hex: z.string() }).strict().nullable(),
  showsLanePill: z.boolean(),
  change: BoxChange,
  wasLines: z.array(z.string()),
  shape: Box.shape.shape.unwrap(),
  headerHeight: z.number(),
  outputs: z.array(z.object({ id: z.string(), label: z.string(), port: Point }).strict()),
  media: z.object({ ...RectFields, kind: BoxMedia.shape.kind, asset: z.string(), mime: BoxMedia.shape.mime, hasPreview: z.boolean(), alt: z.string() }).strict().nullable(),
}).strict();

const LaidOutFrame = z.object({ kind: z.literal('frame'), id: z.string(), ...RectFields, title: z.string(), isLoop: z.boolean() }).strict();

const LaidOutWire = z.object({
  kind: z.literal('wire'),
  id: z.string(),
  path: z.string(),
  start: Point,
  end: Point,
  label: z.string().nullable(),
  labelAt: Point,
  isDashed: z.boolean(),
  isBack: z.boolean(),
  strokeHex: z.string().nullable(),
  tone: WireTone,
  hasArrowhead: z.boolean(),
  joinAt: Point.nullable(),
}).strict();

const LaidOutNote = z.object({ kind: z.literal('note'), id: z.string(), ...RectFields, lines: z.array(z.string()), byline: z.string(), isResolved: z.boolean() }).strict();

const LaidOutUnit = z.object({
  kind: z.literal('unit'),
  id: z.string(),
  ...RectFields,
  label: z.string(),
  status: UnitStatus,
  titleLines: z.array(z.string()),
  bodyLines: z.array(LaidOutLine),
  linkedBoardId: z.string().nullable(),
}).strict();

const LaidOutPanel = z.object({ kind: z.literal('panel'), id: z.string(), ...RectFields, titleLines: z.array(z.string()), bodyLines: z.array(LaidOutLine) }).strict();

const LegendSwatch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lane'), hex: z.string() }).strict(),
  z.object({ kind: z.literal('wire'), tone: WireTone, isDashed: z.boolean(), isBack: z.boolean() }).strict(),
  z.object({ kind: z.literal('change'), change: BoxChange.exclude(['none']) }).strict(),
  z.object({ kind: z.literal('status'), status: UnitStatus }).strict(),
]);

export const LaidOutBoard: z.ZodType<BoardLayout> = z.object({
  columns: z.array(z.object({ id: z.string(), titleLines: z.array(z.string()), titleBaselineY: z.number(), ruleY: z.number(), x: z.number(), width: z.number() }).strict()),
  bands: z.array(z.object({ id: z.string(), label: z.string(), hex: z.string(), ...RectFields }).strict()),
  elements: z.array(z.discriminatedUnion('kind', [LaidOutBox, LaidOutFrame, LaidOutWire, LaidOutNote, LaidOutUnit, LaidOutPanel])),
  legend: z.array(z.object({ label: z.string(), x: z.number(), y: z.number(), swatch: LegendSwatch }).strict()),
  caption: z.object({ text: z.string(), x: z.number(), y: z.number() }).strict().nullable(),
  plan: z.object({ titleAt: Point, arrowPaths: z.array(z.string()) }).strict().nullable(),
  pinnedOffsetY: z.number(),
  bounds: z.object(RectFields).strict(),
  warnings: z.array(z.string()),
}).strict();
