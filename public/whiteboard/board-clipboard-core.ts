import { z } from 'zod';
import { Element, WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { Box, BoxLine, Op } from '#shared/contracts/whiteboard.ts';

const BOARD_CLIPBOARD_TYPE = 'glimmervoid/board-elements';

const ClipboardArea = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();

const BoardClipboard = z.object({
  type: z.literal(BOARD_CLIPBOARD_TYPE),
  version: z.literal(1),
  area: ClipboardArea,
  elements: z.array(Element).min(1),
}).strict().refine(isSelfContained, { error: 'a pasted frame or wire names only boxes the clipboard carries' });

function isSelfContained(clipboard: { elements: readonly Element[] }): boolean {
  const boxIds = new Set(clipboard.elements.flatMap((element) => (element.kind === 'box' ? [element.id] : [])));
  return clipboard.elements.every((element) => {
    if (element.kind === 'frame') return element.contains.every((boxId) => boxIds.has(boxId));
    if (element.kind === 'wire') return boxIds.has(element.from) && boxIds.has(element.to);
    return true;
  });
}

export type BoardClipboard = z.infer<typeof BoardClipboard>;
type ClipboardRect = z.infer<typeof ClipboardArea>;
type ElementKind = Element['kind'];

interface ClipboardPoint {
  x: number;
  y: number;
}

interface CopySource {
  elements: { get: (elementId: string) => Element | undefined };
  selectedIds: ReadonlySet<string>;
  wireIdsOf: (boxId: string) => Iterable<string>;
  placedRectOf: (boxId: string) => ClipboardRect | null;
}

const URL_PATTERN = /^https?:\/\/\S+$/;
const PASTE_ORDER: readonly ElementKind[] = ['box', 'stroke', 'frame', 'wire'];

function selectedOfKind<Kind extends ElementKind>(source: CopySource, kind: Kind): Extract<Element, { kind: Kind }>[] {
  return [...source.selectedIds].flatMap((elementId) => {
    const element = source.elements.get(elementId);
    return element?.kind === kind ? [element as Extract<Element, { kind: Kind }>] : [];
  });
}

function strokeRectOf(points: readonly number[]): ClipboardRect {
  const xs = points.filter((_coordinate, index) => index % 2 === 0);
  const ys = points.filter((_coordinate, index) => index % 2 === 1);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

function areaAround(rects: readonly ClipboardRect[]): ClipboardRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function copiedClipboardOf(source: CopySource): BoardClipboard | null {
  const selectedFrames = selectedOfKind(source, 'frame');
  const boxIds = new Set([...selectedOfKind(source, 'box').map((box) => box.id), ...selectedFrames.flatMap((frame) => frame.contains)]);
  const placedBoxes = [...boxIds].flatMap((boxId) => {
    const box = source.elements.get(boxId);
    const rect = box?.kind === 'box' ? source.placedRectOf(boxId) : null;
    return box?.kind === 'box' && rect ? [{ box, rect }] : [];
  });
  const rectsByBoxId = new Map(placedBoxes.map(({ box, rect }) => [box.id, rect] as const));
  const boxes = placedBoxes.map(({ box, rect }): Box => ({ ...box, place: { at: { x: Math.round(rect.x), y: Math.round(rect.y) } } }));
  const frames = selectedFrames.flatMap((frame) => {
    const contains = frame.contains.filter((boxId) => rectsByBoxId.has(boxId));
    return contains.length > 0 ? [{ ...frame, contains }] : [];
  });
  const wireIds = new Set([...rectsByBoxId.keys()].flatMap((boxId) => [...source.wireIdsOf(boxId)]));
  const wires = [...wireIds].flatMap((wireId) => {
    const wire = source.elements.get(wireId);
    return wire?.kind === 'wire' && rectsByBoxId.has(wire.from) && rectsByBoxId.has(wire.to) ? [wire] : [];
  });
  const strokes = selectedOfKind(source, 'stroke');
  const rects = [...rectsByBoxId.values(), ...strokes.map((stroke) => strokeRectOf(stroke.points))];
  if (rects.length === 0) return null;
  return { type: BOARD_CLIPBOARD_TYPE, version: 1, area: areaAround(rects), elements: [...boxes, ...strokes, ...frames, ...wires] };
}

type ParsedClipboard = { kind: 'board'; clipboard: BoardClipboard } | { kind: 'unreadable' } | { kind: 'text' };

export function parsedClipboardOf(text: string): ParsedClipboard {
  const json = text.includes(BOARD_CLIPBOARD_TYPE) ? jsonOf(text) : null;
  if (!isTaggedAsBoardClipboard(json)) return { kind: 'text' };
  const parsed = BoardClipboard.safeParse(json);
  return parsed.success ? { kind: 'board', clipboard: parsed.data } : { kind: 'unreadable' };
}

function isTaggedAsBoardClipboard(json: unknown): boolean {
  return typeof json === 'object' && json !== null && 'type' in json && json.type === BOARD_CLIPBOARD_TYPE;
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shiftedElementOf(element: Element, offset: ClipboardPoint, newIdById: ReadonlyMap<string, string>): Element {
  const freshIdOf = (elementId: string) => newIdById.get(elementId) ?? elementId;
  const id = freshIdOf(element.id);
  switch (element.kind) {
    case 'box': {
      const at = typeof element.place === 'object' ? element.place.at : { x: 0, y: 0 };
      return { ...element, id, place: { at: { x: Math.round(at.x + offset.x), y: Math.round(at.y + offset.y) } } };
    }
    case 'stroke': return { ...element, id, points: element.points.map((coordinate, index) => Math.round(coordinate + (index % 2 === 0 ? offset.x : offset.y))) };
    case 'frame': return { ...element, id, contains: element.contains.map(freshIdOf) };
    case 'wire': return { ...element, id, from: freshIdOf(element.from), to: freshIdOf(element.to) };
  }
}

export function pastedOpsOf(clipboard: BoardClipboard, offset: ClipboardPoint, newIdOf: (kind: ElementKind) => string): { ops: Op[]; pastedIds: string[] } {
  const newIdById = new Map(clipboard.elements.map((element) => [element.id, newIdOf(element.kind)] as const));
  const ordered = PASTE_ORDER.flatMap((kind) => clipboard.elements.filter((element) => element.kind === kind));
  const pasted = ordered.map((element) => shiftedElementOf(element, offset, newIdById));
  return { ops: pasted.map((element): Op => ({ op: 'add', element })), pastedIds: pasted.map((element) => element.id) };
}

export function centeringOffsetOf(clipboard: BoardClipboard, center: ClipboardPoint): ClipboardPoint {
  const { area } = clipboard;
  return { x: Math.round(center.x - (area.x + area.width / 2)), y: Math.round(center.y - (area.y + area.height / 2)) };
}

interface PastedText {
  title: string;
  lines: BoxLine[];
  isLink: boolean;
  isCut: boolean;
}

export function pastedTextOf(text: string): PastedText | null {
  const rows = text.replace(/\r\n?/g, '\n').split('\n').map((row) => row.trimEnd());
  const firstWrittenRow = rows.findIndex((row) => row.trim() !== '');
  if (firstWrittenRow === -1) return null;
  const writtenRows = rows.slice(firstWrittenRow);
  while (writtenRows.length > 0 && writtenRows[writtenRows.length - 1] === '') writtenRows.pop();
  const titleRow = (writtenRows[0] ?? '').trim();
  const isLink = writtenRows.length === 1 && URL_PATTERN.test(titleRow);
  const lineRows = isLink && titleRow.length > WHITEBOARD_LIMITS.title ? [titleRow] : writtenRows.slice(1);
  const keptLineRows = lineRows.slice(0, WHITEBOARD_LIMITS.linesPerBox);
  const isCut = titleRow.length > WHITEBOARD_LIMITS.title && !isLink
    || lineRows.length > keptLineRows.length
    || keptLineRows.some((row) => row.length > WHITEBOARD_LIMITS.line);
  const lines = keptLineRows.map((row): BoxLine => ({ text: row.slice(0, WHITEBOARD_LIMITS.line), muted: false, style: 'text', key: null }));
  return { title: titleRow.slice(0, WHITEBOARD_LIMITS.title), lines, isLink, isCut };
}
