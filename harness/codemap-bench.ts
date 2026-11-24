import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { runCommand, runGit } from '../server/git/git-exec.ts';
import { createCodemapClient } from '../server/codemap/codemap-client.ts';
import type { CodemapClient } from '../server/codemap/codemap-client.ts';
import { directImportersOf } from '../server/codemap/codemap-wiring.ts';
import { createStructureRunner } from '../server/codemap/structure-runner.ts';
import type { StructureRunner } from '../server/codemap/structure-runner.ts';
import { buildCodemapModel, CODEMAP_TUNABLES, impactOf, mapTextOf, moduleOfPath, whereOf } from '../server/core/codemap-graph-core.ts';
import type { CodemapModel } from '../server/core/codemap-graph-core.ts';
import { glimmervoidHomeDir } from '../server/core/config-path-core.ts';
import { shallowModulesOf, tanglesOf } from '../server/core/codemap-structure-core.ts';
import type { SymbolGraph } from '../server/core/codemap-structure-core.ts';

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

const CHILD_MEMORY_SAMPLE_MS = 250;
const KILOBYTE = 1024;

async function childRssBytes(): Promise<number | null> {
  const listed = await runCommand('ps', ['-o', 'rss=', '--ppid', String(process.pid)]);
  if (!listed.ok) return null;
  return listed.out.split('\n').map((line) => Number(line.trim())).filter(Number.isFinite).reduce((total, kilobytes) => total + kilobytes * KILOBYTE, 0);
}

async function benchStructure(repoDir: string, sha: string, client: CodemapClient, model: CodemapModel): Promise<void> {
  const runner = createStructureRunner({ homeDir: glimmervoidHomeDir(os.homedir(), process.env), client });
  let peakChildRssBytes: number | null = 0;
  const sampler = setInterval(() => {
    void childRssBytes().then((rssBytes) => {
      peakChildRssBytes = rssBytes === null || peakChildRssBytes === null ? null : Math.max(peakChildRssBytes, rssBytes);
    });
  }, CHILD_MEMORY_SAMPLE_MS);
  const graph = await timed('index structure', () => runner.symbolGraphOf(repoDir, sha)).finally(() => clearInterval(sampler));
  const moduleOfRepoPath = (repoPath: string) => moduleOfPath(model, repoPath);
  const tangles = await timed('find tangles', () => tanglesOf(graph, moduleOfRepoPath));
  const shallowModules = await timed('find shallow modules', () => shallowModulesOf(graph, moduleOfRepoPath));
  const unjudged = graph.unjudgedLanguages.map((entry) => `${entry.language} (${entry.reason})`).join(', ') || 'none';
  console.log(`indexer peak rss ${peakChildRssBytes === null ? 'not measured on this platform' : megabytes(peakChildRssBytes)}, ${graph.symbols.length} symbols, ${graph.edgesFrom.length} symbol edges, ${tangles.length} tangles (largest ${tangles[0]?.symbols.length ?? 0} symbols, ceiling ${CODEMAP_TUNABLES.maxTangleSymbols}), ${shallowModules.length} shallow modules (ceiling ${CODEMAP_TUNABLES.maxShownSymbols} shown), unjudged ${unjudged}`);
  await benchIncrementalStructure(repoDir, sha, client, model, runner, graph);
}

function edgeNamesOf(graph: SymbolGraph): Set<string> {
  return new Set(Array.from(graph.edgesFrom, (from, edge) => `${graph.symbols[from]} > ${graph.symbols[graph.edgesTo[edge]]}`));
}

function findingsTextOf(graph: SymbolGraph, model: CodemapModel): string {
  const moduleOfRepoPath = (repoPath: string) => moduleOfPath(model, repoPath);
  return JSON.stringify({ tangles: tanglesOf(graph, moduleOfRepoPath), shallowModules: shallowModulesOf(graph, moduleOfRepoPath) });
}

async function benchIncrementalStructure(repoDir: string, sha: string, client: CodemapClient, model: CodemapModel, runner: StructureRunner, fullGraph: SymbolGraph): Promise<void> {
  const baseRef = process.argv[3] ?? 'HEAD~10';
  const baseRevision = await runGit(['rev-parse', baseRef], { cwd: repoDir });
  if (!baseRevision.ok) throw new Error(`${baseRef} is not a commit of ${repoDir}`);
  const baseSha = baseRevision.out.trim();
  const baseModel = buildCodemapModel(await client.extract(repoDir, baseSha));
  const base = await timed(`index base ${baseRef}`, () => runner.symbolGraphOf(repoDir, baseSha));
  const replacedPaths = new Set<string>();
  const importersOf = (changedPaths: readonly string[]) => {
    const importers = directImportersOf(changedPaths, [model, baseModel]);
    for (const repoPath of [...changedPaths, ...importers]) replacedPaths.add(repoPath);
    return importers;
  };
  const spliced = await timed('index incremental', () => runner.symbolGraphOf(repoDir, sha, { base, importersOf }));
  if (findingsTextOf(spliced, model) !== findingsTextOf(fullGraph, model)) throw new Error(`the incremental tangles or shallow modules against ${baseRef} differ from the full index at ${sha.slice(0, 7)}`);
  const fullEdges = edgeNamesOf(fullGraph);
  const splicedEdges = edgeNamesOf(spliced);
  const differingEdgeCount = [...fullEdges].filter((edge) => !splicedEdges.has(edge)).length + [...splicedEdges].filter((edge) => !fullEdges.has(edge)).length;
  console.log(`incremental against ${baseRef}: ${replacedPaths.size} paths changed or importing a changed path, same tangles and shallow modules as the full index, ${differingEdgeCount} of ${fullEdges.size} symbol edges differ`);
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
  await benchStructure(repoDir, sha, client, model);
  console.log(`${model.paths.length} source files, ${model.modules.length} modules, ${model.moduleEdgeCount} module edges, ${extract.importerIndexes.length} file imports, ${extract.skippedPaths.length} skipped, map text ${mapText.length} chars`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
