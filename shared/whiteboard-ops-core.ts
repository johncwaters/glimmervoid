import { Box, Frame, Note, Wire, WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, BoardChange, Element, Op } from './contracts/whiteboard.ts';
import { isRecord } from './coerce.ts';
import { isStackedPanel, layoutBoard } from './whiteboard-layout-core.ts';
import type { LaidOutBox } from './whiteboard-layout-core.ts';
import type { BoardDiff, ElementChange } from './contracts/control/whiteboard-messages.ts';

type Author = { id: string; name: string };
type ApplyResult = { ok: true; board: Board; changes: BoardChange[]; diff: BoardDiff } | { ok: false; error: string; opIndex: number };
type OpOutcome = { ok: true } | { ok: false; error: string };
type PinPositions = { laidOutBoxById: ReadonlyMap<string, LaidOutBox>; pinnedOffsetY: number };
type Draft = { board: Board; elementCount: number; pinPositions: PinPositions | null; dependentIdsByBoxId: ReadonlyMap<string, ReadonlySet<string>> | null };

const ELEMENT_SCHEMAS = Object.freeze({ box: Box, frame: Frame, wire: Wire, note: Note });
const NOTE_PREVIEW_CHARS = 80;
const OK: OpOutcome = { ok: true };
const DIFFED_BOARD_FIELDS = ['title', 'caption', 'legend', 'codeSessionId'] as const;
const OPERATOR_AUTHOR: Author = Object.freeze({ id: 'operator', name: 'operator' });

function canKeepNoteStamps(author: Author): boolean {
  return author.id === OPERATOR_AUTHOR.id;
}

function storedNote(note: Note, author: Author): Note {
  if (!canKeepNoteStamps(author)) return { ...note, author: author.name, resolvedBy: null };
  return { ...note, author: note.author === '' ? author.name : note.author };
}

function refuse(error: string): OpOutcome {
  return { ok: false, error };
}

function isBox(board: Board, id: string): boolean {
  return board.elements[id]?.kind === 'box';
}

function checkReferences(board: Board, element: Element, previous: Element | undefined): OpOutcome {
  if (element.kind === 'box') return checkBoxReferences(board, element, previous);
  if (element.kind === 'wire') {
    if (!isBox(board, element.from)) return refuse(`wire ${element.id} starts at ${element.from}, which is not a box`);
    if (!isBox(board, element.to)) return refuse(`wire ${element.id} ends at ${element.to}, which is not a box`);
    return checkWireOutput(board, element);
  }
  if (element.kind === 'note') {
    if (!isBox(board, element.on)) return refuse(`note ${element.id} is on ${element.on}, which is not a box`);
    return OK;
  }
  if (element.kind !== 'frame') return OK;
  const strangerId = element.contains.find((id) => !isBox(board, id));
  if (strangerId) return refuse(`frame ${element.id} contains ${strangerId}, which is not a box`);
  return OK;
}

function checkWireOutput(board: Board, wire: Wire): OpOutcome {
  if (wire.fromOutput === null) return OK;
  const from = board.elements[wire.from];
  if (from?.kind !== 'box' || from.shape !== 'decision') return refuse(`wire ${wire.id} starts at output ${wire.fromOutput}, but ${wire.from} is not a decision`);
  if (!from.outputs.some((output) => output.id === wire.fromOutput)) return refuse(`wire ${wire.id} starts at output ${wire.fromOutput}, which decision ${wire.from} does not have`);
  return OK;
}

function checkBoxOutputs(board: Board, box: Box, previous: Element | undefined): OpOutcome {
  if (box.shape !== 'decision' && box.outputs.length > 0) return refuse(`box ${box.id} has outputs, which only a decision has, so set shape to decision`);
  const outputIds = new Set(box.outputs.map((output) => output.id));
  if (outputIds.size !== box.outputs.length) return refuse(`box ${box.id} has two outputs with the same id`);
  const previousOutputs = previous?.kind === 'box' ? previous.outputs : [];
  if (previousOutputs.every((output) => outputIds.has(output.id))) return OK;
  const strandedWire = Object.values(board.elements).find((element) => element.kind === 'wire' && element.from === box.id && element.fromOutput !== null && !outputIds.has(element.fromOutput));
  if (strandedWire?.kind === 'wire') return refuse(`wire ${strandedWire.id} still starts at output ${strandedWire.fromOutput} of ${box.id}, so change or remove that wire first`);
  return OK;
}

function boxSittingNear(board: Board, boxId: string): Box | null {
  const sitting = Object.values(board.elements).find((element) => element.kind === 'box' && element.near?.of === boxId);
  return sitting?.kind === 'box' ? sitting : null;
}

function checkBoxReferences(board: Board, box: Box, previous: Element | undefined): OpOutcome {
  const outputs = checkBoxOutputs(board, box, previous);
  if (!outputs.ok) return outputs;
  if (box.change === 'relabeled' && !box.was) return refuse(`box ${box.id} is relabeled, so give its old title in was`);
  if (box.step === null && box.shape !== 'panel' && box.near === null && box.at === null) {
    return refuse(`box ${box.id} needs a place: near another box or at a point`);
  }
  const isJoiningPanelStack = isStackedPanel(box) && previous?.kind === 'box' && !isStackedPanel(previous);
  const sittingNear = isJoiningPanelStack ? boxSittingNear(board, box.id) : null;
  if (sittingNear) return refuse(`box ${sittingNear.id} sits near ${box.id}, so ${box.id} cannot go back to the panel stack with no place: keep a near or at on it, or move box ${sittingNear.id} first`);
  if (box.near === null) return OK;
  if (box.near.of === box.id) return refuse(`box ${box.id} cannot sit near itself`);
  const nearTarget = board.elements[box.near.of];
  if (nearTarget?.kind !== 'box') return refuse(`box ${box.id} sits near ${box.near.of}, which is not a box`);
  if (isStackedPanel(nearTarget)) return refuse(`box ${box.id} sits near ${box.near.of}, a panel with no place yet, so give that panel a near or at first`);
  if (nearChainReaches(board, box.near.of, box.id)) return refuse(`box ${box.id} sits near ${box.near.of}, which already sits near ${box.id}, so they would place each other`);
  return OK;
}

function nearChainReaches(board: Board, startId: string, soughtId: string): boolean {
  const visitedIds = new Set<string>();
  let currentId: string | undefined = startId;
  while (currentId !== undefined && !visitedIds.has(currentId)) {
    if (currentId === soughtId) return true;
    visitedIds.add(currentId);
    const current: Element | undefined = board.elements[currentId];
    currentId = current?.kind === 'box' ? current.near?.of : undefined;
  }
  return false;
}

function addElement(draft: Draft, element: Element, author: Author): OpOutcome {
  const { board } = draft;
  if (board.elements[element.id]) return refuse(`an element with id ${element.id} already exists`);
  if (draft.elementCount >= WHITEBOARD_LIMITS.elements) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.elements} elements`);
  const stored: Element = element.kind === 'note' ? storedNote(element, author) : element;
  const references = checkReferences(board, stored, undefined);
  if (!references.ok) return references;
  board.elements[element.id] = stored;
  draft.elementCount += 1;
  return OK;
}

function rewrittenNoteStamp(existing: Element, fields: Record<string, unknown>, author: Author): Record<string, unknown> {
  if (existing.kind !== 'note' || !('text' in fields || 'on' in fields)) return {};
  return { author: author.name, resolvedBy: null };
}

function withStepMerged(existing: Element, fields: Record<string, unknown>): Record<string, unknown> {
  if (existing.kind !== 'box' || existing.step === null || !isRecord(fields.step)) return fields;
  return { ...fields, step: { ...existing.step, ...fields.step } };
}

function setFields(board: Board, id: string, rawFields: Record<string, unknown>, author: Author): OpOutcome {
  const existing = board.elements[id];
  if (!existing) return refuse(`no element has id ${id}`);
  const fields = withStepMerged(existing, rawFields);
  if ('kind' in fields || 'id' in fields) return refuse('set cannot change an element kind or id; remove it and add a new one');
  if (!canKeepNoteStamps(author) && ('author' in fields || 'resolvedBy' in fields)) return refuse('set cannot change who wrote or resolved a note; resolve it with a resolve op');
  const parsed = ELEMENT_SCHEMAS[existing.kind].safeParse({ ...existing, ...rewrittenNoteStamp(existing, fields, author), ...fields });
  if (!parsed.success) return refuse(`${id}: ${parsed.error.issues[0]?.message ?? 'invalid fields'}`);
  const references = checkReferences(board, parsed.data, existing);
  if (!references.ok) return references;
  board.elements[id] = parsed.data;
  return OK;
}

function boxIdsDependedOnBy(element: Element): readonly string[] {
  if (element.kind === 'box') return element.near ? [element.near.of] : [];
  if (element.kind === 'wire') return [element.from, element.to];
  if (element.kind === 'note') return [element.on];
  if (element.kind === 'frame') return element.contains;
  return [];
}

function dependentIdsByBoxIdOf(board: Board): Map<string, Set<string>> {
  const dependentIdsByBoxId = new Map<string, Set<string>>();
  for (const element of Object.values(board.elements)) {
    for (const boxId of boxIdsDependedOnBy(element)) {
      const dependentIds = dependentIdsByBoxId.get(boxId) ?? new Set<string>();
      dependentIds.add(element.id);
      dependentIdsByBoxId.set(boxId, dependentIds);
    }
  }
  return dependentIdsByBoxId;
}

function currentDependentsOf(draft: Draft, boxId: string): Element[] {
  draft.dependentIdsByBoxId ??= dependentIdsByBoxIdOf(draft.board);
  const dependentIds = [...draft.dependentIdsByBoxId.get(boxId) ?? []];
  return dependentIds.flatMap((dependentId) => {
    const element = draft.board.elements[dependentId];
    return element && boxIdsDependedOnBy(element).includes(boxId) ? [element] : [];
  });
}

function deleteElement(draft: Draft, id: string): void {
  delete draft.board.elements[id];
  draft.elementCount -= 1;
}

function removeElement(draft: Draft, id: string): OpOutcome {
  const { board } = draft;
  const existing = board.elements[id];
  if (!existing) return refuse(`no element has id ${id}`);
  if (existing.kind === 'box') pinBoxesNear(draft, id);
  deleteElement(draft, id);
  if (existing.kind !== 'box') return OK;
  for (const dependent of currentDependentsOf(draft, id)) removeDependent(draft, dependent, id);
  return OK;
}

function pinPositionsOf(board: Board): PinPositions {
  const layout = layoutBoard(board);
  const laidOutBoxById = new Map(layout.elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  return { laidOutBoxById, pinnedOffsetY: layout.pinnedOffsetY };
}

function pinBoxesNear(draft: Draft, removedBoxId: string): void {
  const { board } = draft;
  const nearBoxes = currentDependentsOf(draft, removedBoxId).flatMap((element) => (element.kind === 'box' ? [element] : []));
  if (nearBoxes.length === 0) return;
  draft.pinPositions ??= pinPositionsOf(board);
  const { laidOutBoxById, pinnedOffsetY } = draft.pinPositions;
  for (const box of nearBoxes) {
    const laidOut = laidOutBoxById.get(box.id);
    if (!laidOut) continue;
    board.elements[box.id] = { ...box, near: null, at: { x: laidOut.x, y: laidOut.y - pinnedOffsetY } };
  }
}

function removeDependent(draft: Draft, element: Element, removedBoxId: string): void {
  if (element.kind === 'wire' && (element.from === removedBoxId || element.to === removedBoxId)) {
    deleteElement(draft, element.id);
    return;
  }
  if (element.kind === 'note' && element.on === removedBoxId) {
    deleteElement(draft, element.id);
    return;
  }
  if (element.kind !== 'frame') return;
  const contains = element.contains.filter((id) => id !== removedBoxId);
  if (contains.length === 0) {
    deleteElement(draft, element.id);
    return;
  }
  draft.board.elements[element.id] = { ...element, contains };
}

function resolveNote(board: Board, id: string, author: Author): OpOutcome {
  const note = board.elements[id];
  if (note?.kind !== 'note') return refuse(`no note has id ${id}`);
  board.elements[id] = { ...note, resolvedBy: author.name };
  return OK;
}

function applyOne(draft: Draft, op: Op, author: Author): OpOutcome {
  const { board } = draft;
  if (op.op !== 'remove') {
    draft.pinPositions = null;
    draft.dependentIdsByBoxId = null;
  }
  switch (op.op) {
    case 'add': return addElement(draft, op.element, author);
    case 'set': return setFields(board, op.id, op.fields, author);
    case 'remove': return removeElement(draft, op.id);
    case 'resolve': return resolveNote(board, op.id, author);
    case 'board':
      if (op.title !== undefined) board.title = op.title;
      if (op.caption !== undefined) board.caption = op.caption;
      if (op.legend !== undefined) board.legend = op.legend;
      if (op.codeSessionId !== undefined) board.codeSessionId = op.codeSessionId;
      return OK;
  }
}

function applyOps(board: Board, ops: readonly Op[], author: Author, nowMs: number): ApplyResult {
  const draft: Draft = { board: { ...board, elements: { ...board.elements } }, elementCount: Object.keys(board.elements).length, pinPositions: null, dependentIdsByBoxId: null };
  const version = board.version + 1;
  const changes: BoardChange[] = [];
  for (const [opIndex, op] of ops.entries()) {
    const elementId = changedElementId(op);
    const previous = elementId === null ? undefined : draft.board.elements[elementId];
    const outcome = applyOne(draft, op, author);
    if (!outcome.ok) return { ok: false, error: `op ${opIndex + 1}: ${outcome.error}`, opIndex };
    changes.push({ version, author: author.id, elementId, summary: `${author.name} ${describeOp(op, previous, draft.board)}` });
  }
  return { ok: true, board: { ...draft.board, version, updatedAt: nowMs }, changes, diff: diffOf(board, draft.board) };
}

function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasSameFieldNames(left: Element, right: Element): boolean {
  const leftNames = Object.keys(left);
  const rightNames = new Set(Object.keys(right));
  return leftNames.length === rightNames.size && leftNames.every((name) => rightNames.has(name));
}

function changeOf(previous: Element, element: Element): ElementChange | null {
  if (previous.kind !== element.kind || !hasSameFieldNames(previous, element)) return ['put', element];
  const previousFields: Record<string, unknown> = { ...previous };
  const changedFields = Object.fromEntries(Object.entries(element).filter(([name, value]) => !isSameValue(previousFields[name], value)));
  return Object.keys(changedFields).length === 0 ? null : ['patch', changedFields];
}

function diffOf(before: Board, after: Board): BoardDiff {
  const elements: Record<string, ElementChange> = {};
  for (const id of Object.keys(before.elements)) {
    if (!after.elements[id]) elements[id] = ['remove'];
  }
  const positionById = new Map(Object.keys(before.elements).map((id, position) => [id, position]));
  let lastKeptPosition = -1;
  let isPastMovedElement = false;
  for (const [id, element] of Object.entries(after.elements)) {
    const previous = before.elements[id];
    const position = positionById.get(id);
    isPastMovedElement ||= !previous || position === undefined || position < lastKeptPosition;
    if (!previous || position === undefined || isPastMovedElement) {
      elements[id] = ['put', element];
      continue;
    }
    lastKeptPosition = position;
    if (previous === element) continue;
    const change = changeOf(previous, element);
    if (change) elements[id] = change;
  }
  const fields = Object.fromEntries(DIFFED_BOARD_FIELDS.filter((name) => !isSameValue(before[name], after[name])).map((name) => [name, after[name]]));
  return { fields, elements };
}

function appliedChangeOf(existing: Element | undefined, id: string, change: ElementChange): Element | null {
  if (change[0] === 'put') return change[1].id === id ? change[1] : null;
  if (change[0] === 'remove' || !existing) return null;
  const parsed = ELEMENT_SCHEMAS[existing.kind].safeParse({ ...existing, ...change[1] });
  return parsed.success && parsed.data.id === id ? parsed.data : null;
}

function applyBoardDiff(board: Board, diff: BoardDiff, version: number, updatedAt: number): Board | null {
  const elements = { ...board.elements };
  for (const [id, change] of Object.entries(diff.elements)) {
    const existing = elements[id];
    if (change[0] === 'remove') {
      if (!existing) return null;
      delete elements[id];
      continue;
    }
    const element = appliedChangeOf(existing, id, change);
    if (!element) return null;
    if (change[0] === 'put') delete elements[id];
    elements[id] = element;
  }
  if (Object.keys(elements).length > WHITEBOARD_LIMITS.elements) return null;
  return { ...board, ...diff.fields, elements, version, updatedAt };
}

function changedElementId(op: Op): string | null {
  if (op.op === 'add') return op.element.id;
  if (op.op === 'set' || op.op === 'remove' || op.op === 'resolve') return op.id;
  return null;
}

function nameOf(board: Board, id: string, element: Element | undefined = board.elements[id]): string {
  if (!element) return id;
  if (element.kind === 'box' || element.kind === 'frame') return `"${element.title || id}"`;
  if (element.kind === 'wire') return `wire ${nameOf(board, element.from)} to ${nameOf(board, element.to)}`;
  return `note ${id}`;
}

function describeStepChange(name: string, before: Box['step'], after: Box['step']): string {
  if (after === null) return `made ${name} no longer a plan step`;
  if (before === null) return `made ${name} a plan step`;
  if (before.status !== after.status) return `marked ${name} ${after.status}`;
  if (after.linkedBoardId === null) return `unlinked ${name} from its board`;
  return `linked ${name} to a board`;
}

function describeSet(op: Extract<Op, { op: 'set' }>, previous: Element | undefined, after: Board): string {
  const fieldNames = Object.keys(op.fields);
  const afterElement = after.elements[op.id];
  if (fieldNames.length === 1 && fieldNames[0] === 'at') return `moved ${nameOf(after, op.id)}`;
  if (fieldNames.length === 1 && fieldNames[0] === 'step' && previous?.kind === 'box' && afterElement?.kind === 'box') return describeStepChange(nameOf(after, op.id), previous.step, afterElement.step);
  if (previous?.kind === 'box' && afterElement?.kind === 'box' && fieldNames.length === 1 && fieldNames[0] === 'title') {
    return `renamed "${previous.title}" to "${afterElement.title}"`;
  }
  if (fieldNames.length === 1 && fieldNames[0] === 'media' && previous?.kind === 'box' && afterElement?.kind === 'box' && previous.media?.kind === 'doc' && afterElement.media?.kind === 'doc') {
    return `edited the document in ${nameOf(after, op.id)} (read it with whiteboard doc)`;
  }
  return `changed ${fieldNames.join(', ')} of ${nameOf(after, op.id)}`;
}

function describeBoardOp(op: Extract<Op, { op: 'board' }>): string {
  if (op.title !== undefined) return `renamed the board to "${op.title}"`;
  if (op.caption !== undefined) return 'changed the caption';
  if (op.codeSessionId !== undefined) return op.codeSessionId === null ? 'cleared the code session' : `set the code session to ${op.codeSessionId}`;
  return 'set the legend';
}

function describeOp(op: Op, previous: Element | undefined, after: Board): string {
  switch (op.op) {
    case 'add': {
      const element = op.element;
      if (element.kind === 'note') return `note on ${nameOf(after, element.on)}${element.ref ? ` at ${element.ref}` : ''}: ${element.text.slice(0, NOTE_PREVIEW_CHARS)} (note ${element.id})`;
      return `added ${element.kind} ${nameOf(after, element.id)}`;
    }
    case 'set': return describeSet(op, previous, after);
    case 'remove': return `removed ${previous?.kind ?? 'element'} ${nameOf(after, op.id, previous)}`;
    case 'resolve': return previous?.kind === 'note' ? `resolved note ${op.id} on ${nameOf(after, previous.on)}` : `resolved note ${op.id}`;
    case 'board': return describeBoardOp(op);
  }
}

function createBoard({ id, title, nowMs, codeSessionId = null }: { id: string; title: string; nowMs: number; codeSessionId?: string | null }): Board {
  return {
    id, title, version: 0, caption: null,
    legend: [],
    codeSessionId,
    elements: {},
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export { OPERATOR_AUTHOR, applyBoardDiff, applyOps, createBoard };
export type { ApplyResult, Author };
