import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';
import { z } from 'zod';

import { execFileAsync, spawn } from '../child-process-safe.ts';
import { errorMessage } from '../../shared/text.ts';
import { CodemapExtractBase } from '../../shared/contracts/codemap.ts';
import { CODEMAP_EXPORT_FILE_BY_KIND, CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import { isSourcePath, readImportsMap } from '../change-map/core/change-map-core.ts';
import { buildImportGraph, extractExportedNames, extractImportSpecifiers, extractPythonImportSpecifiers, extractTypeOnlySpecifiers, outsideGraphImportsOf, relativeImportBasePath } from '../core/import-graph-core.ts';
import { createTsconfigPathsResolver, parseTsconfigJsonc, resolveExtendsPath } from '../core/tsconfig-paths-core.ts';
import type { TsconfigPaths } from '../core/tsconfig-paths-core.ts';

const ExtractRequest = z.strictObject({ repoDir: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/), base: CodemapExtractBase.nullable() });

const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

interface TreeEntry {
  objectId: string;
  sizeBytes: number;
  repoPath: string;
}

function parseTree(treeText: string): TreeEntry[] {
  return treeText.split(String.fromCharCode(0)).flatMap((record) => {
    const tabIndex = record.indexOf('\t');
    if (tabIndex < 0) return [];
    const [, objectType, objectId, sizeText] = record.slice(0, tabIndex).split(/\s+/);
    if (objectType !== 'blob' || !objectId) return [];
    return [{ objectId, sizeBytes: Number(sizeText), repoPath: record.slice(tabIndex + 1) }];
  });
}

function partitionByBudget(entries: readonly TreeEntry[]): { kept: TreeEntry[]; skipped: TreeEntry[] } {
  const kept: TreeEntry[] = [];
  const skipped: TreeEntry[] = [];
  let keptBytes = 0;
  for (const entry of entries) {
    const isWithinBudget = entry.sizeBytes <= CODEMAP_TUNABLES.maxFileBytes && kept.length < CODEMAP_TUNABLES.maxSourceFiles && keptBytes + entry.sizeBytes <= CODEMAP_TUNABLES.maxSourceBytes;
    if (!isWithinBudget) {
      skipped.push(entry);
      continue;
    }
    kept.push(entry);
    keptBytes += entry.sizeBytes;
  }
  return { kept, skipped };
}

async function readTextsByPath(repoDir: string, entries: readonly TreeEntry[]): Promise<Map<string, string>> {
  const objectIds = [...new Set(entries.map((entry) => entry.objectId))];
  const texts = await readBlobs(repoDir, objectIds);
  const textByObjectId = new Map(objectIds.map((objectId, index) => [objectId, texts[index] ?? '']));
  return new Map(entries.map((entry) => [entry.repoPath, textByObjectId.get(entry.objectId) ?? '']));
}

async function readTsconfigs(repoDir: string, entries: readonly TreeEntry[]): Promise<Map<string, TsconfigPaths>> {
  const entryByPath = new Map(entries.map((entry) => [entry.repoPath, entry]));
  const configsByPath = new Map<string, TsconfigPaths>();
  const visitedPaths = new Set<string>();
  let pendingEntries = entries.filter((entry) => path.posix.basename(entry.repoPath) === 'tsconfig.json');
  while (pendingEntries.length > 0) {
    for (const entry of pendingEntries) visitedPaths.add(entry.repoPath);
    const textByPath = await readTextsByPath(repoDir, pendingEntries.filter((entry) => entry.sizeBytes <= CODEMAP_TUNABLES.maxFileBytes));
    const parentEntries = new Map<string, TreeEntry>();
    for (const [configPath, configText] of textByPath) {
      const config = parseTsconfigJsonc(configText);
      if (!config) continue;
      configsByPath.set(configPath, config);
      if (!config.extendsPath) continue;
      const parentEntry = entryByPath.get(resolveExtendsPath(configPath, config.extendsPath));
      if (parentEntry && !visitedPaths.has(parentEntry.repoPath)) parentEntries.set(parentEntry.repoPath, parentEntry);
    }
    pendingEntries = [...parentEntries.values()];
  }
  return configsByPath;
}

interface FileScan {
  specifiers: string[];
  typeOnlySpecifiers: string[];
  exportedNames: string[];
}

function scanOf(repoPath: string, sourceText: string): FileScan {
  if (repoPath.endsWith('.py')) return { specifiers: extractPythonImportSpecifiers(sourceText), typeOnlySpecifiers: [], exportedNames: [] };
  return { specifiers: extractImportSpecifiers(sourceText), typeOnlySpecifiers: extractTypeOnlySpecifiers(sourceText), exportedNames: extractExportedNames(sourceText) };
}

async function reusableScansOf(repoDir: string, base: CodemapExtractBase | null, sha: string): Promise<Map<string, FileScan>> {
  if (!base) return new Map();
  const changed = await execFileAsync('git', ['diff', '--name-only', '--relative', '-z', '--no-renames', base.sha, sha], { cwd: repoDir, encoding: 'utf8', env: GIT_ENV, maxBuffer: GIT_MAX_BUFFER_BYTES })
    .then(({ stdout }) => new Set(stdout.split(String.fromCharCode(0)).filter(Boolean)), () => null);
  if (!changed) return new Map();
  return new Map(base.paths.flatMap((repoPath, index) => (changed.has(repoPath) ? [] : [[repoPath, { specifiers: base.specifiersByIndex[index] ?? [], typeOnlySpecifiers: base.typeOnlySpecifiersByIndex[index] ?? [], exportedNames: base.exportedNamesByIndex[index] ?? [] }] as const])));
}

async function ignoredPathsOf(repoDir: string, candidatePaths: readonly string[]): Promise<Set<string>> {
  if (candidatePaths.length === 0) return new Set();
  const ignoredText = await new Promise<string>((resolve) => {
    const child = spawn('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: repoDir, env: GIT_ENV, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    child.stdin?.end(candidatePaths.join(String.fromCharCode(0)));
  });
  return new Set(ignoredText.split(String.fromCharCode(0)).filter(Boolean));
}

async function assertFullClone(repoDir: string): Promise<void> {
  const promisorSettings = await execFileAsync('git', ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], { cwd: repoDir, encoding: 'utf8', env: GIT_ENV }).then(({ stdout }) => stdout.trim(), () => '');
  if (promisorSettings) throw new Error(`${repoDir} is a partial clone; the code map reads every source file at the mainline commit and does not fetch missing ones`);
}

function readBlobs(repoDir: string, objectIds: readonly string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repoDir, env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderrText = '';
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (exitCode: number | null) => {
      if (exitCode !== 0) {
        reject(new Error(`git cat-file exited ${exitCode}: ${stderrText.trim()}`));
        return;
      }
      const output = Buffer.concat(chunks);
      const texts: string[] = [];
      let offset = 0;
      for (const objectId of objectIds) {
        const headerEnd = output.indexOf(10, offset);
        const header = output.subarray(offset, headerEnd).toString('utf8');
        const sizeBytes = Number(header.split(' ')[2]);
        if (!header.startsWith(objectId) || !Number.isFinite(sizeBytes)) {
          reject(new Error(`git cat-file answered ${header} for ${objectId}`));
          return;
        }
        texts.push(output.subarray(headerEnd + 1, headerEnd + 1 + sizeBytes).toString('utf8'));
        offset = headerEnd + 1 + sizeBytes + 1;
      }
      resolve(texts);
    });
    child.stdin?.end(objectIds.map((objectId) => `${objectId}\n`).join(''));
  });
}

async function extract(repoDir: string, sha: string, base: CodemapExtractBase | null, markPhase: (phase: string) => void) {
  await assertFullClone(repoDir);
  const { stdout: treeText } = await execFileAsync('git', ['ls-tree', '-r', '-z', '--long', sha], { cwd: repoDir, encoding: 'utf8', env: GIT_ENV, maxBuffer: GIT_MAX_BUFFER_BYTES });
  const entries = parseTree(treeText);
  const exportFilePaths = new Set(Object.values(CODEMAP_EXPORT_FILE_BY_KIND));
  const { kept: sourceEntries, skipped } = partitionByBudget(entries.filter((entry) => isSourcePath(entry.repoPath) && !exportFilePaths.has(entry.repoPath)));
  const skippedPaths = skipped.map((entry) => entry.repoPath).sort();
  markPhase('list tree');
  const reusableScans = await reusableScansOf(repoDir, base, sha);
  const packageJsonEntry = entries.find((entry) => entry.repoPath === 'package.json' && entry.sizeBytes <= CODEMAP_TUNABLES.maxFileBytes);
  const unscannedEntries = sourceEntries.filter((entry) => !reusableScans.has(entry.repoPath));
  const textByPath = await readTextsByPath(repoDir, packageJsonEntry ? [...unscannedEntries, packageJsonEntry] : unscannedEntries);
  const configsByPath = await readTsconfigs(repoDir, entries);
  markPhase(`read blobs (${unscannedEntries.length} changed, ${sourceEntries.length - unscannedEntries.length} reused)`);
  const paths = sourceEntries.map((entry) => entry.repoPath).sort();
  const scans = paths.map((repoPath) => reusableScans.get(repoPath) ?? scanOf(repoPath, textByPath.get(repoPath) ?? ''));
  const specifiersByIndex = scans.map((scan) => scan.specifiers);
  const exportedNamesByIndex = scans.map((scan) => scan.exportedNames);
  const typeOnlySpecifiersByIndex = scans.map((scan) => scan.typeOnlySpecifiers);
  const specifiersByPath = new Map(paths.map((repoPath, index) => [repoPath, specifiersByIndex[index] ?? []]));
  const valueSpecifiersByPath = new Map(paths.map((repoPath, index) => [repoPath, (specifiersByIndex[index] ?? []).filter((specifier) => !typeOnlySpecifiersByIndex[index]?.includes(specifier))]));
  const trackedPaths = new Set(entries.map((entry) => entry.repoPath));
  const graphPaths = new Set(paths);
  const candidateImportsByIndex = paths.map((repoPath, index) => outsideGraphImportsOf(repoPath, specifiersByIndex[index] ?? [], graphPaths, trackedPaths));
  const unresolvedBasePaths = paths.flatMap((repoPath, index) => (candidateImportsByIndex[index] ?? []).filter((candidate) => candidate.targetPath === null).map((candidate) => relativeImportBasePath(repoPath, candidate.specifier)));
  const ignoredPaths = await ignoredPathsOf(repoDir, [...new Set(unresolvedBasePaths)].filter((basePath) => !basePath.startsWith('../')));
  const outsideGraphImportsByIndex = paths.map((repoPath, index) => (candidateImportsByIndex[index] ?? []).filter((candidate) => candidate.targetPath !== null || !ignoredPaths.has(relativeImportBasePath(repoPath, candidate.specifier))));
  markPhase('scan imports');
  const resolution = { importsMap: readImportsMap(textByPath.get('package.json') ?? null), tsconfigTargets: createTsconfigPathsResolver(configsByPath) };
  const graph = buildImportGraph({ specifiersByPath, ...resolution });
  const valueGraph = buildImportGraph({ specifiersByPath: valueSpecifiersByPath, ...resolution });
  const indexByPath = new Map(paths.map((repoPath, index) => [repoPath, index]));
  const importers: number[] = [];
  const imported: number[] = [];
  const typeOnlyEdges: number[] = [];
  for (const [importedPath, dependentPaths] of graph.dependentsByPath) {
    const importedIndex = indexByPath.get(importedPath);
    if (importedIndex === undefined) continue;
    for (const dependentPath of [...dependentPaths].sort()) {
      const importerIndex = indexByPath.get(dependentPath);
      if (importerIndex === undefined) continue;
      importers.push(importerIndex);
      imported.push(importedIndex);
      typeOnlyEdges.push(valueGraph.dependentsByPath.get(importedPath)?.has(dependentPath) ? 0 : 1);
    }
  }
  markPhase('resolve graph');
  return { sha, paths, importerIndexes: Int32Array.from(importers), importedIndexes: Int32Array.from(imported), typeOnlyEdges: Uint8Array.from(typeOnlyEdges), specifiersByIndex, typeOnlySpecifiersByIndex, outsideGraphImportsByIndex, exportedNamesByIndex, skippedPaths };
}

function serve(): void {
  const port = parentPort;
  if (!port) throw new Error('the code map extraction runs only as a worker thread');
  port.once('message', (message: unknown) => {
    const parsed = ExtractRequest.safeParse(message);
    if (!parsed.success) {
      port.postMessage({ ok: false, error: 'the code map worker refused a malformed request' });
      return;
    }
    let previousPhaseAt = performance.now();
    function markPhase(phase: string): void {
      const now = performance.now();
      const { heapUsed, rss } = process.memoryUsage();
      port?.postMessage({ phase, elapsedMs: now - previousPhaseAt, heapBytes: heapUsed, rssBytes: rss });
      previousPhaseAt = now;
    }
    extract(parsed.data.repoDir, parsed.data.sha, parsed.data.base, markPhase).then(
      (extracted) => port.postMessage({ ok: true, extract: extracted }, [extracted.importerIndexes.buffer, extracted.importedIndexes.buffer, extracted.typeOnlyEdges.buffer]),
      (error: unknown) => port.postMessage({ ok: false, error: errorMessage(error) }),
    );
  });
}

serve();
