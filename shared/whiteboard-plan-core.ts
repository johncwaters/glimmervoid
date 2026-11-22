import { boxIdOfEnd } from './whiteboard-constants.ts';
import type { Board, Box, Step, Wire } from './contracts/whiteboard.ts';
import { boardIndexOf } from './whiteboard-board-index.ts';

type StepBox = Box & { step: Step };
type PlanStep = { boxId: string; title: string; status: Step['status']; level: number; label: string; afterLabels: string[] };

const LETTERS_IN_ALPHABET = 26;
const MAX_ELEMENT_ID_LENGTH = 40;
const FIRST_LETTER_CODE = 97;

function isStepBox(box: Box): box is StepBox {
  return box.step !== null;
}

function stepBoxesOf(board: Board): StepBox[] {
  return [...boardIndexOf(board.elements).stepBoxIds].flatMap((id) => {
    const element = board.elements.get(id);
    return element?.kind === 'box' && isStepBox(element) ? [element] : [];
  });
}

interface DependencyWire {
  wire: Wire;
  afterId: string;
}

function dependencyWiresInto(board: Board, stepId: string, stepIds: ReadonlySet<string>): DependencyWire[] {
  return [...boardIndexOf(board.elements).dependentIdsByBoxId.get(stepId) ?? []].flatMap((dependentId) => {
    const element = board.elements.get(dependentId);
    if (element?.kind !== 'wire' || boxIdOfEnd(element.to) !== stepId) return [];
    const afterId = boxIdOfEnd(element.from);
    return afterId !== null && afterId !== stepId && stepIds.has(afterId) ? [{ wire: element, afterId }] : [];
  });
}

function afterIdsByStepIdOf(board: Board, stepIds: ReadonlySet<string>): Map<string, string[]> {
  const afterIdsByStepId = new Map<string, string[]>();
  for (const stepId of stepIds) {
    const afterIds = dependencyWiresInto(board, stepId, stepIds).map((dependency) => dependency.afterId);
    if (afterIds.length > 0) afterIdsByStepId.set(stepId, afterIds);
  }
  return afterIdsByStepId;
}

function letterFor(index: number): string {
  const letter = String.fromCharCode(FIRST_LETTER_CODE + (index % LETTERS_IN_ALPHABET));
  const round = Math.floor(index / LETTERS_IN_ALPHABET);
  return round === 0 ? letter : `${letter}${round + 1}`;
}

function levelsOf(stepIds: readonly string[], afterIdsByStepId: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const levelById = new Map<string, number>();
  const visiting = new Set<string>();
  function levelOf(stepId: string): number {
    const known = levelById.get(stepId);
    if (known !== undefined) return known;
    if (visiting.has(stepId)) return 0;
    visiting.add(stepId);
    const level = 1 + Math.max(0, ...(afterIdsByStepId.get(stepId) ?? []).map(levelOf));
    visiting.delete(stepId);
    levelById.set(stepId, level);
    return level;
  }
  for (const stepId of stepIds) levelOf(stepId);
  return levelById;
}

function barycenterOf(stepId: string, afterIdsByStepId: ReadonlyMap<string, readonly string[]>, rowById: ReadonlyMap<string, number>): number {
  const afterRows = (afterIdsByStepId.get(stepId) ?? []).flatMap((afterId) => rowById.get(afterId) ?? []);
  if (afterRows.length === 0) return Number.MAX_VALUE;
  return afterRows.reduce((sum, row) => sum + row, 0) / afterRows.length;
}

function inBarycenterOrder(stepsAtLevel: StepBox[], afterIdsByStepId: ReadonlyMap<string, readonly string[]>, rowById: ReadonlyMap<string, number>): StepBox[] {
  const barycenterById = new Map(stepsAtLevel.map((step) => [step.id, barycenterOf(step.id, afterIdsByStepId, rowById)]));
  const barycenterOfStep = (step: StepBox) => barycenterById.get(step.id) ?? Number.MAX_VALUE;
  return stepsAtLevel.sort((left, right) => barycenterOfStep(left) - barycenterOfStep(right) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function planSteps(board: Board): PlanStep[] {
  const steps = stepBoxesOf(board);
  const afterIdsByStepId = afterIdsByStepIdOf(board, new Set(steps.map((step) => step.id)));
  const levelById = levelsOf(steps.map((step) => step.id), afterIdsByStepId);
  const stepsByLevel = new Map<number, StepBox[]>();
  for (const step of steps) {
    const level = levelById.get(step.id) ?? 1;
    const stepsAtLevel = stepsByLevel.get(level);
    if (stepsAtLevel) {
      stepsAtLevel.push(step);
      continue;
    }
    stepsByLevel.set(level, [step]);
  }
  const labelById = new Map<string, string>();
  const rowById = new Map<string, number>();
  const orderedSteps: StepBox[] = [];
  for (const level of [...stepsByLevel.keys()].sort((left, right) => left - right)) {
    const stepsAtLevel = inBarycenterOrder(stepsByLevel.get(level) ?? [], afterIdsByStepId, rowById);
    for (const [index, step] of stepsAtLevel.entries()) {
      rowById.set(step.id, index);
      labelById.set(step.id, stepsAtLevel.length === 1 ? String(level) : `${level}${letterFor(index)}`);
      orderedSteps.push(step);
    }
  }
  return orderedSteps.map((step) => ({
    boxId: step.id,
    title: step.title,
    status: step.step.status,
    level: levelById.get(step.id) ?? 1,
    label: labelById.get(step.id) ?? '',
    afterLabels: (afterIdsByStepId.get(step.id) ?? []).flatMap((afterId) => labelById.get(afterId) ?? []),
  }));
}

type ReadySteps = { ready: StepBox[] } | { cycle: string[] };

function cycleThrough(stepIds: readonly string[], afterIdsByStepId: ReadonlyMap<string, readonly string[]>): string[] | null {
  const finishedIds = new Set<string>();
  const visitingPath: string[] = [];
  function visit(stepId: string): string[] | null {
    if (finishedIds.has(stepId)) return null;
    const visitingIndex = visitingPath.indexOf(stepId);
    if (visitingIndex !== -1) return visitingPath.slice(visitingIndex);
    visitingPath.push(stepId);
    for (const afterId of afterIdsByStepId.get(stepId) ?? []) {
      const cycle = visit(afterId);
      if (cycle !== null) return cycle;
    }
    visitingPath.pop();
    finishedIds.add(stepId);
    return null;
  }
  for (const stepId of stepIds) {
    const cycle = visit(stepId);
    if (cycle !== null) return cycle;
  }
  return null;
}

function readySteps(board: Board): ReadySteps {
  const steps = stepBoxesOf(board);
  const statusById = new Map(steps.map((step) => [step.id, step.step.status]));
  const afterIdsByStepId = afterIdsByStepIdOf(board, new Set(statusById.keys()));
  const cycle = cycleThrough([...statusById.keys()], afterIdsByStepId);
  if (cycle !== null) return { cycle };
  const hasLanded = (stepId: string) => statusById.get(stepId) === 'landed';
  return { ready: steps.filter((step) => step.step.status === 'planned' && (afterIdsByStepId.get(step.id) ?? []).every(hasLanded)) };
}

function dependencyWireId(fromId: string, toId: string, takenIds: ReadonlySet<string>): string {
  const base = `${fromId}-to-${toId}`.slice(0, MAX_ELEMENT_ID_LENGTH).replace(/-+$/, '');
  if (!takenIds.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, MAX_ELEMENT_ID_LENGTH - ending.length).replace(/-+$/, '')}${ending}`;
    if (!takenIds.has(candidate)) return candidate;
  }
}

function dependencyWireIdsInto(board: Board, stepId: string): string[] {
  return dependencyWiresInto(board, stepId, boardIndexOf(board.elements).stepBoxIds).map((dependency) => dependency.wire.id);
}

export { dependencyWireId, dependencyWireIdsInto, planSteps, readySteps, stepBoxesOf };
export type { PlanStep, StepBox };
