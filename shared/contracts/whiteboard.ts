import { z } from 'zod';

export const WHITEBOARD_LIMITS = Object.freeze({
  elements: 1000, opsPerPut: 200, putBytes: 262_144, title: 80, line: 120, linesPerBox: 12, columns: 12, lanes: 12, noteText: 400, logEntries: 2000, promptContextLines: 20, promptContextCharacters: 6000, promptContextLineCharacters: 300,
});

const LANE_COLORS = ['blue', 'green', 'orange', 'pink', 'cyan', 'yellow'] as const;

const ElementId = z.string({ error: 'an id must be a string' })
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'an id is 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit' });

const Title = z.string().max(WHITEBOARD_LIMITS.title, { error: `a title is at most ${WHITEBOARD_LIMITS.title} characters` });

const BoxLine = z.object({
  text: z.string().max(WHITEBOARD_LIMITS.line, { error: `a box line is at most ${WHITEBOARD_LIMITS.line} characters` }),
  muted: z.boolean().default(false),
}).strict();

const Point = z.object({ x: z.number(), y: z.number() }).strict();

export const Box = z.object({
  kind: z.literal('box'),
  id: ElementId,
  title: Title.min(1, { error: 'a box needs a title' }),
  lines: z.array(BoxLine).max(WHITEBOARD_LIMITS.linesPerBox, { error: `a box holds at most ${WHITEBOARD_LIMITS.linesPerBox} lines` }).default([]),
  lane: ElementId.nullable().default(null),
  ghost: z.boolean().default(false),
  column: ElementId,
  order: z.number().int().default(0),
  at: Point.nullable().default(null),
}).strict();

export const Frame = z.object({
  kind: z.literal('frame'),
  id: ElementId,
  title: Title,
  contains: z.array(ElementId).min(1, { error: 'a frame contains at least one box' }),
}).strict();

export const Wire = z.object({
  kind: z.literal('wire'),
  id: ElementId,
  from: ElementId,
  to: ElementId,
  dashed: z.boolean().default(false),
  tone: z.enum(['plain', 'fail', 'join', 'lane']).default('plain'),
  label: z.string().max(40, { error: 'a wire label is at most 40 characters' }).nullable().default(null),
}).strict();

export const Note = z.object({
  kind: z.literal('note'),
  id: ElementId,
  on: ElementId,
  text: z.string().min(1, { error: 'a note needs text' }).max(WHITEBOARD_LIMITS.noteText, { error: `a note is at most ${WHITEBOARD_LIMITS.noteText} characters` }),
  author: z.string().max(200).default(''),
  resolvedBy: z.string().max(200).nullable().default(null),
}).strict();

export const Element = z.discriminatedUnion('kind', [Box, Frame, Wire, Note], { error: 'an element kind is box, frame, wire or note' });

const BoardColumns = z.array(z.object({ id: ElementId, title: z.string().max(60) }).strict())
  .max(WHITEBOARD_LIMITS.columns, { error: `a board has at most ${WHITEBOARD_LIMITS.columns} columns` });

const BoardLanes = z.array(z.object({ id: ElementId, label: z.string().max(60), color: z.enum(LANE_COLORS) }).strict())
  .max(WHITEBOARD_LIMITS.lanes, { error: `a board has at most ${WHITEBOARD_LIMITS.lanes} lanes` });

export const Board = z.object({
  id: z.string().min(1).max(64),
  title: Title.min(1),
  version: z.number().int().nonnegative(),
  caption: z.string().max(400).nullable(),
  columns: BoardColumns,
  lanes: BoardLanes,
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
  z.object({ op: z.literal('columns'), columns: BoardColumns }).strict(),
  z.object({ op: z.literal('lanes'), lanes: BoardLanes }).strict(),
  z.object({ op: z.literal('board'), title: Title.min(1).optional(), caption: z.string().max(400).nullable().optional() }).strict(),
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
  z.object({ sub: z.literal('get'), board: BoardRef }).strict(),
  z.object({
    sub: z.literal('put'),
    board: BoardRef,
    ops: z.array(Op).min(1, { error: 'put needs at least one op' }).max(WHITEBOARD_LIMITS.opsPerPut, { error: `one put carries at most ${WHITEBOARD_LIMITS.opsPerPut} ops` }),
  }).strict(),
  z.object({ sub: z.literal('resolve'), board: BoardRef, note: ElementId }).strict(),
  z.object({ sub: z.literal('delete'), board: BoardRef }).strict(),
], { error: 'whiteboard takes new, list, connect, disconnect, get, put, resolve or delete' });

export const WhiteboardAgentReply = z.union([
  z.object({ ok: z.literal(true), board: BoardSummary, note: z.string() }).strict(),
  z.object({ ok: z.literal(true), boards: z.array(BoardSummary) }).strict(),
  z.object({ ok: z.literal(true), board: Board, changes: z.array(BoardChange) }).strict(),
  z.object({ ok: z.literal(true), version: z.number().int() }).strict(),
]);

export type Box = z.infer<typeof Box>;
export type Frame = z.infer<typeof Frame>;
export type Wire = z.infer<typeof Wire>;
export type Note = z.infer<typeof Note>;
export type Element = z.infer<typeof Element>;
export type Board = z.infer<typeof Board>;
export type Op = z.infer<typeof Op>;
export type BoardChange = z.infer<typeof BoardChange>;
export type BoardSummary = z.infer<typeof BoardSummary>;
export type BoardRecord = z.infer<typeof BoardRecord>;
export type WhiteboardAgentRequest = z.infer<typeof WhiteboardAgentRequest>;
export type WhiteboardAgentReply = z.infer<typeof WhiteboardAgentReply>;
