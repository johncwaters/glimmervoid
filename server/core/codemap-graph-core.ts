import crypto from 'node:crypto';
import path from 'node:path';

import type { CodemapAllowEntry, CodemapExportKind, CodemapExtract, CodemapModuleEdge, CodemapSetup, CodemapStatus, DesignSpecUnit } from '../../shared/contracts/codemap.ts';
import { AnchorRef, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import { CODEMAP_ID_PREFIXES } from '../../shared/whiteboard-ops-core.ts';
import { isTestPath, TEST_PATH_PATTERN } from './import-graph-core.ts';

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
  valueImports: AdjacencyList;
  dependents: AdjacencyList;
  outsideGraphImportsByIndex: readonly (readonly { specifier: string; targetPath: string | null }[])[];
  typeOnlySpecifiersByIndex: readonly (readonly string[])[];
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

function fixedModulesOf(repoPaths: readonly string[], moduleLayout: readonly string[]): Map<string, string> {
  const longestFirst = [...moduleLayout].filter((moduleId) => moduleId !== ROOT_MODULE).sort((left, right) => right.length - left.length);
  return new Map(repoPaths.map((repoPath) => [repoPath, longestFirst.find((moduleId) => repoPath.startsWith(`${moduleId}/`)) ?? ROOT_MODULE]));
}

function buildCodemapModel(extract: CodemapExtract, moduleLayout: readonly string[] | null = null): CodemapModel {
  const { paths } = extract;
  const moduleByPath = moduleLayout ? fixedModulesOf(paths, moduleLayout) : rollUpModules(paths, CODEMAP_TUNABLES.maxFilesPerModule);
  const moduleByIndex = paths.map((repoPath) => moduleByPath.get(repoPath) ?? ROOT_MODULE);
  const imports = adjacencyOf(paths.length, extract.importerIndexes, extract.importedIndexes);
  const dependents = adjacencyOf(paths.length, extract.importedIndexes, extract.importerIndexes);
  const valueEdgeIndexes = [...extract.typeOnlyEdges.keys()].filter((edgeIndex) => extract.typeOnlyEdges[edgeIndex] === 0);
  const valueImports = adjacencyOf(paths.length, Int32Array.from(valueEdgeIndexes, (edgeIndex) => extract.importerIndexes[edgeIndex]), Int32Array.from(valueEdgeIndexes, (edgeIndex) => extract.importedIndexes[edgeIndex]));
  const moduleIdsLongestFirst = [...new Set(moduleByIndex)].filter((moduleId) => moduleId !== ROOT_MODULE).sort((left, right) => right.length - left.length);
  const moduleOfTarget = (targetPath: string) => moduleByPath.get(targetPath) ?? moduleIdsLongestFirst.find((moduleId) => targetPath.startsWith(`${moduleId}/`)) ?? ROOT_MODULE;
  const outsideModulePairs = extract.outsideGraphImportsByIndex.flatMap((outsideImports, importerIndex) => outsideImports.flatMap(({ targetPath }) => (targetPath === null ? [] : [[moduleByIndex[importerIndex], moduleOfTarget(targetPath)] as const])));
  const graphModulePairs = [...extract.importerIndexes.keys()].map((edgeIndex) => [moduleByIndex[extract.importerIndexes[edgeIndex]], moduleByIndex[extract.importedIndexes[edgeIndex]]] as const);
  const fileImportsByEdgeKey = new Map<string, ModuleEdge>();
  for (const [from, to] of [...graphModulePairs, ...outsideModulePairs]) {
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
    valueImports,
    dependents,
    outsideGraphImportsByIndex: extract.outsideGraphImportsByIndex,
    typeOnlySpecifiersByIndex: extract.typeOnlySpecifiersByIndex,
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

function mapBodyLinesOf(model: CodemapModel): string[] {
  const lines = [`${model.modules.length} modules, ${model.paths.length} source files, ${model.moduleEdgeCount} module edges, ${model.entranceIndexes.length} entrances (files nothing imports)`];
  if (model.skippedPaths.size > 0) lines.push(`${model.skippedPaths.size} source files skipped over the size or count caps, so their imports are missing: ${cappedList([...model.skippedPaths])}`);
  lines.push('modules (file count, imported by N modules): imported modules with file import counts');
  for (const summary of model.modules.slice(0, CODEMAP_TUNABLES.listedModules)) {
    lines.push(`${summary.id} (${summary.fileCount}, in ${summary.importedBy}): ${cappedList((model.edgesByModule.get(summary.id) ?? []).map((edge) => `${edge.to} ${edge.fileImports}`))}`);
  }
  if (model.modules.length > CODEMAP_TUNABLES.listedModules) lines.push(`and ${model.modules.length - CODEMAP_TUNABLES.listedModules} more modules`);
  const cycles = moduleCyclesOf(moduleEdgesOf(model));
  if (cycles.length > 0) lines.push(`module cycles (modules that import each other): ${cycles.map((modules) => modules.join(' <-> ')).join('; ')}`);
  return lines;
}

function mapTextOf(model: CodemapModel | null, status: CodemapStatus, repoName: string): string {
  const statusLine = statusLineOf(repoName, status);
  if (!model) return statusLine;
  return [statusLine, ...mapBodyLinesOf(model), 'Ask codemap where <path or exported name> for one file, or codemap impact <paths> for what a change reaches.'].join('\n');
}

const CODEMAP_EXPORT_FILE_BY_KIND: Record<CodemapExportKind, string> = { lint: '.dependency-cruiser.cjs', map: 'CODEMAP.md' };
const EXTERNAL_DEPENDENCY_TYPES = ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown', 'deprecated', 'core', 'unknown', 'undetermined'];
const CODEMAP_EXPORT_FORMAT = 1;
const EXPORT_MARKER = `Written by glimmervoid codemap export, format ${CODEMAP_EXPORT_FORMAT}.`;
const EXPORT_MARKER_FORMAT = /Written by glimmervoid codemap export, format (\d+)\./;

function exportedMapTextOf(model: CodemapModel): string {
  const fence = '`'.repeat(3);
  return ['# Code map', '', `${EXPORT_MARKER} It maps the committed source; with this export on, codemap check refuses a push that leaves it out of date.`, '', `${fence}text`, ...mapBodyLinesOf(model), fence, ''].join('\n');
}

function isExportWrittenText(text: string): boolean {
  return EXPORT_MARKER_FORMAT.test(text);
}

interface ExportVerdict {
  refusal: string | null;
  note: string | null;
}

function exportVerdictOf(kind: CodemapExportKind, committedText: string | null, expectedText: string): ExportVerdict {
  const fileName = CODEMAP_EXPORT_FILE_BY_KIND[kind];
  const remedy = `run codemap export ${kind} and commit ${fileName}`;
  if (committedText === expectedText) return { refusal: null, note: null };
  if (committedText === null) return { refusal: `${fileName} is missing at the branch head; ${remedy}`, note: null };
  const committedFormat = EXPORT_MARKER_FORMAT.exec(committedText)?.[1];
  if (committedFormat !== undefined && Number(committedFormat) !== CODEMAP_EXPORT_FORMAT) return { refusal: null, note: `${fileName} was written in export format ${committedFormat} and this Glimmervoid writes format ${CODEMAP_EXPORT_FORMAT}, so it is not judged; ${remedy}` };
  return { refusal: `${fileName} at the branch head does not match ${kind === 'map' ? 'its code map' : 'the code map setup'}; ${remedy}`, note: null };
}

function escapedPatternOf(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function modulePathRuleOf(moduleId: string, moduleIds: readonly string[]): { path?: string; pathNot?: string } {
  const nestedModules = moduleIds.filter((other) => other !== moduleId && other !== ROOT_MODULE && (moduleId === ROOT_MODULE || other.startsWith(`${moduleId}/`)));
  const excluded = nestedModules.length > 0 ? { pathNot: `^(${nestedModules.map(escapedPatternOf).join('|')})/` } : {};
  if (moduleId === ROOT_MODULE) return excluded;
  return { path: `^${escapedPatternOf(moduleId)}/`, ...excluded };
}

function lintConfigTextOf(setup: CodemapSetup): string {
  const moduleIds = [...new Set([ROOT_MODULE, ...setup.modules, ...setup.allow.flatMap((entry) => [entry.from, entry.to])])].sort(compareText);
  const allowed = [
    { comment: 'packages and runtime built-ins', from: {}, to: { dependencyTypes: EXTERNAL_DEPENDENCY_TYPES } },
    { comment: 'type-only imports', from: {}, to: { dependencyTypes: ['type-only'] } },
    { comment: 'imports from tests', from: { path: TEST_PATH_PATTERN }, to: {} },
    ...moduleIds.map((moduleId) => ({ comment: `within ${moduleId}`, from: modulePathRuleOf(moduleId, moduleIds), to: modulePathRuleOf(moduleId, moduleIds) })),
    ...setup.allow.map((entry) => ({
      comment: entry.origin === 'allowed' ? `${entry.from} -> ${entry.to}, allowed ${entry.date}: ${entry.reason}` : `${entry.from} -> ${entry.to}, on mainline when setup seeded it`,
      from: modulePathRuleOf(entry.from, moduleIds),
      to: modulePathRuleOf(entry.to, moduleIds),
    })),
  ];
  const config = { allowed, allowedSeverity: 'error', options: { tsPreCompilationDeps: true, doNotFollow: { path: 'node_modules' } } };
  return `// ${EXPORT_MARKER}\nmodule.exports = ${JSON.stringify(config, null, 2)};\n`;
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

interface MapDecorations {
  churnByModule: ReadonlyMap<string, number> | null;
  overlaidModules: ReadonlySet<string>;
}

const OVERLAY_TONE = 'violet';

function moduleOfPath(model: CodemapModel, repoPath: string): string {
  const index = model.indexByPath.get(repoPath);
  if (index !== undefined) return model.moduleByIndex[index];
  const owningModules = model.modules.map((summary) => summary.id).filter((moduleId) => moduleId !== ROOT_MODULE && repoPath.startsWith(`${moduleId}/`));
  return owningModules.sort((left, right) => right.length - left.length)[0] ?? ROOT_MODULE;
}

function churnByModuleOf(model: CodemapModel, commits: readonly { paths: readonly string[] }[]): Map<string, number> {
  const churnByModule = new Map<string, number>();
  for (const commit of commits) {
    for (const moduleId of new Set(commit.paths.map((repoPath) => moduleOfPath(model, repoPath)))) churnByModule.set(moduleId, (churnByModule.get(moduleId) ?? 0) + 1);
  }
  return churnByModule;
}

function moduleLinesOf(summary: ModuleSummary, churnByModule: ReadonlyMap<string, number> | null): { text: string; muted: boolean }[] {
  const sizeLine = { text: `${summary.fileCount} files, imported by ${summary.importedBy} modules`, muted: true };
  if (!churnByModule) return [sizeLine];
  return [sizeLine, { text: `changed by ${churnByModule.get(summary.id) ?? 0} recent commits`, muted: true }];
}

function mapBoardOpsOf(model: CodemapModel, existingKindById: ReadonlyMap<string, string>, { churnByModule, overlaidModules }: MapDecorations): Record<string, unknown>[] {
  const columnCount = Math.max(1, Math.ceil(Math.sqrt(model.modules.length)));
  const boxes = model.modules.map((summary, index) => ({
    kind: 'box',
    id: moduleBoxIdOf(summary.id),
    title: boardTitleOf(summary.id === ROOT_MODULE ? 'repo root' : summary.id),
    lines: moduleLinesOf(summary, churnByModule),
    tone: overlaidModules.has(summary.id) ? OVERLAY_TONE : null,
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

const OVERLAY_STAMP_ID = generatedIdOf(CODEMAP_ID_PREFIXES.overlay, 'overlay stamp', String.fromCharCode(0));

interface MapOverlay {
  title: string;
  lines: readonly string[];
}

function overlayOpsOf(overlay: MapOverlay | null, existingKindById: ReadonlyMap<string, string>): Record<string, unknown>[] {
  const staleRemovals = [...existingKindById.keys()].filter((id) => id.startsWith(CODEMAP_ID_PREFIXES.overlay) && (overlay === null || id !== OVERLAY_STAMP_ID)).map((id) => ({ op: 'remove', id }));
  if (!overlay) return staleRemovals;
  const stamp = {
    kind: 'box', id: OVERLAY_STAMP_ID, title: boardTitleOf(overlay.title), lines: overlay.lines.slice(0, WHITEBOARD_LIMITS.linesPerBox).map((text) => ({ text: text.slice(0, WHITEBOARD_LIMITS.line) })), tone: OVERLAY_TONE,
    place: { at: { x: MAP_BOX_SPACING.x, y: -MAP_BOX_SPACING.y } },
  };
  return [...staleRemovals, existingKindById.has(OVERLAY_STAMP_ID) ? { op: 'set', id: OVERLAY_STAMP_ID, fields: fieldsToRefresh(stamp) } : { op: 'add', element: stamp }];
}

interface SpecPlan {
  slug: string;
  units: readonly DesignSpecUnit[];
  dependsOn: readonly { from: string; to: string }[];
  landedUnitIds: ReadonlySet<string>;
}

function specStepIdOf(slug: string, unitId: string): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.steps, `${slug}-${unitId}`, `${slug}\n${unitId}`);
}

function specPlanOpsOf(model: CodemapModel, plan: SpecPlan | null, existingKindById: ReadonlyMap<string, string>): { removals: Record<string, unknown>[]; writes: Record<string, unknown>[] } {
  const moduleIds = new Set(model.modules.map((summary) => summary.id));
  const unitIds = new Set(plan?.units.map((unit) => unit.id) ?? []);
  const steps = (plan?.units ?? []).map((unit) => ({
    kind: 'box',
    id: specStepIdOf(plan?.slug ?? '', unit.id),
    title: `${unit.id} ${unit.title}`.slice(0, WHITEBOARD_LIMITS.title),
    lines: [{ text: `changes ${unit.changes.length} files`, muted: true }],
    refs: unit.changes.filter((change) => AnchorRef.safeParse(change).success).slice(0, WHITEBOARD_LIMITS.refsPerElement),
    place: 'plan',
    step: { status: plan?.landedUnitIds.has(unit.id) ? 'landed' : 'planned' },
  }));
  const orderWires = (plan?.dependsOn ?? []).filter((edge) => unitIds.has(edge.from) && unitIds.has(edge.to)).map((edge) => ({
    kind: 'wire', id: generatedIdOf(CODEMAP_ID_PREFIXES.steps, edge.from, `${plan?.slug}\n${edge.to}\n${edge.from}`), from: specStepIdOf(plan?.slug ?? '', edge.to), to: specStepIdOf(plan?.slug ?? '', edge.from),
  }));
  const moduleWires = (plan?.units ?? []).flatMap((unit) => [...new Set(unit.changes.map((change) => moduleOfPath(model, change)))].filter((moduleId) => moduleIds.has(moduleId)).map((moduleId) => ({
    kind: 'wire', id: generatedIdOf(CODEMAP_ID_PREFIXES.steps, `${unit.id}-${moduleId}`, `${plan?.slug}\n${unit.id}\n${moduleId}`), from: specStepIdOf(plan?.slug ?? '', unit.id), to: moduleBoxIdOf(moduleId), dashed: true, arrows: 'none',
  })));
  const produced = [...steps, ...orderWires, ...moduleWires];
  const producedIds = new Set(produced.map((element) => element.id));
  const staleIds = [...existingKindById.keys()].filter((id) => id.startsWith(CODEMAP_ID_PREFIXES.steps) && !producedIds.has(id));
  const removals = [...staleIds.filter((id) => existingKindById.get(id) === 'wire'), ...staleIds.filter((id) => existingKindById.get(id) !== 'wire')].map((id) => ({ op: 'remove', id }));
  const writes = produced.map((element) => {
    if (!existingKindById.has(element.id)) return { op: 'add', element };
    const fields = fieldsToRefresh(element);
    const isLanded = 'step' in element && element.step.status === 'landed';
    return { op: 'set', id: element.id, fields: isLanded ? fields : Object.fromEntries(Object.entries(fields).filter(([field]) => field !== 'step')) };
  });
  return { removals, writes };
}

function codemapNoticeOf(repoName: string, status: CodemapStatus): string {
  const mapAt = `Code map of ${repoName} at ${shortSha(status.sha)}`;
  if (status.state === 'failed') return `${mapAt}, the last run failed: ${status.reason ?? 'no reason given'}; codemap map shows the last good map.`;
  return `${mapAt}, ${status.state} (mainline is ${shortSha(status.mainlineSha)}); read it with codemap map.`;
}

interface UnallowedEdge {
  from: string;
  to: string;
  fileImports: string[];
}

function edgeKeyOf(from: string, to: string): string {
  return `${from}\n${to}`;
}

function isJudgedImporter(model: CodemapModel, importerIndex: number): boolean {
  if (!isTestPath(model.paths[importerIndex])) return true;
  return [...neighborsOf(model.dependents, importerIndex)].some((dependentIndex) => !isTestPath(model.paths[dependentIndex]));
}

function judgedModuleImportsOf(model: CodemapModel, importerPaths: Iterable<string>): Map<string, UnallowedEdge> {
  const importsByEdgeKey = new Map<string, UnallowedEdge>();
  for (const importerPath of importerPaths) {
    const importerIndex = model.indexByPath.get(importerPath);
    if (importerIndex === undefined || !isJudgedImporter(model, importerIndex)) continue;
    const from = model.moduleByIndex[importerIndex];
    const graphTargets = [...neighborsOf(model.valueImports, importerIndex)].map((importedIndex) => model.paths[importedIndex]);
    const typeOnlySpecifiers = new Set(model.typeOnlySpecifiersByIndex[importerIndex] ?? []);
    const outsideTargets = (model.outsideGraphImportsByIndex[importerIndex] ?? []).flatMap(({ specifier, targetPath }) => (targetPath === null || typeOnlySpecifiers.has(specifier) ? [] : [targetPath]));
    for (const targetPath of [...graphTargets, ...outsideTargets]) {
      const to = moduleOfPath(model, targetPath);
      if (from === to) continue;
      const edge = importsByEdgeKey.get(edgeKeyOf(from, to)) ?? { from, to, fileImports: [] };
      edge.fileImports.push(`${importerPath} imports ${targetPath}`);
      importsByEdgeKey.set(edgeKeyOf(from, to), edge);
    }
  }
  return importsByEdgeKey;
}

function unallowedEdgesOf(model: CodemapModel, changedPaths: ReadonlySet<string>, allowed: readonly CodemapModuleEdge[]): UnallowedEdge[] {
  const allowedKeys = new Set(allowed.map((edge) => edgeKeyOf(edge.from, edge.to)));
  return [...judgedModuleImportsOf(model, changedPaths).values()]
    .filter((edge) => !allowedKeys.has(edgeKeyOf(edge.from, edge.to)))
    .sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));
}

function moduleCyclesOf(edges: readonly CodemapModuleEdge[]): string[][] {
  const targetsByModule = new Map<string, string[]>();
  for (const edge of edges) targetsByModule.set(edge.from, [...(targetsByModule.get(edge.from) ?? []), edge.to]);
  const moduleIds = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort(compareText);
  const visitOrderByModule = new Map<string, number>();
  const lowLinkByModule = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const visit = (moduleId: string): void => {
    visitOrderByModule.set(moduleId, visitOrderByModule.size);
    lowLinkByModule.set(moduleId, visitOrderByModule.get(moduleId) ?? 0);
    stack.push(moduleId);
    onStack.add(moduleId);
    for (const target of targetsByModule.get(moduleId) ?? []) {
      if (!visitOrderByModule.has(target)) visit(target);
      if (onStack.has(target)) lowLinkByModule.set(moduleId, Math.min(lowLinkByModule.get(moduleId) ?? 0, lowLinkByModule.get(target) ?? 0));
    }
    if (lowLinkByModule.get(moduleId) !== visitOrderByModule.get(moduleId)) return;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.push(member);
      if (member === moduleId) break;
    }
    if (component.length > 1) cycles.push(component.sort(compareText));
  };
  for (const moduleId of moduleIds) if (!visitOrderByModule.has(moduleId)) visit(moduleId);
  return cycles.sort((left, right) => compareText(left[0] ?? '', right[0] ?? ''));
}

interface NewCycle {
  modules: readonly string[];
  newEdges: readonly CodemapModuleEdge[];
}

function newCyclesOf(headModel: CodemapModel, mainlineModel: CodemapModel): NewCycle[] {
  const mainlineEdgeKeys = new Set(judgedModuleImportsOf(mainlineModel, mainlineModel.paths).keys());
  const headEdges = [...judgedModuleImportsOf(headModel, headModel.paths).values()];
  return moduleCyclesOf(headEdges).flatMap((modules) => {
    const members = new Set(modules);
    const newEdges = headEdges.filter((edge) => members.has(edge.from) && members.has(edge.to) && !mainlineEdgeKeys.has(edgeKeyOf(edge.from, edge.to)))
      .map(({ from, to }) => ({ from, to })).sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to));
    return newEdges.length > 0 ? [{ modules, newEdges }] : [];
  });
}

function moduleEdgesOf(model: CodemapModel): CodemapModuleEdge[] {
  return [...model.edgesByModule.values()].flat().map(({ from, to }) => ({ from, to }));
}

function staleAllowedEdgesOf(model: CodemapModel, allowed: readonly CodemapModuleEdge[]): CodemapModuleEdge[] {
  const presentKeys = new Set(moduleEdgesOf(model).map((edge) => edgeKeyOf(edge.from, edge.to)));
  return allowed.filter((edge) => !presentKeys.has(edgeKeyOf(edge.from, edge.to)));
}

function shrunkAllowListOf(model: CodemapModel, allow: readonly CodemapAllowEntry[]): { allow: CodemapAllowEntry[]; dropped: CodemapAllowEntry[] } {
  const mainlineEdgeKeys = new Set(moduleEdgesOf(model).map((edge) => edgeKeyOf(edge.from, edge.to)));
  const isOnMainline = (entry: CodemapAllowEntry) => mainlineEdgeKeys.has(edgeKeyOf(entry.from, entry.to));
  const isDroppable = (entry: CodemapAllowEntry) => !isOnMainline(entry) && (entry.origin === 'seeded' || entry.landed);
  const kept = allow.filter((entry) => !isDroppable(entry)).map((entry) => (entry.origin === 'allowed' && isOnMainline(entry) ? { ...entry, landed: true } : entry));
  return { allow: kept, dropped: allow.filter(isDroppable) };
}

function unresolvedImportsOf(model: CodemapModel, changedPaths: ReadonlySet<string>): string[] {
  return [...changedPaths].sort(compareText).flatMap((changedPath) => {
    const index = model.indexByPath.get(changedPath);
    if (index === undefined || !isJudgedImporter(model, index)) return [];
    return (model.outsideGraphImportsByIndex[index] ?? []).flatMap(({ specifier, targetPath }) => (targetPath === null ? [`${changedPath} imports ${specifier}`] : []));
  });
}

function unjudgedPathsOf(model: CodemapModel, changedPaths: ReadonlySet<string>): string[] {
  return [...changedPaths].filter((changedPath) => model.skippedPaths.has(changedPath)).sort(compareText);
}

interface CheckFindings {
  unallowedEdges: readonly UnallowedEdge[];
  unjudgedPaths: readonly string[];
  unresolvedImports: readonly string[];
  newCycles: readonly NewCycle[];
  staleExports: readonly string[];
  exportNotes: readonly string[];
  staleAllowedEdges: readonly CodemapModuleEdge[];
}

function isCheckRefusing(findings: CheckFindings): boolean {
  return findings.unallowedEdges.length > 0 || findings.unjudgedPaths.length > 0 || findings.unresolvedImports.length > 0 || findings.newCycles.length > 0 || findings.staleExports.length > 0;
}

function checkTextOf(repoName: string, findings: CheckFindings, gateNote: string | null): string {
  const { unallowedEdges, unjudgedPaths, unresolvedImports, newCycles, staleExports, exportNotes, staleAllowedEdges } = findings;
  const noteLines = exportNotes.map((note) => `  ${note}`);
  const staleLines = staleAllowedEdges.length > 0 ? [`  allowed module imports this branch no longer has, which codemap shrink drops once mainline lacks them too: ${cappedList(staleAllowedEdges.map((edge) => `${edge.from} -> ${edge.to}`))}`] : [];
  if (!isCheckRefusing(findings)) return [...noteLines, ...staleLines, `codemap check: no new module import in ${repoName} needs allowing.`].join('\n');
  const edgeLines = unallowedEdges.flatMap((edge) => [
    `  ${edge.from} -> ${edge.to} is not allowed for this repo; ask the operator to allow it (glimmervoid codemap allow <repo> ${edge.from} ${edge.to} --reason <why>)`,
    ...edge.fileImports.slice(0, CODEMAP_TUNABLES.listedPathsPerSection).map((fileImport) => `    ${fileImport}`),
  ]);
  const unjudgedLine = unjudgedPaths.length > 0 ? [`  changed files over the size or count caps, so their imports cannot be judged: ${cappedList(unjudgedPaths)}`] : [];
  const unresolvedLine = unresolvedImports.length > 0 ? [`  relative imports that resolve to no file in the repo, so they cannot be judged: ${cappedList(unresolvedImports)}`] : [];
  const cycleLines = newCycles.map((cycle) => `  module cycle ${cycle.modules.join(', ')} holds module imports mainline does not have, which no allow excuses; break the cycle: ${cycle.newEdges.map((edge) => `${edge.from} -> ${edge.to}`).join(', ')}`);
  const edgeNames = unallowedEdges.map((edge) => `${edge.from} -> ${edge.to}`).join(', ');
  const summaryParts = [
    edgeNames ? `adds module imports the operator has not allowed: ${edgeNames}` : '',
    unjudgedPaths.length > 0 ? `changes ${unjudgedPaths.length} files too large to judge` : '',
    unresolvedImports.length > 0 ? `has ${unresolvedImports.length} relative imports that resolve to no file` : '',
    newCycles.length > 0 ? `has ${newCycles.length} module cycles mainline does not have` : '',
    staleExports.length > 0 ? `has ${staleExports.length} out of date exports` : '',
  ].filter(Boolean);
  const exportLines = staleExports.map((refusal) => `  ${refusal}`);
  return [...edgeLines, ...unjudgedLine, ...unresolvedLine, ...cycleLines, ...exportLines, ...noteLines, ...staleLines, ...(gateNote ? [gateNote] : []), `codemap check: ${repoName} ${summaryParts.join('; ')}`].join('\n');
}

export { CODEMAP_EXPORT_FILE_BY_KIND, buildCodemapModel, checkTextOf, exportedMapTextOf, exportVerdictOf, isExportWrittenText, lintConfigTextOf, churnByModuleOf, moduleOfPath, overlayOpsOf, specPlanOpsOf, shrunkAllowListOf, staleAllowedEdgesOf, isCheckRefusing, newCyclesOf, unjudgedPathsOf, unresolvedImportsOf, codemapNoticeOf, moduleEdgesOf, unallowedEdgesOf, impactOf, mapBoardOpsOf, mapStampOpsOf, mapTextOf, whereOf };
export type { CodemapModel, MapDecorations, MapOverlay, SpecPlan };
