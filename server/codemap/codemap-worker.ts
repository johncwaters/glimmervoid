import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';
import { z } from 'zod';

import { execFileAsync, spawn } from '../child-process-safe.ts';
import { errorMessage } from '../../shared/text.ts';
import { CodemapExtractBase } from '../../shared/contracts/codemap.ts';
import { CODEMAP_EXPORT_FILE_BY_KIND, CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import { readImportsMap } from '../change-map/core/change-map-core.ts';
import { blankOutsideScriptRegions, buildImportGraph, directDependentsOf, expandedEdgeCountOf, extractExportedNames, extractImportSpecifiers, extractPythonImportSpecifiers, extractTypeOnlySpecifiers, outsideGraphImportsOf, packageKeysPastEdgeBudget, relativeImportBasePath, scriptSourceSpecifiers, withOneFilePerDirectory } from '../core/import-graph-core.ts';
import { importLanguageOf, isImportManifestPath, isSourcePath } from '../core/import-language-core.ts';
import { symbolGraphOfIndex } from '../core/codemap-structure-core.ts';
import { isTestPath } from '../core/import-graph-core.ts';
import { scipDocumentsOf } from '../core/scip-index-core.ts';
import { scanGrammarImports, threadCpuMs } from '../import-scan/grammar-scan.ts';
import { createTsconfigPathsResolver, parseTsconfigJsonc, resolveExtendsPath } from '../core/tsconfig-paths-core.ts';
import type { TsconfigPaths } from '../core/tsconfig-paths-core.ts';

const ExtractRequest = z.strictObject({ repoDir: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/), base: CodemapExtractBase.nullable() });
const ScanFilesRequest = z.strictObject({ kind: z.literal('scanFiles'), root: z.string().min(1), repoPaths: z.array(z.string().min(1)) });
const SymbolGraphRequest = z.strictObject({ kind: z.literal('symbolGraph'), indexes: z.array(z.strictObject({ indexPath: z.string().min(1), pathPrefix: z.string() })).min(1), treeSha: z.string().regex(/^[0-9a-f]{40}$/), keepsOutsideEdges: z.boolean() });

const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };

interface TreeEntry {
  objectId: string;
  sizeBytes: number;
  repoPath: string;
}

interface PartialClone {
  promisorRemote: string;
  missingObjectIds: Set<string>;
}

type FetchBlobsOf = (entries: readonly TreeEntry[]) => Promise<TreeEntry[]>;

function parseTree(treeText: string): Omit<TreeEntry, 'sizeBytes'>[] {
  return treeText.split(String.fromCharCode(0)).flatMap((record) => {
    const tabIndex = record.indexOf('\t');
    if (tabIndex < 0) return [];
    const [, objectType, objectId] = record.slice(0, tabIndex).split(/\s+/);
    if (objectType !== 'blob' || !objectId) return [];
    return [{ objectId, repoPath: record.slice(tabIndex + 1) }];
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

async function readTsconfigs(repoDir: string, entries: readonly TreeEntry[], fetchBlobsOf: FetchBlobsOf): Promise<Map<string, TsconfigPaths>> {
  const entryByPath = new Map(entries.map((entry) => [entry.repoPath, entry]));
  const configsByPath = new Map<string, TsconfigPaths>();
  const visitedPaths = new Set<string>();
  let pendingEntries = entries.filter((entry) => path.posix.basename(entry.repoPath) === 'tsconfig.json');
  while (pendingEntries.length > 0) {
    for (const entry of pendingEntries) visitedPaths.add(entry.repoPath);
    pendingEntries = await fetchBlobsOf(pendingEntries);
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
  declaredNames: string[];
}

const NO_IMPORTS: FileScan = { specifiers: [], typeOnlySpecifiers: [], exportedNames: [], declaredNames: [] };

interface GrammarAllowance {
  remainingCpuMs: number;
}

function grammarAllowance(): GrammarAllowance {
  return { remainingCpuMs: CODEMAP_TUNABLES.grammarScanBudgetMs };
}

async function scanOf(repoPath: string, sourceText: string, allowance: GrammarAllowance): Promise<FileScan | null> {
  const scanner = importLanguageOf(repoPath)?.scanner;
  if (!scanner) return NO_IMPORTS;
  if (scanner.kind === 'grammar') {
    const budgetMs = Math.min(CODEMAP_TUNABLES.grammarParseBudgetMs, allowance.remainingCpuMs);
    if (budgetMs <= 0) return null;
    const startedAt = threadCpuMs();
    const grammarImports = await scanGrammarImports(scanner, sourceText, budgetMs);
    allowance.remainingCpuMs -= threadCpuMs() - startedAt;
    return grammarImports && { ...NO_IMPORTS, ...grammarImports };
  }
  if (scanner.kind === 'python') return { ...NO_IMPORTS, specifiers: extractPythonImportSpecifiers(sourceText) };
  if (scanner.kind === 'typescript') return { ...NO_IMPORTS, specifiers: extractImportSpecifiers(sourceText), typeOnlySpecifiers: extractTypeOnlySpecifiers(sourceText), exportedNames: extractExportedNames(sourceText) };
  const scriptText = blankOutsideScriptRegions(sourceText, scanner.host);
  const sourceSpecifiers = scanner.host === 'html' ? scriptSourceSpecifiers(sourceText) : [];
  return { ...NO_IMPORTS, specifiers: [...new Set([...extractImportSpecifiers(scriptText), ...sourceSpecifiers])], typeOnlySpecifiers: extractTypeOnlySpecifiers(scriptText) };
}

async function scanFiles(root: string, repoPaths: readonly string[]): Promise<{ repoPath: string; specifiers: string[]; declaredNames: string[] }[]> {
  const scans: { repoPath: string; specifiers: string[]; declaredNames: string[] }[] = [];
  const allowance = grammarAllowance();
  for (const repoPath of repoPaths) {
    const sourceText = await fs.promises.readFile(path.join(root, repoPath), 'utf8').catch(() => null);
    if (sourceText === null) continue;
    const isWithinBudget = Buffer.byteLength(sourceText) <= CODEMAP_TUNABLES.maxFileBytes;
    if (!isWithinBudget) {
      scans.push({ repoPath, specifiers: [], declaredNames: [] });
      continue;
    }
    const scan = await scanOf(repoPath, sourceText, allowance);
    if (scan) scans.push({ repoPath, specifiers: scan.specifiers, declaredNames: scan.declaredNames });
  }
  return scans;
}

async function reusableScansOf(repoDir: string, base: CodemapExtractBase | null, sha: string): Promise<Map<string, FileScan>> {
  if (!base) return new Map();
  const changed = await execFileAsync('git', ['diff', '--name-only', '--relative', '-z', '--no-renames', base.sha, sha], { cwd: repoDir, encoding: 'utf8', env: GIT_ENV, maxBuffer: GIT_MAX_BUFFER_BYTES })
    .then(({ stdout }) => new Set(stdout.split(String.fromCharCode(0)).filter(Boolean)), () => null);
  if (!changed) return new Map();
  return new Map(base.paths.flatMap((repoPath, index) => (changed.has(repoPath) ? [] : [[repoPath, { specifiers: base.specifiersByIndex[index] ?? [], typeOnlySpecifiers: base.typeOnlySpecifiersByIndex[index] ?? [], exportedNames: base.exportedNamesByIndex[index] ?? [], declaredNames: base.declaredNamesByIndex[index] ?? [] }] as const])));
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

function isReadByMap(entry: TreeEntry): boolean {
  return isSourcePath(entry.repoPath) || entry.repoPath === 'package.json' || isImportManifestPath(entry.repoPath) || path.posix.basename(entry.repoPath) === 'tsconfig.json';
}

function runGitWithInput(repoDir: string, args: readonly string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoDir, env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderrText = '';
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (exitCode: number | null) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      reject(new Error(`git ${args.join(' ')} exited ${exitCode}: ${stderrText.trim()}`));
    });
    child.stdin?.end(input);
  });
}

async function promisorRemoteOf(repoDir: string): Promise<string | null> {
  const settingsText = await execFileAsync('git', ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], { cwd: repoDir, encoding: 'utf8', env: GIT_ENV }).then(({ stdout }) => stdout, () => '');
  for (const line of settingsText.split('\n')) {
    const promisorRemote = /^remote\.(.+)\.promisor true$/.exec(line.trim())?.[1] ?? /^extensions\.partialclone (.+)$/.exec(line.trim())?.[1];
    if (promisorRemote) return promisorRemote;
  }
  return null;
}

async function partialCloneOf(repoDir: string, sha: string): Promise<PartialClone | null> {
  const promisorRemote = await promisorRemoteOf(repoDir);
  if (!promisorRemote) return null;
  const { stdout: objectsText } = await execFileAsync('git', ['rev-list', '--objects', '--no-walk', '--missing=print', sha], { cwd: repoDir, encoding: 'utf8', env: GIT_ENV, maxBuffer: GIT_MAX_BUFFER_BYTES });
  const missingObjectIds = new Set(objectsText.split('\n').filter((line) => line.startsWith('?')).map((line) => line.slice(1)));
  return { promisorRemote, missingObjectIds };
}

async function sizeByObjectIdOf(repoDir: string, objectIds: readonly string[]): Promise<Map<string, number>> {
  if (objectIds.length === 0) return new Map();
  const sizesText = await runGitWithInput(repoDir, ['cat-file', '--batch-check'], objectIds.map((objectId) => `${objectId}\n`).join(''));
  return new Map(sizesText.split('\n').flatMap((line) => {
    const [objectId, objectType, sizeText] = line.split(' ');
    return objectId && objectType === 'blob' ? [[objectId, Number(sizeText)] as const] : [];
  }));
}

async function listTree(repoDir: string, sha: string, partialClone: PartialClone | null): Promise<TreeEntry[]> {
  const { stdout: treeText } = await execFileAsync('git', ['ls-tree', '-r', '-z', sha], { cwd: repoDir, encoding: 'utf8', env: GIT_ENV, maxBuffer: GIT_MAX_BUFFER_BYTES });
  const treeObjects = parseTree(treeText);
  const presentObjectIds = [...new Set(treeObjects.map((treeObject) => treeObject.objectId))].filter((objectId) => !partialClone?.missingObjectIds.has(objectId));
  const sizeByObjectId = await sizeByObjectIdOf(repoDir, presentObjectIds);
  return treeObjects.map((treeObject) => ({ ...treeObject, sizeBytes: sizeByObjectId.get(treeObject.objectId) ?? Number.NaN }));
}

async function fetchMissingBlobs(repoDir: string, partialClone: PartialClone | null, entries: readonly TreeEntry[]): Promise<TreeEntry[]> {
  const missingObjectIds = [...new Set(entries.map((entry) => entry.objectId))].filter((objectId) => partialClone?.missingObjectIds.has(objectId));
  if (!partialClone || missingObjectIds.length === 0) return [...entries];
  const { promisorRemote } = partialClone;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(promisorRemote)) throw new Error(`${repoDir} names ${JSON.stringify(promisorRemote)} as its promisor remote, which is not a remote name the code map fetches from`);
  await runGitWithInput(repoDir, ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin', '--end-of-options', promisorRemote], missingObjectIds.map((objectId) => `${objectId}\n`).join(''))
    .catch((error: unknown) => { throw new Error(`could not fetch the ${missingObjectIds.length} missing source files of ${repoDir} from ${promisorRemote}: ${errorMessage(error)}`); });
  for (const objectId of missingObjectIds) partialClone.missingObjectIds.delete(objectId);
  const sizeByObjectId = await sizeByObjectIdOf(repoDir, missingObjectIds);
  return entries.map((entry) => ({ ...entry, sizeBytes: sizeByObjectId.get(entry.objectId) ?? entry.sizeBytes }));
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
  const partialClone = await partialCloneOf(repoDir, sha);
  const listedEntries = await listTree(repoDir, sha, partialClone);
  const fetchedEntries = await fetchMissingBlobs(repoDir, partialClone, listedEntries.filter(isReadByMap));
  const fetchedEntryByPath = new Map(fetchedEntries.map((entry) => [entry.repoPath, entry]));
  const entries = listedEntries.map((entry) => fetchedEntryByPath.get(entry.repoPath) ?? entry);
  const exportFilePaths = new Set(Object.values(CODEMAP_EXPORT_FILE_BY_KIND));
  const { kept: sourceEntries, skipped } = partitionByBudget(entries.filter((entry) => isSourcePath(entry.repoPath) && !exportFilePaths.has(entry.repoPath)));
  markPhase('list tree');
  const reusableScans = await reusableScansOf(repoDir, base, sha);
  const configEntries = entries.filter((entry) => (entry.repoPath === 'package.json' || isImportManifestPath(entry.repoPath)) && entry.sizeBytes <= CODEMAP_TUNABLES.maxFileBytes);
  const unscannedEntries = sourceEntries.filter((entry) => !reusableScans.has(entry.repoPath));
  const textByPath = await readTextsByPath(repoDir, [...unscannedEntries, ...configEntries]);
  const configsByPath = await readTsconfigs(repoDir, entries, (wantedEntries) => fetchMissingBlobs(repoDir, partialClone, wantedEntries));
  markPhase(`read blobs (${unscannedEntries.length} changed, ${sourceEntries.length - unscannedEntries.length} reused)`);
  const scanByPath = new Map<string, FileScan>();
  const overBudgetPaths: string[] = [];
  const allowance = grammarAllowance();
  for (const repoPath of sourceEntries.map((entry) => entry.repoPath)) {
    const scan = reusableScans.get(repoPath) ?? await scanOf(repoPath, textByPath.get(repoPath) ?? '', allowance);
    if (scan) scanByPath.set(repoPath, scan);
    if (!scan) overBudgetPaths.push(repoPath);
  }
  const skippedPaths = [...skipped.map((entry) => entry.repoPath), ...overBudgetPaths].sort();
  const paths = [...scanByPath.keys()].sort();
  const scans = paths.map((repoPath) => scanByPath.get(repoPath) ?? NO_IMPORTS);
  const specifiersByIndex = scans.map((scan) => scan.specifiers);
  const exportedNamesByIndex = scans.map((scan) => scan.exportedNames);
  const typeOnlySpecifiersByIndex = scans.map((scan) => scan.typeOnlySpecifiers);
  const declaredNamesByIndex = scans.map((scan) => scan.declaredNames);
  const declaredNamesByPath = new Map(paths.map((repoPath, index) => [repoPath, declaredNamesByIndex[index] ?? []]));
  const specifiersByPath = new Map(paths.map((repoPath, index) => [repoPath, specifiersByIndex[index] ?? []]));
  const valueSpecifiersByPath = new Map(paths.map((repoPath, index) => [repoPath, (specifiersByIndex[index] ?? []).filter((specifier) => !typeOnlySpecifiersByIndex[index]?.includes(specifier))]));
  const trackedPaths = new Set(entries.map((entry) => entry.repoPath));
  const graphPaths = new Set(paths);
  const candidateImportsByIndex = paths.map((repoPath, index) => outsideGraphImportsOf(repoPath, specifiersByIndex[index] ?? [], graphPaths, trackedPaths));
  const unresolvedBasePaths = paths.flatMap((repoPath, index) => (candidateImportsByIndex[index] ?? []).filter((candidate) => candidate.targetPath === null).map((candidate) => relativeImportBasePath(repoPath, candidate.specifier)));
  const ignoredPaths = await ignoredPathsOf(repoDir, [...new Set(unresolvedBasePaths)].filter((basePath) => !basePath.startsWith('../')));
  const outsideGraphImportsByIndex = paths.map((repoPath, index) => (candidateImportsByIndex[index] ?? []).filter((candidate) => candidate.targetPath !== null || !ignoredPaths.has(relativeImportBasePath(repoPath, candidate.specifier))));
  markPhase('scan imports');
  const manifestTextByPath = new Map([...textByPath].filter(([repoPath]) => isImportManifestPath(repoPath)));
  const resolution = { unscannedSourcePaths: skippedPaths, importsMap: readImportsMap(textByPath.get('package.json') ?? null), tsconfigTargets: createTsconfigPathsResolver(configsByPath), manifestTextByPath, declaredNamesByPath };
  const fullGraph = buildImportGraph({ specifiersByPath, ...resolution });
  const trimmedPackageKeys = packageKeysPastEdgeBudget(fullGraph, CODEMAP_TUNABLES.maxImportEdges);
  const graph = withOneFilePerDirectory(fullGraph, trimmedPackageKeys);
  const valueGraph = withOneFilePerDirectory(buildImportGraph({ specifiersByPath: valueSpecifiersByPath, ...resolution }), trimmedPackageKeys);
  if (expandedEdgeCountOf(graph) > CODEMAP_TUNABLES.maxImportEdges) throw new Error(`the repo has more than ${CODEMAP_TUNABLES.maxImportEdges} file imports, past what the code map can draw`);
  const indexByPath = new Map(paths.map((repoPath, index) => [repoPath, index]));
  const importers: number[] = [];
  const imported: number[] = [];
  const typeOnlyEdges: number[] = [];
  for (const importedPath of graph.dependentsByPath.keys()) {
    const importedIndex = indexByPath.get(importedPath);
    if (importedIndex === undefined) continue;
    const valueDependents = directDependentsOf(valueGraph, importedPath);
    for (const dependentPath of [...directDependentsOf(graph, importedPath)].sort()) {
      const importerIndex = indexByPath.get(dependentPath);
      if (importerIndex === undefined) continue;
      importers.push(importerIndex);
      imported.push(importedIndex);
      typeOnlyEdges.push(valueDependents.has(dependentPath) ? 0 : 1);
    }
  }
  markPhase('resolve graph');
  return { sha, paths, importerIndexes: Int32Array.from(importers), importedIndexes: Int32Array.from(imported), typeOnlyEdges: Uint8Array.from(typeOnlyEdges), specifiersByIndex, typeOnlySpecifiersByIndex, outsideGraphImportsByIndex, exportedNamesByIndex, declaredNamesByIndex, skippedPaths };
}

function* documentsOfIndexes(indexes: readonly { indexPath: string; pathPrefix: string }[]) {
  for (const { indexPath, pathPrefix } of indexes) {
    for (const document of scipDocumentsOf(fs.readFileSync(indexPath))) yield { ...document, relativePath: `${pathPrefix}${document.relativePath}` };
  }
}

function serve(): void {
  const port = parentPort;
  if (!port) throw new Error('the code map extraction runs only as a worker thread');
  port.once('message', (message: unknown) => {
    const scanRequest = ScanFilesRequest.safeParse(message);
    if (scanRequest.success) {
      scanFiles(scanRequest.data.root, scanRequest.data.repoPaths).then(
        (scans) => port.postMessage({ ok: true, scans }),
        (error: unknown) => port.postMessage({ ok: false, error: errorMessage(error) }),
      );
      return;
    }
    const graphRequest = SymbolGraphRequest.safeParse(message);
    if (graphRequest.success) {
      try {
        const graph = symbolGraphOfIndex(graphRequest.data.treeSha, documentsOfIndexes(graphRequest.data.indexes), isTestPath, graphRequest.data.keepsOutsideEdges);
        port.postMessage({ ok: true, graph });
      } catch (error) {
        port.postMessage({ ok: false, error: errorMessage(error) });
      }
      return;
    }
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
