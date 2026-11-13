import { z } from 'zod';

import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION, Board, Element, WHITEBOARD_LIMITS, sparseElement } from '../../shared/contracts/whiteboard.ts';
import type { BoxMedia } from '../../shared/contracts/whiteboard.ts';
import { exportedElementOf } from './board-file-core.ts';
import type { BoardContent } from './board-file-core.ts';

type BoardDocument = { headerLine: string; lineById: ReadonlyMap<string, string> };
type DecodedDocument = { ok: true; document: BoardDocument; content: BoardContent } | { ok: false; error: string };

const BoardDocumentHeader = z.object({
  format: z.literal(BOARD_FILE_FORMAT, { error: 'this is not a Glimmervoid board document' }),
  version: z.literal(BOARD_FILE_VERSION, { error: `this board document is from another Glimmervoid version; this one reads version ${BOARD_FILE_VERSION}` }),
  title: Board.shape.title,
  caption: Board.shape.caption,
  legend: Board.shape.legend,
}).strict();

function headerLineOf(content: Pick<BoardContent, 'title' | 'caption' | 'legend'>): string {
  return JSON.stringify({ format: BOARD_FILE_FORMAT, version: BOARD_FILE_VERSION, title: content.title, caption: content.caption, legend: content.legend });
}

function elementLineOf(element: Element): string {
  return JSON.stringify(sparseElement(exportedElementOf(element)));
}

function boardDocumentOf(content: BoardContent): BoardDocument {
  return { headerLine: headerLineOf(content), lineById: new Map(content.elements.map((element) => [element.id, elementLineOf(element)])) };
}

function encodeBoardDocument(document: BoardDocument): string {
  const sortedIds = [...document.lineById.keys()].sort();
  return [document.headerLine, ...sortedIds.map((id) => document.lineById.get(id))].join('\n').concat('\n');
}

function issueTextOf(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'it does not match the board document shape';
}

function parsedJsonOf(line: string): { ok: true; json: unknown } | { ok: false } {
  try {
    return { ok: true, json: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

function decodeBoardDocument(text: string): DecodedDocument {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const [headerText, ...elementTexts] = lines;
  if (headerText === undefined) return { ok: false, error: 'board.jsonl is empty' };
  if (elementTexts.length > WHITEBOARD_LIMITS.elements) return { ok: false, error: `board.jsonl holds more than the ${WHITEBOARD_LIMITS.elements} elements a board takes` };
  const headerJson = parsedJsonOf(headerText);
  if (!headerJson.ok) return { ok: false, error: 'line 1 of board.jsonl is not JSON' };
  const header = BoardDocumentHeader.safeParse(headerJson.json);
  if (!header.success) return { ok: false, error: `line 1 of board.jsonl: ${issueTextOf(header.error)}` };
  const elements: Element[] = [];
  const seenIds = new Set<string>();
  for (const [index, elementText] of elementTexts.entries()) {
    const lineNumber = index + 2;
    const elementJson = parsedJsonOf(elementText);
    if (!elementJson.ok) return { ok: false, error: `line ${lineNumber} of board.jsonl is not JSON` };
    const element = Element.safeParse(elementJson.json);
    if (!element.success) return { ok: false, error: `line ${lineNumber} of board.jsonl: ${issueTextOf(element.error)}` };
    if (seenIds.has(element.data.id)) return { ok: false, error: `line ${lineNumber} of board.jsonl repeats element ${element.data.id}` };
    seenIds.add(element.data.id);
    elements.push(element.data);
  }
  const content: BoardContent = { title: header.data.title, caption: header.data.caption, legend: header.data.legend, elements };
  return { ok: true, document: boardDocumentOf(content), content };
}

function mergedLine(base: string | undefined, ours: string | undefined, theirs: string | undefined): string | undefined {
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  return theirs;
}

function mergeBoardDocuments(base: BoardDocument, ours: BoardDocument, theirs: BoardDocument): BoardDocument {
  const allIds = new Set([...base.lineById.keys(), ...ours.lineById.keys(), ...theirs.lineById.keys()]);
  const lineById = new Map<string, string>();
  for (const id of allIds) {
    const line = mergedLine(base.lineById.get(id), ours.lineById.get(id), theirs.lineById.get(id));
    if (line !== undefined) lineById.set(id, line);
  }
  const headerLine = mergedLine(base.headerLine, ours.headerLine, theirs.headerLine) ?? theirs.headerLine;
  return { headerLine, lineById };
}

function withDanglingReferencesDropped(content: BoardContent): BoardContent {
  const boxIds = new Set(content.elements.filter((element) => element.kind === 'box').map((element) => element.id));
  const elements = content.elements.flatMap((element): Element[] => {
    if (element.kind === 'wire') return boxIds.has(element.from) && boxIds.has(element.to) ? [element] : [];
    if (element.kind !== 'frame') return [element];
    const contains = element.contains.filter((id) => boxIds.has(id));
    return contains.length === 0 ? [] : [{ ...element, contains }];
  });
  return { ...content, elements };
}

function mediaOfDocument(content: BoardContent): BoxMedia[] {
  return content.elements.flatMap((element) => (element.kind === 'box' && element.media ? [element.media] : []));
}

export { boardDocumentOf, decodeBoardDocument, encodeBoardDocument, mediaOfDocument, mergeBoardDocuments, withDanglingReferencesDropped };
export type { BoardDocument };
