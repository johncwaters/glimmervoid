import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';

import { errorMessage } from '../../shared/text.ts';
import { layoutWorkerPath } from '../runtime-paths.ts';
import { codeStampOf } from './code-stamp.ts';
import { openLayoutCache } from './layout-cache.ts';
import { LayoutRequest, createLayoutHost } from './layout-worker-core.ts';
import type { OpenStep } from './layout-worker-core.ts';

function serve(): void {
  const port = parentPort;
  if (!port) throw new Error('the whiteboard layout runs only as a worker thread');
  const cachePath: unknown = workerData;
  let openSteps: OpenStep[] = [];
  let previousStepAt = performance.now();
  function markStep(step: string): void {
    const now = performance.now();
    openSteps.push({ step, elapsedMs: now - previousStepAt, heapBytes: v8.getHeapStatistics().used_heap_size });
    previousStepAt = now;
  }
  const host = createLayoutHost(openLayoutCache(typeof cachePath === 'string' ? cachePath : null, codeStampOf(layoutWorkerPath)), markStep);
  port.on('message', (message: unknown) => {
    const parsed = LayoutRequest.safeParse(message);
    if (!parsed.success) {
      const requestId: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'requestId') : null;
      port.postMessage({ requestId: typeof requestId === 'number' ? requestId : -1, ok: false, error: 'the whiteboard layout refused a malformed request' });
      return;
    }
    const { requestId, ...request } = parsed.data;
    openSteps = [];
    previousStepAt = performance.now();
    try {
      const answer = host.handle(request);
      port.postMessage({ requestId, ok: true, ...answer, ...(openSteps.length > 0 ? { openSteps } : {}) });
    } catch (error) {
      port.postMessage({ requestId, ok: false, error: errorMessage(error) });
    }
  });
}

serve();
