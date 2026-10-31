import type { Board, Element, Op } from './contracts/whiteboard.ts';
import { OPERATOR_AUTHOR, applyOps } from './whiteboard-ops-core.ts';

type UndoDirection = 'undo' | 'redo';
type UndoHistory = Readonly<Record<UndoDirection, readonly Op[][]>>;

const UNDO_LIMIT = 100;
const EMPTY_HISTORY: UndoHistory = Object.freeze({ undo: [], redo: [] });
const EARLY_ADD_KINDS: ReadonlySet<Element['kind']> = new Set(['box', 'unit', 'panel']);
const REMOVAL_ORDER: readonly Element['kind'][] = ['wire', 'note', 'frame', 'box', 'panel', 'unit'];
const UNSETTABLE_FIELDS: ReadonlySet<string> = new Set(['kind', 'id']);

function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dependencyIdsOf(element: Element): readonly string[] {
  if (element.kind === 'box') return element.near ? [element.near.of] : [];
  if (element.kind === 'unit') return element.after;
  return [];
}

function inDependencyOrder(elements: readonly Element[]): Element[] {
  const pendingIds = new Set(elements.map((element) => element.id));
  const ordered: Element[] = [];
  while (pendingIds.size > 0) {
    const ready = elements.filter((element) => pendingIds.has(element.id) && dependencyIdsOf(element).every((id) => !pendingIds.has(id)));
    const batch = ready.length > 0 ? ready : elements.filter((element) => pendingIds.has(element.id));
    for (const element of batch) pendingIds.delete(element.id);
    ordered.push(...batch);
  }
  return ordered;
}

function changedFields(current: Element, target: Element): Record<string, unknown> {
  const currentFields: Record<string, unknown> = { ...current };
  const changed = Object.fromEntries(Object.entries(target).filter(([field, value]) => !UNSETTABLE_FIELDS.has(field) && !isSameValue(currentFields[field], value)));
  if (target.kind !== 'note' || Object.keys(changed).length === 0) return changed;
  return { ...changed, author: target.author, resolvedBy: target.resolvedBy };
}

function boardFieldOps(current: Board, target: Board): Op[] {
  const fields = {
    ...(current.title === target.title ? {} : { title: target.title }),
    ...(current.caption === target.caption ? {} : { caption: target.caption }),
    ...(isSameValue(current.legend, target.legend) ? {} : { legend: target.legend }),
  };
  return Object.keys(fields).length === 0 ? [] : [{ op: 'board', ...fields }];
}

function columnOps(current: Board, target: Board): { widen: Op[]; narrow: Op[] } {
  if (isSameValue(current.columns, target.columns)) return { widen: [], narrow: [] };
  const targetColumnIds = new Set(target.columns.map((column) => column.id));
  const widenedColumns = [...target.columns, ...current.columns.filter((column) => !targetColumnIds.has(column.id))];
  return { widen: [{ op: 'columns', columns: widenedColumns, move: {} }], narrow: [{ op: 'columns', columns: target.columns, move: {} }] };
}

function restoringOps(current: Board, target: Board): Op[] {
  const currentElements = Object.values(current.elements);
  const targetElements = Object.values(target.elements);
  const removed = REMOVAL_ORDER.flatMap((kind) => currentElements.filter((element) => element.kind === kind && !target.elements[element.id]));
  const added = inDependencyOrder(targetElements.filter((element) => !current.elements[element.id]));
  const setOps: Op[] = targetElements.flatMap((element) => {
    const existing = current.elements[element.id];
    if (!existing) return [];
    const fields = changedFields(existing, element);
    return Object.keys(fields).length === 0 ? [] : [{ op: 'set', id: element.id, fields }];
  });
  const { widen, narrow } = columnOps(current, target);
  return [
    ...(isSameValue(current.lanes, target.lanes) ? [] : [{ op: 'lanes', lanes: target.lanes } satisfies Op]),
    ...widen,
    ...removed.map((element): Op => ({ op: 'remove', id: element.id })),
    ...added.filter((element) => EARLY_ADD_KINDS.has(element.kind)).map((element): Op => ({ op: 'add', element })),
    ...setOps,
    ...added.filter((element) => !EARLY_ADD_KINDS.has(element.kind)).map((element): Op => ({ op: 'add', element })),
    ...narrow,
    ...boardFieldOps(current, target),
  ];
}

function inverseOps(before: Board, ops: readonly Op[]): Op[] {
  const applied = applyOps(before, ops, OPERATOR_AUTHOR, before.updatedAt);
  if (!applied.ok) return [];
  return restoringOps(applied.board, before);
}

function withEntry(stack: readonly Op[][], entry: Op[]): Op[][] {
  if (entry.length === 0) return [...stack];
  return [...stack, entry].slice(-UNDO_LIMIT);
}

function recordEdit(history: UndoHistory, inverse: Op[]): UndoHistory {
  if (inverse.length === 0) return history;
  return { undo: withEntry(history.undo, inverse), redo: [] };
}

function takeStep(history: UndoHistory, direction: UndoDirection): { entry: Op[]; history: UndoHistory } | null {
  const entry = history[direction].at(-1);
  if (!entry) return null;
  return { entry, history: { ...history, [direction]: history[direction].slice(0, -1) } };
}

function recordStep(history: UndoHistory, direction: UndoDirection, inverse: Op[]): UndoHistory {
  const opposite: UndoDirection = direction === 'undo' ? 'redo' : 'undo';
  return { ...history, [opposite]: withEntry(history[opposite], inverse) };
}

export { EMPTY_HISTORY, UNDO_LIMIT, inverseOps, recordEdit, recordStep, takeStep };
export type { UndoDirection, UndoHistory };
