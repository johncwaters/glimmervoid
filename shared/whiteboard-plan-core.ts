import type { Board, Box, Step, Wire } from './contracts/whiteboard.ts';
import { boardIndexOf } from './whiteboard-board-index.ts';

type StepBox = Box & { step: Step };
type PlanStep = { boxId: string; title: string; status: Step['status']; level: number; label: string; afterLabels: string[]; linkedBoardId: string | null };

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

function dependencyWiresInto(board: Board, stepId: string, stepIds: ReadonlySet<string>): Wire[] {
  return [...boardIndexOf(board.elements).dependentIdsByBoxId.get(stepId) ?? []].flatMap((dependentId) => {
    const element = board.elements.get(dependentId);
    return element?.kind === 'wire' && element.to === stepId && element.from !== stepId && stepIds.has(element.from) ? [element] : [];
  });
}

function afterIdsByStepIdOf(board: Board, stepIds: ReadonlySet<string>): Map<string, string[]> {
  const afterIdsByStepId = new Map<string, string[]>();
  for (const stepId of stepIds) {
    const afterIds = dependencyWiresInto(board, stepId, stepIds).map((wire) => wire.from);
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

function planSteps(board: Board): PlanStep[] {
  const steps = stepBoxesOf(board);
  const afterIdsByStepId = afterIdsByStepIdOf(board, new Set(steps.map((step) => step.id)));
  const levelById = levelsOf(steps.map((step) => step.id), afterIdsByStepId);
  const stepsByLevel = new Map<number, StepBox[]>();
  for (const step of steps) {
    const level = levelById.get(step.id) ?? 1;
    stepsByLevel.set(level, [...(stepsByLevel.get(level) ?? []), step]);
  }
  const labelById = new Map<string, string>();
  const orderedSteps: StepBox[] = [];
  for (const level of [...stepsByLevel.keys()].sort((left, right) => left - right)) {
    const stepsAtLevel = (stepsByLevel.get(level) ?? []).sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    for (const [index, step] of stepsAtLevel.entries()) {
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
    linkedBoardId: step.step.linkedBoardId,
  }));
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
  return dependencyWiresInto(board, stepId, boardIndexOf(board.elements).stepBoxIds).map((wire) => wire.id);
}

export { dependencyWireId, dependencyWireIdsInto, planSteps, stepBoxesOf };
export type { PlanStep, StepBox };
