import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';

import { createLaneLog } from '../lanes/lane-log.ts';
import type { OpenStepLog } from './board-tile-service.ts';

interface BoardOpenSteps extends OpenStepLog {
  logIfBoardLoaded(didLoadElements: boolean): void;
}

function createOpenStepLogs(logger: Partial<Pick<Console, 'log'>>): (boardId: string) => BoardOpenSteps {
  const openLog = createLaneLog({ prefix: '[whiteboard]', logger });

  return (boardId) => {
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
        for (const workerStep of steps) record(workerStep.step, 'layout-worker', workerStep.elapsedMs, workerStep.heapBytes, {});
      },
      logIfBoardLoaded: (didLoadElements) => {
        if (!didLoadElements && !hasWorkerSteps) return;
        for (const stepLine of stepLines) openLog.note(`open ${stepLine.step}`, stepLine.fields);
        openLog.note('open done', { board: boardId, ms: Math.round(performance.now() - startedAt) });
      },
    };
  };
}

export { createOpenStepLogs };
