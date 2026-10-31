import { z } from 'zod';

export const WHITEBOARD_LIMITS = Object.freeze({
  elements: 1000, opsPerPut: 200, putBytes: 262_144, title: 80, line: 120, linesPerBox: 12, columns: 12, lanes: 12, noteText: 400, logEntries: 2000, promptContextLines: 20, promptContextCharacters: 6000, promptContextLineCharacters: 300, layoutWarnings: 20, units: 40, unitDependencies: 12, linesPerUnit: 4,
});

const LANE_COLORS = ['blue', 'green', 'orange', 'pink', 'cyan', 'yellow'] as const;

const ElementId = z.string({ error: 'an id must be a string' })
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'an id is 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit' });

const Title = z.string().max(WHITEBOARD_LIMITS.title, { error: `a title is at most ${WHITEBOARD_LIMITS.title} characters` });

export const AnchorRef = z.string().min(1).max(200, { error: 'a ref is at most 200 characters' })
  .regex(/^[^#\s]+(#L[1-9]\d*(-L[1-9]\d*)?)?$/, { error: 'a ref is path, path#L12 or path#L12-L30' });

const AnchorRefs = z.array(AnchorRef).max(8, { error: 'an element carries at most 8 refs' }).default([]);

const BoxLine = z.object({
  text: z.string().max(WHITEBOARD_LIMITS.line, { error: `a box line is at most ${WHITEBOARD_LIMITS.line} characters` }),
  muted: z.boolean().default(false),
  style: z.enum(['text', 'code', 'item', 'numbered', 'kv']).default('text'),
  key: z.string().max(40, { error: 'a line key is at most 40 characters' }).nullable().default(null),
  ref: AnchorRef.nullable().default(null),
}).strict().refine((line) => line.style !== 'kv' || Boolean(line.key), { error: 'a kv line needs a key' });

const Point = z.object({ x: z.number(), y: z.number() }).strict();

export const BOX_CHANGES = ['none', 'added', 'removed', 'relabeled'] as const;

export const UNIT_STATUSES = ['planned', 'building', 'landed'] as const;

const Side = z.enum(['left', 'right', 'top', 'bottom']);

const Near = z.object({
  of: ElementId,
  side: Side,
  gap: z.number().int().min(0).max(400).default(60),
}).strict();

const Output = z.object({
  id: ElementId,
  label: z.string().min(1, { error: 'an output needs a label' }).max(30, { error: 'an output label is at most 30 characters' }),
}).strict();

export const Box = z.object({
  kind: z.literal('box'),
  id: ElementId,
  title: Title.min(1, { error: 'a box needs a title' }),
  lines: z.array(BoxLine).max(WHITEBOARD_LIMITS.linesPerBox, { error: `a box holds at most ${WHITEBOARD_LIMITS.linesPerBox} lines` }).default([]),
  lane: ElementId.nullable().default(null),
  refs: AnchorRefs,
  change: z.enum(BOX_CHANGES).default('none'),
  was: Title.nullable().default(null),
  column: ElementId.nullable().default(null),
  near: Near.nullable().default(null),
  order: z.number().int().default(0),
  at: Point.nullable().default(null),
  shape: z.enum(['box', 'decision']).default('box'),
  outputs: z.array(Output).max(8, { error: 'a decision has at most 8 outputs' }).default([]),
}).strict();

export const Frame = z.object({
  kind: z.literal('frame'),
  id: ElementId,
  title: Title,
  contains: z.array(ElementId).min(1, { error: 'a frame contains at least one box' }),
  loop: z.boolean().default(false),
}).strict();

export const Wire = z.object({
  kind: z.literal('wire'),
  id: ElementId,
  from: ElementId,
  to: ElementId,
  fromOutput: ElementId.nullable().default(null),
  dashed: z.boolean().default(false),
  tone: z.enum(['plain', 'fail', 'join', 'lane']).default('plain'),
  label: z.string().max(40, { error: 'a wire label is at most 40 characters' }).nullable().default(null),
  fromSide: Side.nullable().default(null),
  toSide: Side.nullable().default(null),
  back: z.boolean().default(false),
}).strict();

export const Note = z.object({
  kind: z.literal('note'),
  id: ElementId,
  on: ElementId,
  text: z.string().min(1, { error: 'a note needs text' }).max(WHITEBOARD_LIMITS.noteText, { error: `a note is at most ${WHITEBOARD_LIMITS.noteText} characters` }),
  ref: AnchorRef.nullable().default(null),
  author: z.string().max(200).default(''),
  resolvedBy: z.string().max(200).nullable().default(null),
}).strict();

export const Unit = z.object({
  kind: z.literal('unit'),
  id: ElementId,
  title: Title.min(1, { error: 'a unit needs a title' }),
  lines: z.array(BoxLine).max(WHITEBOARD_LIMITS.linesPerUnit, { error: `a unit holds at most ${WHITEBOARD_LIMITS.linesPerUnit} lines` }).default([]),
  refs: AnchorRefs,
  status: z.enum(UNIT_STATUSES).default('planned'),
  after: z.array(ElementId).max(WHITEBOARD_LIMITS.unitDependencies, { error: `a unit comes after at most ${WHITEBOARD_LIMITS.unitDependencies} units` }).default([]),
  linkedBoardId: z.string().min(1).max(64).nullable().default(null),
}).strict();

export const Panel = z.object({
  kind: z.literal('panel'),
  id: ElementId,
  title: Title.min(1, { error: 'a panel needs a title' }),
  lines: z.array(BoxLine).max(WHITEBOARD_LIMITS.linesPerBox, { error: `a panel holds at most ${WHITEBOARD_LIMITS.linesPerBox} lines` }).default([]),
  order: z.number().int().default(0),
}).strict();

export const Element = z.discriminatedUnion('kind', [Box, Frame, Wire, Note, Unit, Panel], { error: 'an element kind is box, frame, wire, note, unit or panel' });

const LegendEntries = z.array(z.object({
  tone: Wire.shape.tone,
  dashed: z.boolean().default(false),
  back: z.boolean().default(false),
  label: z.string().min(1, { error: 'a legend entry needs a label' }).max(40, { error: 'a legend label is at most 40 characters' }),
}).strict()).max(12, { error: 'a legend has at most 12 entries' });

const BoardColumns = z.array(z.object({ id: ElementId, title: z.string().max(60) }).strict())
  .max(WHITEBOARD_LIMITS.columns, { error: `a board has at most ${WHITEBOARD_LIMITS.columns} columns` });

const BoardLanes = z.array(z.object({ id: ElementId, label: z.string().max(60), color: z.enum(LANE_COLORS) }).strict())
  .max(WHITEBOARD_LIMITS.lanes, { error: `a board has at most ${WHITEBOARD_LIMITS.lanes} lanes` });

const CodeSessionId = z.string().min(1).max(64);

export const Board = z.object({
  id: z.string().min(1).max(64),
  title: Title.min(1),
  version: z.number().int().nonnegative(),
  caption: z.string().max(400).nullable(),
  columns: BoardColumns,
  lanes: BoardLanes,
  legend: LegendEntries.default([]),
  codeSessionId: CodeSessionId.nullable().default(null),
  elements: z.record(ElementId, Element)
    .refine((elements) => Object.keys(elements).length <= WHITEBOARD_LIMITS.elements, { error: `a board holds at most ${WHITEBOARD_LIMITS.elements} elements` })
    .refine((elements) => Object.entries(elements).every(([id, element]) => element.id === id), { error: 'every element is stored under its own id' }),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), element: Element }).strict(),
  z.object({ op: z.literal('set'), id: ElementId, fields: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ op: z.literal('remove'), id: ElementId }).strict(),
  z.object({ op: z.literal('resolve'), id: ElementId }).strict(),
  z.object({ op: z.literal('columns'), columns: BoardColumns, move: z.record(ElementId, ElementId).default({}) }).strict(),
  z.object({ op: z.literal('lanes'), lanes: BoardLanes }).strict(),
  z.object({ op: z.literal('board'), title: Title.min(1).optional(), caption: z.string().max(400).nullable().optional(), legend: LegendEntries.optional(), codeSessionId: CodeSessionId.nullable().optional() }).strict(),
], { error: 'an op is add, set, remove, resolve, columns, lanes or board' });

export const BoardChange = z.object({
  version: z.number().int(),
  author: z.string(),
  elementId: z.string().nullable(),
  summary: z.string(),
}).strict();

export const BoardSummary = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number().int(),
  updatedAt: z.number(),
  connectedSessionIds: z.array(z.string()),
  queuedBySessionId: z.record(z.string(), z.number().int()),
}).strict();

export const BoardRecord = z.object({
  board: Board,
  log: z.array(BoardChange),
  cursorBySessionId: z.record(z.string(), z.number().int()),
  createdBy: z.string().nullable().default(null),
}).strict();

const BoardRef = z.string({ error: 'the board must be a string' }).min(1, { error: 'name the board by id or title' }).max(200);

export const WhiteboardAgentRequest = z.discriminatedUnion('sub', [
  z.object({ sub: z.literal('new'), title: Title.min(1, { error: 'a new board needs a title' }) }).strict(),
  z.object({ sub: z.literal('list') }).strict(),
  z.object({ sub: z.literal('connect'), board: BoardRef }).strict(),
  z.object({ sub: z.literal('disconnect'), board: BoardRef }).strict(),
  z.object({ sub: z.literal('get'), board: BoardRef, peek: z.boolean().optional(), review: z.boolean().optional() }).strict(),
  z.object({
    sub: z.literal('put'),
    board: BoardRef,
    ops: z.array(Op).min(1, { error: 'put needs at least one op' }).max(WHITEBOARD_LIMITS.opsPerPut, { error: `one put carries at most ${WHITEBOARD_LIMITS.opsPerPut} ops` }),
  }).strict(),
  z.object({ sub: z.literal('resolve'), board: BoardRef, note: ElementId }).strict(),
  z.object({ sub: z.literal('delete'), board: BoardRef }).strict(),
], { error: 'whiteboard takes new, list, connect, disconnect, get, put, resolve or delete' });

export const BoardReview = z.object({
  codeSessionId: z.string().nullable(),
  anchorWarnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  unitWarnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  uncoveredPaths: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  worthALookPaths: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
}).strict();

export const WhiteboardAgentReply = z.union([
  z.object({ ok: z.literal(true), board: BoardSummary, note: z.string() }).strict(),
  z.object({ ok: z.literal(true), boards: z.array(BoardSummary) }).strict(),
  z.object({ ok: z.literal(true), board: Board, changes: z.array(BoardChange), review: BoardReview.optional() }).strict(),
  z.object({ ok: z.literal(true), version: z.number().int(), warnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings).optional() }).strict(),
]);

export type Box = z.infer<typeof Box>;
export type Frame = z.infer<typeof Frame>;
export type Wire = z.infer<typeof Wire>;
export type Note = z.infer<typeof Note>;
export type Unit = z.infer<typeof Unit>;
export type Panel = z.infer<typeof Panel>;
export type Element = z.infer<typeof Element>;
export type Board = z.infer<typeof Board>;
export type Op = z.infer<typeof Op>;
export type BoardChange = z.infer<typeof BoardChange>;
export type BoardReview = z.infer<typeof BoardReview>;
export type BoardSummary = z.infer<typeof BoardSummary>;
export type BoardRecord = z.infer<typeof BoardRecord>;
export type WhiteboardAgentRequest = z.infer<typeof WhiteboardAgentRequest>;
export type WhiteboardAgentReply = z.infer<typeof WhiteboardAgentReply>;
