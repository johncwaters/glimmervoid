import { Worker } from 'node:worker_threads';
import { z } from 'zod';

import { CodemapExtract, FileImports } from '../../shared/contracts/codemap.ts';
import type { CodemapExtractBase } from '../../shared/contracts/codemap.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import type { SymbolGraph } from '../core/codemap-structure-core.ts';
import { codemapWorkerPath } from '../runtime-paths.ts';

const ExtractPhase = z.strictObject({ phase: z.string(), elapsedMs: z.number(), heapBytes: z.number(), rssBytes: z.number() });
type ExtractPhase = z.infer<typeof ExtractPhase>;

const WorkerFailure = z.strictObject({ ok: z.literal(false), error: z.string() });
const ExtractReply = z.union([z.strictObject({ ok: z.literal(true), extract: CodemapExtract }), WorkerFailure]);
const SymbolGraphReply = z.union([
  z.strictObject({
    ok: z.literal(true),
    graph: z.strictObject({ treeSha: z.string(), symbols: z.array(z.string()), fileOfSymbol: z.instanceof(Int32Array), files: z.array(z.string()), edgesFrom: z.instanceof(Int32Array), edgesTo: z.instanceof(Int32Array), unjudgedLanguages: z.array(z.strictObject({ language: z.string(), reason: z.string() })) }),
  }),
  WorkerFailure,
]);
const ScanFilesReply = z.union([z.strictObject({ ok: z.literal(true), scans: z.array(FileImports.extend({ repoPath: z.string() })) }), WorkerFailure]);

interface CodemapClient {
  extract(repoDir: string, sha: string, base?: CodemapExtractBase | null): Promise<CodemapExtract>;
  scanFiles(root: string, repoPaths: readonly string[]): Promise<Map<string, FileImports>>;
  symbolGraph(indexPaths: readonly string[], treeSha: string): Promise<SymbolGraph>;
}

function createCodemapClient({ onPhase = () => {} }: { onPhase?: (phase: ExtractPhase) => void } = {}): CodemapClient {
  const runningByKey = new Map<string, Promise<CodemapExtract>>();

  function runWorker<Reply extends { ok: true }>(request: object, replySchema: z.ZodType<Reply | z.infer<typeof WorkerFailure>>): Promise<Reply> {
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
        const reply = replySchema.safeParse(message);
        if (!reply.success) {
          settle(() => reject(new Error('the code map worker sent a reply that breaks its contract')));
          return;
        }
        const answer = reply.data;
        if (answer.ok) {
          settle(() => resolve(answer));
          return;
        }
        settle(() => reject(new Error(answer.error)));
      });
      worker.on('error', (error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
      worker.on('exit', (exitCode) => settle(() => reject(new Error(`the code map worker stopped with exit code ${exitCode}`))));
      worker.postMessage(request);
    });
  }

  function extract(repoDir: string, sha: string, base: CodemapExtractBase | null = null): Promise<CodemapExtract> {
    const key = `${repoDir}\n${sha}`;
    const running = runningByKey.get(key);
    if (running) return running;
    const started = runWorker({ repoDir, sha, base }, ExtractReply).then((reply) => reply.extract).finally(() => runningByKey.delete(key));
    runningByKey.set(key, started);
    return started;
  }

  async function scanFiles(root: string, repoPaths: readonly string[]): Promise<Map<string, FileImports>> {
    if (repoPaths.length === 0) return new Map();
    const reply = await runWorker({ kind: 'scanFiles', root, repoPaths }, ScanFilesReply);
    return new Map(reply.scans.map(({ repoPath, specifiers, declaredNames }) => [repoPath, { specifiers, declaredNames }]));
  }

  async function symbolGraph(indexPaths: readonly string[], treeSha: string): Promise<SymbolGraph> {
    const reply = await runWorker({ kind: 'symbolGraph', indexPaths, treeSha }, SymbolGraphReply);
    return reply.graph;
  }

  return { extract, scanFiles, symbolGraph };
}

export { createCodemapClient };
export type { CodemapClient };
