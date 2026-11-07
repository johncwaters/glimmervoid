import { filledElement, sparseElement } from './contracts/whiteboard.ts';
import type { Element } from './contracts/whiteboard.ts';

interface ElementTable extends ReadonlyMap<string, Element> {
  bodyOf(id: string): string | undefined;
  put(element: Element): void;
  remove(id: string): boolean;
  copy(): ElementTable;
  toJSON(): Record<string, Element>;
}

interface TableRows {
  ids: (string | null)[];
  bodies: (string | null)[];
  slotById: Map<string, number>;
  indexKeySlots: number[];
  indexKeyOrders: number[];
  holeCount: number;
}

const ARRAY_INDEX_KEY = /^(?:0|[1-9]\d{0,9})$/;
const MAX_ARRAY_INDEX = 4294967294;
const MIN_HOLES_BEFORE_COMPACTING = 1024;
const builtTables = new WeakSet<object>();

function isArrayIndexKey(id: string): boolean {
  return ARRAY_INDEX_KEY.test(id) && Number(id) <= MAX_ARRAY_INDEX;
}

function elementOfBody(body: string): Element {
  return filledElement(JSON.parse(body));
}

function bodyOf(element: Element): string {
  return JSON.stringify(sparseElement(element));
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
  return { ids: [], bodies: [], slotById: new Map(), indexKeySlots: [], indexKeyOrders: [], holeCount: 0 };
}

function compacted(rows: TableRows): TableRows {
  const fresh = emptyRows();
  for (const slot of orderedSlotsOf(rows)) appendRow(fresh, rows.ids[slot] ?? '', rows.bodies[slot] ?? '');
  return fresh;
}

function appendRow(rows: TableRows, id: string, body: string): void {
  const slot = rows.ids.length;
  rows.ids.push(id);
  rows.bodies.push(body);
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
  function* entries(): Generator<[string, Element]> {
    for (const slot of orderedSlotsOf(rows)) yield [rows.ids[slot] ?? '', elementOfBody(rows.bodies[slot] ?? '')];
  }
  function* keys(): Generator<string> {
    for (const slot of orderedSlotsOf(rows)) yield rows.ids[slot] ?? '';
  }
  function* values(): Generator<Element> {
    for (const slot of orderedSlotsOf(rows)) yield elementOfBody(rows.bodies[slot] ?? '');
  }
  function get(id: string): Element | undefined {
    const body = rowBodyOf(id);
    return body === undefined ? undefined : elementOfBody(body);
  }
  function rowBodyOf(id: string): string | undefined {
    const slot = rows.slotById.get(id);
    return slot === undefined ? undefined : rows.bodies[slot] ?? undefined;
  }
  function put(element: Element): void {
    const slot = rows.slotById.get(element.id);
    if (slot === undefined) {
      appendRow(rows, element.id, bodyOf(element));
      return;
    }
    rows.bodies[slot] = bodyOf(element);
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
    return tableOfRows({ ids: [...rows.ids], bodies: [...rows.bodies], slotById: new Map(rows.slotById), indexKeySlots: [...rows.indexKeySlots], indexKeyOrders: [...rows.indexKeyOrders], holeCount: rows.holeCount });
  }
  function forEach(visit: (element: Element, id: string, table: ReadonlyMap<string, Element>) => void): void {
    for (const [id, element] of entries()) visit(element, id, table);
  }
  const table: ElementTable = {
    get size() { return rows.slotById.size; },
    get,
    bodyOf: rowBodyOf,
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

function isElementTable(value: unknown): value is ElementTable {
  return typeof value === 'object' && value !== null && builtTables.has(value);
}

export { elementTableOf, isElementTable };
export type { ElementTable };
