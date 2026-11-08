import { recordEdit, recordStep, takeStep } from '#shared/whiteboard-undo-core.ts';
import type { UndoDirection, UndoHistory } from '#shared/whiteboard-undo-core.ts';

export type EditKind = 'type' | 'delete' | 'paragraph' | 'note' | 'decide';
type GroupedEditKind = 'type' | 'delete';

interface TextSplice {
  start: number;
  removedText: string;
  insertedText: string;
  caretBefore: number;
  caretAfter: number;
}

interface OpenGroup {
  kind: GroupedEditKind;
  caretAfter: number;
  lastEditAtMs: number;
}

export interface DocHistory {
  stacks: UndoHistory<TextSplice[]>;
  openGroup: OpenGroup | null;
}

export interface DocEdit {
  kind: EditKind;
  before: string;
  after: string;
  caretBefore: number;
  caretAfter: number;
  atMs: number;
}

export const TYPING_GROUP_GAP_MS = 1000;
export const EMPTY_DOC_HISTORY: DocHistory = Object.freeze({ stacks: Object.freeze({ undo: [], redo: [] }), openGroup: null });

const GROUPED_EDIT_KINDS: ReadonlySet<EditKind> = new Set(['type', 'delete']);

function isGroupedKind(kind: EditKind): kind is GroupedEditKind {
  return GROUPED_EDIT_KINDS.has(kind);
}

function spliceBetween(before: string, after: string, caretBefore: number, caretAfter: number): TextSplice {
  const shorterLength = Math.min(before.length, after.length);
  let sharedPrefixLength = 0;
  while (sharedPrefixLength < shorterLength && before[sharedPrefixLength] === after[sharedPrefixLength]) sharedPrefixLength += 1;
  let sharedSuffixLength = 0;
  const suffixRoom = shorterLength - sharedPrefixLength;
  while (sharedSuffixLength < suffixRoom && before[before.length - 1 - sharedSuffixLength] === after[after.length - 1 - sharedSuffixLength]) sharedSuffixLength += 1;
  return {
    start: sharedPrefixLength,
    removedText: before.slice(sharedPrefixLength, before.length - sharedSuffixLength),
    insertedText: after.slice(sharedPrefixLength, after.length - sharedSuffixLength),
    caretBefore,
    caretAfter,
  };
}

function joinsOpenGroup(group: OpenGroup | null, edit: DocEdit): boolean {
  if (!group) return false;
  return group.kind === edit.kind && group.caretAfter === edit.caretBefore && edit.atMs - group.lastEditAtMs < TYPING_GROUP_GAP_MS;
}

function withSpliceOnTopStep(stacks: UndoHistory<TextSplice[]>, splice: TextSplice): UndoHistory<TextSplice[]> {
  const topStep = stacks.undo.at(-1);
  if (!topStep) return recordEdit(stacks, [splice]);
  return { undo: [...stacks.undo.slice(0, -1), [...topStep, splice]], redo: [] };
}

export function recordDocEdit(history: DocHistory, edit: DocEdit): DocHistory {
  if (edit.before === edit.after) return history;
  const splice = spliceBetween(edit.before, edit.after, edit.caretBefore, edit.caretAfter);
  const openGroup = isGroupedKind(edit.kind) ? { kind: edit.kind, caretAfter: edit.caretAfter, lastEditAtMs: edit.atMs } : null;
  const stacks = joinsOpenGroup(history.openGroup, edit) ? withSpliceOnTopStep(history.stacks, splice) : recordEdit(history.stacks, [splice]);
  return { stacks, openGroup };
}

function undoSplice(source: string, splice: TextSplice): string {
  return source.slice(0, splice.start) + splice.removedText + source.slice(splice.start + splice.insertedText.length);
}

function redoSplice(source: string, splice: TextSplice): string {
  return source.slice(0, splice.start) + splice.insertedText + source.slice(splice.start + splice.removedText.length);
}

function replayStep(source: string, step: readonly TextSplice[], direction: UndoDirection): { source: string; caret: number } {
  if (direction === 'undo') return { source: step.toReversed().reduce(undoSplice, source), caret: step[0]?.caretBefore ?? 0 };
  return { source: step.reduce(redoSplice, source), caret: step.at(-1)?.caretAfter ?? 0 };
}

export function stepDocHistory(history: DocHistory, direction: UndoDirection, source: string): { history: DocHistory; source: string; caret: number } | null {
  const taken = takeStep(history.stacks, direction);
  if (!taken) return null;
  const replayed = replayStep(source, taken.entry, direction);
  return { history: { stacks: recordStep(taken.history, direction, taken.entry), openGroup: null }, ...replayed };
}
