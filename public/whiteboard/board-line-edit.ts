import { WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { BoxLine } from '#shared/contracts/whiteboard.ts';

export type LineEditState = { mode: 'closed' } | { mode: 'editing'; boxId: string; lineIndex: number; isNewLine: boolean };

export type LineEditEvent =
  | { kind: 'doubleClickLine'; boxId: string; lineIndex: number }
  | { kind: 'doubleClickEmptyBody'; boxId: string; lineCount: number }
  | { kind: 'enter'; draft: BoxLine; lineCount: number }
  | { kind: 'backspaceOnEmptyLine' }
  | { kind: 'escape' }
  | { kind: 'blur'; draft: BoxLine }
  | { kind: 'linesChangedUnderEditor' };

export type LineOp =
  | { op: 'insert'; boxId: string; lineIndex: number; line: BoxLine }
  | { op: 'replace'; boxId: string; lineIndex: number; line: BoxLine }
  | { op: 'remove'; boxId: string; lineIndex: number };

type Editing = Extract<LineEditState, { mode: 'editing' }>;

export const CLOSED_LINE_EDIT: LineEditState = { mode: 'closed' };

export const EMPTY_LINE: BoxLine = { text: '', muted: false, style: 'text', key: null };

export const LINE_STYLE_LABELS: Readonly<Record<BoxLine['style'], string>> = { text: 'Text', code: 'Code', item: 'Bullet', kv: 'Key and value' };

export function lineWithStyle(line: BoxLine, style: BoxLine['style']): BoxLine {
  if (style === 'kv') return { ...line, style, key: line.key || 'key' };
  return { ...line, style };
}

function committedOps(editing: Editing, draft: BoxLine): LineOp[] {
  const { boxId, lineIndex } = editing;
  if (!editing.isNewLine) return [{ op: 'replace', boxId, lineIndex, line: draft }];
  if (!draft.text) return [];
  return [{ op: 'insert', boxId, lineIndex, line: draft }];
}

function afterEnter(editing: Editing, draft: BoxLine, lineCount: number): { state: LineEditState; lineOps: LineOp[] } {
  const lineOps = committedOps(editing, draft);
  const isEndingNewLines = editing.isNewLine && !draft.text;
  const lineCountAfter = lineCount + (editing.isNewLine && lineOps.length > 0 ? 1 : 0);
  if (isEndingNewLines || lineCountAfter >= WHITEBOARD_LIMITS.linesPerBox) return { state: CLOSED_LINE_EDIT, lineOps };
  return { state: { mode: 'editing', boxId: editing.boxId, lineIndex: editing.lineIndex + 1, isNewLine: true }, lineOps };
}

function afterBackspaceOnEmptyLine(editing: Editing): { state: LineEditState; lineOps: LineOp[] } {
  const { boxId, lineIndex } = editing;
  const lineOps: LineOp[] = editing.isNewLine ? [] : [{ op: 'remove', boxId, lineIndex }];
  if (lineIndex === 0) return { state: CLOSED_LINE_EDIT, lineOps };
  return { state: { mode: 'editing', boxId, lineIndex: lineIndex - 1, isNewLine: false }, lineOps };
}

function nextFromClosed(event: LineEditEvent): LineEditState {
  if (event.kind === 'doubleClickLine') return { mode: 'editing', boxId: event.boxId, lineIndex: event.lineIndex, isNewLine: false };
  if (event.kind !== 'doubleClickEmptyBody' || event.lineCount >= WHITEBOARD_LIMITS.linesPerBox) return CLOSED_LINE_EDIT;
  return { mode: 'editing', boxId: event.boxId, lineIndex: event.lineCount, isNewLine: true };
}

export function nextLineEdit(state: LineEditState, event: LineEditEvent): { state: LineEditState; lineOps: LineOp[] } {
  if (state.mode === 'closed') return { state: nextFromClosed(event), lineOps: [] };
  switch (event.kind) {
    case 'enter': return afterEnter(state, event.draft, event.lineCount);
    case 'backspaceOnEmptyLine': return afterBackspaceOnEmptyLine(state);
    case 'blur': return { state: CLOSED_LINE_EDIT, lineOps: committedOps(state, event.draft) };
    case 'escape':
    case 'linesChangedUnderEditor': return { state: CLOSED_LINE_EDIT, lineOps: [] };
    case 'doubleClickLine':
    case 'doubleClickEmptyBody': return { state, lineOps: [] };
  }
}

function isSameLine(first: BoxLine, second: BoxLine | undefined): boolean {
  return second !== undefined && first.text === second.text && first.muted === second.muted && first.style === second.style && first.key === second.key;
}

export function isSameLines(first: readonly BoxLine[], second: readonly BoxLine[]): boolean {
  return first.length === second.length && first.every((line, index) => isSameLine(line, second[index]));
}

export function linesAfter(lines: readonly BoxLine[], lineOps: readonly LineOp[]): BoxLine[] {
  return lineOps.reduce<BoxLine[]>((edited, lineOp) => {
    if (lineOp.op === 'insert') return lineOp.lineIndex <= edited.length ? edited.toSpliced(lineOp.lineIndex, 0, lineOp.line) : edited;
    if (lineOp.lineIndex >= edited.length) return edited;
    if (lineOp.op === 'remove') return edited.toSpliced(lineOp.lineIndex, 1);
    return edited.with(lineOp.lineIndex, lineOp.line);
  }, [...lines]);
}
