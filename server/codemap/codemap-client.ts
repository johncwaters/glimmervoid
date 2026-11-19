import { Worker } from 'node:worker_threads';
import { z } from 'zod';

import { CodemapExtract } from '../../shared/contracts/codemap.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import { codemapWorkerPath } from '../runtime-paths.ts';

const ExtractPhase = z.strictObject({ phase: z.string(), elapsedMs: z.number(), heapBytes: z.number(), rssBytes: z.number() });
type ExtractPhase = z.infer<typeof ExtractPhase>;

const ExtractReply = z.union([
  z.strictObject({ ok: z.literal(true), extract: CodemapExtract }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);

interface CodemapClient {
  extract(repoDir: string, sha: string): Promise<CodemapExtract>;
}

function createCodemapClient({ onPhase = () => {} }: { onPhase?: (phase: ExtractPhase) => void } = {}): CodemapClient {
  const runningByKey = new Map<string, Promise<CodemapExtract>>();

  function runWorker(repoDir: string, sha: string): Promise<CodemapExtract> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(codemapWorkerPath, { resourceLimits: { maxOldGenerationSizeMb: CODEMAP_TUNABLES.workerHeapMb } });
      let isSettled = false;
      const deadline = setTimeout(() => settle(() => reject(new Error(`the code map worker ran past its ${CODEMAP_TUNABLES.extractDeadlineMs} ms deadline`))), CODEMAP_TUNABLES.extractDeadlineMs);
      function settle(outcome: () => void): void {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(deadline);
        outcome();
        void worker.terminate();
      }
      worker.on('message', (message: unknown) => {
        const phase = ExtractPhase.safeParse(message);
        if (phase.success) {
          onPhase(phase.data);
          return;
        }
        const reply = ExtractReply.safeParse(message);
        if (!reply.success) {
          settle(() => reject(new Error('the code map worker sent a reply that breaks its contract')));
          return;
        }
        const answer = reply.data;
        if (answer.ok) {
          settle(() => resolve(answer.extract));
          return;
        }
        settle(() => reject(new Error(answer.error)));
      });
      worker.on('error', (error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
      worker.on('exit', (exitCode) => settle(() => reject(new Error(`the code map worker stopped with exit code ${exitCode}`))));
      worker.postMessage({ repoDir, sha });
    });
  }

  function extract(repoDir: string, sha: string): Promise<CodemapExtract> {
    const key = `${repoDir}\n${sha}`;
    const running = runningByKey.get(key);
    if (running) return running;
    const started = runWorker(repoDir, sha).finally(() => runningByKey.delete(key));
    runningByKey.set(key, started);
    return started;
  }

  return { extract };
}

export { createCodemapClient };
export type { CodemapClient };
