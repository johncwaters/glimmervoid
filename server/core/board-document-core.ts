import { z } from 'zod';

import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION, Board, Element, WHITEBOARD_LIMITS, boxIdOfEnd, sparseElement } from '../../shared/contracts/whiteboard.ts';
import type { BoxMedia, WireEnd } from '../../shared/contracts/whiteboard.ts';
import { exportedElementOf } from './board-file-core.ts';
import type { BoardContent } from './board-file-core.ts';

type BoardDocument = { headerLine: string; lineById: ReadonlyMap<string, string>; stackKeyById: ReadonlyMap<string, string> };
type DecodedDocument = { ok: true; document: BoardDocument; content: BoardContent } | { ok: false; error: string };

const STACKED_DOCUMENT_VERSION = BOARD_FILE_VERSION + 1;
const FIRST_READABLE_DOCUMENT_VERSION = 4;
const READABLE_DOCUMENT_VERSIONS = Array.from({ length: STACKED_DOCUMENT_VERSION - FIRST_READABLE_DOCUMENT_VERSION + 1 }, (_, offset) => FIRST_READABLE_DOCUMENT_VERSION + offset);

const BoardDocumentHeader = z.object({
  format: z.literal(BOARD_FILE_FORMAT, { error: 'this is not a Glimmervoid board document' }),
  version: z.literal(READABLE_DOCUMENT_VERSIONS, { error: `this board document is from another Glimmervoid version; this one reads versions ${READABLE_DOCUMENT_VERSIONS.join(', ')}` }),
  title: Board.shape.title,
  caption: Board.shape.caption,
  legend: Board.shape.legend,
}).strict();

function headerLineOf(content: Pick<BoardContent, 'title' | 'caption' | 'legend'>): string {
  return JSON.stringify({ format: BOARD_FILE_FORMAT, version: STACKED_DOCUMENT_VERSION, title: content.title, caption: content.caption, legend: content.legend });
}

const STACK_KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const STACK_KEY_PATTERN = /^[0-9A-Za-z]{0,999}[1-9A-Za-z]$/;
const MIDDLE_STACK_KEY = 'V';
const MAX_MADE_STACK_KEY_LENGTH = 64;

function stackDigitAt(key: string, index: number): number {
  return STACK_KEY_DIGITS.indexOf(key[index] ?? '0');
}

function stackDigit(digit: number): string {
  return STACK_KEY_DIGITS[digit] ?? '';
}

function midpointStackKey(lower: string, upper: string | null): string {
  if (upper !== null) {
    let sharedLength = 0;
    while (sharedLength < upper.length && (lower[sharedLength] ?? '0') === upper[sharedLength]) sharedLength += 1;
    if (sharedLength > 0) return upper.slice(0, sharedLength) + midpointStackKey(lower.slice(sharedLength), upper.slice(sharedLength));
  }
  const lowerDigit = stackDigitAt(lower, 0);
  const upperDigit = upper === null ? STACK_KEY_DIGITS.length : stackDigitAt(upper, 0);
  if (upperDigit - lowerDigit > 1) return stackDigit(Math.round((lowerDigit + upperDigit) / 2));
  if (upper !== null && upper.length > 1) return upper.slice(0, 1);
  return stackDigit(lowerDigit) + midpointStackKey(lower.slice(1), null);
}

function stackKeyAfter(lower: string): string {
  const raisableIndex = [...lower].findIndex((character) => character !== 'z');
  if (raisableIndex === -1) return `${lower}1`;
  return lower.slice(0, raisableIndex) + stackDigit(stackDigitAt(lower, raisableIndex) + 1);
}

function stackKeyBetween(lower: string | null, upper: string | null): string {
  if (upper === null) return lower === null ? MIDDLE_STACK_KEY : stackKeyAfter(lower);
  return midpointStackKey(lower ?? '', upper);
}

function stackKeysBetween(lower: string | null, upper: string | null, count: number): string[] {
  if (count === 0) return [];
  const middle = stackKeyBetween(lower, upper);
  const lowerCount = Math.floor((count - 1) / 2);
  return [...stackKeysBetween(lower, middle, lowerCount), middle, ...stackKeysBetween(middle, upper, count - 1 - lowerCount)];
}

function indexesOfLongestRisingRun(keys: readonly (string | undefined)[]): Set<number> {
  const tailIndexes: number[] = [];
  const previousIndexes: number[] = keys.map(() => -1);
  for (const [index, key] of keys.entries()) {
    if (key === undefined) continue;
    let low = 0;
    let high = tailIndexes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((keys[tailIndexes[middle] ?? -1] ?? '') < key) {
        low = middle + 1;
        continue;
      }
      high = middle;
    }
    previousIndexes[index] = low > 0 ? tailIndexes[low - 1] ?? -1 : -1;
    tailIndexes[low] = index;
  }
  const runIndexes = new Set<number>();
  for (let index = tailIndexes.at(-1) ?? -1; index !== -1; index = previousIndexes[index] ?? -1) runIndexes.add(index);
  return runIndexes;
}

function stackKeysOfKind(ids: readonly string[], keptKeyById: ReadonlyMap<string, string>): Map<string, string> {
  const keptKeys = ids.map((id) => keptKeyById.get(id));
  const runIndexes = indexesOfLongestRisingRun(keptKeys);
  const stackKeyById = new Map<string, string>();
  let lowerKey: string | null = null;
  let waitingIds: string[] = [];
  const placeWaiting = (upperKey: string | null) => {
    const waitingKeys = stackKeysBetween(lowerKey, upperKey, waitingIds.length);
    for (const [index, id] of waitingIds.entries()) stackKeyById.set(id, waitingKeys[index] ?? '');
    waitingIds = [];
  };
  for (const [index, id] of ids.entries()) {
    const keptKey = keptKeys[index];
    if (keptKey === undefined || !runIndexes.has(index)) {
      waitingIds.push(id);
      continue;
    }
    placeWaiting(keptKey);
    stackKeyById.set(id, keptKey);
    lowerKey = keptKey;
  }
  placeWaiting(null);
  const isAnyKeyTooLong = [...stackKeyById.values()].some((key) => key.length > MAX_MADE_STACK_KEY_LENGTH);
  if (!isAnyKeyTooLong) return stackKeyById;
  const evenlySpacedKeys = stackKeysBetween(null, null, ids.length);
  return new Map(ids.map((id, index) => [id, evenlySpacedKeys[index] ?? '']));
}

function stackKeysOf(elements: readonly Element[], keptKeyById: ReadonlyMap<string, string>): Map<string, string> {
  const idsByKind = new Map<Element['kind'], string[]>();
  for (const element of elements) {
    const idsOfKind = idsByKind.get(element.kind) ?? [];
    idsOfKind.push(element.id);
    idsByKind.set(element.kind, idsOfKind);
  }
  return new Map([...idsByKind.values()].flatMap((ids) => [...stackKeysOfKind(ids, keptKeyById)]));
}

function elementLineOf(element: Element): string {
  return JSON.stringify(sparseElement(exportedElementOf(element)));
}

function keyedLineOf(line: string, stackKey: string | undefined): string {
  return stackKey === undefined ? line : `${line.slice(0, -1)},"stack":${JSON.stringify(stackKey)}}`;
}

function documentOfKeyedContent(content: BoardContent, stackKeyById: ReadonlyMap<string, string>): BoardDocument {
  const lineById = new Map(content.elements.map((element) => [element.id, elementLineOf(element)]));
  return { headerLine: headerLineOf(content), lineById, stackKeyById };
}

function boardDocumentOf(content: BoardContent, keptKeyById: ReadonlyMap<string, string>): BoardDocument {
  return documentOfKeyedContent(content, stackKeysOf(content.elements, keptKeyById));
}

function encodeBoardDocument(document: BoardDocument): string {
  const sortedIds = [...document.lineById.keys()].sort();
  return [document.headerLine, ...sortedIds.map((id) => keyedLineOf(document.lineById.get(id) ?? '', document.stackKeyById.get(id)))].join('\n').concat('\n');
}

const KeyedElementLine = z.looseObject({
  stack: z.string().regex(STACK_KEY_PATTERN, { error: 'stack is not a stack key of digits and letters' }).optional(),
});

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
  const stackKeyById = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const [index, elementText] of elementTexts.entries()) {
    const lineNumber = index + 2;
    const elementJson = parsedJsonOf(elementText);
    if (!elementJson.ok) return { ok: false, error: `line ${lineNumber} of board.jsonl is not JSON` };
    const keyedElement = KeyedElementLine.safeParse(elementJson.json);
    if (!keyedElement.success) return { ok: false, error: `line ${lineNumber} of board.jsonl: ${issueTextOf(keyedElement.error)}` };
    const { stack, ...elementFields } = keyedElement.data;
    const element = Element.safeParse(elementFields);
    if (!element.success) return { ok: false, error: `line ${lineNumber} of board.jsonl: ${issueTextOf(element.error)}` };
    if (seenIds.has(element.data.id)) return { ok: false, error: `line ${lineNumber} of board.jsonl repeats element ${element.data.id}` };
    seenIds.add(element.data.id);
    if (stack !== undefined) stackKeyById.set(element.data.id, stack);
    elements.push(element.data);
  }
  const stackedElements = elements.toSorted((first, second) => compareStackPlaces(stackKeyById.get(first.id) ?? '', first.id, stackKeyById.get(second.id) ?? '', second.id));
  const content: BoardContent = { title: header.data.title, caption: header.data.caption, legend: header.data.legend, elements: stackedElements };
  return { ok: true, document: documentOfKeyedContent(content, stackKeyById), content };
}

function compareStackPlaces(firstKey: string, firstId: string, secondKey: string, secondId: string): number {
  if (firstKey !== secondKey) return firstKey < secondKey ? -1 : 1;
  if (firstId === secondId) return 0;
  return firstId < secondId ? -1 : 1;
}

function mergedLine(base: string | undefined, ours: string | undefined, theirs: string | undefined): string | undefined {
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  return theirs;
}

function mergeBoardDocuments(base: BoardDocument, ours: BoardDocument, theirs: BoardDocument): BoardDocument {
  const allIds = new Set([...base.lineById.keys(), ...ours.lineById.keys(), ...theirs.lineById.keys()]);
  const lineById = new Map<string, string>();
  const stackKeyById = new Map<string, string>();
  for (const id of allIds) {
    const line = mergedLine(base.lineById.get(id), ours.lineById.get(id), theirs.lineById.get(id));
    if (line === undefined) continue;
    lineById.set(id, line);
    const stackKey = mergedLine(base.stackKeyById.get(id), ours.stackKeyById.get(id), theirs.stackKeyById.get(id)) ?? ours.stackKeyById.get(id) ?? theirs.stackKeyById.get(id);
    if (stackKey !== undefined) stackKeyById.set(id, stackKey);
  }
  const headerLine = mergedLine(base.headerLine, ours.headerLine, theirs.headerLine) ?? theirs.headerLine;
  return { headerLine, lineById, stackKeyById };
}

function withDanglingReferencesDropped(content: BoardContent): BoardContent {
  const boxIds = new Set(content.elements.filter((element) => element.kind === 'box').map((element) => element.id));
  const isWireEndPresent = (end: WireEnd) => { const boxId = boxIdOfEnd(end); return boxId === null || boxIds.has(boxId); };
  const elements = content.elements.flatMap((element): Element[] => {
    if (element.kind === 'wire') return isWireEndPresent(element.from) && isWireEndPresent(element.to) ? [element] : [];
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
