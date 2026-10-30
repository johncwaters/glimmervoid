import type { Board, Unit } from './contracts/whiteboard.ts';

type PlanStep = { unitId: string; title: string; label: string; afterLabels: string[]; linkedBoardId: string | null };

const LETTERS_IN_ALPHABET = 26;
const FIRST_LETTER_CODE = 97;

function unitsOf(board: Board): Unit[] {
  return Object.values(board.elements).filter((element): element is Unit => element.kind === 'unit');
}

function letterFor(index: number): string {
  const letter = String.fromCharCode(FIRST_LETTER_CODE + (index % LETTERS_IN_ALPHABET));
  const round = Math.floor(index / LETTERS_IN_ALPHABET);
  return round === 0 ? letter : `${letter}${round + 1}`;
}

function levelsOf(units: readonly Unit[]): Map<string, number> {
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const levelById = new Map<string, number>();
  const visiting = new Set<string>();
  function levelOf(unitId: string): number {
    const known = levelById.get(unitId);
    if (known !== undefined) return known;
    const unit = unitById.get(unitId);
    if (!unit || visiting.has(unitId)) return 0;
    visiting.add(unitId);
    const level = 1 + Math.max(0, ...unit.after.map(levelOf));
    visiting.delete(unitId);
    levelById.set(unitId, level);
    return level;
  }
  for (const unit of units) levelOf(unit.id);
  return levelById;
}

function planSteps(board: Board): PlanStep[] {
  const units = unitsOf(board);
  const levelById = levelsOf(units);
  const unitsByLevel = new Map<number, Unit[]>();
  for (const unit of units) {
    const level = levelById.get(unit.id) ?? 1;
    unitsByLevel.set(level, [...(unitsByLevel.get(level) ?? []), unit]);
  }
  const labelById = new Map<string, string>();
  const orderedUnits: Unit[] = [];
  for (const level of [...unitsByLevel.keys()].sort((left, right) => left - right)) {
    const unitsAtLevel = (unitsByLevel.get(level) ?? []).sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    for (const [index, unit] of unitsAtLevel.entries()) {
      labelById.set(unit.id, unitsAtLevel.length === 1 ? String(level) : `${level}${letterFor(index)}`);
      orderedUnits.push(unit);
    }
  }
  return orderedUnits.map((unit) => ({
    unitId: unit.id,
    title: unit.title,
    label: labelById.get(unit.id) ?? '',
    afterLabels: unit.after.flatMap((afterId) => labelById.get(afterId) ?? []),
    linkedBoardId: unit.linkedBoardId,
  }));
}

function findDependencyCycle(board: Board): string[] | null {
  const unitById = new Map(unitsOf(board).map((unit) => [unit.id, unit]));
  const finished = new Set<string>();
  const path: string[] = [];
  function walk(unitId: string): string[] | null {
    const loopStart = path.indexOf(unitId);
    if (loopStart !== -1) return [...path.slice(loopStart), unitId];
    if (finished.has(unitId)) return null;
    path.push(unitId);
    for (const afterId of unitById.get(unitId)?.after ?? []) {
      const cycle = walk(afterId);
      if (cycle) return cycle;
    }
    path.pop();
    finished.add(unitId);
    return null;
  }
  for (const unitId of unitById.keys()) {
    const cycle = walk(unitId);
    if (cycle) return cycle;
  }
  return null;
}

export { findDependencyCycle, planSteps, unitsOf };
