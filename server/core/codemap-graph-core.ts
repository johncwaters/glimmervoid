import crypto from 'node:crypto';
import path from 'node:path';

import type { CodemapExtract, CodemapStatus } from '../../shared/contracts/codemap.ts';
import { AnchorRef, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import { CODEMAP_ID_PREFIXES } from '../../shared/whiteboard-ops-core.ts';
import { isTestPath } from './import-graph-core.ts';

export const CODEMAP_TUNABLES = Object.freeze({
  maxFilesPerModule: 40,
  maxSourceFiles: 50_000,
  maxFileBytes: 512 * 1024,
  maxSourceBytes: 128 * 1024 * 1024,
  workerHeapMb: 512,
  extractDeadlineMs: 120_000,
  failureRetryMs: 60_000,
  listedPathsPerSection: 30,
  listedModules: 300,
});

const ROOT_MODULE = '.';

interface AdjacencyList {
  offsets: Int32Array;
  targets: Int32Array;
}

interface ModuleSummary {
  id: string;
  fileCount: number;
  importedBy: number;
}

interface ModuleEdge {
  from: string;
  to: string;
  fileImports: number;
}

interface CodemapModel {
  sha: string;
  paths: readonly string[];
  indexByPath: ReadonlyMap<string, number>;
  moduleByIndex: readonly string[];
  modules: readonly ModuleSummary[];
  moduleEdgeCount: number;
  edgesByModule: ReadonlyMap<string, readonly ModuleEdge[]>;
  imports: AdjacencyList;
  dependents: AdjacencyList;
  exportedNamesByIndex: readonly (readonly string[])[];
  entranceIndexes: readonly number[];
  skippedPaths: ReadonlySet<string>;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function childDirectoryOf(directory: string, repoPath: string): string | null {
  const relativePath = directory === ROOT_MODULE ? repoPath : repoPath.slice(directory.length + 1);
  const slashIndex = relativePath.indexOf('/');
  if (slashIndex < 0) return null;
  const segment = relativePath.slice(0, slashIndex);
  return directory === ROOT_MODULE ? segment : `${directory}/${segment}`;
}

function assignModules(directory: string, repoPaths: readonly string[], maxFilesPerModule: number, moduleByPath: Map<string, string>): void {
  if (repoPaths.length <= maxFilesPerModule) {
    for (const repoPath of repoPaths) moduleByPath.set(repoPath, directory);
    return;
  }
  const pathsByChild = new Map<string, string[]>();
  for (const repoPath of repoPaths) {
    const child = childDirectoryOf(directory, repoPath);
    if (child === null) {
      moduleByPath.set(repoPath, directory);
      continue;
    }
    const childPaths = pathsByChild.get(child) ?? [];
    childPaths.push(repoPath);
    pathsByChild.set(child, childPaths);
  }
  for (const [child, childPaths] of pathsByChild) assignModules(child, childPaths, maxFilesPerModule, moduleByPath);
}

function rollUpModules(repoPaths: readonly string[], maxFilesPerModule: number): Map<string, string> {
  const moduleByPath = new Map<string, string>();
  assignModules(ROOT_MODULE, repoPaths, maxFilesPerModule, moduleByPath);
  return moduleByPath;
}

function adjacencyOf(nodeCount: number, sources: Int32Array, targets: Int32Array): AdjacencyList {
  const offsets = new Int32Array(nodeCount + 1);
  for (const source of sources) offsets[source + 1] += 1;
  for (let index = 0; index < nodeCount; index++) offsets[index + 1] += offsets[index];
  const filled = offsets.slice(0, nodeCount);
  const ordered = new Int32Array(sources.length);
  for (let index = 0; index < sources.length; index++) {
    ordered[filled[sources[index]]] = targets[index];
    filled[sources[index]] += 1;
  }
  return { offsets, targets: ordered };
}

function neighborsOf(list: AdjacencyList, index: number): Int32Array {
  return list.targets.subarray(list.offsets[index], list.offsets[index + 1]);
}

function buildCodemapModel(extract: CodemapExtract, maxFilesPerModule: number = CODEMAP_TUNABLES.maxFilesPerModule): CodemapModel {
  const { paths } = extract;
  const moduleByPath = rollUpModules(paths, maxFilesPerModule);
  const moduleByIndex = paths.map((repoPath) => moduleByPath.get(repoPath) ?? ROOT_MODULE);
  const imports = adjacencyOf(paths.length, extract.importerIndexes, extract.importedIndexes);
  const dependents = adjacencyOf(paths.length, extract.importedIndexes, extract.importerIndexes);
  const fileImportsByEdgeKey = new Map<string, ModuleEdge>();
  for (let index = 0; index < extract.importerIndexes.length; index++) {
    const from = moduleByIndex[extract.importerIndexes[index]];
    const to = moduleByIndex[extract.importedIndexes[index]];
    if (from === to) continue;
    const edgeKey = `${from}\n${to}`;
    const edge = fileImportsByEdgeKey.get(edgeKey) ?? { from, to, fileImports: 0 };
    edge.fileImports += 1;
    fileImportsByEdgeKey.set(edgeKey, edge);
  }
  const moduleEdges = [...fileImportsByEdgeKey.values()].sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));
  const fileCountByModule = new Map<string, number>();
  for (const moduleId of moduleByIndex) fileCountByModule.set(moduleId, (fileCountByModule.get(moduleId) ?? 0) + 1);
  const importedByCount = new Map<string, number>();
  const edgesByModule = new Map<string, ModuleEdge[]>();
  for (const edge of moduleEdges) {
    importedByCount.set(edge.to, (importedByCount.get(edge.to) ?? 0) + 1);
    const moduleEdgesFrom = edgesByModule.get(edge.from) ?? [];
    moduleEdgesFrom.push(edge);
    edgesByModule.set(edge.from, moduleEdgesFrom);
  }
  const modules = [...fileCountByModule].map(([id, fileCount]) => ({ id, fileCount, importedBy: importedByCount.get(id) ?? 0 }))
    .sort((left, right) => compareText(left.id, right.id));
  const entranceIndexes = paths.flatMap((repoPath, index) => (neighborsOf(dependents, index).length === 0 && !isTestPath(repoPath) ? [index] : []));
  return {
    sha: extract.sha,
    paths,
    indexByPath: new Map(paths.map((repoPath, index) => [repoPath, index])),
    moduleByIndex,
    modules,
    moduleEdgeCount: moduleEdges.length,
    edgesByModule,
    imports,
    dependents,
    exportedNamesByIndex: extract.exportedNamesByIndex,
    entranceIndexes,
    skippedPaths: new Set(extract.skippedPaths),
  };
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'none';
}

function statusLineOf(repoName: string, status: CodemapStatus): string {
  const mapAt = `Code map of ${repoName} at ${shortSha(status.sha)}`;
  if (status.state === 'current') return `${mapAt}: current, mainline is ${shortSha(status.mainlineSha)}`;
  if (status.state === 'behind') return `${mapAt}: behind, mainline is ${shortSha(status.mainlineSha)}`;
  return `${mapAt}: the last run failed: ${status.reason ?? 'no reason given'}`;
}

function cappedList(names: readonly string[]): string {
  const limit = CODEMAP_TUNABLES.listedPathsPerSection;
  if (names.length === 0) return 'none';
  const listed = names.slice(0, limit).join(', ');
  return names.length > limit ? `${listed} and ${names.length - limit} more` : listed;
}

function mapTextOf(model: CodemapModel | null, status: CodemapStatus, repoName: string): string {
  const lines = [statusLineOf(repoName, status)];
  if (!model) return lines.join('\n');
  lines.push(`${model.modules.length} modules, ${model.paths.length} source files, ${model.moduleEdgeCount} module edges, ${model.entranceIndexes.length} entrances (files nothing imports)`);
  if (model.skippedPaths.size > 0) lines.push(`${model.skippedPaths.size} source files skipped over the size or count caps, so their imports are missing: ${cappedList([...model.skippedPaths])}`);
  lines.push('modules (file count, imported by N modules): imported modules with file import counts');
  for (const summary of model.modules.slice(0, CODEMAP_TUNABLES.listedModules)) {
    lines.push(`${summary.id} (${summary.fileCount}, in ${summary.importedBy}): ${cappedList((model.edgesByModule.get(summary.id) ?? []).map((edge) => `${edge.to} ${edge.fileImports}`))}`);
  }
  if (model.modules.length > CODEMAP_TUNABLES.listedModules) lines.push(`and ${model.modules.length - CODEMAP_TUNABLES.listedModules} more modules`);
  lines.push('Ask codemap where <path or exported name> for one file, or codemap impact <paths> for what a change reaches.');
  return lines.join('\n');
}

function reachingEntrances(model: CodemapModel, startIndex: number): string[] {
  const entrances = new Set(model.entranceIndexes);
  const visited = new Uint8Array(model.paths.length);
  const queued = [startIndex];
  visited[startIndex] = 1;
  const reached: string[] = [];
  for (let position = 0; position < queued.length; position++) {
    const current = queued[position];
    if (entrances.has(current) && current !== startIndex) reached.push(model.paths[current]);
    for (const dependent of neighborsOf(model.dependents, current)) {
      if (visited[dependent]) continue;
      visited[dependent] = 1;
      queued.push(dependent);
    }
  }
  return reached.sort(compareText);
}

function uniqueSorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort(compareText);
}

function whereLinesOf(model: CodemapModel, index: number): string[] {
  const owningModule = model.moduleByIndex[index];
  const importedIndexes = [...neighborsOf(model.imports, index)];
  const importerIndexes = [...neighborsOf(model.dependents, index)];
  const otherModulesOf = (indexes: readonly number[]) => uniqueSorted(indexes.map((neighbor) => model.moduleByIndex[neighbor]).filter((moduleId) => moduleId !== owningModule));
  return [
    `${model.paths[index]} is in module ${owningModule}`,
    `  exports: ${cappedList(model.exportedNamesByIndex[index] ?? [])}`,
    `  imports modules: ${cappedList(otherModulesOf(importedIndexes))}`,
    `  imported by modules: ${cappedList(otherModulesOf(importerIndexes))}`,
    `  imports files: ${cappedList(uniqueSorted(importedIndexes.map((neighbor) => model.paths[neighbor])))}`,
    `  imported by files: ${cappedList(uniqueSorted(importerIndexes.map((neighbor) => model.paths[neighbor])))}`,
    `  reached from entrances: ${cappedList(reachingEntrances(model, index))}`,
  ];
}

function normalizedRepoPath(target: string): string {
  return path.posix.normalize(target.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function whereOf(model: CodemapModel, target: string): { ok: true; text: string } | { ok: false; error: string } {
  const repoPath = normalizedRepoPath(target);
  if (model.skippedPaths.has(repoPath)) return { ok: true, text: `${repoPath} is skipped over the size or count caps, so the map at ${shortSha(model.sha)} holds none of its imports or exports` };
  const pathIndex = model.indexByPath.get(repoPath);
  if (pathIndex !== undefined) return { ok: true, text: whereLinesOf(model, pathIndex).join('\n') };
  const exportingIndexes = model.paths.flatMap((_repoPath, index) => ((model.exportedNamesByIndex[index] ?? []).includes(target) ? [index] : []));
  if (exportingIndexes.length === 0) return { ok: false, error: `${target} is neither a source file in the map at ${shortSha(model.sha)} nor a name any of them exports; name a path relative to the repo root` };
  const shownIndexes = exportingIndexes.slice(0, 5);
  const header = `${target} is exported by ${cappedList(exportingIndexes.map((index) => model.paths[index]))}`;
  return { ok: true, text: [header, ...shownIndexes.flatMap((index) => whereLinesOf(model, index))].join('\n') };
}

function impactOf(model: CodemapModel, targets: readonly string[]): { ok: true; text: string } | { ok: false; error: string } {
  const startIndexes = uniqueSorted(targets.map(normalizedRepoPath)).flatMap((target) => {
    const index = model.indexByPath.get(target);
    return index === undefined ? [] : [index];
  });
  const unknownPaths = uniqueSorted(targets.map(normalizedRepoPath)).filter((target) => !model.indexByPath.has(target));
  if (startIndexes.length === 0) return { ok: false, error: `none of ${cappedList(unknownPaths)} is a source file in the map at ${shortSha(model.sha)}` };
  const visited = new Uint8Array(model.paths.length);
  const queued = [...startIndexes];
  for (const index of startIndexes) visited[index] = 1;
  for (let position = 0; position < queued.length; position++) {
    for (const dependent of neighborsOf(model.dependents, queued[position])) {
      if (visited[dependent]) continue;
      visited[dependent] = 1;
      queued.push(dependent);
    }
  }
  const startSet = new Set(startIndexes);
  const reachedIndexes = queued.filter((index) => !startSet.has(index));
  const reachedPaths = uniqueSorted(reachedIndexes.map((index) => model.paths[index]));
  const entrances = new Set(model.entranceIndexes);
  const lines = [
    `${startIndexes.length} changed files reach ${reachedPaths.length} dependent files`,
    `  modules reached: ${cappedList(uniqueSorted(reachedIndexes.map((index) => model.moduleByIndex[index])))}`,
    `  tests reached: ${cappedList(reachedPaths.filter(isTestPath))}`,
    `  entrances reached: ${cappedList(reachedIndexes.filter((index) => entrances.has(index)).map((index) => model.paths[index]).sort(compareText))}`,
    `  dependent files: ${cappedList(reachedPaths.filter((reachedPath) => !isTestPath(reachedPath)))}`,
  ];
  if (unknownPaths.length > 0) lines.push(`  not in the map: ${cappedList(unknownPaths)}`);
  if (model.skippedPaths.size > 0) lines.push(`  not traced, skipped over the size or count caps: ${cappedList([...model.skippedPaths])}`);
  return { ok: true, text: lines.join('\n') };
}

const MAP_BOX_SPACING = Object.freeze({ x: 320, y: 200 });
const GENERATED_ID_MAX_LENGTH = 40;
const GENERATED_HASH_LENGTH = 8;

function generatedIdOf(prefix: string, displayPath: string, identity: string): string {
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, GENERATED_HASH_LENGTH);
  const slugRoom = GENERATED_ID_MAX_LENGTH - prefix.length - hash.length - 1;
  const slug = displayPath.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(-slugRoom).replace(/^-+|-+$/g, '');
  return slug ? `${prefix}${slug}-${hash}` : `${prefix}${hash}`;
}

function moduleBoxIdOf(moduleId: string): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, moduleId === ROOT_MODULE ? 'root' : moduleId, moduleId);
}

function boardTitleOf(text: string): string {
  return text.slice(-WHITEBOARD_LIMITS.title);
}

function fieldsToRefresh(element: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(element).filter(([field]) => field !== 'kind' && field !== 'id' && field !== 'place'));
}

function mapBoardOpsOf(model: CodemapModel, existingKindById: ReadonlyMap<string, string>): Record<string, unknown>[] {
  const columnCount = Math.max(1, Math.ceil(Math.sqrt(model.modules.length)));
  const boxes = model.modules.map((summary, index) => ({
    kind: 'box',
    id: moduleBoxIdOf(summary.id),
    title: boardTitleOf(summary.id === ROOT_MODULE ? 'repo root' : summary.id),
    lines: [{ text: `${summary.fileCount} files, imported by ${summary.importedBy} modules`, muted: true }],
    refs: summary.id !== ROOT_MODULE && AnchorRef.safeParse(summary.id).success ? [summary.id] : [],
    place: { at: { x: (index % columnCount) * MAP_BOX_SPACING.x, y: Math.floor(index / columnCount) * MAP_BOX_SPACING.y } },
  }));
  const wires = [...model.edgesByModule.values()].flat().map((edge) => ({
    kind: 'wire', id: generatedIdOf(CODEMAP_ID_PREFIXES.map, edge.to, `${edge.from}\n${edge.to}`), from: moduleBoxIdOf(edge.from), to: moduleBoxIdOf(edge.to), label: `${edge.fileImports}`,
  }));
  const producedIds = new Set([STAMP_BOX_ID, ...[...boxes, ...wires].map((element) => element.id)]);
  const staleIds = [...existingKindById.keys()].filter((id) => id.startsWith(CODEMAP_ID_PREFIXES.map) && !producedIds.has(id));
  const staleWireRemovals = staleIds.filter((id) => existingKindById.get(id) === 'wire').map((id) => ({ op: 'remove', id }));
  const staleBoxRemovals = staleIds.filter((id) => existingKindById.get(id) !== 'wire').map((id) => ({ op: 'remove', id }));
  const writes = [...boxes, ...wires].map((element) => (existingKindById.has(element.id) ? { op: 'set', id: element.id, fields: fieldsToRefresh(element) } : { op: 'add', element }));
  return [...staleWireRemovals, ...staleBoxRemovals, ...writes];
}

const STAMP_BOX_ID = generatedIdOf(CODEMAP_ID_PREFIXES.map, 'map stamp', String.fromCharCode(0));
const STAMP_TONE_BY_STATE: Record<CodemapStatus['state'], string> = { current: 'green', behind: 'yellow', failed: 'pink' };

function stampLinesOf(status: CodemapStatus): { text: string }[] {
  const lines = [{ text: `mainline is ${shortSha(status.mainlineSha)}` }];
  if (status.reason) lines.push({ text: status.reason.slice(0, WHITEBOARD_LIMITS.line) });
  return lines;
}

function mapStampOpsOf(status: CodemapStatus, existingKindById: ReadonlyMap<string, string>): Record<string, unknown>[] {
  const stamp = {
    kind: 'box', id: STAMP_BOX_ID, title: `Map at ${shortSha(status.sha)}: ${status.state}`, lines: stampLinesOf(status), tone: STAMP_TONE_BY_STATE[status.state],
    place: { at: { x: 0, y: -MAP_BOX_SPACING.y } },
  };
  return [existingKindById.has(STAMP_BOX_ID) ? { op: 'set', id: STAMP_BOX_ID, fields: fieldsToRefresh(stamp) } : { op: 'add', element: stamp }];
}

function codemapNoticeOf(repoName: string, status: CodemapStatus): string {
  const mapAt = `Code map of ${repoName} at ${shortSha(status.sha)}`;
  if (status.state === 'failed') return `${mapAt}, the last run failed: ${status.reason ?? 'no reason given'}; codemap map shows the last good map.`;
  return `${mapAt}, ${status.state} (mainline is ${shortSha(status.mainlineSha)}); read it with codemap map.`;
}

export { buildCodemapModel, codemapNoticeOf, impactOf, mapBoardOpsOf, mapStampOpsOf, mapTextOf, whereOf };
export type { CodemapModel };
