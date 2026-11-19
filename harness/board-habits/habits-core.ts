import { z } from 'zod';

const CARD_WORDS_MAX = 24;
const CHANGE_ACTIONS = new Set(['put', 'show']);
const LOOK_ACTIONS = new Set(['view', 'render']);
const READ_ACTIONS = new Set(['get', 'query', 'view']);
const CLI_BOARD_ACTION = /\bglimmervoid\s+(?:whiteboard\s+(\w+)|(show)\b)/;

const ToolCall = z.object({ name: z.string(), input: z.unknown(), isError: z.boolean(), resultText: z.string() });
const TurnResult = z.object({ ok: z.boolean(), costUsd: z.number(), text: z.string(), toolCalls: z.array(ToolCall) });
const ResultLine = z.object({ text: z.string() }).loose();
const ResultElement = z.object({
  kind: z.string(),
  id: z.string(),
  title: z.string().optional(),
  icon: z.string().nullish(),
  shape: z.string().optional(),
  lines: z.array(ResultLine).optional(),
  media: z.object({ source: z.object({ path: z.string().optional() }).loose().nullish() }).loose().nullish(),
}).loose();
const ResultBoard = z.object({ id: z.string(), elements: z.union([z.record(z.string(), ResultElement), z.array(ResultElement)]) }).loose();
export const TrialResult = z.object({
  arm: z.string(),
  task: z.string(),
  trialIndex: z.number().int(),
  turnResults: z.array(TurnResult),
  boards: z.array(ResultBoard.nullable()),
  operatorEditBoxId: z.string().nullable(),
});

export type ToolCall = z.infer<typeof ToolCall>;
export type TurnResult = z.infer<typeof TurnResult>;
export type TrialResult = z.infer<typeof TrialResult>;
type ResultElement = z.infer<typeof ResultElement>;

export interface HabitScores {
  viewedAfterChange: number | null;
  readBeforeChange: number | null;
  boardsCreated: number;
  newCalls: number;
  duplicateFileCards: number;
  refusedPuts: number;
  operatorEditKept: number | null;
  attachCalls: number;
  showCalls: number;
  wordyBoxes: number;
  pictorialShare: number;
  costUsd: number;
}

const SCORE_COLUMNS: readonly (keyof HabitScores)[] = ['viewedAfterChange', 'readBeforeChange', 'boardsCreated', 'newCalls', 'duplicateFileCards', 'refusedPuts', 'operatorEditKept', 'attachCalls', 'showCalls', 'wordyBoxes', 'pictorialShare', 'costUsd'];

function stringFieldOf(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null || !(field in input)) return null;
  const value: unknown = Reflect.get(input, field);
  return typeof value === 'string' ? value : null;
}

export function boardActionOf(call: ToolCall): string | null {
  if (call.name === 'mcp__glimmervoid__whiteboard') return stringFieldOf(call.input, 'action');
  if (call.name === 'mcp__glimmervoid__show') return 'show';
  if (call.name !== 'Bash') return null;
  const match = CLI_BOARD_ACTION.exec(stringFieldOf(call.input, 'command') ?? '');
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function isRefused(call: ToolCall): boolean {
  return call.isError || call.resultText.includes('"ok":false');
}

function shareOf(hits: number, total: number): number | null {
  return total === 0 ? null : hits / total;
}

function viewedAfterChangeOf(turns: readonly TurnResult[]): number | null {
  const changingTurns = turns.map((turn) => turn.toolCalls.map((call) => ({ action: boardActionOf(call), isRefused: isRefused(call) })))
    .filter((actions) => actions.some(({ action, isRefused: refused }) => action !== null && CHANGE_ACTIONS.has(action) && !refused));
  const lookedTurns = changingTurns.filter((actions) => {
    const lastChangeIndex = actions.findLastIndex(({ action, isRefused: refused }) => action !== null && CHANGE_ACTIONS.has(action) && !refused);
    return actions.slice(lastChangeIndex + 1).some(({ action }) => action !== null && LOOK_ACTIONS.has(action));
  });
  return shareOf(lookedTurns.length, changingTurns.length);
}

function readBeforeChangeOf(turns: readonly TurnResult[]): number | null {
  const followUpActions = turns.slice(1).map((turn) => turn.toolCalls.map(boardActionOf));
  const changingTurns = followUpActions.filter((actions) => actions.some((action) => action !== null && CHANGE_ACTIONS.has(action)));
  const readFirstTurns = changingTurns.filter((actions) => {
    const firstChangeIndex = actions.findIndex((action) => action !== null && CHANGE_ACTIONS.has(action));
    return actions.slice(0, firstChangeIndex).some((action) => action !== null && READ_ACTIONS.has(action));
  });
  return shareOf(readFirstTurns.length, changingTurns.length);
}

function elementsOf(trial: TrialResult): ResultElement[] {
  return trial.boards.flatMap((board) => (board === null ? [] : Array.isArray(board.elements) ? board.elements : Object.values(board.elements)));
}

function wordCountOf(box: ResultElement): number {
  const text = [box.title ?? '', ...(box.lines ?? []).map((line) => line.text)].join(' ');
  return text.split(/\s+/).filter(Boolean).length;
}

export function habitScoresOf(trial: TrialResult): HabitScores {
  const calls = trial.turnResults.flatMap((turn) => turn.toolCalls);
  const actions = calls.map((call) => ({ action: boardActionOf(call), isRefused: isRefused(call) }));
  const countOf = (wanted: string) => actions.filter(({ action, isRefused: refused }) => action === wanted && !refused).length;
  const elements = elementsOf(trial);
  const boxes = elements.filter((element) => element.kind === 'box');
  const sourceNames = boxes.flatMap((box) => {
    const sourcePath = box.media?.source?.path;
    return sourcePath ? [sourcePath.split(/[\\/]/).at(-1) ?? sourcePath] : [];
  });
  const pictorialBoxes = boxes.filter((box) => box.icon || box.media || (box.shape ?? 'box') !== 'box');
  return {
    viewedAfterChange: viewedAfterChangeOf(trial.turnResults),
    readBeforeChange: readBeforeChangeOf(trial.turnResults),
    boardsCreated: trial.boards.filter((board) => board !== null).length,
    newCalls: countOf('new'),
    duplicateFileCards: sourceNames.length - new Set(sourceNames).size,
    refusedPuts: actions.filter(({ action, isRefused: refused }) => action === 'put' && refused).length,
    operatorEditKept: trial.operatorEditBoxId === null ? null : Number(elements.some((element) => element.id === trial.operatorEditBoxId)),
    attachCalls: countOf('attach'),
    showCalls: countOf('show'),
    wordyBoxes: boxes.filter((box) => wordCountOf(box) > CARD_WORDS_MAX).length,
    pictorialShare: boxes.length === 0 ? 0 : pictorialBoxes.length / boxes.length,
    costUsd: trial.turnResults.reduce((sum, turn) => sum + turn.costUsd, 0),
  };
}

function meanOf(values: readonly (number | null)[]): string {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return '-';
  return (present.reduce((sum, value) => sum + value, 0) / present.length).toFixed(2);
}

export function habitTableOf(trials: readonly TrialResult[]): string {
  const scoresByGroup = new Map<string, HabitScores[]>();
  const failedCountByGroup = new Map<string, number>();
  for (const trial of trials) {
    const groupKey = `${trial.task} | ${trial.arm}`;
    const scoreList = scoresByGroup.get(groupKey) ?? [];
    scoresByGroup.set(groupKey, scoreList);
    if (trial.turnResults.some((turn) => !turn.ok)) {
      failedCountByGroup.set(groupKey, (failedCountByGroup.get(groupKey) ?? 0) + 1);
      continue;
    }
    scoreList.push(habitScoresOf(trial));
  }
  const header = `| task | arm | n | ${SCORE_COLUMNS.join(' | ')} | failed |`;
  const divider = `|${' --- |'.repeat(SCORE_COLUMNS.length + 4)}`;
  const rows = [...scoresByGroup].sort(([left], [right]) => left.localeCompare(right))
    .map(([groupKey, scoreList]) => `| ${groupKey} | ${scoreList.length} | ${SCORE_COLUMNS.map((column) => meanOf(scoreList.map((scores) => scores[column]))).join(' | ')} | ${failedCountByGroup.get(groupKey) ?? 0} |`);
  return [header, divider, ...rows].join('\n');
}
