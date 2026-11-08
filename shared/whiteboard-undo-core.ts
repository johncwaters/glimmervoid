import { elementInputOf } from './contracts/whiteboard.ts';
import type { Board, Element, Op } from './contracts/whiteboard.ts';
import type { BoardDiff, DiffBefore } from './contracts/control/whiteboard-messages.ts';
import { applyBoardDiff } from './whiteboard-ops-core.ts';
import { elementTableOf } from './whiteboard-element-table.ts';

type UndoDirection = 'undo' | 'redo';
type UndoHistory<Entry extends readonly unknown[] = Op[]> = Readonly<Record<UndoDirection, readonly Entry[]>>;

const UNDO_LIMIT = 100;
const EMPTY_HISTORY: UndoHistory = Object.freeze({ undo: [], redo: [] });
const EARLY_ADD_KINDS: ReadonlySet<Element['kind']> = new Set(['box']);
const REMOVAL_ORDER: readonly Element['kind'][] = ['wire', 'frame', 'box'];
const UNSETTABLE_FIELDS: ReadonlySet<string> = new Set(['kind', 'id']);

function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedFields(current: Element, target: Element): Record<string, unknown> {
  const currentFields: Record<string, unknown> = { ...current };
  return Object.fromEntries(Object.entries(target).filter(([field, value]) => !UNSETTABLE_FIELDS.has(field) && !isSameValue(currentFields[field], value)));
}

function boardFieldOps(current: Board, target: Board): Op[] {
  const fields = {
    ...(current.title === target.title ? {} : { title: target.title }),
    ...(current.caption === target.caption ? {} : { caption: target.caption }),
    ...(isSameValue(current.legend, target.legend) ? {} : { legend: target.legend }),
    ...(current.codeSessionId === target.codeSessionId ? {} : { codeSessionId: target.codeSessionId }),
  };
  return Object.keys(fields).length === 0 ? [] : [{ op: 'board', ...fields }];
}

function restoringOps(current: Board, target: Board): Op[] {
  const currentElements = [...current.elements.values()];
  const targetElements = [...target.elements.values()];
  const removed = REMOVAL_ORDER.flatMap((kind) => currentElements.filter((element) => element.kind === kind && !target.elements.get(element.id)));
  const added = targetElements.filter((element) => !current.elements.get(element.id));
  const setOps: Op[] = targetElements.flatMap((element) => {
    const existing = current.elements.get(element.id);
    if (!existing || existing === element) return [];
    const fields = changedFields(existing, element);
    return Object.keys(fields).length === 0 ? [] : [{ op: 'set', id: element.id, fields }];
  });
  return [
    ...removed.map((element): Op => ({ op: 'remove', id: element.id })),
    ...added.filter((element) => EARLY_ADD_KINDS.has(element.kind)).map((element): Op => ({ op: 'add', element: elementInputOf(element) })),
    ...setOps,
    ...added.filter((element) => !EARLY_ADD_KINDS.has(element.kind)).map((element): Op => ({ op: 'add', element: elementInputOf(element) })),
    ...boardFieldOps(current, target),
  ];
}

const TOUCHED_ONLY_HEAD = Object.freeze({ id: 'touched', title: 'touched', version: 0, caption: null, legend: [], codeSessionId: null, project: null, createdAt: 0, updatedAt: 0 });

function undoOpsOf(before: DiffBefore, diff: BoardDiff): Op[] {
  const beforeElements = elementTableOf(Object.values(before.elements).flatMap((element) => element ?? []));
  const touchedBefore: Board = { ...TOUCHED_ONLY_HEAD, ...before.fields, elements: beforeElements };
  const touchedAfter = applyBoardDiff(touchedBefore, diff, 0, 0);
  return touchedAfter ? restoringOps(touchedAfter, touchedBefore) : [];
}

function withEntry<Entry extends readonly unknown[]>(stack: readonly Entry[], entry: Entry): Entry[] {
  if (entry.length === 0) return [...stack];
  return [...stack, entry].slice(-UNDO_LIMIT);
}

function recordEdit<Entry extends readonly unknown[]>(history: UndoHistory<Entry>, entry: Entry): UndoHistory<Entry> {
  if (entry.length === 0) return history;
  return { undo: withEntry(history.undo, entry), redo: [] };
}

function takeStep<Entry extends readonly unknown[]>(history: UndoHistory<Entry>, direction: UndoDirection): { entry: Entry; history: UndoHistory<Entry> } | null {
  const entry = history[direction].at(-1);
  if (!entry) return null;
  return { entry, history: { ...history, [direction]: history[direction].slice(0, -1) } };
}

function recordStep<Entry extends readonly unknown[]>(history: UndoHistory<Entry>, direction: UndoDirection, entry: Entry): UndoHistory<Entry> {
  const opposite: UndoDirection = direction === 'undo' ? 'redo' : 'undo';
  return { ...history, [opposite]: withEntry(history[opposite], entry) };
}

export { EMPTY_HISTORY, UNDO_LIMIT, recordEdit, recordStep, takeStep, undoOpsOf };
export type { UndoDirection, UndoHistory };
