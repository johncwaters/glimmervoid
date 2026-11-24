import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';

import { createLaneLog } from '../lanes/lane-log.ts';
import type { OpenStepLog } from './board-tile-service.ts';
import type { SavedLayoutWrite } from './layout-worker-core.ts';
import type { BoardOpenStep, TelemetryEventProperties } from '../../shared/contracts/telemetry.ts';

const SAVED_LAYOUT_QUEUED_STEP: BoardOpenStep = 'saved layout queued';

interface BoardOpenSteps extends OpenStepLog {
  logIfBoardLoaded(didLoadElements: boolean): void;
}

interface QueuedLayoutWrite {
  isOpenLogged: boolean;
  written: SavedLayoutWrite | null;
}

interface OpenStepLogs {
  openStepLogOf(boardId: string): BoardOpenSteps;
  logSavedLayoutWritten(written: SavedLayoutWrite): void;
}

type BoardOpenedReport = TelemetryEventProperties<'board_opened'>;

interface StepLine {
  step: BoardOpenStep;
  fields: Record<string, string | number>;
}

function numberField(stepLine: StepLine | undefined, field: string): number {
  const value = stepLine?.fields[field];
  return typeof value === 'number' ? value : 0;
}

function boardOpenedReportOf(stepLines: readonly StepLine[], totalMs: number): BoardOpenedReport | null {
  const [firstStep, ...laterSteps] = stepLines;
  if (!firstStep) return null;
  const slowest = laterSteps.reduce((current, candidate) => (numberField(candidate, 'ms') > numberField(current, 'ms') ? candidate : current), firstStep);
  const lastMainStep = stepLines.findLast((stepLine) => stepLine.fields.thread === 'main');
  return {
    total_ms: Math.max(0, Math.round(totalMs)),
    tile_count: numberField(stepLines.find((stepLine) => stepLine.step === 'tiles answered'), 'tiles'),
    saved_layout_hit: stepLines.some((stepLine) => stepLine.step === 'saved layout read'),
    slowest_step: slowest.step,
    slowest_step_ms: numberField(slowest, 'ms'),
    heap_mb: numberField(lastMainStep, 'heapMb'),
  };
}

function createOpenStepLogs(logger: Partial<Pick<Console, 'log'>>, reportBoardOpened: (report: BoardOpenedReport) => void = () => {}): OpenStepLogs {
  const openLog = createLaneLog({ prefix: '[whiteboard]', logger });
  const queuedWriteByBoardId = new Map<string, QueuedLayoutWrite>();

  function noteWritten(written: SavedLayoutWrite): void {
    queuedWriteByBoardId.delete(written.boardId);
    openLog.note('open saved layout written', { board: written.boardId, ms: Math.round(written.elapsedMs), heapMb: Math.round(written.heapBytes / 1_000_000), thread: 'layout-worker' });
  }

  function logSavedLayoutWritten(written: SavedLayoutWrite): void {
    const queued = queuedWriteByBoardId.get(written.boardId);
    if (!queued) return;
    if (queued.isOpenLogged) {
      noteWritten(written);
      return;
    }
    queued.written = written;
  }

  function openStepLogOf(boardId: string): BoardOpenSteps {
    const startedAt = performance.now();
    let previousStepAt = startedAt;
    let hasWorkerSteps = false;
    const stepLines: StepLine[] = [];

    function record(step: BoardOpenStep, thread: string, elapsedMs: number, heapBytes: number, fields: Record<string, number>): void {
      stepLines.push({ step, fields: { board: boardId, ms: Math.round(elapsedMs), heapMb: Math.round(heapBytes / 1_000_000), thread, ...fields } });
    }

    return {
      mark: (step, fields = {}) => {
        const stepAt = performance.now();
        record(step, 'main', stepAt - previousStepAt, v8.getHeapStatistics().used_heap_size, fields);
        previousStepAt = stepAt;
      },
      addWorkerSteps: (steps) => {
        hasWorkerSteps = hasWorkerSteps || steps.length > 0;
        if (steps.some((workerStep) => workerStep.step === SAVED_LAYOUT_QUEUED_STEP)) queuedWriteByBoardId.set(boardId, { isOpenLogged: false, written: null });
        for (const workerStep of steps) record(workerStep.step, 'layout-worker', workerStep.elapsedMs, workerStep.heapBytes, {});
      },
      logIfBoardLoaded: (didLoadElements) => {
        if (!didLoadElements && !hasWorkerSteps) return;
        for (const stepLine of stepLines) openLog.note(`open ${stepLine.step}`, stepLine.fields);
        const totalMs = performance.now() - startedAt;
        openLog.note('open done', { board: boardId, ms: Math.round(totalMs) });
        const report = boardOpenedReportOf(stepLines, totalMs);
        if (report) reportBoardOpened(report);
        const queued = queuedWriteByBoardId.get(boardId);
        if (!queued) return;
        queued.isOpenLogged = true;
        if (queued.written) noteWritten(queued.written);
      },
    };
  }

  return { openStepLogOf, logSavedLayoutWritten };
}

export { createOpenStepLogs };
