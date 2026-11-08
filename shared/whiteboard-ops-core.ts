import { BOX_SHAPES, BoxInput, Frame, Stroke, Wire, WHITEBOARD_LIMITS, dialParamsProblemOf, fieldNamesOfShape } from './contracts/whiteboard.ts';
import type { Board, BoardChange, Box, BoxLine, Element, ElementInput, Op } from './contracts/whiteboard.ts';
import { isRecord } from './coerce.ts';
import { isStackedPanel, laidOutBox, laidOutNearBox, layoutBoard } from './whiteboard-layout-core.ts';
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
  strokeCount: number;
  basePinPositions: PinPositions | null;
};

const ELEMENT_SCHEMAS = Object.freeze({ box: BoxInput, frame: Frame, wire: Wire, stroke: Stroke });
const NOTE_TEXT_FIELDS = ['title', 'lines', 'shape'] as const;
const BYLINE_PREFIX = 'from ';
const OK: OpOutcome = { ok: true };
const DIFFED_BOARD_FIELDS = ['title', 'caption', 'legend', 'codeSessionId'] as const;
const OPERATOR_AUTHOR: Author = Object.freeze({ id: 'operator', name: 'operator' });
const NO_PLAN_STEPS = new Map<string, never>();

function isOperatorAuthor(author: Author): boolean {
  return author.id === OPERATOR_AUTHOR.id;
}

function isBylineLine(line: BoxLine | undefined): boolean {
  return Boolean(line?.muted && line.text.startsWith(BYLINE_PREFIX));
}

function signedNoteBox(element: Element, author: Author): { ok: true; element: Element } | { ok: false; error: string } {
  if (element.kind !== 'box' || element.shape !== 'note') return { ok: true, element };
  const lastLine = element.lines.at(-1);
  if (isOperatorAuthor(author) && isBylineLine(lastLine)) return { ok: true, element };
  const unsignedLines = isBylineLine(lastLine) ? element.lines.slice(0, -1) : element.lines;
  if (unsignedLines.length >= WHITEBOARD_LIMITS.linesPerBox) return { ok: false, error: `box ${element.id}: a note box holds at most ${WHITEBOARD_LIMITS.linesPerBox - 1} lines, since its last line names who wrote it` };
  const byline: BoxLine = { text: `${BYLINE_PREFIX}${author.name}`.slice(0, WHITEBOARD_LIMITS.line), muted: true, style: 'text', key: null, ref: null, icon: null };
  return { ok: true, element: { ...element, lines: [...unsignedLines, byline] } };
}

function noteBoxTextOf(text: string): { title: string; lines: string[] } {
  const words = text.trim().split(/\s+/);
  const wrapped: string[] = [];
  for (const word of words) {
    const lineLimit = wrapped.length <= 1 ? WHITEBOARD_LIMITS.title : WHITEBOARD_LIMITS.line;
    const current = wrapped.at(-1);
    if (current !== undefined && current.length + 1 + word.length <= lineLimit) {
      wrapped[wrapped.length - 1] = `${current} ${word}`;
      continue;
    }
    let restOfWord = word;
    while (restOfWord.length > 0) {
      const pieceLimit = wrapped.length === 0 ? WHITEBOARD_LIMITS.title : WHITEBOARD_LIMITS.line;
      wrapped.push(restOfWord.slice(0, pieceLimit));
      restOfWord = restOfWord.slice(pieceLimit);
    }
  }
  const [title = '', ...lines] = wrapped;
  return { title, lines: lines.slice(0, WHITEBOARD_LIMITS.linesPerBox - 1) };
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
  if (elementOf(draft, id)?.kind === 'stroke') draft.strokeCount -= 1;
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
  if (element.kind !== 'frame') return OK;
  const strangerId = element.contains.find((id) => !isBox(draft, id));
  if (strangerId) return refuse(`frame ${element.id} contains ${strangerId}, which is not a box`);
  return checkStackMembership(draft, element);
}

function checkStackMembership(draft: Draft, frame: Frame): OpOutcome {
  if (!frame.collapsed) return OK;
  for (const boxId of frame.contains) {
    const otherStack = currentDependentsOf(draft, boxId).find((dependent) => dependent.kind === 'frame' && dependent.collapsed && dependent.id !== frame.id);
    if (otherStack) return refuse(`frame ${frame.id} stacks ${boxId}, which is already in stack ${otherStack.id}`);
  }
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

function checkBoxReferences(draft: Draft, box: Box, previous: Element | undefined): OpOutcome {
  const outputs = checkBoxOutputs(draft, box, previous);
  if (!outputs.ok) return outputs;
  if (box.change === 'relabeled' && !box.was) return refuse(`box ${box.id} is relabeled, so give its old title in was`);
  const dialProblem = dialParamsProblemOf(box);
  if (dialProblem) return refuse(dialProblem);
  if (box.step === null && box.shape !== 'panel' && box.at === null) {
    return refuse(`box ${box.id} needs a place: near another box or at a point`);
  }
  return OK;
}

function withoutEmptyOutputsOffDecision(element: Element): Element {
  if (element.kind !== 'box' || element.shape === 'decision' || !('outputs' in element) || element.outputs === undefined) return element;
  const { outputs, ...elementWithoutOutputs } = element;
  return elementWithoutOutputs;
}

function drawnRectOf(draft: Draft, targetId: string): PlacedBox | null {
  const target = elementOf(draft, targetId);
  if (target?.kind !== 'box') return null;
  if (target.at) return laidOutBox(NO_PLAN_STEPS, target, target.at);
  const laidOut = draft.basePinPositions?.laidOutBoxOf(targetId);
  if (!laidOut) return null;
  return { ...laidOut, y: laidOut.y - (draft.basePinPositions?.pinnedOffsetY ?? 0) };
}

function placedAtNear(draft: Draft, element: ElementInput): { ok: true; element: Element } | { ok: false; error: string } {
  if (element.kind !== 'box') return { ok: true, element };
  const { near, ...box } = element;
  if (near === null || box.at !== null) return { ok: true, element: box };
  if (near.of === box.id) return { ok: false, error: `box ${box.id} cannot sit near itself` };
  const target = elementOf(draft, near.of);
  if (target?.kind !== 'box') return { ok: false, error: `box ${box.id} sits near ${near.of}, which is not a box` };
  if (isStackedPanel(target)) return { ok: false, error: `box ${box.id} sits near ${near.of}, a panel with no place yet, so give that panel a near or at first` };
  const targetRect = drawnRectOf(draft, near.of);
  if (!targetRect) return { ok: false, error: `box ${box.id} sits near ${near.of}, which has no drawn place yet, so give ${near.of} an at first` };
  const placed = laidOutNearBox(NO_PLAN_STEPS, box, near, targetRect);
  return { ok: true, element: { ...box, at: { x: placed.x, y: placed.y } } };
}

function withoutAtUnlessGiven(element: ElementInput, isAtGiven: boolean): ElementInput {
  if (element.kind !== 'box' || isAtGiven) return element;
  return { ...element, at: null };
}

function addElement(draft: Draft, element: ElementInput, author: Author): OpOutcome {
  if (elementOf(draft, element.id)) return refuse(`an element with id ${element.id} already exists`);
  if (draft.elementCount >= WHITEBOARD_LIMITS.elements) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.elements} elements`);
  if (element.kind === 'stroke' && !isOperatorAuthor(author)) return refuse('only the operator draws strokes; an agent may read or remove one');
  if (element.kind === 'stroke' && draft.strokeCount >= WHITEBOARD_LIMITS.strokes) return refuse(`a board holds at most ${WHITEBOARD_LIMITS.strokes} strokes`);
  const placed = placedAtNear(draft, element);
  if (!placed.ok) return placed;
  const signed = signedNoteBox(withoutEmptyOutputsOffDecision(placed.element), author);
  if (!signed.ok) return signed;
  const stored = signed.element;
  const references = checkReferences(draft, stored, undefined);
  if (!references.ok) return references;
  writeElement(draft, stored);
  draft.elementCount += 1;
  if (stored.kind === 'stroke') draft.strokeCount += 1;
  return OK;
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
  if (existing.kind === 'stroke' && !isOperatorAuthor(author)) return refuse('only the operator changes strokes; an agent may read or remove one');
  const parsed = ELEMENT_SCHEMAS[existing.kind].safeParse({ ...existingFieldsKeptBy(existing, fields), ...fields });
  if (!parsed.success) return refuse(`${id}: ${parsed.error.issues[0]?.message ?? 'invalid fields'}`);
  const placed = placedAtNear(draft, 'near' in fields ? withoutAtUnlessGiven(parsed.data, 'at' in fields) : parsed.data);
  if (!placed.ok) return placed;
  const signed = NOTE_TEXT_FIELDS.some((field) => field in fields) ? signedNoteBox(withoutEmptyOutputsOffDecision(placed.element), author) : { ok: true as const, element: withoutEmptyOutputsOffDecision(placed.element) };
  if (!signed.ok) return signed;
  const stored = signed.element;
  const references = checkReferences(draft, stored, existing);
  if (!references.ok) return references;
  writeElement(draft, stored);
  return OK;
}

function removeElement(draft: Draft, id: string): OpOutcome {
  const existing = elementOf(draft, id);
  if (!existing) return refuse(`no element has id ${id}`);
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

function removeDependent(draft: Draft, element: Element, removedBoxId: string): void {
  if (element.kind === 'wire' && (element.from === removedBoxId || element.to === removedBoxId)) {
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

function applyOne(draft: Draft, op: Op, author: Author): OpOutcome {
  switch (op.op) {
    case 'add': return addElement(draft, op.element, author);
    case 'set': return setFields(draft, op.id, op.fields, author);
    case 'remove': return removeElement(draft, op.id);
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
    elementCount: boardIndexOf(board.elements).elementCount, strokeCount: boardIndexOf(board.elements).strokeCount, basePinPositions,
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

function nearTargetIdOf(op: Op): string | null {
  if (op.op === 'add') return op.element.kind === 'box' && op.element.at === null ? op.element.near?.of ?? null : null;
  if (op.op !== 'set' || 'at' in op.fields || !isRecord(op.fields.near)) return null;
  return typeof op.fields.near.of === 'string' ? op.fields.near.of : null;
}

function unplacedNearTargetIdsOf(board: Board, ops: readonly Op[]): string[] {
  return ops.flatMap((op) => {
    const targetId = nearTargetIdOf(op);
    const target = targetId === null ? undefined : board.elements.get(targetId);
    return targetId !== null && target?.kind === 'box' && target.at === null && !isStackedPanel(target) ? [targetId] : [];
  });
}

function applyOps(board: Board, ops: readonly Op[], author: Author, nowMs: number): ApplyResult {
  const isPinNeeded = unplacedNearTargetIdsOf(board, ops).length > 0;
  const basePinPositions = isPinNeeded ? pinPositionsOf(board) : null;
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
  if (op.op === 'set' || op.op === 'remove') return op.id;
  return null;
}

function nameOf(after: ElementLookup, id: string, element: Element | undefined = after(id)): string {
  if (!element) return id;
  if (element.kind === 'box' || element.kind === 'frame') return `"${element.title || id}"`;
  if (element.kind === 'wire') return `wire ${nameOf(after, element.from)} to ${nameOf(after, element.to)}`;
  return `${element.kind} ${id}`;
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
      if (element.kind === 'box' && element.shape === 'note') return `added note ${nameOf(after, element.id)}`;
      return `added ${element.kind} ${nameOf(after, element.id)}`;
    }
    case 'set': return describeSet(op, previous, after);
    case 'remove': return `removed ${previous?.kind ?? 'element'} ${nameOf(after, op.id, previous)}`;
    case 'board': return describeBoardOp(op);
  }
}

function createBoard({ id, title, nowMs, codeSessionId = null, project = null }: { id: string; title: string; nowMs: number; codeSessionId?: string | null; project?: string | null }): Board {
  return {
    id, title, version: 0, caption: null,
    legend: [],
    codeSessionId,
    project,
    elements: elementTableOf(),
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export { OPERATOR_AUTHOR, applyBoardDiff, applyOps, createBoard, noteBoxTextOf, stageOps, unplacedNearTargetIdsOf };
export type { ApplyResult, Author, PinPositions, StagedOps };
