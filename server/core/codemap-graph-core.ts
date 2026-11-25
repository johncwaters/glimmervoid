import crypto from 'node:crypto';
import path from 'node:path';

import type { CodemapAllowEntry, CodemapExportKind, CodemapExtract, CodemapModuleEdge, CodemapSetup, CodemapStatus, DesignSpecUnit } from '../../shared/contracts/codemap.ts';
import { CODEMAP_SETUP_VERSION, moduleImportAllowsOf, structureAllowsOf } from '../../shared/contracts/codemap.ts';
import { AnchorRef, Element, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoxMedia, Op } from '../../shared/contracts/whiteboard.ts';
import { CODEMAP_ID_PREFIXES, noteBoxTextOf } from '../../shared/contracts/whiteboard-ops-core.ts';
import { MARGIN as BOARD_MARGIN } from '../../shared/whiteboard-layout-core.ts';
import { REPO_ROOT_BRANCH_TITLE } from '../../shared/board-branch-core.ts';
import { isTestPath, TEST_PATH_PATTERN } from './import-graph-core.ts';
import { IMPORT_LANGUAGE_IDS, importLanguageOf } from './import-language-core.ts';
import type { GrownShallowModule, ShallowModule, Tangle, UnjudgedLanguage } from './codemap-structure-core.ts';

export const CODEMAP_TUNABLES = Object.freeze({
  maxFilesPerModule: 40,
  maxSourceFiles: 50_000,
  maxFileBytes: 512 * 1024,
  maxSourceBytes: 128 * 1024 * 1024,
  maxImportEdges: 2_000_000,
  workerHeapMb: 512,
  extractDeadlineMs: 120_000,
  grammarParseBudgetMs: 1_000,
  grammarScanBudgetMs: 30_000,
  failureRetryMs: 60_000,
  listedPathsPerSection: 30,
  listedModules: 300,
  maxTangleSymbols: 7,
  maxShownSymbols: 7,
  indexDeadlineMs: 600_000,
  indexerInstallDeadlineMs: 300_000,
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
  if (model.skippedPaths.size > 0) lines.push(`${model.skippedPaths.size} source files skipped over the size, count or parse time caps, so their imports are missing: ${cappedList([...model.skippedPaths])}`);
  lines.push('modules (file count, imported by N modules): imported modules with file import counts');
  for (const summary of model.modules.slice(0, CODEMAP_TUNABLES.listedModules)) {
    lines.push(`${summary.id} (${summary.fileCount}, in ${summary.importedBy}): ${cappedList((model.edgesByModule.get(summary.id) ?? []).map((edge) => `${edge.to} ${edge.fileImports}`))}`);
  }
  if (model.modules.length > CODEMAP_TUNABLES.listedModules) lines.push(`and ${model.modules.length - CODEMAP_TUNABLES.listedModules} more modules`);
  const cycles = moduleCyclesOf(moduleEdgesOf(model));
  if (cycles.length > 0) lines.push(`module cycles (modules that import each other): ${cycles.map((modules) => modules.join(' <-> ')).join('; ')}`);
  const crossedWires = crossedWiresOf(model);
  if (crossedWires.length > 0) lines.push(`crossed wires (the lighter direction of two modules that import each other, cheapest first; each may lose file imports, never gain them): ${cappedList(crossedWires.map((wire) => `${wire.from} -> ${wire.to} ${wire.fileImports.length} (${wire.fileImports.slice(0, CROSSED_WIRE_LISTED_IMPORTS).join('; ')})`))}`);
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
  const moduleImportAllows = moduleImportAllowsOf(setup.allow);
  const moduleIds = [...new Set([ROOT_MODULE, ...setup.modules, ...moduleImportAllows.flatMap((entry) => [entry.from, entry.to])])].sort(compareText);
  const allowed = [
    { comment: 'packages and runtime built-ins', from: {}, to: { dependencyTypes: EXTERNAL_DEPENDENCY_TYPES } },
    { comment: 'type-only imports', from: {}, to: { dependencyTypes: ['type-only'] } },
    { comment: 'imports from tests', from: { path: TEST_PATH_PATTERN }, to: {} },
    ...moduleIds.map((moduleId) => ({ comment: `within ${moduleId}`, from: modulePathRuleOf(moduleId, moduleIds), to: modulePathRuleOf(moduleId, moduleIds) })),
    ...moduleImportAllows.map((entry) => ({
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
  if (model.skippedPaths.has(repoPath)) return { ok: true, text: `${repoPath} is skipped over the size, count or parse time caps, so the map at ${shortSha(model.sha)} holds none of its imports or exports` };
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
  if (model.skippedPaths.size > 0) lines.push(`  not traced, skipped over the size, count or parse time caps: ${cappedList([...model.skippedPaths])}`);
  return { ok: true, text: lines.join('\n') };
}

const MAP_BOX_SPACING = Object.freeze({ x: 320, y: 200 });
const MAP_TOP = BOARD_MARGIN + MAP_BOX_SPACING.y;
const GENERATED_ID_MAX_LENGTH = 40;
const GENERATED_HASH_LENGTH = 8;

const REPO_TAG_LENGTH = 6;

type RepoKey = string;

interface MapArea {
  repoKey: RepoKey;
  title: string;
  origin: { x: number; y: number };
  isFolded: boolean;
  hasRedWiresElsewhere: boolean;
}

function repoIdPrefixOf(prefix: string, repoKey: RepoKey): string {
  return `${prefix}${crypto.createHash('sha256').update(repoKey).digest('hex').slice(0, REPO_TAG_LENGTH)}-`;
}

function generatedIdOf(prefix: string, repoKey: RepoKey, displayPath: string, identity: string): string {
  const repoPrefix = repoIdPrefixOf(prefix, repoKey);
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, GENERATED_HASH_LENGTH);
  const slugRoom = GENERATED_ID_MAX_LENGTH - repoPrefix.length - hash.length - 1;
  const slug = displayPath.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(-slugRoom).replace(/^-+|-+$/g, '');
  return slug ? `${repoPrefix}${slug}-${hash}` : `${repoPrefix}${hash}`;
}

function rootBoxIdOf(repoKey: RepoKey): string {
  return moduleBoxIdOf(repoKey, ROOT_MODULE);
}

function repoBoxIdOfUnscopedBox(repoKey: RepoKey, unscopedBox: { id: string; title: string }): string {
  const identityHash = unscopedBox.id.slice(-GENERATED_HASH_LENGTH);
  const pathParts = unscopedBox.title.split('/');
  const pathAndFolders = pathParts.map((_part, partCount) => pathParts.slice(0, pathParts.length - partCount).join('/'));
  const candidateIds = [folderCardIdOf(repoKey, unscopedBox.title), ...pathAndFolders.map((moduleId) => moduleBoxIdOf(repoKey, moduleId))];
  return candidateIds.find((candidateId) => candidateId.endsWith(identityHash)) ?? rootBoxIdOf(repoKey);
}

function stampBoxIdOf(repoKey: RepoKey): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, 'map stamp', String.fromCharCode(0));
}

function matrixBoxIdOf(repoKey: RepoKey): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, 'folder matrix', `matrix${String.fromCharCode(0)}`);
}

function areaFrameIdOf(repoKey: RepoKey): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, 'area', `area${String.fromCharCode(0)}`);
}

function areaCardIdOf(repoKey: RepoKey): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, 'area card', `area card${String.fromCharCode(0)}`);
}

function moduleBoxIdOf(repoKey: RepoKey, moduleId: string): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, moduleId === ROOT_MODULE ? 'root' : moduleId, moduleId);
}

function fallbackBoxIdOf(repoKey: RepoKey, model: CodemapModel): string {
  return model.modules.some((summary) => summary.id === ROOT_MODULE) ? moduleBoxIdOf(repoKey, ROOT_MODULE) : stampBoxIdOf(repoKey);
}

function drawnBoxIdOfPath(repoKey: RepoKey, model: CodemapModel, repoPath: string): string {
  const moduleId = moduleOfPath(model, repoPath);
  return moduleId === ROOT_MODULE ? fallbackBoxIdOf(repoKey, model) : moduleBoxIdOf(repoKey, moduleId);
}

function boardTitleOf(text: string): string {
  return text.slice(-WHITEBOARD_LIMITS.title);
}

function generatedFieldsOf(element: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(element).filter(([field]) => field !== 'kind' && field !== 'id'));
}

function fieldsToRefresh(element: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(generatedFieldsOf(element)).filter(([field]) => field !== 'place'));
}

interface MapDecorations {
  churnByModule: ReadonlyMap<string, number> | null;
  overlaidModules: ReadonlySet<string>;
  folderChoices: ReadonlyMap<string, boolean>;
  matrixMedia: BoxMedia | null;
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

interface WeightedEdge {
  from: string;
  to: string;
  fileImports: readonly string[];
}

interface Levelized {
  levelById: ReadonlyMap<string, number>;
  feedbackKeys: ReadonlySet<string>;
}

function feedbackOrderOf(nodeIds: readonly string[], edges: readonly WeightedEdge[]): string[] {
  const outgoing = new Map(nodeIds.map((id) => [id, new Map<string, number>()]));
  const incoming = new Map(nodeIds.map((id) => [id, new Map<string, number>()]));
  for (const edge of edges) {
    if (edge.from === edge.to || !outgoing.has(edge.from) || !outgoing.has(edge.to)) continue;
    outgoing.get(edge.from)?.set(edge.to, edge.fileImports.length);
    incoming.get(edge.to)?.set(edge.from, edge.fileImports.length);
  }
  const remaining = new Set([...nodeIds].sort(compareText));
  const remainingWeightOf = (links: ReadonlyMap<string, number> | undefined) => [...(links ?? [])].reduce((total, [id, weight]) => total + (remaining.has(id) ? weight : 0), 0);
  const head: string[] = [];
  const tail: string[] = [];
  while (remaining.size > 0) {
    const candidates = [...remaining];
    const sink = candidates.find((id) => remainingWeightOf(outgoing.get(id)) === 0);
    const source = sink === undefined ? candidates.find((id) => remainingWeightOf(incoming.get(id)) === 0) : undefined;
    const surplusOf = (id: string) => remainingWeightOf(outgoing.get(id)) - remainingWeightOf(incoming.get(id));
    const picked = sink ?? source ?? candidates.reduce((chosen, id) => (surplusOf(id) > surplusOf(chosen) ? id : chosen));
    remaining.delete(picked);
    if (picked === sink) tail.unshift(picked);
    if (picked !== sink) head.push(picked);
  }
  const weightBetween = (from: string, to: string) => outgoing.get(from)?.get(to) ?? 0;
  const order = [...head, ...tail];
  for (let isImproved = true; isImproved;) {
    isImproved = false;
    for (let index = 0; index + 1 < order.length; index += 1) {
      const upper = order[index];
      const lower = order[index + 1];
      if (weightBetween(lower, upper) <= weightBetween(upper, lower)) continue;
      order[index] = lower;
      order[index + 1] = upper;
      isImproved = true;
    }
  }
  return order;
}

function levelizedOf(nodeIds: readonly string[], edges: readonly WeightedEdge[]): Levelized {
  const order = feedbackOrderOf(nodeIds, edges);
  const positionById = new Map(order.map((id, position) => [id, position]));
  const isDownward = (edge: WeightedEdge) => (positionById.get(edge.from) ?? 0) < (positionById.get(edge.to) ?? 0);
  const downwardTargetsById = new Map<string, string[]>();
  for (const edge of edges.filter((candidate) => positionById.has(candidate.from) && positionById.has(candidate.to) && isDownward(candidate))) downwardTargetsById.set(edge.from, [...(downwardTargetsById.get(edge.from) ?? []), edge.to]);
  const levelById = new Map<string, number>();
  for (const id of [...order].reverse()) levelById.set(id, Math.max(-1, ...(downwardTargetsById.get(id) ?? []).map((target) => levelById.get(target) ?? 0)) + 1);
  const isUpward = (edge: WeightedEdge) => (levelById.get(edge.from) ?? 0) <= (levelById.get(edge.to) ?? 0);
  const feedbackKeys = new Set(edges.filter((edge) => edge.from !== edge.to && positionById.has(edge.from) && positionById.has(edge.to) && isUpward(edge)).map((edge) => edgeKeyOf(edge.from, edge.to)));
  return { levelById, feedbackKeys };
}

function folderOf(moduleId: string): string {
  return moduleId === ROOT_MODULE ? ROOT_MODULE : moduleId.split('/')[0];
}

interface ModuleLayers {
  judgedEdges: readonly WeightedEdge[];
  folderEdges: readonly WeightedEdge[];
  folders: Levelized;
  modulesByFolder: ReadonlyMap<string, readonly ModuleSummary[]>;
  innerByFolder: ReadonlyMap<string, Levelized>;
}

function moduleLayersOf(model: CodemapModel): ModuleLayers {
  const judgedEdges = [...judgedModuleImportsOf(model, model.paths).values()];
  const modulesByFolder = new Map<string, ModuleSummary[]>();
  for (const summary of model.modules) modulesByFolder.set(folderOf(summary.id), [...(modulesByFolder.get(folderOf(summary.id)) ?? []), summary]);
  const folderEdgeByKey = new Map<string, { from: string; to: string; fileImports: string[] }>();
  for (const edge of judgedEdges) {
    const from = folderOf(edge.from);
    const to = folderOf(edge.to);
    if (from === to) continue;
    const folderEdge = folderEdgeByKey.get(edgeKeyOf(from, to)) ?? { from, to, fileImports: [] };
    folderEdge.fileImports.push(...edge.fileImports);
    folderEdgeByKey.set(edgeKeyOf(from, to), folderEdge);
  }
  const folderEdges = [...folderEdgeByKey.values()];
  const folders = levelizedOf([...modulesByFolder.keys()], folderEdges);
  const innerByFolder = new Map([...modulesByFolder].map(([folder, summaries]) => [folder, levelizedOf(summaries.map((summary) => summary.id), judgedEdges.filter((edge) => folderOf(edge.from) === folder && folderOf(edge.to) === folder))]));
  return { judgedEdges, folderEdges, folders, modulesByFolder, innerByFolder };
}

function folderTitleOf(folder: string): string {
  return folder === ROOT_MODULE ? 'repo root' : `${folder}/`;
}

function folderCardIdOf(repoKey: RepoKey, folder: string): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, `${folder} folder`, `folder\n${folder}`);
}

function branchBoxChoicesOf(repoKey: RepoKey, model: CodemapModel, boxIdOfPath: (repoPath: string) => string): { boxId: string; title: string }[] {
  const folders = [...new Set(model.modules.map((summary) => folderOf(summary.id)))];
  const titleOf = (moduleOrFolder: string) => moduleOrFolder === ROOT_MODULE ? REPO_ROOT_BRANCH_TITLE : moduleOrFolder.slice(-WHITEBOARD_LIMITS.title);
  return [
    ...folders.map((folder) => ({ boxId: folderCardIdOf(repoKey, folder), title: titleOf(folder) })),
    ...model.modules.map((summary) => ({ boxId: moduleBoxIdOf(repoKey, summary.id), title: titleOf(summary.id) })),
    ...model.paths.map((repoPath) => ({ boxId: boxIdOfPath(repoPath), title: repoPath.slice(-WHITEBOARD_LIMITS.title) })),
  ];
}

function folderFrameIdOf(repoKey: RepoKey, folder: string): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, `${folder} frame`, `frame\n${folder}`);
}

function focusModulesOf(layers: ModuleLayers, overlaidModules: ReadonlySet<string>): Set<string> {
  return new Set([...overlaidModules, ...layers.judgedEdges.flatMap((edge) => (overlaidModules.has(edge.from) ? [edge.to] : overlaidModules.has(edge.to) ? [edge.from] : []))]);
}

function openFoldersOf(focusModules: ReadonlySet<string>, folderChoices: ReadonlyMap<string, boolean>): Set<string> {
  const openFolders = new Set([...focusModules].map(folderOf));
  for (const [folder, isOpen] of folderChoices) {
    if (isOpen) openFolders.add(folder);
    if (!isOpen) openFolders.delete(folder);
  }
  return openFolders;
}

function folderOfMapBoxId(repoKey: RepoKey, model: CodemapModel, boxId: string): string | null {
  for (const folder of new Set(model.modules.map((summary) => folderOf(summary.id)))) {
    if (boxId === folderCardIdOf(repoKey, folder) || boxId === folderFrameIdOf(repoKey, folder)) return folder;
  }
  return null;
}

const MODULE_COLUMNS_PER_FOLDER = 6;
const MATRIX_BOX_WIDTH = 640;
const RED_WIRE = Object.freeze({ tone: 'fail', width: 'bold' });
const RED_WIRE_LEGEND_ENTRY = Object.freeze({ tone: RED_WIRE.tone, dashed: false, label: 'imports upward' });

function wireLabelOf(edge: WeightedEdge): string {
  const [onlyImport] = edge.fileImports;
  if (edge.fileImports.length !== 1 || !onlyImport) return `${edge.fileImports.length}`;
  const [importer, target] = onlyImport.split(' imports ');
  return `${path.basename(importer ?? '')} imports ${path.basename(target ?? '')}`.slice(0, WHITEBOARD_LIMITS.wireLabel);
}

function foldersByLevelOf(layers: ModuleLayers): string[][] {
  const levels = [...layers.folders.levelById.values()];
  const topLevel = Math.max(0, ...levels);
  return Array.from({ length: topLevel + 1 }, (_unused, offset) => [...layers.folders.levelById].filter(([, level]) => level === topLevel - offset).map(([folder]) => folder).sort(compareText));
}

function innerRowsOf(layers: ModuleLayers, folder: string): string[][] {
  const inner = layers.innerByFolder.get(folder);
  const levels = [...(inner?.levelById.values() ?? [])];
  const topLevel = Math.max(0, ...levels);
  return Array.from({ length: topLevel + 1 }, (_unused, offset) => [...(inner?.levelById ?? [])].filter(([, level]) => level === topLevel - offset).map(([moduleId]) => moduleId).sort(compareText))
    .flatMap((levelModules) => Array.from({ length: Math.ceil(levelModules.length / MODULE_COLUMNS_PER_FOLDER) }, (_unused, chunk) => levelModules.slice(chunk * MODULE_COLUMNS_PER_FOLDER, (chunk + 1) * MODULE_COLUMNS_PER_FOLDER)))
    .filter((row) => row.length > 0);
}

function placedFoldersOf(layers: ModuleLayers, openFolders: ReadonlySet<string>, repoKey: RepoKey, origin: { x: number; y: number }): Map<string, { x: number; y: number }> {
  const placeById = new Map<string, { x: number; y: number }>();
  let rowTop = origin.y + MAP_TOP;
  for (const levelFolders of foldersByLevelOf(layers)) {
    let blockLeft = origin.x;
    let rowHeight: number = MAP_BOX_SPACING.y;
    for (const folder of levelFolders) {
      const cardPlace = { x: blockLeft, y: rowTop };
      placeById.set(folderCardIdOf(repoKey, folder), cardPlace);
      if (!openFolders.has(folder)) {
        for (const summary of layers.modulesByFolder.get(folder) ?? []) placeById.set(moduleBoxIdOf(repoKey, summary.id), cardPlace);
        blockLeft += 2 * MAP_BOX_SPACING.x;
        continue;
      }
      const rows = innerRowsOf(layers, folder);
      for (const [rowIndex, row] of rows.entries()) {
        for (const [column, moduleId] of row.entries()) placeById.set(moduleBoxIdOf(repoKey, moduleId), { x: blockLeft + column * MAP_BOX_SPACING.x, y: rowTop + (rowIndex + 1) * MAP_BOX_SPACING.y });
      }
      blockLeft += (Math.max(1, ...rows.map((row) => row.length)) + 1) * MAP_BOX_SPACING.x;
      rowHeight = Math.max(rowHeight, (rows.length + 1) * MAP_BOX_SPACING.y);
    }
    rowTop += rowHeight + MAP_BOX_SPACING.y;
  }
  return placeById;
}

const AREA_GAP = 2 * MAP_BOX_SPACING.x;
const FOLDED_AREA_WIDTH = MAP_BOX_SPACING.x;

function areaWidthOf(model: CodemapModel): number {
  const layers = moduleLayersOf(model);
  const everyFolder = new Set(layers.modulesByFolder.keys());
  const rightmostLeft = Math.max(0, ...[...placedFoldersOf(layers, everyFolder, '', { x: 0, y: 0 }).values()].map((place) => place.x));
  return rightmostLeft + 2 * MAP_BOX_SPACING.x + MATRIX_BOX_WIDTH;
}

function areaOriginsOf(areas: readonly { repoKey: RepoKey; width: number }[]): Map<RepoKey, { x: number; y: number }> {
  const originByRepoKey = new Map<RepoKey, { x: number; y: number }>();
  let areaLeft = 0;
  for (const area of areas) {
    originByRepoKey.set(area.repoKey, { x: areaLeft, y: 0 });
    areaLeft += area.width + AREA_GAP;
  }
  return originByRepoKey;
}

interface AreaSpan {
  left: number;
  right: number;
}

function rowRedrawOrderOf(shownSpanByRepoKey: ReadonlyMap<RepoKey, AreaSpan>, wantedSpanByRepoKey: ReadonlyMap<RepoKey, AreaSpan>): RepoKey[] {
  const movedRepoKeys = [...wantedSpanByRepoKey.keys()].filter((repoKey) => {
    const shown = shownSpanByRepoKey.get(repoKey);
    const wanted = wantedSpanByRepoKey.get(repoKey);
    return !shown || !wanted || shown.left !== wanted.left || shown.right !== wanted.right;
  });
  const isGrowing = (repoKey: RepoKey) => (wantedSpanByRepoKey.get(repoKey)?.right ?? 0) > (shownSpanByRepoKey.get(repoKey)?.right ?? Number.NEGATIVE_INFINITY);
  const leftOf = (repoKey: RepoKey) => wantedSpanByRepoKey.get(repoKey)?.left ?? 0;
  const freeing = movedRepoKeys.filter((repoKey) => !isGrowing(repoKey)).sort((first, second) => leftOf(first) - leftOf(second));
  const growing = movedRepoKeys.filter(isGrowing).sort((first, second) => leftOf(second) - leftOf(first));
  return [...freeing, ...growing];
}

function folderMatrixCsvOf(model: CodemapModel): string {
  const layers = moduleLayersOf(model);
  const orderedFolders = foldersByLevelOf(layers).reverse().flat();
  const countByKey = new Map(layers.folderEdges.map((edge) => [edgeKeyOf(edge.from, edge.to), edge.fileImports.length]));
  const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;
  const header = ['imports', ...orderedFolders.map(folderTitleOf)].map(quoted).join(',');
  const rows = orderedFolders.map((row) => [quoted(`${folderTitleOf(row)} L${layers.folders.levelById.get(row) ?? 0}`), ...orderedFolders.map((column) => {
    const count = countByKey.get(edgeKeyOf(row, column));
    if (!count) return '';
    return layers.folders.feedbackKeys.has(edgeKeyOf(row, column)) ? quoted(`${count} up`) : `${count}`;
  })].join(','));
  return `${[header, ...rows].join('\n')}\n`;
}

function isRedWireLegendEntry(entry: Board['legend'][number]): boolean {
  return entry.tone === RED_WIRE_LEGEND_ENTRY.tone && entry.dashed === RED_WIRE_LEGEND_ENTRY.dashed && entry.label === RED_WIRE_LEGEND_ENTRY.label;
}

function mapLegendOf(storedLegend: Board['legend'], hasRedWires: boolean): Board['legend'] {
  const othersLegend = storedLegend.filter((entry) => !isRedWireLegendEntry(entry));
  if (!hasRedWires) return othersLegend;
  return [...othersLegend.slice(0, WHITEBOARD_LIMITS.legendEntries - 1), RED_WIRE_LEGEND_ENTRY];
}

function mapBoardOpsOf(model: CodemapModel, existingKindById: ReadonlyMap<string, string>, storedLegend: Board['legend'], { churnByModule, overlaidModules, folderChoices, matrixMedia }: MapDecorations, { repoKey, title: areaTitle, origin, isFolded, hasRedWiresElsewhere }: MapArea): Record<string, unknown>[] {
  const layers = moduleLayersOf(model);
  const focusModules = focusModulesOf(layers, overlaidModules);
  const focusFolders = openFoldersOf(focusModules, folderChoices);
  const placeById = placedFoldersOf(layers, focusFolders, repoKey, origin);
  const moduleBoxIdOfArea = (moduleId: string) => moduleBoxIdOf(repoKey, moduleId);
  const folderCardIdOfArea = (folder: string) => folderCardIdOf(repoKey, folder);
  const mapIdOfArea = (displayPath: string, identity: string) => generatedIdOf(CODEMAP_ID_PREFIXES.map, repoKey, displayPath, identity);
  const stampBoxId = stampBoxIdOf(repoKey);
  const matrixBoxId = matrixBoxIdOf(repoKey);
  const isFeedback = (edge: WeightedEdge) => {
    const folder = folderOf(edge.from);
    if (folder !== folderOf(edge.to)) return layers.folders.feedbackKeys.has(edgeKeyOf(folder, folderOf(edge.to)));
    return layers.innerByFolder.get(folder)?.feedbackKeys.has(edgeKeyOf(edge.from, edge.to)) ?? false;
  };
  const foldedPlace = { x: origin.x, y: origin.y + BOARD_MARGIN };
  const placeOf = (id: string) => ({ at: isFolded ? foldedPlace : placeById.get(id) ?? { x: origin.x, y: origin.y + MAP_TOP } });
  const matrixLeft = Math.max(origin.x, ...[...placeById.values()].map((place) => place.x)) + 2 * MAP_BOX_SPACING.x;
  const moduleBoxes = model.modules.map((summary) => ({
    kind: 'box',
    id: moduleBoxIdOfArea(summary.id),
    title: boardTitleOf(summary.id === ROOT_MODULE ? 'repo root' : summary.id),
    lines: moduleLinesOf(summary, churnByModule),
    tone: overlaidModules.has(summary.id) ? OVERLAY_TONE : null,
    refs: summary.id !== ROOT_MODULE && AnchorRef.safeParse(summary.id).success ? [summary.id] : [],
    place: placeOf(moduleBoxIdOfArea(summary.id)),
  }));
  const folderCards = [...layers.modulesByFolder].map(([folder, summaries]) => ({
    kind: 'box',
    id: folderCardIdOfArea(folder),
    title: boardTitleOf(folderTitleOf(folder)),
    lines: [
      { text: `level ${layers.folders.levelById.get(folder) ?? 0}: ${summaries.length} modules, ${summaries.reduce((total, summary) => total + summary.fileCount, 0)} files`, muted: true },
      { text: `${layers.innerByFolder.get(folder)?.feedbackKeys.size ?? 0} crossed wires inside`, muted: true },
    ],
    tone: summaries.some((summary) => overlaidModules.has(summary.id)) ? OVERLAY_TONE : null,
    place: placeOf(folderCardIdOfArea(folder)),
  }));
  const matrixBoxes = matrixMedia ? [{ kind: 'box', id: matrixBoxId, title: 'Folder imports: rows import columns', media: matrixMedia, width: MATRIX_BOX_WIDTH, place: { at: isFolded ? foldedPlace : { x: matrixLeft, y: origin.y + MAP_TOP } } }] : [];
  const folderFrames = [...layers.modulesByFolder].map(([folder, summaries]) => ({
    kind: 'frame', id: folderFrameIdOf(repoKey, folder), title: boardTitleOf(folderTitleOf(folder)), contains: [folderCardIdOfArea(folder), ...summaries.map((summary) => moduleBoxIdOfArea(summary.id))], collapsed: !isFolded && !focusFolders.has(folder),
  }));
  const folderWires = layers.folderEdges.map((edge) => ({
    kind: 'wire', id: mapIdOfArea(`${edge.to} folder`, `folder\n${edge.from}\n${edge.to}`), from: folderCardIdOfArea(edge.from), to: folderCardIdOfArea(edge.to),
    ...(layers.folders.feedbackKeys.has(edgeKeyOf(edge.from, edge.to)) ? { ...RED_WIRE, label: wireLabelOf(edge) } : { tone: 'plain', width: 'thin', label: null }),
  }));
  const moduleWires = layers.judgedEdges.filter((edge) => (folderOf(edge.from) === folderOf(edge.to) && isFeedback(edge)) || (focusModules.has(edge.from) && focusModules.has(edge.to))).map((edge) => ({
    kind: 'wire', id: mapIdOfArea(edge.to, `${edge.from}\n${edge.to}`), from: moduleBoxIdOfArea(edge.from), to: moduleBoxIdOfArea(edge.to),
    ...(isFeedback(edge) ? { ...RED_WIRE, label: wireLabelOf(edge) } : { tone: 'plain', width: 'thin', label: null }),
  }));
  const areaCards = [{
    kind: 'box', id: areaCardIdOf(repoKey), title: boardTitleOf(areaTitle),
    lines: [{ text: `${model.modules.length} modules, ${model.modules.reduce((total, summary) => total + summary.fileCount, 0)} files`, muted: true }],
    place: { at: foldedPlace },
  }];
  const boxes = [...areaCards, ...folderCards, ...moduleBoxes, ...matrixBoxes];
  const keptMatrixBoxIds = matrixMedia === null && existingKindById.has(matrixBoxId) ? [matrixBoxId] : [];
  const areaFrame = { kind: 'frame', id: areaFrameIdOf(repoKey), title: boardTitleOf(areaTitle), contains: [...boxes.map((box) => box.id), stampBoxId, ...keptMatrixBoxIds], collapsed: isFolded };
  const frames = isFolded ? [...folderFrames, areaFrame] : [areaFrame, ...folderFrames];
  const wires = isFolded ? [] : [...folderWires, ...moduleWires];
  const producedIds = new Set([stampBoxId, matrixBoxId, ...[...boxes, ...frames, ...wires].map((element) => element.id)]);
  const areaIdPrefix = repoIdPrefixOf(CODEMAP_ID_PREFIXES.map, repoKey);
  const staleIds = [...existingKindById.keys()].filter((id) => id.startsWith(areaIdPrefix) && !producedIds.has(id));
  const staleRemovalsOfKind = (isKind: (kind: string | undefined) => boolean) => staleIds.filter((id) => isKind(existingKindById.get(id))).map((id) => ({ op: 'remove', id }));
  const refreshOf = (element: { kind: string; id: string } & Record<string, unknown>) => {
    if (!existingKindById.has(element.id)) return { op: 'add', element };
    return { op: 'set', id: element.id, fields: generatedFieldsOf(element) };
  };
  const hasRedWires = hasRedWiresElsewhere || wires.some((wire) => wire.tone === RED_WIRE.tone);
  return [
    ...staleRemovalsOfKind((kind) => kind === 'wire'), ...staleRemovalsOfKind((kind) => kind === 'frame'), ...staleRemovalsOfKind((kind) => kind !== 'wire' && kind !== 'frame'),
    ...boxes.map(refreshOf), ...frames.map(refreshOf), ...wires.map(refreshOf),
    { op: 'board', legend: mapLegendOf(storedLegend, hasRedWires) },
  ];
}

function isUnchangedLegendOp(op: Op, storedLegend: Board['legend']): boolean {
  if (op.op !== 'board') return false;
  return Object.keys(op).every((field) => field === 'op' || field === 'legend') && JSON.stringify(op.legend) === JSON.stringify(storedLegend);
}

function withoutUnchangedSets(ops: readonly Op[], board: Pick<Board, 'elements' | 'legend'>): Op[] {
  return ops.filter((op) => {
    if (isUnchangedLegendOp(op, board.legend)) return false;
    if (op.op !== 'set') return true;
    const stored = board.elements.get(op.id);
    if (!stored) return true;
    const refreshed = Element.safeParse({ ...stored, ...op.fields });
    return !refreshed.success || JSON.stringify(refreshed.data) !== JSON.stringify(stored);
  });
}

const STAMP_TONE_BY_STATE: Record<CodemapStatus['state'], string> = { current: 'green', behind: 'yellow', failed: 'pink' };

function stampLinesOf(status: CodemapStatus): { text: string }[] {
  const lines = [{ text: `mainline is ${shortSha(status.mainlineSha)}` }];
  if (status.reason) lines.push({ text: status.reason.slice(0, WHITEBOARD_LIMITS.line) });
  return lines;
}

function mapStampOpsOf(status: CodemapStatus, existingKindById: ReadonlyMap<string, string>, { repoKey, origin }: Pick<MapArea, 'repoKey' | 'origin'>): Record<string, unknown>[] {
  const stampBoxId = stampBoxIdOf(repoKey);
  const stamp = {
    kind: 'box', id: stampBoxId, title: `Map at ${shortSha(status.sha)}: ${status.state}`, lines: stampLinesOf(status), tone: STAMP_TONE_BY_STATE[status.state],
    place: { at: { x: origin.x + MAP_BOX_SPACING.x, y: origin.y + BOARD_MARGIN } },
  };
  return [existingKindById.has(stampBoxId) ? { op: 'set', id: stampBoxId, fields: generatedFieldsOf(stamp) } : { op: 'add', element: stamp }];
}


interface MapOverlay {
  title: string;
  lines: readonly string[];
}

function overlayOpsOf(overlay: MapOverlay | null, existingKindById: ReadonlyMap<string, string>, { repoKey, origin }: Pick<MapArea, 'repoKey' | 'origin'>): Record<string, unknown>[] {
  const overlayStampId = generatedIdOf(CODEMAP_ID_PREFIXES.overlay, repoKey, 'overlay stamp', String.fromCharCode(0));
  const areaOverlayPrefix = repoIdPrefixOf(CODEMAP_ID_PREFIXES.overlay, repoKey);
  const staleRemovals = [...existingKindById.keys()].filter((id) => id.startsWith(areaOverlayPrefix) && (overlay === null || id !== overlayStampId)).map((id) => ({ op: 'remove', id }));
  if (!overlay) return staleRemovals;
  const stamp = {
    kind: 'box', id: overlayStampId, title: boardTitleOf(overlay.title), lines: overlay.lines.slice(0, WHITEBOARD_LIMITS.linesPerBox).map((text) => ({ text: text.slice(0, WHITEBOARD_LIMITS.line) })), tone: OVERLAY_TONE,
    place: { at: { x: origin.x + 2 * MAP_BOX_SPACING.x, y: origin.y + BOARD_MARGIN } },
  };
  return [...staleRemovals, existingKindById.has(overlayStampId) ? { op: 'set', id: overlayStampId, fields: generatedFieldsOf(stamp) } : { op: 'add', element: stamp }];
}

function areaRemovalOpsOf(repoKey: RepoKey, existingKindById: ReadonlyMap<string, string>, storedLegend: Board['legend'], hasRedWiresElsewhere: boolean): Record<string, unknown>[] {
  const areaPrefixes = Object.values(CODEMAP_ID_PREFIXES).map((prefix) => repoIdPrefixOf(prefix, repoKey));
  const areaIds = [...existingKindById.keys()].filter((id) => areaPrefixes.some((areaPrefix) => id.startsWith(areaPrefix)));
  const removalsOfKind = (isKind: (kind: string | undefined) => boolean) => areaIds.filter((id) => isKind(existingKindById.get(id))).map((id) => ({ op: 'remove', id }));
  return [...removalsOfKind((kind) => kind === 'wire'), ...removalsOfKind((kind) => kind === 'frame'), ...removalsOfKind((kind) => kind !== 'wire' && kind !== 'frame'), { op: 'board', legend: mapLegendOf(storedLegend, hasRedWiresElsewhere) }];
}

interface SpecPlan {
  slug: string;
  units: readonly DesignSpecUnit[];
  dependsOn: readonly { from: string; to: string }[];
  landedUnitIds: ReadonlySet<string>;
}

function specStepIdOf(repoKey: RepoKey, slug: string, unitId: string): string {
  return generatedIdOf(CODEMAP_ID_PREFIXES.steps, repoKey, `${slug}-${unitId}`, `${slug}\n${unitId}`);
}

function specStepOf(repoKey: RepoKey, slug: string, unit: DesignSpecUnit, isLanded: boolean) {
  const { title, lines } = noteBoxTextOf(`${unit.id} ${unit.title}`);
  return {
    kind: 'box',
    id: specStepIdOf(repoKey, slug, unit.id),
    title,
    lines: [...lines.slice(0, WHITEBOARD_LIMITS.linesPerBox - 1).map((text) => ({ text })), { text: `changes ${unit.changes.length} files`, muted: true }],
    refs: unit.changes.filter((change) => AnchorRef.safeParse(change).success).slice(0, WHITEBOARD_LIMITS.refsPerElement),
    place: 'plan',
    step: { status: isLanded ? 'landed' : 'planned' },
  };
}

function specPlanOpsOf(model: CodemapModel, plan: SpecPlan | null, existingKindById: ReadonlyMap<string, string>, repoKey: RepoKey): { removals: Record<string, unknown>[]; writes: Record<string, unknown>[] } {
  const moduleIds = new Set(model.modules.map((summary) => summary.id));
  const unitIds = new Set(plan?.units.map((unit) => unit.id) ?? []);
  const stepIdOf = (unitId: string) => specStepIdOf(repoKey, plan?.slug ?? '', unitId);
  const stepWireIdOf = (displayPath: string, identity: string) => generatedIdOf(CODEMAP_ID_PREFIXES.steps, repoKey, displayPath, identity);
  const steps = (plan?.units ?? []).map((unit) => specStepOf(repoKey, plan?.slug ?? '', unit, plan?.landedUnitIds.has(unit.id) ?? false));
  const orderWires = (plan?.dependsOn ?? []).filter((edge) => unitIds.has(edge.from) && unitIds.has(edge.to)).map((edge) => ({
    kind: 'wire', id: stepWireIdOf(edge.from, `${plan?.slug}\n${edge.to}\n${edge.from}`), from: stepIdOf(edge.to), to: stepIdOf(edge.from),
  }));
  const moduleWires = (plan?.units ?? []).flatMap((unit) => [...new Set(unit.changes.map((change) => moduleOfPath(model, change)))].filter((moduleId) => moduleIds.has(moduleId)).map((moduleId) => ({
    kind: 'wire', id: stepWireIdOf(`${unit.id}-${moduleId}`, `${plan?.slug}\n${unit.id}\n${moduleId}`), from: stepIdOf(unit.id), to: moduleBoxIdOf(repoKey, moduleId), dashed: true, arrows: 'none',
  })));
  const produced = [...steps, ...orderWires, ...moduleWires];
  const producedIds = new Set(produced.map((element) => element.id));
  const areaStepPrefix = repoIdPrefixOf(CODEMAP_ID_PREFIXES.steps, repoKey);
  const staleIds = [...existingKindById.keys()].filter((id) => id.startsWith(areaStepPrefix) && !producedIds.has(id));
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

function unallowedEdgesOf(model: CodemapModel, mainlineModel: CodemapModel, changedPaths: ReadonlySet<string>, allowed: readonly CodemapModuleEdge[]): UnallowedEdge[] {
  const allowedKeys = new Set(allowed.map((edge) => edgeKeyOf(edge.from, edge.to)));
  const mainlineImports = judgedModuleImportsOf(mainlineModel, changedPaths);
  return [...judgedModuleImportsOf(model, changedPaths).values()]
    .flatMap((edge) => {
      const key = edgeKeyOf(edge.from, edge.to);
      if (allowedKeys.has(key)) return [];
      const onMainline = new Set(mainlineImports.get(key)?.fileImports ?? []);
      const addedFileImports = edge.fileImports.filter((fileImport) => !onMainline.has(fileImport));
      return addedFileImports.length > 0 ? [{ ...edge, fileImports: addedFileImports }] : [];
    })
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

const CROSSED_WIRE_LISTED_IMPORTS = 3;

function crossedWiresOf(model: CodemapModel): UnallowedEdge[] {
  const judgedImports = judgedModuleImportsOf(model, model.paths);
  return [...judgedImports.values()].filter((edge) => {
    const reverse = judgedImports.get(edgeKeyOf(edge.to, edge.from));
    if (!reverse) return false;
    if (edge.fileImports.length !== reverse.fileImports.length) return edge.fileImports.length < reverse.fileImports.length;
    return compareText(edge.from, reverse.from) > 0;
  }).sort((left, right) => left.fileImports.length - right.fileImports.length || compareText(left.from, right.from) || compareText(left.to, right.to));
}

function fileImportCeilingsOf(model: CodemapModel): Map<string, number> {
  return new Map(crossedWiresOf(model).map((wire) => [edgeKeyOf(wire.from, wire.to), wire.fileImports.length]));
}

const LEGACY_SEEDED_LANGUAGE_IDS: readonly string[] = ['python', 'typescript'];

function seededSetupOf(repoKey: string, model: CodemapModel): CodemapSetup {
  const ceilings = fileImportCeilingsOf(model);
  const allow = moduleEdgesOf(model).map((edge) => ({ ...edge, origin: 'seeded' as const, fileImportCeiling: ceilings.get(edgeKeyOf(edge.from, edge.to)) ?? null }));
  return { version: CODEMAP_SETUP_VERSION, repo: repoKey, gate: true, modules: model.modules.map((summary) => summary.id), allow, exports: [], languages: [...IMPORT_LANGUAGE_IDS] };
}

function seededEntriesForNewLanguages(model: CodemapModel, current: CodemapSetup): CodemapAllowEntry[] {
  const trackedLanguages = new Set(current.languages ?? LEGACY_SEEDED_LANGUAGE_IDS);
  const addedLanguages = new Set(IMPORT_LANGUAGE_IDS.filter((languageId) => !trackedLanguages.has(languageId)));
  if (addedLanguages.size === 0) return [];
  const newLanguagePaths = model.paths.filter((repoPath) => {
    const language = importLanguageOf(repoPath);
    return language !== null && addedLanguages.has(language.id);
  });
  if (newLanguagePaths.length === 0) return [];
  const existingKeys = new Set(moduleImportAllowsOf(current.allow).map((edge) => edgeKeyOf(edge.from, edge.to)));
  return [...judgedModuleImportsOf(model, newLanguagePaths).values()]
    .filter((edge) => !existingKeys.has(edgeKeyOf(edge.from, edge.to)))
    .sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to))
    .map(({ from, to }) => ({ from, to, origin: 'seeded' as const, fileImportCeiling: null }));
}

function settledSetupOf(model: CodemapModel, current: CodemapSetup): CodemapSetup {
  const nextLanguages = uniqueSorted([...(current.languages ?? LEGACY_SEEDED_LANGUAGE_IDS), ...IMPORT_LANGUAGE_IDS]);
  const mergedAllow = [...moduleImportAllowsOf(current.allow), ...seededEntriesForNewLanguages(model, current)];
  const { allow } = shrunkAllowListOf(model, mergedAllow);
  return { ...current, allow: [...allow, ...structureAllowsOf(current.allow)], languages: nextLanguages };
}

function ratchetedCeilingOf(entry: CodemapAllowEntry, mainlineCeiling: number | undefined): number | null {
  if (mainlineCeiling === undefined) return null;
  if (entry.fileImportCeiling === null) return mainlineCeiling;
  return Math.min(entry.fileImportCeiling, mainlineCeiling);
}

function shrunkAllowListOf(model: CodemapModel, allow: readonly CodemapAllowEntry[]): { allow: CodemapAllowEntry[]; dropped: CodemapAllowEntry[] } {
  const mainlineEdgeKeys = new Set(moduleEdgesOf(model).map((edge) => edgeKeyOf(edge.from, edge.to)));
  const ceilings = fileImportCeilingsOf(model);
  const isOnMainline = (entry: CodemapAllowEntry) => mainlineEdgeKeys.has(edgeKeyOf(entry.from, entry.to));
  const isDroppable = (entry: CodemapAllowEntry) => !isOnMainline(entry) && (entry.origin === 'seeded' || entry.landed);
  const kept = allow.filter((entry) => !isDroppable(entry)).map((entry): CodemapAllowEntry => {
    if (!isOnMainline(entry)) return entry;
    const fileImportCeiling = ratchetedCeilingOf(entry, ceilings.get(edgeKeyOf(entry.from, entry.to)));
    return entry.origin === 'allowed' ? { ...entry, landed: true, fileImportCeiling } : { ...entry, fileImportCeiling };
  });
  return { allow: kept, dropped: allow.filter(isDroppable) };
}

interface CeilingBreach {
  from: string;
  to: string;
  fileImportCeiling: number;
  fileImports: string[];
}

function ceilingBreachesOf(model: CodemapModel, mainlineModel: CodemapModel, changedPaths: ReadonlySet<string>, allow: readonly CodemapAllowEntry[]): CeilingBreach[] {
  const judgedImports = judgedModuleImportsOf(model, model.paths);
  const mainlineImports = judgedModuleImportsOf(mainlineModel, mainlineModel.paths);
  const importerOf = (fileImport: string) => fileImport.slice(0, fileImport.indexOf(' imports '));
  return allow.flatMap((entry) => {
    const key = edgeKeyOf(entry.from, entry.to);
    const edge = judgedImports.get(key);
    if (entry.fileImportCeiling === null || !edge || edge.fileImports.length <= entry.fileImportCeiling) return [];
    const onMainline = new Set(mainlineImports.get(key)?.fileImports ?? []);
    const addedFileImports = edge.fileImports.filter((fileImport) => changedPaths.has(importerOf(fileImport)) && !onMainline.has(fileImport));
    if (addedFileImports.length === 0) return [];
    return [{ from: entry.from, to: entry.to, fileImportCeiling: entry.fileImportCeiling, fileImports: [...addedFileImports, ...edge.fileImports.filter((fileImport) => !addedFileImports.includes(fileImport))] }];
  });
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
  ceilingBreaches: readonly CeilingBreach[];
  unjudgedPaths: readonly string[];
  unresolvedImports: readonly string[];
  newCycles: readonly NewCycle[];
  staleExports: readonly string[];
  exportNotes: readonly string[];
  staleAllowedEdges: readonly CodemapModuleEdge[];
  newTangles: readonly Tangle[];
  newShallowModules: readonly ShallowModule[];
  grownShallowModules: readonly GrownShallowModule[];
  unjudgedLanguages: readonly UnjudgedLanguage[];
}

function readableSymbolOf(symbol: string): string {
  return symbol.slice(symbol.indexOf(' ') + 1).replaceAll('`', '');
}

function isCheckRefusing(findings: CheckFindings): boolean {
  return findings.unallowedEdges.length > 0 || findings.ceilingBreaches.length > 0 || findings.unjudgedPaths.length > 0 || findings.unresolvedImports.length > 0 || findings.newCycles.length > 0 || findings.staleExports.length > 0 || findings.newTangles.length > 0 || findings.newShallowModules.length > 0;
}

function checkTextOf(repoName: string, findings: CheckFindings, gateNote: string | null): string {
  const { unallowedEdges, ceilingBreaches, unjudgedPaths, unresolvedImports, newCycles, staleExports, exportNotes, staleAllowedEdges, newTangles, newShallowModules, grownShallowModules, unjudgedLanguages } = findings;
  const noteLines = [
    ...exportNotes.map((note) => `  ${note}`),
    ...unjudgedLanguages.map((unjudged) => `  the structure of ${unjudged.language} code was not judged, so no tangle or shallow module there refuses: ${unjudged.reason}`),
    ...grownShallowModules.map((grown) => `  shallow module ${grown.module} was already shallow on mainline and shows ${grown.shown.length} symbols to other modules here, ${grown.mainlineShownCount} on mainline, keeping ${grown.hiddenCount} to itself; this does not refuse, but a smaller face would help`),
  ];
  const staleLines = staleAllowedEdges.length > 0 ? [`  allowed module imports this branch no longer has, which codemap shrink drops once mainline lacks them too: ${cappedList(staleAllowedEdges.map((edge) => `${edge.from} -> ${edge.to}`))}`] : [];
  if (!isCheckRefusing(findings)) return [...noteLines, ...staleLines, `codemap check: no new module import in ${repoName} needs allowing.`].join('\n');
  const edgeLines = unallowedEdges.flatMap((edge) => [
    `  ${edge.from} -> ${edge.to} is not allowed for this repo; ask the operator to allow it (glimmervoid codemap allow <repo> ${edge.from} ${edge.to} --reason <why>)`,
    ...edge.fileImports.slice(0, CODEMAP_TUNABLES.listedPathsPerSection).map((fileImport) => `    ${fileImport}`),
  ]);
  const breachLines = ceilingBreaches.flatMap((breach) => [
    `  ${breach.from} -> ${breach.to} is a crossed wire held to ${breach.fileImportCeiling} file imports and now has ${breach.fileImports.length}; remove the import, or move the code both modules need into a module below them`,
    ...breach.fileImports.slice(0, CODEMAP_TUNABLES.listedPathsPerSection).map((fileImport) => `    ${fileImport}`),
  ]);
  const unjudgedLine = unjudgedPaths.length > 0 ? [`  changed files over the size, count or parse time caps, so their imports cannot be judged: ${cappedList(unjudgedPaths)}`] : [];
  const unresolvedLine = unresolvedImports.length > 0 ? [`  relative imports that resolve to no file in the repo, so they cannot be judged: ${cappedList(unresolvedImports)}`] : [];
  const cycleLines = newCycles.map((cycle) => `  module cycle ${cycle.modules.join(', ')} holds module imports mainline does not have, which no allow excuses; break the cycle: ${cycle.newEdges.map((edge) => `${edge.from} -> ${edge.to}`).join(', ')}`);
  const tangleLines = newTangles.map((tangle) => `  tangle ${tangle.key} across ${tangle.modules.join(', ')}: ${tangle.symbols.length} symbols reference each other in a circle mainline does not have; break the circle by moving what they share below them, not by moving the symbols around (glimmervoid codemap allow <repo> --tangle ${tangle.key} --reason <why> is the operator's alone): ${cappedList(tangle.symbols.map(readableSymbolOf))}`);
  const shallowLines = newShallowModules.map((shallow) => `  shallow module ${shallow.module} shows ${shallow.shown.length} symbols to other modules and keeps ${shallow.hiddenCount} to itself; give it a smaller face that hides more, or merge it into its callers: ${cappedList(shallow.shown.map(readableSymbolOf))}`);
  const edgeNames = unallowedEdges.map((edge) => `${edge.from} -> ${edge.to}`).join(', ');
  const summaryParts = [
    edgeNames ? `adds module imports the operator has not allowed: ${edgeNames}` : '',
    ceilingBreaches.length > 0 ? `grows crossed wires past their ceiling: ${ceilingBreaches.map((breach) => `${breach.from} -> ${breach.to}`).join(', ')}` : '',
    unjudgedPaths.length > 0 ? `changes ${unjudgedPaths.length} files too large to judge` : '',
    unresolvedImports.length > 0 ? `has ${unresolvedImports.length} relative imports that resolve to no file` : '',
    newCycles.length > 0 ? `has ${newCycles.length} module cycles mainline does not have` : '',
    staleExports.length > 0 ? `has ${staleExports.length} out of date exports` : '',
    newTangles.length > 0 ? `adds ${newTangles.length} tangles` : '',
    newShallowModules.length > 0 ? `makes ${newShallowModules.length} modules shallow` : '',
  ].filter(Boolean);
  const exportLines = staleExports.map((refusal) => `  ${refusal}`);
  return [...edgeLines, ...breachLines, ...unjudgedLine, ...unresolvedLine, ...cycleLines, ...tangleLines, ...shallowLines, ...exportLines, ...noteLines, ...staleLines, ...(gateNote ? [gateNote] : []), `codemap check: ${repoName} ${summaryParts.join('; ')}`].join('\n');
}

export { CODEMAP_EXPORT_FILE_BY_KIND, FOLDED_AREA_WIDTH, repoBoxIdOfUnscopedBox, rootBoxIdOf, areaCardIdOf, areaFrameIdOf, folderCardIdOf, folderOf, areaOriginsOf, areaRemovalOpsOf, areaWidthOf, rowRedrawOrderOf, repoIdPrefixOf, branchBoxChoicesOf, buildCodemapModel, folderOfMapBoxId, folderMatrixCsvOf, matrixBoxIdOf, withoutUnchangedSets, ceilingBreachesOf, seededSetupOf, settledSetupOf, checkTextOf, exportedMapTextOf, exportVerdictOf, isExportWrittenText, lintConfigTextOf, churnByModuleOf, drawnBoxIdOfPath, fallbackBoxIdOf, moduleBoxIdOf, moduleOfPath, overlayOpsOf, specPlanOpsOf, shrunkAllowListOf, staleAllowedEdgesOf, isCheckRefusing, newCyclesOf, unjudgedPathsOf, unresolvedImportsOf, codemapNoticeOf, unallowedEdgesOf, impactOf, mapBoardOpsOf, mapStampOpsOf, mapTextOf, whereOf };
export type { CodemapModel, MapArea, MapDecorations, MapOverlay, SpecPlan };
