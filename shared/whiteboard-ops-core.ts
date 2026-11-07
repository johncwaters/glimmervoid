import { Box, Frame, Note, Panel, Unit, Wire, WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, BoardChange, Element, Op } from './contracts/whiteboard.ts';
import { layoutBoard } from './whiteboard-layout-core.ts';
import type { LaidOutBox } from './whiteboard-layout-core.ts';
import type { BoardDiff, ElementChange } from './contracts/control/whiteboard-messages.ts';
import { findDependencyCycle } from './whiteboard-plan-core.ts';
import { appendElement, boardIndexOf, boxIdsDependedOnBy, dropElement, elementsOfKind, idsOfKindInKeyOrder, storeElement } from './whiteboard-board-index.ts';

type Author = { id: string; name: string };
type ApplyResult = { ok: true; board: Board; changes: BoardChange[]; diff: BoardDiff } | { ok: false; error: string; opIndex: number };
type StagedOps = {
  ok: true;
  board: Board;
  changes: BoardChange[];
  diff: BoardDiff;
  afterById: ReadonlyMap<string, Element | null>;
  commit: () => void;
} | { ok: false; error: string; opIndex: number };
type OpOutcome = { ok: true } | { ok: false; error: string };
type PinPositions = { laidOutBoxById: ReadonlyMap<string, LaidOutBox>; pinnedOffsetY: number };
type ElementLookup = (id: string) => Element | undefined;
type Draft = {
  base: Board;
  head: Board;
  afterById: Map<string, Element | null>;
  erasedIds: Set<string>;
  overlayDependentIdsByBoxId: Map<string, Set<string>>;
  elementCount: number;
  pinPositions: PinPositions | null;
};

const ELEMENT_SCHEMAS = Object.freeze({ box: Box, frame: Frame, wire: Wire, note: Note, unit: Unit, panel: Panel });
const NOTE_PREVIEW_CHARS = 80;
const OK: OpOutcome = { ok: true };
const DIFFED_BOARD_FIELDS = ['title', 'caption', 'legend', 'columns', 'lanes', 'codeSessionId'] as const;
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

function elementOf(draft: Draft, id: string): Element | undefined {
  if (draft.afterById.has(id)) return draft.afterById.get(id) ?? undefined;
  return draft.base.elements[id];
}

function writeElement(draft: Draft, element: Element): void {
  if (draft.afterById.get(element.id) === null) draft.afterById.delete(element.id);
  draft.afterById.set(element.id, element);
  for (const boxId of boxIdsDependedOnBy(element)) {
    const dependentIds = draft.overlayDependentIdsByBoxId.get(boxId) ?? new Set<string>();
    dependentIds.add(element.id);
    draft.overlayDependentIdsByBoxId.set(boxId, dependentIds);
  }
}

function eraseElement(draft: Draft, id: string): void {
  draft.afterById.set(id, null);
  draft.erasedIds.add(id);
  draft.elementCount -= 1;
}

function isBox(draft: Draft, id: string): boolean {
  return elementOf(draft, id)?.kind === 'box';
}

function unitsOfDraft(draft: Draft): Unit[] {
  const units: Unit[] = [];
  const baseUnitIds = new Set(idsOfKindInKeyOrder(boardIndexOf(draft.base.elements), 'unit'));
  for (const id of baseUnitIds) {
    const element = elementOf(draft, id);
    if (element?.kind === 'unit') units.push(element);
  }
  for (const [id, element] of draft.afterById) {
    if (!baseUnitIds.has(id) && element?.kind === 'unit') units.push(element);
  }
  return units;
}

function currentDependentsOf(draft: Draft, boxId: string): Element[] {
  const candidateIds = new Set([...boardIndexOf(draft.base.elements).dependentIdsByBoxId.get(boxId) ?? [], ...draft.overlayDependentIdsByBoxId.get(boxId) ?? []]);
  return [...candidateIds].flatMap((dependentId) => {
    const element = elementOf(draft, dependentId);
    return element && boxIdsDependedOnBy(element).includes(boxId) ? [element] : [];
  });
}

function checkReferences(draft: Draft, element: Element, previous: Element | undefined): OpOutcome {
  if (element.kind === 'box') return checkBoxReferences(draft, element, previous);
  if (element.kind === 'unit') return checkUnitReferences(draft, element);
  if (element.kind === 'wire') {
    if (!isBox(draft, element.from)) return refuse(`wire ${element.id} starts at ${element.from}, which is not a box`);
    if (!isBox(draft, element.to)) return refuse(`wire ${element.id} ends at ${element.to}, which is not a box`);
    return checkWireOutput(draft, element);
  }
  if (element.kind === 'note') {
    if (!isBox(draft, element.on)) return refuse(`note ${element.id} is on ${element.on}, which is not a box`);
    return OK;
  }
  if (element.kind !== 'frame') return OK;
  const strangerId = element.contains.find((id) => !isBox(draft, id));
  if (strangerId) return refuse(`frame ${element.id} contains ${strangerId}, which is not a box`);
  return OK;
}

function checkWireOutput(draft: Draft, wire: Wire): OpOutcome {
  if (wire.fromOutput === null) return OK;
  const from = elementOf(draft, wire.from);
  if (from?.kind !== 'box' || from.shape !== 'decision') return refuse(`wire ${wire.id} starts at output ${wire.fromOutput}, but ${wire.from} is not a decision`);
  if (!from.outputs.some((output) => output.id === wire.fromOutput)) return refuse(`wire ${wire.id} starts at output ${wire.fromOutput}, which decision ${wire.from} does not have`);
  return OK;
}

function checkBoxOutputs(draft: Draft, box: Box, previous: Element | undefined): OpOutcome {
  if (box.shape !== 'decision' && box.outputs.length > 0) return refuse(`box ${box.id} has outputs, which only a decision has, so set shape to decision`);
  const outputIds = new Set(box.outputs.map((output) => output.id));
  if (outputIds.size !== box.outputs.length) return refuse(`box ${box.id} has two outputs with the same id`);
  const previousOutputs = previous?.kind === 'box' ? previous.outputs : [];
  if (previousOutputs.every((output) => outputIds.has(output.id))) return OK;
  const strandedWire = currentDependentsOf(draft, box.id).find((element) => element.kind === 'wire' && element.from === box.id && element.fromOutput !== null && !outputIds.has(element.fromOutput));
  if (strandedWire?.kind === 'wire') return refuse(`wire ${strandedWire.id} still starts at output ${strandedWire.fromOutput} of ${box.id}, so change or remove that wire first`);
  return OK;
}

function checkBoxReferences(draft: Draft, box: Box, previous: Element | undefined): OpOutcome {
  const outputs = checkBoxOutputs(draft, box, previous);
  if (!outputs.ok) return outputs;
  if (box.change === 'relabeled' && !box.was) return refuse(`box ${box.id} is relabeled, so give its old title in was`);
  if (box.column === null && box.near === null && box.at === null) {
    return refuse(`box ${box.id} needs a place: a column, near another box, or at a point`);
  }
  if (box.column !== null && !draft.head.columns.some((column) => column.id === box.column)) {
    return refuse(`box ${box.id} names column ${box.column}, which the board does not have, so add it with a columns op first`);
  }
  if (box.lane !== null && !draft.head.lanes.some((lane) => lane.id === box.lane)) {
    return refuse(`box ${box.id} names lane ${box.lane}, which the board does not have, so add it with a lanes op first`);
  }
  if (box.near === null) return OK;
  if (box.near.of === box.id) return refuse(`box ${box.id} cannot sit near itself`);
  if (!isBox(draft, box.near.of)) return refuse(`box ${box.id} sits near ${box.near.of}, which is not a box`);
  if (nearChainReaches(draft, box.near.of, box.id)) return refuse(`box ${box.id} sits near ${box.near.of}, which already sits near ${box.id}, so they would place each other`);
  return OK;
}

function nearChainReaches(draft: Draft, startId: string, soughtId: string): boolean {
  const visitedIds = new Set<string>();
  let currentId: string | undefined = startId;
  while (currentId !== undefined && !visitedIds.has(currentId)) {
    if (currentId === soughtId) return true;
    visitedIds.add(currentId);
    const current: Element | undefined = elementOf(draft, currentId);
    currentId = current?.kind === 'box' ? current.near?.of : undefined;
  }
  return false;
}

function checkUnitReferences(draft: Draft, unit: Unit): OpOutcome {
  if (unit.after.includes(unit.id)) return refuse(`unit ${unit.id} cannot come after itself`);
  const strangerId = unit.after.find((id) => elementOf(draft, id)?.kind !== 'unit');
  if (strangerId) return refuse(`unit ${unit.id} comes after ${strangerId}, which is not a unit on this board`);
  return OK;
}

function addElement(draft: Draft, element: Element, author: Author): OpOutcome {
  if (elementOf(draft, element.id)) return refuse(`an element with id ${element.id} already exists`);
  if (draft.elementCount >= WHITEBOARD_LIMITS.elements) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.elements} elements`);
  if (element.kind === 'unit' && unitsOfDraft(draft).length >= WHITEBOARD_LIMITS.units) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.units} units`);
  const stored: Element = element.kind === 'note' ? storedNote(element, author) : element;
  const references = checkReferences(draft, stored, undefined);
  if (!references.ok) return references;
  writeElement(draft, stored);
  draft.elementCount += 1;
  return OK;
}

function rewrittenNoteStamp(existing: Element, fields: Record<string, unknown>, author: Author): Record<string, unknown> {
  if (existing.kind !== 'note' || !('text' in fields || 'on' in fields)) return {};
  return { author: author.name, resolvedBy: null };
}

function setFields(draft: Draft, id: string, fields: Record<string, unknown>, author: Author): OpOutcome {
  const existing = elementOf(draft, id);
  if (!existing) return refuse(`no element has id ${id}`);
  if ('kind' in fields || 'id' in fields) return refuse('set cannot change an element kind or id; remove it and add a new one');
  if (!canKeepNoteStamps(author) && ('author' in fields || 'resolvedBy' in fields)) return refuse('set cannot change who wrote or resolved a note; resolve it with a resolve op');
  const parsed = ELEMENT_SCHEMAS[existing.kind].safeParse({ ...existing, ...rewrittenNoteStamp(existing, fields, author), ...fields });
  if (!parsed.success) return refuse(`${id}: ${parsed.error.issues[0]?.message ?? 'invalid fields'}`);
  const references = checkReferences(draft, parsed.data, existing);
  if (!references.ok) return references;
  writeElement(draft, parsed.data);
  return OK;
}

function removeElement(draft: Draft, id: string): OpOutcome {
  const existing = elementOf(draft, id);
  if (!existing) return refuse(`no element has id ${id}`);
  if (existing.kind === 'box') pinBoxesNear(draft, id);
  eraseElement(draft, id);
  if (existing.kind === 'unit') {
    for (const unit of unitsOfDraft(draft)) {
      if (unit.after.includes(id)) writeElement(draft, { ...unit, after: unit.after.filter((afterId) => afterId !== id) });
    }
    return OK;
  }
  if (existing.kind !== 'box') return OK;
  for (const dependent of currentDependentsOf(draft, id)) removeDependent(draft, dependent, id);
  return OK;
}

function draftBoard(draft: Draft): Board {
  const elements = { ...draft.base.elements };
  for (const [id, element] of draft.afterById) {
    if (!element) {
      delete elements[id];
      continue;
    }
    if (draft.erasedIds.has(id)) delete elements[id];
    elements[id] = element;
  }
  return { ...draft.head, elements };
}

function pinPositionsOf(board: Board): PinPositions {
  const layout = layoutBoard(board);
  const laidOutBoxById = new Map(layout.elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  return { laidOutBoxById, pinnedOffsetY: layout.pinnedOffsetY };
}

function pinBoxesNear(draft: Draft, removedBoxId: string): void {
  const nearBoxes = currentDependentsOf(draft, removedBoxId).flatMap((element) => (element.kind === 'box' ? [element] : []));
  if (nearBoxes.length === 0) return;
  draft.pinPositions ??= pinPositionsOf(draftBoard(draft));
  const { laidOutBoxById, pinnedOffsetY } = draft.pinPositions;
  for (const box of nearBoxes) {
    const laidOut = laidOutBoxById.get(box.id);
    if (!laidOut) continue;
    writeElement(draft, { ...box, near: null, at: { x: laidOut.x, y: laidOut.y - pinnedOffsetY } });
  }
}

function removeDependent(draft: Draft, element: Element, removedBoxId: string): void {
  if (element.kind === 'wire' && (element.from === removedBoxId || element.to === removedBoxId)) {
    eraseElement(draft, element.id);
    return;
  }
  if (element.kind === 'note' && element.on === removedBoxId) {
    eraseElement(draft, element.id);
    return;
  }
  if (element.kind !== 'frame') return;
  const contains = element.contains.filter((id) => id !== removedBoxId);
  if (contains.length === 0) {
    eraseElement(draft, element.id);
    return;
  }
  writeElement(draft, { ...element, contains });
}

function resolveNote(draft: Draft, id: string, author: Author): OpOutcome {
  const note = elementOf(draft, id);
  if (note?.kind !== 'note') return refuse(`no note has id ${id}`);
  writeElement(draft, { ...note, resolvedBy: author.name });
  return OK;
}

function boxesOfDraft(draft: Draft): Box[] {
  const boxes: Box[] = [];
  for (const box of elementsOfKind(draft.base, 'box')) {
    const current = elementOf(draft, box.id);
    if (current?.kind === 'box') boxes.push(current);
  }
  for (const [id, element] of draft.afterById) {
    if (element?.kind === 'box' && draft.base.elements[id]?.kind !== 'box') boxes.push(element);
  }
  return boxes;
}

function replaceColumns(draft: Draft, columns: Board['columns'], moveByColumnId: Readonly<Record<string, string>>): OpOutcome {
  const columnIds = new Set(columns.map((column) => column.id));
  if (columnIds.size !== columns.length) return refuse('column ids must be unique');
  const strayTarget = Object.entries(moveByColumnId).find(([, targetId]) => !columnIds.has(targetId));
  if (strayTarget) return refuse(`move sends column ${strayTarget[0]} to ${strayTarget[1]}, which is not in the new columns`);
  const movedBoxes = boxesOfDraft(draft).flatMap((box) => {
    if (box.column === null) return [];
    const column = Object.hasOwn(moveByColumnId, box.column) ? moveByColumnId[box.column] ?? box.column : box.column;
    return [{ box, moved: column === box.column ? box : { ...box, column } }];
  });
  const stranded = movedBoxes.find(({ moved }) => moved.column !== null && !columnIds.has(moved.column));
  if (stranded) return refuse(`box ${stranded.moved.id} is still in removed column ${stranded.moved.column}, so name it in move or remove the box first`);
  for (const { box, moved } of movedBoxes) {
    if (moved !== box) writeElement(draft, moved);
  }
  draft.head.columns = columns;
  return OK;
}

function replaceLanes(draft: Draft, lanes: Board['lanes']): OpOutcome {
  const laneIds = new Set(lanes.map((lane) => lane.id));
  if (laneIds.size !== lanes.length) return refuse('lane ids must be unique');
  draft.head.lanes = lanes;
  for (const box of boxesOfDraft(draft)) {
    if (box.lane !== null && !laneIds.has(box.lane)) writeElement(draft, { ...box, lane: null });
  }
  return OK;
}

function applyOne(draft: Draft, op: Op, author: Author): OpOutcome {
  if (op.op !== 'remove') draft.pinPositions = null;
  switch (op.op) {
    case 'add': return addElement(draft, op.element, author);
    case 'set': return setFields(draft, op.id, op.fields, author);
    case 'remove': return removeElement(draft, op.id);
    case 'resolve': return resolveNote(draft, op.id, author);
    case 'columns': return replaceColumns(draft, op.columns, op.move);
    case 'lanes': return replaceLanes(draft, op.lanes);
    case 'board':
      if (op.title !== undefined) draft.head.title = op.title;
      if (op.caption !== undefined) draft.head.caption = op.caption;
      if (op.legend !== undefined) draft.head.legend = op.legend;
      if (op.codeSessionId !== undefined) draft.head.codeSessionId = op.codeSessionId;
      return OK;
  }
}

function stageOps(board: Board, ops: readonly Op[], author: Author, nowMs: number): StagedOps {
  const draft: Draft = {
    base: board, head: { ...board }, afterById: new Map(), erasedIds: new Set(), overlayDependentIdsByBoxId: new Map(),
    elementCount: boardIndexOf(board.elements).elementCount, pinPositions: null,
  };
  const lookup: ElementLookup = (id) => elementOf(draft, id);
  const version = board.version + 1;
  const changes: BoardChange[] = [];
  for (const [opIndex, op] of ops.entries()) {
    const elementId = changedElementId(op);
    const previous = elementId === null ? undefined : elementOf(draft, elementId);
    const outcome = applyOne(draft, op, author);
    if (!outcome.ok) return { ok: false, error: `op ${opIndex + 1}: ${outcome.error}`, opIndex };
    changes.push({ version, author: author.id, elementId, summary: `${author.name} ${describeOp(op, previous, lookup)}` });
  }
  const cycle = findDependencyCycle(unitsOfDraft(draft));
  if (cycle) return { ok: false, error: `that makes a dependency cycle: ${cycle.join(', ')}`, opIndex: ops.length - 1 };
  const diff = diffOf(draft);
  const elements = board.elements;
  const commit = (): void => {
    for (const [id, change] of Object.entries(diff.elements)) {
      const element = draft.afterById.get(id);
      if (change[0] === 'remove' || !element) {
        dropElement(elements, id);
        continue;
      }
      if (change[0] === 'put') {
        appendElement(elements, element);
        continue;
      }
      storeElement(elements, element);
    }
  };
  return { ok: true, board: { ...draft.head, elements, version, updatedAt: nowMs }, changes, diff, afterById: draft.afterById, commit };
}

function applyOps(board: Board, ops: readonly Op[], author: Author, nowMs: number): ApplyResult {
  const staged = stageOps({ ...board, elements: { ...board.elements } }, ops, author, nowMs);
  if (!staged.ok) return staged;
  staged.commit();
  return { ok: true, board: staged.board, changes: staged.changes, diff: staged.diff };
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

function diffOf(draft: Draft): BoardDiff {
  const elements: Record<string, ElementChange> = {};
  for (const [id, element] of draft.afterById) {
    const previous = draft.base.elements[id];
    if (!element) {
      if (previous) elements[id] = ['remove'];
      continue;
    }
    if (!previous || draft.erasedIds.has(id)) {
      elements[id] = ['put', element];
      continue;
    }
    if (previous === element) continue;
    const change = changeOf(previous, element);
    if (change) elements[id] = change;
  }
  const before = draft.base;
  const after = draft.head;
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

function nameOf(after: ElementLookup, id: string, element: Element | undefined = after(id)): string {
  if (!element) return id;
  if (element.kind === 'box' || element.kind === 'frame' || element.kind === 'unit' || element.kind === 'panel') return `"${element.title || id}"`;
  if (element.kind === 'wire') return `wire ${nameOf(after, element.from)} to ${nameOf(after, element.to)}`;
  return `note ${id}`;
}

function describeUnitAfter(after: ElementLookup, unitId: string, afterIds: readonly string[]): string {
  if (afterIds.length === 0) return `cleared what ${nameOf(after, unitId)} comes after`;
  return `set ${nameOf(after, unitId)} to come after ${afterIds.map((afterId) => nameOf(after, afterId)).join(', ')}`;
}

function describeSet(op: Extract<Op, { op: 'set' }>, previous: Element | undefined, after: ElementLookup): string {
  const fieldNames = Object.keys(op.fields);
  const afterElement = after(op.id);
  if (fieldNames.length === 1 && fieldNames[0] === 'at') return `moved ${nameOf(after, op.id)}`;
  if (fieldNames.length === 1 && fieldNames[0] === 'linkedBoardId') return afterElement?.kind === 'unit' && afterElement.linkedBoardId === null ? `unlinked ${nameOf(after, op.id)} from its board` : `linked ${nameOf(after, op.id)} to a board`;
  if (fieldNames.length === 1 && fieldNames[0] === 'after' && afterElement?.kind === 'unit') return describeUnitAfter(after, afterElement.id, afterElement.after);
  if (fieldNames.length === 1 && fieldNames[0] === 'status' && afterElement?.kind === 'unit') return `marked ${nameOf(after, op.id)} ${afterElement.status}`;
  if (previous?.kind === 'box' && afterElement?.kind === 'box' && fieldNames.length === 1 && fieldNames[0] === 'title') {
    return `renamed "${previous.title}" to "${afterElement.title}"`;
  }
  return `changed ${fieldNames.join(', ')} of ${nameOf(after, op.id)}`;
}

function describeBoardOp(op: Extract<Op, { op: 'board' }>): string {
  if (op.title !== undefined) return `renamed the board to "${op.title}"`;
  if (op.caption !== undefined) return 'changed the caption';
  if (op.codeSessionId !== undefined) return op.codeSessionId === null ? 'cleared the code session' : `set the code session to ${op.codeSessionId}`;
  return 'set the legend';
}

function describeOp(op: Op, previous: Element | undefined, after: ElementLookup): string {
  switch (op.op) {
    case 'add': {
      const element = op.element;
      if (element.kind === 'note') return `note on ${nameOf(after, element.on)}${element.ref ? ` at ${element.ref}` : ''}: ${element.text.slice(0, NOTE_PREVIEW_CHARS)} (note ${element.id})`;
      return `added ${element.kind} ${nameOf(after, element.id)}`;
    }
    case 'set': return describeSet(op, previous, after);
    case 'remove': return `removed ${previous?.kind ?? 'element'} ${nameOf(after, op.id, previous)}`;
    case 'resolve': return previous?.kind === 'note' ? `resolved note ${op.id} on ${nameOf(after, previous.on)}` : `resolved note ${op.id}`;
    case 'columns': return `set the columns to ${op.columns.map((column) => column.title || column.id).join(', ') || 'none'}`;
    case 'lanes': return `set the lanes to ${op.lanes.map((lane) => lane.label || lane.id).join(', ') || 'none'}`;
    case 'board': return describeBoardOp(op);
  }
}

function createBoard({ id, title, nowMs, codeSessionId = null }: { id: string; title: string; nowMs: number; codeSessionId?: string | null }): Board {
  return {
    id, title, version: 0, caption: null,
    columns: [{ id: 'main', title: '' }],
    lanes: [],
    legend: [],
    codeSessionId,
    elements: {},
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export { OPERATOR_AUTHOR, applyBoardDiff, applyOps, createBoard, stageOps };
export type { ApplyResult, Author, StagedOps };
