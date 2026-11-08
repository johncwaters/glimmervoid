import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';

import { createLaneLog } from '../lanes/lane-log.ts';
import type { OpenStepLog } from './board-tile-service.ts';
import type { SavedLayoutWrite } from './layout-worker-core.ts';

const SAVED_LAYOUT_QUEUED_STEP = 'saved layout queued';

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

function createOpenStepLogs(logger: Partial<Pick<Console, 'log'>>): OpenStepLogs {
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
    const stepLines: { step: string; fields: Record<string, string | number> }[] = [];

    function record(step: string, thread: string, elapsedMs: number, heapBytes: number, fields: Record<string, number>): void {
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
        openLog.note('open done', { board: boardId, ms: Math.round(performance.now() - startedAt) });
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
