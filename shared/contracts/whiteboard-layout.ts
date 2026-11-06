import { z } from 'zod';

import type { BoardLayout } from '../whiteboard-layout-core.ts';
import { BOX_CHANGES, Box, BoxLine, BoxMedia, STEP_STATUSES, Wire } from './whiteboard.ts';

const Point = z.object({ x: z.number(), y: z.number() }).strict();
const RectFields = { x: z.number(), y: z.number(), width: z.number(), height: z.number() };
const BoxChange = z.enum(BOX_CHANGES);
const WireTone = Wire.shape.tone.unwrap();
const StepStatus = z.enum(STEP_STATUSES);

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
  change: BoxChange,
  wasLines: z.array(z.string()),
  shape: Box.shape.shape.unwrap(),
  headerHeight: z.number(),
  outputs: z.array(z.object({ id: z.string(), label: z.string(), port: Point }).strict()),
  media: z.object({ ...RectFields, kind: BoxMedia.shape.kind, asset: z.string(), mime: BoxMedia.shape.mime, hasPreview: z.boolean(), alt: z.string() }).strict().nullable(),
  step: z.object({ label: z.string(), status: StepStatus, linkedBoardId: z.string().nullable() }).strict().nullable(),
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
  tone: WireTone,
  hasArrowhead: z.boolean(),
  joinAt: Point.nullable(),
}).strict();

const LaidOutNote = z.object({ kind: z.literal('note'), id: z.string(), ...RectFields, lines: z.array(z.string()), byline: z.string(), isResolved: z.boolean() }).strict();

const LegendSwatch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wire'), tone: WireTone, isDashed: z.boolean(), isBack: z.boolean() }).strict(),
  z.object({ kind: z.literal('change'), change: BoxChange.exclude(['none']) }).strict(),
  z.object({ kind: z.literal('status'), status: StepStatus }).strict(),
]);

export const LaidOutBoard: z.ZodType<BoardLayout> = z.object({
  elements: z.array(z.discriminatedUnion('kind', [LaidOutBox, LaidOutFrame, LaidOutWire, LaidOutNote])),
  legend: z.array(z.object({ label: z.string(), x: z.number(), y: z.number(), swatch: LegendSwatch }).strict()),
  caption: z.object({ text: z.string(), x: z.number(), y: z.number() }).strict().nullable(),
  plan: z.object({ titleAt: Point }).strict().nullable(),
  pinnedOffsetY: z.number(),
  bounds: z.object(RectFields).strict(),
  warnings: z.array(z.string()),
}).strict();
