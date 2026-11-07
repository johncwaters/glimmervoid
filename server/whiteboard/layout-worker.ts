import { parentPort, workerData } from 'node:worker_threads';

import { errorMessage } from '../../shared/text.ts';
import { layoutWorkerPath } from '../runtime-paths.ts';
import { codeStampOf } from './code-stamp.ts';
import { openLayoutCache } from './layout-cache.ts';
import { LayoutRequest, createLayoutHost } from './layout-worker-core.ts';

function serve(): void {
  const port = parentPort;
  if (!port) throw new Error('the whiteboard layout runs only as a worker thread');
  const cachePath: unknown = workerData;
  const host = createLayoutHost(openLayoutCache(typeof cachePath === 'string' ? cachePath : null, codeStampOf(layoutWorkerPath)));
  port.on('message', (message: unknown) => {
    const parsed = LayoutRequest.safeParse(message);
    if (!parsed.success) {
      const requestId: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'requestId') : null;
      port.postMessage({ requestId: typeof requestId === 'number' ? requestId : -1, ok: false, error: 'the whiteboard layout refused a malformed request' });
      return;
    }
    const { requestId, ...request } = parsed.data;
    try {
      port.postMessage({ requestId, ok: true, ...host.handle(request) });
    } catch (error) {
      port.postMessage({ requestId, ok: false, error: errorMessage(error) });
    }
  });
}

serve();
