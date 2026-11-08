import { filledElement, sparseElement } from './contracts/whiteboard.ts';
import type { Element } from './contracts/whiteboard.ts';

type ElementKind = Element['kind'];

interface ElementTable extends ReadonlyMap<string, Element> {
  bodyOf(id: string): string | undefined;
  kindOf(id: string): ElementKind | undefined;
  sparseLengthOf(id: string): number;
  valuesOfKind<Kind extends ElementKind>(kind: Kind): Generator<Extract<Element, { kind: Kind }>>;
  countsByKind(): Map<ElementKind, number>;
  storedIdOf(id: string): string | undefined;
  put(element: Element): void;
  remove(id: string): boolean;
  copy(): ElementTable;
  toJSON(): Record<string, Element>;
}

interface StoredElementRow {
  id: string;
  kind: ElementKind;
  body: string;
}

interface TableRows {
  ids: (string | null)[];
  bodies: (string | null)[];
  kindCodes: Uint8Array;
  slotById: Map<string, number>;
  indexKeySlots: number[];
  indexKeyOrders: number[];
  holeCount: number;
}

const ARRAY_INDEX_KEY = /^(?:0|[1-9]\d{0,9})$/;
const MAX_ARRAY_INDEX = 4294967294;
const MIN_HOLES_BEFORE_COMPACTING = 1024;
const builtTables = new WeakSet<object>();
const KIND_NAMES = ['box', 'frame', 'wire', 'note', 'stroke'] as const satisfies readonly ElementKind[];
const KIND_CODE_BY_NAME = new Map<ElementKind, number>(KIND_NAMES.map((kind, code) => [kind, code]));
const KIND_NAME_SET = new Set<string>(KIND_NAMES);
const EMPTY_BODY = '{}';
const SHORTENED_KEYS = [
  'title', 'at', 'x', 'y', 'lines', 'text', 'style', 'from', 'to', 'label', 'on', 'contains', 'near', 'of', 'side', 'gap',
  'width', 'step', 'status', 'shape', 'icon', 'refs', 'change', 'muted', 'media', 'outputs', 'id', 'kind', 'ref', 'author', 'dashed',
] as const;
const KEY_CODE_BY_QUOTED_KEY = new Map<string, string>(SHORTENED_KEYS.map((key, index) => [`"${key}":`, String.fromCharCode(index + 1)]));
const QUOTED_KEY_BY_CODE = new Map<string, string>(SHORTENED_KEYS.map((key, index) => [String.fromCharCode(index + 1), `"${key}":`]));
const QUOTED_KEY_PATTERN = new RegExp(`"(?:${SHORTENED_KEYS.join('|')})":`, 'g');
const KEY_CODE_PATTERN = /[\u0001-\u001f]/g;

function shortenedKeysOf(json: string): string {
  return json.replace(QUOTED_KEY_PATTERN, (quotedKey) => KEY_CODE_BY_QUOTED_KEY.get(quotedKey) ?? quotedKey);
}

function jsonOfStored(body: string): string {
  return body.replace(KEY_CODE_PATTERN, (code) => QUOTED_KEY_BY_CODE.get(code) ?? code);
}

function isArrayIndexKey(id: string): boolean {
  return ARRAY_INDEX_KEY.test(id) && Number(id) <= MAX_ARRAY_INDEX;
}

function isElementKind(value: unknown): value is ElementKind {
  return typeof value === 'string' && KIND_NAME_SET.has(value);
}

function elementOfRow(id: string, kindCode: number, body: string): Element {
  const parsed = JSON.parse(jsonOfStored(body));
  parsed.id = id;
  parsed.kind = KIND_NAMES[kindCode];
  return filledElement(parsed);
}

function isElementOfKind<Kind extends ElementKind>(element: Element, kind: Kind): element is Extract<Element, { kind: Kind }> {
  return element.kind === kind;
}

function bodyOf(element: Element): string {
  const sparse = sparseElement(element);
  if (typeof sparse !== 'object' || sparse === null) return EMPTY_BODY;
  return shortenedKeysOf(JSON.stringify(Object.fromEntries(Object.entries(sparse).filter(([key]) => key !== 'id' && key !== 'kind'))));
}

function indexKeyPositionOf(rows: TableRows, id: string): number {
  const order = Number(id);
  let low = 0;
  let high = rows.indexKeyOrders.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows.indexKeyOrders[middle] ?? 0) < order) {
      low = middle + 1;
      continue;
    }
    high = middle;
  }
  return low;
}

function insertIndexKeySlot(rows: TableRows, slot: number, id: string): void {
  const position = indexKeyPositionOf(rows, id);
  rows.indexKeySlots.splice(position, 0, slot);
  rows.indexKeyOrders.splice(position, 0, Number(id));
}

function emptyRows(): TableRows {
  return { ids: [], bodies: [], kindCodes: new Uint8Array(64), slotById: new Map(), indexKeySlots: [], indexKeyOrders: [], holeCount: 0 };
}

function compacted(rows: TableRows): TableRows {
  const fresh = emptyRows();
  for (const slot of orderedSlotsOf(rows)) appendRow(fresh, rows.ids[slot] ?? '', rows.kindCodes[slot] ?? 0, rows.bodies[slot] ?? EMPTY_BODY);
  return fresh;
}

function setKindCode(rows: TableRows, slot: number, kindCode: number): void {
  if (slot >= rows.kindCodes.length) {
    const larger = new Uint8Array(Math.max(slot + 1, rows.kindCodes.length * 2));
    larger.set(rows.kindCodes);
    rows.kindCodes = larger;
  }
  rows.kindCodes[slot] = kindCode;
}

function appendRow(rows: TableRows, id: string, kindCode: number, body: string): void {
  const slot = rows.ids.length;
  rows.ids.push(id);
  rows.bodies.push(body);
  setKindCode(rows, slot, kindCode);
  rows.slotById.set(id, slot);
  if (isArrayIndexKey(id)) insertIndexKeySlot(rows, slot, id);
}

function* orderedSlotsOf(rows: TableRows): Generator<number> {
  for (const slot of rows.indexKeySlots) {
    if (rows.ids[slot] !== null) yield slot;
  }
  for (let slot = 0; slot < rows.ids.length; slot += 1) {
    const id = rows.ids[slot];
    if (id !== null && id !== undefined && !isArrayIndexKey(id)) yield slot;
  }
}

function tableOfRows(initialRows: TableRows): ElementTable {
  let rows = initialRows;
  const elementAt = (slot: number): Element => elementOfRow(rows.ids[slot] ?? '', rows.kindCodes[slot] ?? 0, rows.bodies[slot] ?? EMPTY_BODY);
  function* entries(): Generator<[string, Element]> {
    for (const slot of orderedSlotsOf(rows)) yield [rows.ids[slot] ?? '', elementAt(slot)];
  }
  function* keys(): Generator<string> {
    for (const slot of orderedSlotsOf(rows)) yield rows.ids[slot] ?? '';
  }
  function* values(): Generator<Element> {
    for (const slot of orderedSlotsOf(rows)) yield elementAt(slot);
  }
  function* valuesOfKind<Kind extends ElementKind>(kind: Kind): Generator<Extract<Element, { kind: Kind }>> {
    const kindCode = KIND_CODE_BY_NAME.get(kind);
    for (const slot of orderedSlotsOf(rows)) {
      if (rows.kindCodes[slot] !== kindCode) continue;
      const element = elementAt(slot);
      if (isElementOfKind(element, kind)) yield element;
    }
  }
  function countsByKind(): Map<ElementKind, number> {
    const counts = new Map<ElementKind, number>();
    for (let slot = 0; slot < rows.ids.length; slot += 1) {
      const kind = rows.ids[slot] === null ? undefined : KIND_NAMES[rows.kindCodes[slot] ?? 0];
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return counts;
  }
  function get(id: string): Element | undefined {
    const slot = rows.slotById.get(id);
    return slot === undefined ? undefined : elementAt(slot);
  }
  function kindOf(id: string): ElementKind | undefined {
    const slot = rows.slotById.get(id);
    return slot === undefined ? undefined : KIND_NAMES[rows.kindCodes[slot] ?? 0];
  }
  function sparseLengthOf(id: string): number {
    const slot = rows.slotById.get(id);
    const storedBody = slot === undefined ? null : rows.bodies[slot];
    const kind = slot === undefined ? undefined : KIND_NAMES[rows.kindCodes[slot] ?? 0];
    if (!storedBody || !kind) return 0;
    const body = jsonOfStored(storedBody);
    const separatorLength = body === EMPTY_BODY ? 0 : 1;
    return `{"kind":"${kind}","id":${JSON.stringify(id)}}`.length + body.length - 2 + separatorLength;
  }
  function rowBodyOf(id: string): string | undefined {
    const slot = rows.slotById.get(id);
    return slot === undefined ? undefined : rows.bodies[slot] ?? undefined;
  }
  function storedIdOf(id: string): string | undefined {
    const slot = rows.slotById.get(id);
    return slot === undefined ? undefined : rows.ids[slot] ?? undefined;
  }
  function put(element: Element): void {
    const slot = rows.slotById.get(element.id);
    const kindCode = KIND_CODE_BY_NAME.get(element.kind) ?? 0;
    if (slot === undefined) {
      appendRow(rows, element.id, kindCode, bodyOf(element));
      return;
    }
    rows.bodies[slot] = bodyOf(element);
    setKindCode(rows, slot, kindCode);
  }
  function remove(id: string): boolean {
    const slot = rows.slotById.get(id);
    if (slot === undefined) return false;
    rows.ids[slot] = null;
    rows.bodies[slot] = null;
    rows.slotById.delete(id);
    rows.holeCount += 1;
    if (rows.holeCount >= MIN_HOLES_BEFORE_COMPACTING && rows.holeCount > rows.slotById.size) rows = compacted(rows);
    return true;
  }
  function copy(): ElementTable {
    return tableOfRows({ ids: [...rows.ids], bodies: [...rows.bodies], kindCodes: rows.kindCodes.slice(), slotById: new Map(rows.slotById), indexKeySlots: [...rows.indexKeySlots], indexKeyOrders: [...rows.indexKeyOrders], holeCount: rows.holeCount });
  }
  function forEach(visit: (element: Element, id: string, table: ReadonlyMap<string, Element>) => void): void {
    for (const [id, element] of entries()) visit(element, id, table);
  }
  const table: ElementTable = {
    get size() { return rows.slotById.size; },
    get,
    bodyOf: rowBodyOf,
    kindOf,
    sparseLengthOf,
    valuesOfKind,
    countsByKind,
    storedIdOf,
    has: (id) => rows.slotById.has(id),
    entries,
    keys,
    values,
    forEach,
    put,
    remove,
    copy,
    toJSON: () => Object.fromEntries(entries()),
    [Symbol.iterator]: entries,
  };
  builtTables.add(table);
  return table;
}

function elementTableOf(elements: Iterable<Element> = []): ElementTable {
  const table = tableOfRows(emptyRows());
  for (const element of elements) table.put(element);
  return table;
}

function elementTableOfStoredRows(storedRows: Iterable<StoredElementRow>): ElementTable {
  const rows = emptyRows();
  for (const { id, kind, body } of storedRows) {
    if (rows.slotById.has(id)) continue;
    appendRow(rows, id, KIND_CODE_BY_NAME.get(kind) ?? 0, body);
  }
  return tableOfRows(rows);
}

function isElementTable(value: unknown): value is ElementTable {
  return typeof value === 'object' && value !== null && builtTables.has(value);
}

export { KIND_NAMES as ELEMENT_KIND_NAMES, elementTableOf, elementTableOfStoredRows, isElementKind, isElementTable };
export type { ElementKind, ElementTable, StoredElementRow };
