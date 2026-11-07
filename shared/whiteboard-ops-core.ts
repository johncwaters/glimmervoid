import { BOX_SHAPES, Box, Frame, Note, Wire, WHITEBOARD_LIMITS, fieldNamesOfShape } from './contracts/whiteboard.ts';
import type { Board, BoardChange, Element, Op } from './contracts/whiteboard.ts';
import { isRecord } from './coerce.ts';
import { isStackedPanel, layoutBoard } from './whiteboard-layout-core.ts';
import type { PlacedBox } from './whiteboard-layout-core.ts';
import type { BoardDiff, DiffBefore, ElementChange } from './contracts/control/whiteboard-messages.ts';
import { elementTableOf } from './whiteboard-element-table.ts';
import { appendElement, boardIndexOf, boxIdsDependedOnBy, copyOfElements, dropElement, storeElement } from './whiteboard-board-index.ts';

type Author = { id: string; name: string };
type ApplyResult = { ok: true; board: Board; changes: BoardChange[]; diff: BoardDiff; before: DiffBefore } | { ok: false; error: string; opIndex: number };
type StagedOps = {
  ok: true;
  board: Board;
  changes: BoardChange[];
  diff: BoardDiff;
  before: DiffBefore;
  afterById: ReadonlyMap<string, Element | null>;
  commit: () => void;
} | { ok: false; error: string; opIndex: number };
type OpOutcome = { ok: true } | { ok: false; error: string };
type PinPositions = { laidOutBoxOf: (id: string) => PlacedBox | undefined; pinnedOffsetY: number };
type ElementLookup = (id: string) => Element | undefined;
type Draft = {
  base: Board;
  head: Board;
  afterById: Map<string, Element | null>;
  erasedIds: Set<string>;
  overlayDependentIdsByBoxId: Map<string, Set<string>>;
  elementCount: number;
  basePinPositions: PinPositions | null;
};

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

function elementOf(draft: Draft, id: string): Element | undefined {
  if (draft.afterById.has(id)) return draft.afterById.get(id) ?? undefined;
  return draft.base.elements.get(id);
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

function currentDependentsOf(draft: Draft, boxId: string): Element[] {
  const candidateIds = new Set([...boardIndexOf(draft.base.elements).dependentIdsByBoxId.get(boxId) ?? [], ...draft.overlayDependentIdsByBoxId.get(boxId) ?? []]);
  return [...candidateIds].flatMap((dependentId) => {
    const element = elementOf(draft, dependentId);
    return element && boxIdsDependedOnBy(element).includes(boxId) ? [element] : [];
  });
}

function checkReferences(draft: Draft, element: Element, previous: Element | undefined): OpOutcome {
  if (element.kind === 'box') return checkBoxReferences(draft, element, previous);
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

type DecisionOutputs = Extract<Box, { shape: 'decision' }>['outputs'];

function decisionOutputsOf(element: Element | undefined): DecisionOutputs {
  if (element?.kind !== 'box' || element.shape !== 'decision') return [];
  return element.outputs;
}

function checkBoxOutputs(draft: Draft, box: Box, previous: Element | undefined): OpOutcome {
  const outputs = decisionOutputsOf(box);
  const outputIds = new Set(outputs.map((output) => output.id));
  if (outputIds.size !== outputs.length) return refuse(`box ${box.id} has two outputs with the same id`);
  const previousOutputs = decisionOutputsOf(previous);
  if (previousOutputs.every((output) => outputIds.has(output.id))) return OK;
  const strandedWire = currentDependentsOf(draft, box.id).find((element) => element.kind === 'wire' && element.from === box.id && element.fromOutput !== null && !outputIds.has(element.fromOutput));
  if (strandedWire?.kind === 'wire') return refuse(`wire ${strandedWire.id} still starts at output ${strandedWire.fromOutput} of ${box.id}, so change or remove that wire first`);
  return OK;
}

function boxSittingNear(draft: Draft, boxId: string): Box | null {
  const sitting = currentDependentsOf(draft, boxId).find((element) => element.kind === 'box' && element.near?.of === boxId);
  return sitting?.kind === 'box' ? sitting : null;
}

function checkBoxReferences(draft: Draft, box: Box, previous: Element | undefined): OpOutcome {
  const outputs = checkBoxOutputs(draft, box, previous);
  if (!outputs.ok) return outputs;
  if (box.change === 'relabeled' && !box.was) return refuse(`box ${box.id} is relabeled, so give its old title in was`);
  if (box.step === null && box.shape !== 'panel' && box.near === null && box.at === null) {
    return refuse(`box ${box.id} needs a place: near another box or at a point`);
  }
  const isJoiningPanelStack = isStackedPanel(box) && previous?.kind === 'box' && !isStackedPanel(previous);
  const sittingNear = isJoiningPanelStack ? boxSittingNear(draft, box.id) : null;
  if (sittingNear) return refuse(`box ${sittingNear.id} sits near ${box.id}, so ${box.id} cannot go back to the panel stack with no place: keep a near or at on it, or move box ${sittingNear.id} first`);
  if (box.near === null) return OK;
  if (box.near.of === box.id) return refuse(`box ${box.id} cannot sit near itself`);
  const nearTarget = elementOf(draft, box.near.of);
  if (nearTarget?.kind !== 'box') return refuse(`box ${box.id} sits near ${box.near.of}, which is not a box`);
  if (isStackedPanel(nearTarget)) return refuse(`box ${box.id} sits near ${box.near.of}, a panel with no place yet, so give that panel a near or at first`);
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

function withoutEmptyOutputsOffDecision(element: Element): Element {
  if (element.kind !== 'box' || element.shape === 'decision' || !('outputs' in element) || element.outputs === undefined) return element;
  const { outputs, ...elementWithoutOutputs } = element;
  return elementWithoutOutputs;
}

function addElement(draft: Draft, element: Element, author: Author): OpOutcome {
  if (elementOf(draft, element.id)) return refuse(`an element with id ${element.id} already exists`);
  if (draft.elementCount >= WHITEBOARD_LIMITS.elements) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.elements} elements`);
  const stored: Element = element.kind === 'note' ? storedNote(element, author) : withoutEmptyOutputsOffDecision(element);
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

function withStepMerged(existing: Element, fields: Record<string, unknown>): Record<string, unknown> {
  if (existing.kind !== 'box' || existing.step === null || !isRecord(fields.step)) return fields;
  return { ...fields, step: { ...existing.step, ...fields.step } };
}

function isBoxShape(value: unknown): value is Box['shape'] {
  return BOX_SHAPES.some((shape) => shape === value);
}

function existingFieldsKeptBy(existing: Element, fields: Record<string, unknown>): Record<string, unknown> {
  if (existing.kind !== 'box' || fields.shape === undefined || fields.shape === existing.shape || !isBoxShape(fields.shape)) return existing;
  const fieldNames = fieldNamesOfShape(fields.shape);
  return Object.fromEntries(Object.entries(existing).filter(([fieldName]) => fieldNames.has(fieldName)));
}

function setFields(draft: Draft, id: string, rawFields: Record<string, unknown>, author: Author): OpOutcome {
  const existing = elementOf(draft, id);
  if (!existing) return refuse(`no element has id ${id}`);
  const fields = withStepMerged(existing, rawFields);
  if ('kind' in fields || 'id' in fields) return refuse('set cannot change an element kind or id; remove it and add a new one');
  if (!canKeepNoteStamps(author) && ('author' in fields || 'resolvedBy' in fields)) return refuse('set cannot change who wrote or resolved a note; resolve it with a resolve op');
  const parsed = ELEMENT_SCHEMAS[existing.kind].safeParse({ ...existingFieldsKeptBy(existing, fields), ...rewrittenNoteStamp(existing, fields, author), ...fields });
  if (!parsed.success) return refuse(`${id}: ${parsed.error.issues[0]?.message ?? 'invalid fields'}`);
  const stored = withoutEmptyOutputsOffDecision(parsed.data);
  const references = checkReferences(draft, stored, existing);
  if (!references.ok) return references;
  writeElement(draft, stored);
  return OK;
}

function removeElement(draft: Draft, id: string): OpOutcome {
  const existing = elementOf(draft, id);
  if (!existing) return refuse(`no element has id ${id}`);
  if (existing.kind === 'box') pinBoxesNear(draft, id);
  eraseElement(draft, id);
  if (existing.kind !== 'box') return OK;
  for (const dependent of currentDependentsOf(draft, id)) removeDependent(draft, dependent, id);
  return OK;
}

function pinPositionsOf(board: Board): PinPositions {
  const layout = layoutBoard(board);
  const laidOutBoxById = new Map(layout.elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  return { laidOutBoxOf: (id) => laidOutBoxById.get(id), pinnedOffsetY: layout.pinnedOffsetY };
}

const ORIGIN = Object.freeze({ x: 0, y: 0 });

function drawnPlaceOf(draft: Draft, boxId: string, visitedIds: Set<string>): { x: number; y: number } {
  const laidOut = draft.basePinPositions?.laidOutBoxOf(boxId);
  if (laidOut) return { x: laidOut.x, y: laidOut.y - (draft.basePinPositions?.pinnedOffsetY ?? 0) };
  const box = elementOf(draft, boxId) ?? draft.base.elements.get(boxId);
  if (box?.kind !== 'box') return ORIGIN;
  if (box.at) return box.at;
  if (!box.near || visitedIds.has(box.near.of)) return ORIGIN;
  visitedIds.add(boxId);
  return drawnPlaceOf(draft, box.near.of, visitedIds);
}

function pinBoxesNear(draft: Draft, removedBoxId: string): void {
  const nearBoxes = currentDependentsOf(draft, removedBoxId).flatMap((element) => (element.kind === 'box' ? [element] : []));
  for (const box of nearBoxes) {
    const laidOut = draft.basePinPositions?.laidOutBoxOf(box.id);
    const at = laidOut ? drawnPlaceOf(draft, box.id, new Set()) : drawnPlaceOf(draft, removedBoxId, new Set([box.id]));
    writeElement(draft, { ...box, near: null, at });
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

function applyOne(draft: Draft, op: Op, author: Author): OpOutcome {
  switch (op.op) {
    case 'add': return addElement(draft, op.element, author);
    case 'set': return setFields(draft, op.id, op.fields, author);
    case 'remove': return removeElement(draft, op.id);
    case 'resolve': return resolveNote(draft, op.id, author);
    case 'board':
      if (op.title !== undefined) draft.head.title = op.title;
      if (op.caption !== undefined) draft.head.caption = op.caption;
      if (op.legend !== undefined) draft.head.legend = op.legend;
      if (op.codeSessionId !== undefined) draft.head.codeSessionId = op.codeSessionId;
      return OK;
  }
}

function stageOps(board: Board, ops: readonly Op[], author: Author, nowMs: number, basePinPositions: PinPositions | null): StagedOps {
  const draft: Draft = {
    base: board, head: { ...board }, afterById: new Map(), erasedIds: new Set(), overlayDependentIdsByBoxId: new Map(),
    elementCount: boardIndexOf(board.elements).elementCount, basePinPositions,
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
  const diff = diffOf(draft);
  const before = beforeOf(board, diff);
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
  return { ok: true, board: { ...draft.head, elements, version, updatedAt: nowMs }, changes, diff, before, afterById: draft.afterById, commit };
}

function applyOps(board: Board, ops: readonly Op[], author: Author, nowMs: number): ApplyResult {
  const basePinPositions = ops.some((op) => op.op === 'remove') ? pinPositionsOf(board) : null;
  const staged = stageOps({ ...board, elements: copyOfElements(board.elements) }, ops, author, nowMs, basePinPositions);
  if (!staged.ok) return staged;
  staged.commit();
  return { ok: true, board: staged.board, changes: staged.changes, diff: staged.diff, before: staged.before };
}

function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasSameFieldNames(left: Element, right: Element): boolean {
  const leftNames = Object.keys(left);
  const rightNames = new Set(Object.keys(right));
  return leftNames.length === rightNames.size && leftNames.every((name) => rightNames.has(name));
}

function isBoxShapeChange(previous: Element, element: Element): boolean {
  return previous.kind === 'box' && element.kind === 'box' && previous.shape !== element.shape;
}

function changeOf(previous: Element, element: Element): ElementChange | null {
  if (previous.kind !== element.kind || (!hasSameFieldNames(previous, element) && !isBoxShapeChange(previous, element))) return ['put', element];
  const previousFields: Record<string, unknown> = { ...previous };
  const changedFields = Object.fromEntries(Object.entries(element).filter(([name, value]) => !isSameValue(previousFields[name], value)));
  return Object.keys(changedFields).length === 0 ? null : ['patch', changedFields];
}

function diffOf(draft: Draft): BoardDiff {
  const elements: Record<string, ElementChange> = {};
  for (const [id, element] of draft.afterById) {
    const previous = draft.base.elements.get(id);
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
  const parsed = ELEMENT_SCHEMAS[existing.kind].safeParse({ ...existingFieldsKeptBy(existing, change[1]), ...change[1] });
  return parsed.success && parsed.data.id === id ? parsed.data : null;
}

function beforeOf(board: Board, diff: BoardDiff): DiffBefore {
  return {
    fields: {
      ...('title' in diff.fields ? { title: board.title } : {}),
      ...('caption' in diff.fields ? { caption: board.caption } : {}),
      ...('legend' in diff.fields ? { legend: board.legend } : {}),
      ...('codeSessionId' in diff.fields ? { codeSessionId: board.codeSessionId } : {}),
    },
    elements: Object.fromEntries(Object.keys(diff.elements).map((id) => [id, board.elements.get(id) ?? null])),
  };
}

function applyBoardDiff(board: Board, diff: BoardDiff, version: number, updatedAt: number): Board | null {
  const elements = copyOfElements(board.elements);
  for (const [id, change] of Object.entries(diff.elements)) {
    const existing = elements.get(id);
    if (change[0] === 'remove') {
      if (!existing) return null;
      dropElement(elements, id);
      continue;
    }
    const element = appliedChangeOf(existing, id, change);
    if (!element) return null;
    if (change[0] === 'put') {
      appendElement(elements, element);
      continue;
    }
    storeElement(elements, element);
  }
  if (elements.size > WHITEBOARD_LIMITS.elements) return null;
  return { ...board, ...diff.fields, elements, version, updatedAt };
}

function changedElementId(op: Op): string | null {
  if (op.op === 'add') return op.element.id;
  if (op.op === 'set' || op.op === 'remove' || op.op === 'resolve') return op.id;
  return null;
}

function nameOf(after: ElementLookup, id: string, element: Element | undefined = after(id)): string {
  if (!element) return id;
  if (element.kind === 'box' || element.kind === 'frame') return `"${element.title || id}"`;
  if (element.kind === 'wire') return `wire ${nameOf(after, element.from)} to ${nameOf(after, element.to)}`;
  return `note ${id}`;
}

function describeStepChange(name: string, before: Box['step'], after: Box['step']): string {
  if (after === null) return `made ${name} no longer a plan step`;
  if (before === null) return `made ${name} a plan step`;
  if (before.status !== after.status) return `marked ${name} ${after.status}`;
  if (after.linkedBoardId === null) return `unlinked ${name} from its board`;
  return `linked ${name} to a board`;
}

function describeSet(op: Extract<Op, { op: 'set' }>, previous: Element | undefined, after: ElementLookup): string {
  const fieldNames = Object.keys(op.fields);
  const afterElement = after(op.id);
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
    case 'board': return describeBoardOp(op);
  }
}

function createBoard({ id, title, nowMs, codeSessionId = null }: { id: string; title: string; nowMs: number; codeSessionId?: string | null }): Board {
  return {
    id, title, version: 0, caption: null,
    legend: [],
    codeSessionId,
    elements: elementTableOf(),
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export { OPERATOR_AUTHOR, applyBoardDiff, applyOps, createBoard, stageOps };
export type { ApplyResult, Author, PinPositions, StagedOps };
