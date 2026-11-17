import type { Board, BoardSummary, Step } from '../shared/contracts/whiteboard.ts';
import { readySteps, stepBoxesOf } from '../shared/whiteboard-plan-core.ts';
import type { StepBox } from '../shared/whiteboard-plan-core.ts';
import { createKeyedSerialQueue } from './spawn-gate.ts';
import type { WhiteboardReply } from './whiteboard/whiteboard-wiring.ts';

type StepStatus = Step['status'];
type PlanBoardRead = { ok: true; board: Board; summary: BoardSummary } | { ok: false; reply: WhiteboardReply };
type SpawnedStep = { ok: true; childId: string; childName: string; onLanded: (listener: () => void) => void } | { ok: false; error: string };

interface PlanRunPorts {
  readPlanBoard(boardRef: string): Promise<PlanBoardRead>;
  setStepStatus(boardId: string, stepId: string, status: StepStatus): Promise<void>;
  spawnStep(name: string, prompt: string): Promise<SpawnedStep>;
  isLive(sessionId: string): boolean;
  tellRunner(text: string): void;
}

type StartedSteps = { reply: WhiteboardReply; problem: string | null };

interface PlanRuns {
  run(boardRef: string, ports: PlanRunPorts): Promise<WhiteboardReply>;
}

function stepPrompt(board: Board, step: StepBox): string {
  const detailLines = step.lines.map((line) => `- ${line.text}`);
  const refLines = step.refs.length > 0 ? [`Code it points at: ${step.refs.join(', ')}`] : [];
  return [
    `Build the plan step "${step.title}" (${step.id}) from the whiteboard "${board.title}" (${board.id}).`,
    ...detailLines,
    ...refLines,
    'Every step it comes after has landed. When this step is done and verified, land it with glimmervoid push; Glimmervoid then marks the step landed and starts the steps waiting on it.',
  ].join('\n');
}

function describeRun(board: Board, startedLines: readonly string[], spawnRefusal: string | null, waitingCount: number): string {
  const steps = stepBoxesOf(board);
  const landedCount = steps.filter((step) => step.step.status === 'landed').length;
  if (steps.length === 0) return `"${board.title}" has no plan steps; add one with glimmervoid whiteboard plan add ${board.id} <title>`;
  const startedText = startedLines.length > 0 ? `started ${startedLines.join(', ')}` : 'started no step';
  const progressText = `${landedCount} of ${steps.length} steps landed`;
  if (spawnRefusal !== null) return `${startedText}; ${waitingCount} ready ${waitingCount === 1 ? 'step waits' : 'steps wait'} because the spawn was refused (${spawnRefusal}), so run glimmervoid whiteboard run ${board.id} again once a spawned session closes; ${progressText}`;
  if (landedCount === steps.length) return `every step of "${board.title}" has landed`;
  return `${startedText}; each step is marked landed when its session's work merges, which starts the steps waiting on it; ${progressText}`;
}

function createPlanRuns({ warn }: { warn: (message: string) => void }): PlanRuns {
  const runsByBoardId = createKeyedSerialQueue();
  const childIdByStepKey = new Map<string, string>();
  const promptByStepIdByBoardId = new Map<string, Map<string, string>>();
  const stepKeyOf = (boardId: string, stepId: string) => JSON.stringify([boardId, stepId]);

  async function reopenAbandonedSteps(board: Board, ports: PlanRunPorts): Promise<boolean> {
    let hasReopened = false;
    for (const step of stepBoxesOf(board)) {
      const stepKey = stepKeyOf(board.id, step.id);
      const childId = childIdByStepKey.get(stepKey);
      if (childId !== undefined && ports.isLive(childId)) continue;
      childIdByStepKey.delete(stepKey);
      if (step.step.status !== 'building') continue;
      await ports.setStepStatus(board.id, step.id, 'planned');
      hasReopened = true;
    }
    return hasReopened;
  }

  function landStep(boardId: string, stepId: string, ports: PlanRunPorts): void {
    childIdByStepKey.delete(stepKeyOf(boardId, stepId));
    runsByBoardId.run(boardId, async () => {
      await ports.setStepStatus(boardId, stepId, 'landed');
      const started = await startReadySteps(boardId, ports, promptByStepIdByBoardId.get(boardId) ?? new Map());
      if (started.problem !== null) ports.tellRunner(`The plan step ${stepId} landed, but the steps after it did not all start: ${started.problem}`);
    }).catch((error: unknown) => warn(`[plan run ${boardId}] could not advance after ${stepId} landed: ${String(error)}`));
  }

  async function startReadySteps(boardId: string, ports: PlanRunPorts, authorizedPromptByStepId: ReadonlyMap<string, string>): Promise<StartedSteps> {
    const firstRead = await ports.readPlanBoard(boardId);
    if (!firstRead.ok) return { reply: firstRead.reply, problem: 'the board could not be read' };
    const read = await reopenAbandonedSteps(firstRead.board, ports) ? await ports.readPlanBoard(boardId) : firstRead;
    if (!read.ok) return { reply: read.reply, problem: 'the board could not be read' };
    const plan = readySteps(read.board);
    if ('cycle' in plan) return refusedLoop(read.board, plan.cycle);
    const authorizedSteps = plan.ready.filter((step) => authorizedPromptByStepId.get(step.id) === stepPrompt(read.board, step));
    const startedLines: string[] = [];
    for (const [index, step] of authorizedSteps.entries()) {
      const spawned = await ports.spawnStep(step.title, stepPrompt(read.board, step));
      if (!spawned.ok) return { reply: { status: 200, body: { ok: true, board: read.summary, note: describeRun(read.board, startedLines, spawned.error, authorizedSteps.length - index) } }, problem: spawned.error };
      childIdByStepKey.set(stepKeyOf(boardId, step.id), spawned.childId);
      await ports.setStepStatus(boardId, step.id, 'building');
      spawned.onLanded(() => landStep(boardId, step.id, ports));
      startedLines.push(`${step.id} in session ${spawned.childName} (${spawned.childId})`);
    }
    const settled = startedLines.length > 0 ? await ports.readPlanBoard(boardId) : read;
    return { reply: { status: 200, body: { ok: true, board: settled.ok ? settled.summary : read.summary, note: describeRun(settled.ok ? settled.board : read.board, startedLines, null, 0) } }, problem: null };
  }

  function refusedLoop(board: Board, cycle: readonly string[]): StartedSteps {
    const error = `the plan on "${board.title}" never finishes, because its steps wait on each other in a loop: ${[...cycle, cycle[0]].join(' waits on ')}; remove one of those wires first`;
    return { reply: { status: 409, body: { ok: false, error } }, problem: error };
  }

  async function run(boardRef: string, ports: PlanRunPorts): Promise<WhiteboardReply> {
    const located = await ports.readPlanBoard(boardRef);
    if (!located.ok) return located.reply;
    const boardId = located.board.id;
    return runsByBoardId.run(boardId, async () => {
      const current = await ports.readPlanBoard(boardId);
      if (!current.ok) return current.reply;
      const authorizedPromptByStepId = new Map(stepBoxesOf(current.board).map((step) => [step.id, stepPrompt(current.board, step)]));
      promptByStepIdByBoardId.set(boardId, authorizedPromptByStepId);
      return (await startReadySteps(boardId, ports, authorizedPromptByStepId)).reply;
    });
  }

  return { run };
}

export { createPlanRuns };
export type { PlanRunPorts };
