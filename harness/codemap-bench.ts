import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { runGit } from '../server/git/git-exec.ts';
import { createCodemapClient } from '../server/codemap/codemap-client.ts';
import { buildCodemapModel, impactOf, mapTextOf, whereOf } from '../server/core/codemap-graph-core.ts';

const BYTES_PER_MB = 2 ** 20;

function megabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function logStep(step: string, elapsedMs: number, heapBytes: number, rssBytes: number): void {
  console.log(`${step.padEnd(24)} ${elapsedMs.toFixed(0).padStart(6)} ms  heap ${megabytes(heapBytes)}  rss ${megabytes(rssBytes)}`);
}

async function timed<Value>(step: string, run: () => Promise<Value> | Value): Promise<Value> {
  const startedAt = performance.now();
  const value = await run();
  const { heapUsed, rss } = process.memoryUsage();
  logStep(`server: ${step}`, performance.now() - startedAt, heapUsed, rss);
  return value;
}

async function main(): Promise<void> {
  const repoDir = path.resolve(process.argv[2] ?? '.');
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: repoDir });
  if (!head.ok) throw new Error(`${repoDir} is not a git checkout`);
  const sha = head.out.trim();
  console.log(`code map bench: ${repoDir} at ${sha}`);
  const client = createCodemapClient({ onPhase: ({ phase, elapsedMs, heapBytes, rssBytes }) => logStep(`worker: ${phase}`, elapsedMs, heapBytes, rssBytes) });
  const extract = await timed('extract', () => client.extract(repoDir, sha));
  const model = await timed('build model', () => buildCodemapModel(extract));
  const status = { sha, mainlineSha: sha, state: 'current' as const, reason: null };
  const mapText = await timed('map text', () => mapTextOf(model, status, path.basename(repoDir)));
  const repeatedText = mapTextOf(buildCodemapModel(await client.extract(repoDir, sha)), status, path.basename(repoDir));
  if (repeatedText !== mapText) throw new Error('two runs at one commit gave different map text');
  const firstPath = model.paths.find((repoPath) => repoPath.startsWith('server/')) ?? model.paths[0];
  if (firstPath) {
    await timed('where', () => whereOf(model, firstPath));
    await timed('impact', () => impactOf(model, [firstPath]));
  }
  console.log(`${model.paths.length} source files, ${model.modules.length} modules, ${model.moduleEdgeCount} module edges, ${extract.importerIndexes.length} file imports, ${extract.skippedPaths.length} skipped, map text ${mapText.length} chars`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
