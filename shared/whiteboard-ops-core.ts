import { Box, Frame, Note, Unit, Wire, WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, BoardChange, Element, Op } from './contracts/whiteboard.ts';
import { layoutBoard } from './whiteboard-layout-core.ts';
import { findDependencyCycle, unitsOf } from './whiteboard-plan-core.ts';

type Author = { id: string; name: string };
type ApplyResult = { ok: true; board: Board; changes: BoardChange[] } | { ok: false; error: string; opIndex: number };
type OpOutcome = { ok: true } | { ok: false; error: string };

const ELEMENT_SCHEMAS = Object.freeze({ box: Box, frame: Frame, wire: Wire, note: Note, unit: Unit });
const NOTE_PREVIEW_CHARS = 80;
const OK: OpOutcome = { ok: true };

function refuse(error: string): OpOutcome {
  return { ok: false, error };
}

function isBox(board: Board, id: string): boolean {
  return board.elements[id]?.kind === 'box';
}

function checkReferences(board: Board, element: Element): OpOutcome {
  if (element.kind === 'box') return checkBoxReferences(board, element);
  if (element.kind === 'unit') return checkUnitReferences(board, element);
  if (element.kind === 'wire') {
    if (!isBox(board, element.from)) return refuse(`wire ${element.id} starts at ${element.from}, which is not a box`);
    if (!isBox(board, element.to)) return refuse(`wire ${element.id} ends at ${element.to}, which is not a box`);
    return OK;
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

function checkBoxReferences(board: Board, box: Box): OpOutcome {
  if (box.column === null && box.near === null && box.at === null) {
    return refuse(`box ${box.id} needs a place: a column, near another box, or at a point`);
  }
  if (box.column !== null && !board.columns.some((column) => column.id === box.column)) {
    return refuse(`box ${box.id} names column ${box.column}, which the board does not have, so add it with a columns op first`);
  }
  if (box.lane !== null && !board.lanes.some((lane) => lane.id === box.lane)) {
    return refuse(`box ${box.id} names lane ${box.lane}, which the board does not have, so add it with a lanes op first`);
  }
  if (box.near === null) return OK;
  if (box.near.of === box.id) return refuse(`box ${box.id} cannot sit near itself`);
  if (!isBox(board, box.near.of)) return refuse(`box ${box.id} sits near ${box.near.of}, which is not a box`);
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

function checkUnitReferences(board: Board, unit: Unit): OpOutcome {
  if (unit.after.includes(unit.id)) return refuse(`unit ${unit.id} cannot come after itself`);
  const strangerId = unit.after.find((id) => board.elements[id]?.kind !== 'unit');
  if (strangerId) return refuse(`unit ${unit.id} comes after ${strangerId}, which is not a unit on this board`);
  return OK;
}

function addElement(board: Board, element: Element, author: Author): OpOutcome {
  if (board.elements[element.id]) return refuse(`an element with id ${element.id} already exists`);
  if (Object.keys(board.elements).length >= WHITEBOARD_LIMITS.elements) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.elements} elements`);
  if (element.kind === 'unit' && unitsOf(board).length >= WHITEBOARD_LIMITS.units) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.units} units`);
  const stored: Element = element.kind === 'note' ? { ...element, author: author.name, resolvedBy: null } : element;
  const references = checkReferences(board, stored);
  if (!references.ok) return references;
  board.elements[element.id] = stored;
  return OK;
}

function rewrittenNoteStamp(existing: Element, fields: Record<string, unknown>, author: Author): Record<string, unknown> {
  if (existing.kind !== 'note' || !('text' in fields || 'on' in fields)) return {};
  return { author: author.name, resolvedBy: null };
}

function setFields(board: Board, id: string, fields: Record<string, unknown>, author: Author): OpOutcome {
  const existing = board.elements[id];
  if (!existing) return refuse(`no element has id ${id}`);
  if ('kind' in fields || 'id' in fields) return refuse('set cannot change an element kind or id; remove it and add a new one');
  if ('author' in fields || 'resolvedBy' in fields) return refuse('set cannot change who wrote or resolved a note; resolve it with a resolve op');
  const parsed = ELEMENT_SCHEMAS[existing.kind].safeParse({ ...existing, ...fields, ...rewrittenNoteStamp(existing, fields, author) });
  if (!parsed.success) return refuse(`${id}: ${parsed.error.issues[0]?.message ?? 'invalid fields'}`);
  const references = checkReferences(board, parsed.data);
  if (!references.ok) return references;
  board.elements[id] = parsed.data;
  return OK;
}

function removeElement(board: Board, id: string): OpOutcome {
  const existing = board.elements[id];
  if (!existing) return refuse(`no element has id ${id}`);
  if (existing.kind === 'box') pinBoxesNear(board, id);
  delete board.elements[id];
  if (existing.kind === 'unit') {
    for (const unit of unitsOf(board)) {
      if (unit.after.includes(id)) board.elements[unit.id] = { ...unit, after: unit.after.filter((afterId) => afterId !== id) };
    }
    return OK;
  }
  if (existing.kind !== 'box') return OK;
  for (const element of Object.values(board.elements)) removeDependent(board, element, id);
  return OK;
}

function pinBoxesNear(board: Board, removedBoxId: string): void {
  const nearBoxes = Object.values(board.elements).flatMap((element) => (element.kind === 'box' && element.near?.of === removedBoxId ? [element] : []));
  if (nearBoxes.length === 0) return;
  const layout = layoutBoard(board);
  for (const box of nearBoxes) {
    const laidOut = layout.elements.find((element) => element.id === box.id);
    if (!laidOut || laidOut.kind !== 'box') continue;
    board.elements[box.id] = { ...box, near: null, at: { x: laidOut.x, y: laidOut.y - layout.pinnedOffsetY } };
  }
}

function removeDependent(board: Board, element: Element, removedBoxId: string): void {
  if (element.kind === 'wire' && (element.from === removedBoxId || element.to === removedBoxId)) {
    delete board.elements[element.id];
    return;
  }
  if (element.kind === 'note' && element.on === removedBoxId) {
    delete board.elements[element.id];
    return;
  }
  if (element.kind !== 'frame') return;
  const contains = element.contains.filter((id) => id !== removedBoxId);
  if (contains.length === 0) {
    delete board.elements[element.id];
    return;
  }
  board.elements[element.id] = { ...element, contains };
}

function resolveNote(board: Board, id: string, author: Author): OpOutcome {
  const note = board.elements[id];
  if (note?.kind !== 'note') return refuse(`no note has id ${id}`);
  board.elements[id] = { ...note, resolvedBy: author.name };
  return OK;
}

function replaceColumns(board: Board, columns: Board['columns'], moveByColumnId: Readonly<Record<string, string>>): OpOutcome {
  const columnIds = new Set(columns.map((column) => column.id));
  if (columnIds.size !== columns.length) return refuse('column ids must be unique');
  const strayTarget = Object.entries(moveByColumnId).find(([, targetId]) => !columnIds.has(targetId));
  if (strayTarget) return refuse(`move sends column ${strayTarget[0]} to ${strayTarget[1]}, which is not in the new columns`);
  const movedBoxes = Object.values(board.elements).flatMap((element) => {
    if (element.kind !== 'box' || element.column === null) return [];
    return [{ ...element, column: Object.hasOwn(moveByColumnId, element.column) ? moveByColumnId[element.column] ?? element.column : element.column }];
  });
  const strandedBox = movedBoxes.find((box) => box.column !== null && !columnIds.has(box.column));
  if (strandedBox) return refuse(`box ${strandedBox.id} is still in removed column ${strandedBox.column}, so name it in move or remove the box first`);
  for (const box of movedBoxes) board.elements[box.id] = box;
  board.columns = columns;
  return OK;
}

function replaceLanes(board: Board, lanes: Board['lanes']): OpOutcome {
  const laneIds = new Set(lanes.map((lane) => lane.id));
  if (laneIds.size !== lanes.length) return refuse('lane ids must be unique');
  board.lanes = lanes;
  for (const element of Object.values(board.elements)) {
    if (element.kind === 'box' && element.lane !== null && !laneIds.has(element.lane)) board.elements[element.id] = { ...element, lane: null };
  }
  return OK;
}

function applyOne(board: Board, op: Op, author: Author): OpOutcome {
  switch (op.op) {
    case 'add': return addElement(board, op.element, author);
    case 'set': return setFields(board, op.id, op.fields, author);
    case 'remove': return removeElement(board, op.id);
    case 'resolve': return resolveNote(board, op.id, author);
    case 'columns': return replaceColumns(board, op.columns, op.move);
    case 'lanes': return replaceLanes(board, op.lanes);
    case 'board':
      if (op.title !== undefined) board.title = op.title;
      if (op.caption !== undefined) board.caption = op.caption;
      return OK;
  }
}

function applyOps(board: Board, ops: readonly Op[], author: Author, nowMs: number): ApplyResult {
  const draft = structuredClone(board);
  const version = board.version + 1;
  const changes: BoardChange[] = [];
  for (const [opIndex, op] of ops.entries()) {
    const elementId = changedElementId(op);
    const previous = elementId === null ? undefined : draft.elements[elementId];
    const outcome = applyOne(draft, op, author);
    if (!outcome.ok) return { ok: false, error: `op ${opIndex + 1}: ${outcome.error}`, opIndex };
    changes.push({ version, author: author.id, elementId, summary: `${author.name} ${describeOp(op, previous, draft)}` });
  }
  const cycle = findDependencyCycle(draft);
  if (cycle) return { ok: false, error: `that makes a dependency cycle: ${cycle.join(', ')}`, opIndex: ops.length - 1 };
  draft.version = version;
  draft.updatedAt = nowMs;
  return { ok: true, board: draft, changes };
}

function changedElementId(op: Op): string | null {
  if (op.op === 'add') return op.element.id;
  if (op.op === 'set' || op.op === 'remove' || op.op === 'resolve') return op.id;
  return null;
}

function nameOf(board: Board, id: string, element: Element | undefined = board.elements[id]): string {
  if (!element) return id;
  if (element.kind === 'box' || element.kind === 'frame' || element.kind === 'unit') return `"${element.title || id}"`;
  if (element.kind === 'wire') return `wire ${nameOf(board, element.from)} to ${nameOf(board, element.to)}`;
  return `note ${id}`;
}

function describeUnitAfter(board: Board, unitId: string, afterIds: readonly string[]): string {
  if (afterIds.length === 0) return `cleared what ${nameOf(board, unitId)} comes after`;
  return `set ${nameOf(board, unitId)} to come after ${afterIds.map((afterId) => nameOf(board, afterId)).join(', ')}`;
}

function describeSet(op: Extract<Op, { op: 'set' }>, previous: Element | undefined, after: Board): string {
  const fieldNames = Object.keys(op.fields);
  const afterElement = after.elements[op.id];
  if (fieldNames.length === 1 && fieldNames[0] === 'at') return `moved ${nameOf(after, op.id)}`;
  if (fieldNames.length === 1 && fieldNames[0] === 'linkedBoardId') return afterElement?.kind === 'unit' && afterElement.linkedBoardId === null ? `unlinked ${nameOf(after, op.id)} from its board` : `linked ${nameOf(after, op.id)} to a board`;
  if (fieldNames.length === 1 && fieldNames[0] === 'after' && afterElement?.kind === 'unit') return describeUnitAfter(after, afterElement.id, afterElement.after);
  if (previous?.kind === 'box' && afterElement?.kind === 'box' && fieldNames.length === 1 && fieldNames[0] === 'title') {
    return `renamed "${previous.title}" to "${afterElement.title}"`;
  }
  return `changed ${fieldNames.join(', ')} of ${nameOf(after, op.id)}`;
}

function describeOp(op: Op, previous: Element | undefined, after: Board): string {
  switch (op.op) {
    case 'add': {
      const element = op.element;
      if (element.kind === 'note') return `note on ${nameOf(after, element.on)}: ${element.text.slice(0, NOTE_PREVIEW_CHARS)} (note ${element.id})`;
      return `added ${element.kind} ${nameOf(after, element.id)}`;
    }
    case 'set': return describeSet(op, previous, after);
    case 'remove': return `removed ${previous?.kind ?? 'element'} ${nameOf(after, op.id, previous)}`;
    case 'resolve': return previous?.kind === 'note' ? `resolved note ${op.id} on ${nameOf(after, previous.on)}` : `resolved note ${op.id}`;
    case 'columns': return `set the columns to ${op.columns.map((column) => column.title || column.id).join(', ') || 'none'}`;
    case 'lanes': return `set the lanes to ${op.lanes.map((lane) => lane.label || lane.id).join(', ') || 'none'}`;
    case 'board': return op.title === undefined ? 'changed the caption' : `renamed the board to "${op.title}"`;
  }
}

function createBoard({ id, title, nowMs }: { id: string; title: string; nowMs: number }): Board {
  return {
    id, title, version: 0, caption: null,
    columns: [{ id: 'main', title: '' }],
    lanes: [],
    elements: {},
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export { applyOps, createBoard };
export type { ApplyResult, Author };
