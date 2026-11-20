import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import v8 from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { errorMessage } from '../../shared/text.ts';
import { layoutWorkerPath } from '../runtime-paths.ts';
import { codeStampOf } from './code-stamp.ts';
import { openLayoutCache } from './layout-cache.ts';
import { LayoutRequest, boardIdOfRequest, createLayoutHost } from './layout-worker-core.ts';
import type { AnswerFields, OpenStep } from './layout-worker-core.ts';

interface LayoutJob {
  requestId: number;
  steps: Generator<void, AnswerFields>;
  openSteps: OpenStep[];
  previousStepAt: number;
}

function workerPort(): MessagePort {
  if (!parentPort) throw new Error('the whiteboard layout runs only as a worker thread');
  return parentPort;
}

function serve(): void {
  const port = workerPort();
  const cachePath: unknown = workerData;
  const jobsByBoardId = new Map<string, LayoutJob[]>();
  let runningJob: LayoutJob | null = null;
  function markStep(step: string): void {
    if (!runningJob) return;
    const now = performance.now();
    runningJob.openSteps.push({ step, elapsedMs: now - runningJob.previousStepAt, heapBytes: v8.getHeapStatistics().used_heap_size });
    runningJob.previousStepAt = now;
  }
  const cache = openLayoutCache(typeof cachePath === 'string' ? cachePath : null, codeStampOf(layoutWorkerPath), ({ boardId, elapsedMs }) => {
    port.postMessage({ savedLayoutWritten: { boardId, elapsedMs, heapBytes: v8.getHeapStatistics().used_heap_size } });
  });
  const host = createLayoutHost(cache, markStep, yieldToEventLoop);
  function isJobFinished(job: LayoutJob): boolean {
    runningJob = job;
    try {
      const step = job.steps.next();
      if (!step.done) return false;
      port.postMessage({ requestId: job.requestId, ok: true, ...step.value, ...(job.openSteps.length > 0 ? { openSteps: job.openSteps } : {}) });
      return true;
    } catch (error) {
      port.postMessage({ requestId: job.requestId, ok: false, error: errorMessage(error) });
      return true;
    } finally {
      runningJob = null;
    }
  }
  function stepFrontJob(boardId: string, jobs: LayoutJob[]): void {
    const [front] = jobs;
    if (front && isJobFinished(front)) jobs.shift();
    if (jobs.length === 0) jobsByBoardId.delete(boardId);
  }
  let isSliceScheduled = false;
  function runQueuedSlices(): void {
    for (const [boardId, jobs] of jobsByBoardId) stepFrontJob(boardId, jobs);
    isSliceScheduled = cache.runQueuedSlice((boardId) => jobsByBoardId.has(boardId)) || jobsByBoardId.size > 0;
    if (isSliceScheduled) setImmediate(runQueuedSlices);
  }
  function scheduleQueuedSlices(): void {
    if (isSliceScheduled) return;
    isSliceScheduled = true;
    setImmediate(runQueuedSlices);
  }
  port.on('message', (message: unknown) => {
    const parsed = LayoutRequest.safeParse(message);
    if (!parsed.success) {
      const requestId: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'requestId') : null;
      port.postMessage({ requestId: typeof requestId === 'number' ? requestId : -1, ok: false, error: 'the whiteboard layout refused a malformed request' });
      return;
    }
    const { requestId, ...request } = parsed.data;
    const boardId = boardIdOfRequest(request);
    const job: LayoutJob = { requestId, steps: host.handling(request), openSteps: [], previousStepAt: performance.now() };
    const waitingJobs = jobsByBoardId.get(boardId);
    if (waitingJobs) waitingJobs.push(job);
    if (!waitingJobs) {
      const jobs = [job];
      jobsByBoardId.set(boardId, jobs);
      stepFrontJob(boardId, jobs);
    }
    scheduleQueuedSlices();
  });
}

serve();
