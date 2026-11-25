import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { REPO_ROOT_BRANCH_TITLE } from '../../shared/board-branch-core.ts';
import type { BranchAbout, BranchTarget } from '../../shared/board-branch-core.ts';
import { CODEMAP_CHECK_ID, CODEMAP_SPEC_SLUG, moduleImportAllowsOf, structureAllowsOf } from '../../shared/contracts/codemap.ts';
import { CODEMAP_BOX_CHOICES_MAX, CODE_MAP_BOARD_TITLE } from '../../shared/contracts/control/board-session-messages.ts';
import { VERIFICATION_OUTPUT_TAIL_BYTES } from '../../shared/contracts/verification.ts';
import type { CheckOutcome } from '../../shared/contracts/verification.ts';
import type { AgentCodemapReply, AgentCodemapRequest, CodemapStructureAllowEntry, CodemapStructureLint, CodemapExportKind, CodemapExtract, CodemapExtractBase, CodemapModuleEdge, CodemapSetup, CodemapStatus } from '../../shared/contracts/codemap.ts';
import { clock } from '../../shared/clock.ts';
import { errorCode, errorMessage } from '../../shared/text.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import { BoxMedia, Op, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board } from '../../shared/contracts/whiteboard.ts';
import { CODEMAP_AUTHOR, CODEMAP_ID_PREFIXES } from '../../shared/contracts/whiteboard-ops-core.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';
import type { Rect } from '../../shared/whiteboard-layout-core.ts';
import { createJsonStateStore, writeTextAtomic } from '../json-file.ts';
import { fileTextAtCommit, mainlineShaOf, readCodemapSetup, readDesignSpec, recentCommitsOf, repoKeyOf, revParse, ticketTrailersOf, updateCodemapSetup, judgedTreeOf, worktreeRootOf } from './codemap-store.ts';
import { CODEMAP_EXPORT_FILE_BY_KIND, FOLDED_AREA_WIDTH, areaCardIdOf, areaFrameIdOf, folderCardIdOf, folderOf, areaOriginsOf, areaRemovalOpsOf, areaWidthOf, repoIdPrefixOf, branchBoxChoicesOf, buildCodemapModel, folderOfMapBoxId, folderMatrixCsvOf, withoutUnchangedSets, ceilingBreachesOf, checkTextOf, seededSetupOf, settledSetupOf, exportedMapTextOf, exportVerdictOf, isExportWrittenText, lintConfigTextOf, churnByModuleOf, CODEMAP_TUNABLES, drawnBoxIdOfPath, fallbackBoxIdOf, moduleBoxIdOf, moduleOfPath, overlayOpsOf, specPlanOpsOf, codemapNoticeOf, isCheckRefusing, newCyclesOf, shrunkAllowListOf, staleAllowedEdgesOf, unallowedEdgesOf, unjudgedPathsOf, unresolvedImportsOf, impactOf, mapBoardOpsOf, mapStampOpsOf, mapTextOf, whereOf } from '../core/codemap-graph-core.ts';
import type { CodemapModel, MapArea, MapDecorations, MapOverlay, SpecPlan } from '../core/codemap-graph-core.ts';
import { createCodemapClient } from './codemap-client.ts';
import type { CodemapClient } from './codemap-client.ts';
import { grownShallowModulesOf, newShallowModulesOf, newTanglesOf, shallowModulesOf, tanglesOf } from '../core/codemap-structure-core.ts';
import type { GrownShallowModule, ShallowModule, SymbolGraph, Tangle, UnjudgedLanguage } from '../core/codemap-structure-core.ts';
import { createStructureRunner } from './structure-runner.ts';
import type { StructureRunner } from './structure-runner.ts';

interface CodemapRepo {
  repoDir: string;
  worktreeDir?: string | null;
  sessionId?: string | null;
}

async function writeExportFile(targetPath: string, text: string): Promise<string | null> {
  const existing = await fsp.lstat(targetPath).catch(() => null);
  if (existing && !existing.isFile()) return 'it is not a regular file';
  const existingText = existing ? await fsp.readFile(targetPath, 'utf8').catch(() => '') : null;
  if (existingText !== null && !isExportWrittenText(existingText)) return 'it was not written by codemap export; remove or rename it first';
  return writeTextAtomic(targetPath, text, { exclusive: true }).then(() => null, (error: unknown) => errorMessage(error));
}

const CODEMAP_BUILT_IN_COMMAND = 'codemap check (built in)';

interface MainlineView {
  model: CodemapModel;
  base: CodemapExtractBase;
}

interface StructureCheck {
  runner: StructureRunner;
  mainlineGraph: () => Promise<SymbolGraph>;
}

interface StructureFindings {
  newTangles: Tangle[];
  newShallowModules: ShallowModule[];
  grownShallowModules: GrownShallowModule[];
  unjudgedLanguages: readonly UnjudgedLanguage[];
}

function allowedKeysOf(structureAllows: readonly CodemapStructureAllowEntry[], lint: CodemapStructureLint): string[] {
  return structureAllows.filter((entry) => entry.lint === lint).map((entry) => entry.key);
}

const NO_STRUCTURE_FINDINGS: StructureFindings = { newTangles: [], newShallowModules: [], grownShallowModules: [], unjudgedLanguages: [] };

function directImportersOf(changedPaths: readonly string[], models: readonly CodemapModel[]): string[] {
  return models.flatMap((codemapModel) => changedPaths.flatMap((repoPath) => {
    const fileIndex = codemapModel.indexByPath.get(repoPath);
    if (fileIndex === undefined) return [];
    const { offsets, targets } = codemapModel.dependents;
    return Array.from(targets.subarray(offsets[fileIndex], offsets[fileIndex + 1]), (importerIndex) => codemapModel.paths[importerIndex]);
  }));
}

async function structureFindingsOf(structure: StructureCheck, worktreeDir: string, treeSha: string, model: CodemapModel, mainlineModel: CodemapModel, structureAllows: readonly CodemapStructureAllowEntry[]): Promise<StructureFindings> {
  const mainlineGraph = await structure.mainlineGraph();
  const unjudgedOnMainline = mainlineGraph.unjudgedLanguages.map((unjudged) => ({ language: unjudged.language, reason: `mainline was not indexed, so nothing on this branch is judged against it: ${unjudged.reason}` }));
  if (unjudgedOnMainline.length > 0) return { ...NO_STRUCTURE_FINDINGS, unjudgedLanguages: [...(await structure.runner.symbolGraphOf(worktreeDir, treeSha)).unjudgedLanguages, ...unjudgedOnMainline] };
  const headGraph = await structure.runner.symbolGraphOf(worktreeDir, treeSha, { base: mainlineGraph, importersOf: (changedPaths) => directImportersOf(changedPaths, [model, mainlineModel]) });
  const moduleOfHeadPath = (repoPath: string) => moduleOfPath(model, repoPath);
  const moduleOfMainlinePath = (repoPath: string) => moduleOfPath(mainlineModel, repoPath);
  const headShallowModules = shallowModulesOf(headGraph, moduleOfHeadPath);
  const mainlineShallowModules = shallowModulesOf(mainlineGraph, moduleOfMainlinePath);
  return {
    newTangles: newTanglesOf(tanglesOf(headGraph, moduleOfHeadPath), tanglesOf(mainlineGraph, moduleOfMainlinePath), allowedKeysOf(structureAllows, 'tangle')),
    newShallowModules: newShallowModulesOf(headShallowModules, mainlineShallowModules, allowedKeysOf(structureAllows, 'shallow')),
    grownShallowModules: grownShallowModulesOf(headShallowModules, mainlineShallowModules),
    unjudgedLanguages: headGraph.unjudgedLanguages,
  };
}

interface WorktreeCheck {
  client: CodemapClient;
  structure?: StructureCheck | null;
  homeDir: string;
  worktreeDir: string;
  mainlineSha: string;
  mainline?: MainlineView | null;
  commitSha?: string | null;
}

type WorktreeCheckOutcome = { ok: true; isGateOn: boolean; isRefusing: boolean; text: string } | { ok: false; error: string };

async function mainlineViewOf(client: CodemapClient, worktreeDir: string, mainlineSha: string, moduleLayout: readonly string[]): Promise<MainlineView> {
  const extract = await client.extract(worktreeDir, mainlineSha);
  return { model: buildCodemapModel(extract, moduleLayout), base: extractBaseOf(extract) };
}

async function checkWorktree({ client, structure = null, homeDir, worktreeDir, mainlineSha, mainline = null, commitSha = null }: WorktreeCheck): Promise<WorktreeCheckOutcome> {
  const repoKey = await repoKeyOf(worktreeDir);
  if (!repoKey) return { ok: false, error: `${worktreeDir} is not inside a git repository` };
  const repoName = path.basename(repoKey);
  const lookup = await readCodemapSetup(homeDir, repoKey);
  if (lookup.kind === 'none') return { ok: true, isGateOn: false, isRefusing: false, text: `codemap check: ${repoName} has no code map setup, so no module import is judged.` };
  if (lookup.kind === 'invalid') return { ok: false, error: lookup.message };
  const { setup } = lookup;
  const tree = await judgedTreeOf(worktreeDir, mainlineSha, commitSha);
  if (!tree) return { ok: false, error: `${commitSha ? `commit ${commitSha.slice(0, 7)}` : 'the working tree'} of ${worktreeDir} could not be compared with mainline ${mainlineSha.slice(0, 7)}` };
  const mainlineView = mainline?.model.sha === mainlineSha ? mainline : await mainlineViewOf(client, worktreeDir, mainlineSha, setup.modules);
  const model = buildCodemapModel(await client.extract(worktreeDir, tree.treeSha, mainlineView.base), setup.modules);
  const { changedPaths } = tree;
  const exportVerdicts = await Promise.all(setup.exports.map(async (kind) => exportVerdictOf(kind, await fileTextAtCommit(worktreeDir, tree.treeSha, CODEMAP_EXPORT_FILE_BY_KIND[kind]), kind === 'lint' ? lintConfigTextOf(setup) : exportedMapTextOf(model))));
  const staleExports = exportVerdicts.flatMap((verdict) => (verdict.refusal ? [verdict.refusal] : []));
  const exportNotes = exportVerdicts.flatMap((verdict) => (verdict.note ? [verdict.note] : []));
  const moduleImportAllows = moduleImportAllowsOf(setup.allow);
  const structureFindings = structure ? await structureFindingsOf(structure, worktreeDir, tree.treeSha, model, mainlineView.model, structureAllowsOf(setup.allow)).catch((error: unknown) => ({ ...NO_STRUCTURE_FINDINGS, unjudgedLanguages: [{ language: 'every language', reason: errorMessage(error) }] })) : NO_STRUCTURE_FINDINGS;
  const findings = { ...structureFindings, staleExports, exportNotes, unallowedEdges: unallowedEdgesOf(model, mainlineView.model, changedPaths, moduleImportAllows), ceilingBreaches: ceilingBreachesOf(model, mainlineView.model, changedPaths, moduleImportAllows), unjudgedPaths: unjudgedPathsOf(model, changedPaths), unresolvedImports: unresolvedImportsOf(model, changedPaths), newCycles: newCyclesOf(model, mainlineView.model), staleAllowedEdges: staleAllowedEdgesOf(model, moduleImportAllows) };
  const gateNote = setup.gate ? null : 'The import gate is off for this repo, so these never refuse a merge.';
  return { ok: true, isGateOn: setup.gate, isRefusing: setup.gate && isCheckRefusing(findings), text: checkTextOf(repoName, findings, gateNote) };
}

interface SetupShrink {
  client: CodemapClient;
  homeDir: string;
  repoKey: string;
  mainlineSha: string;
}

async function shrinkSetup({ client, homeDir, repoKey, mainlineSha }: SetupShrink): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const lookup = await readCodemapSetup(homeDir, repoKey);
  if (lookup.kind === 'none') return { ok: false, error: `${repoKey} has no code map setup; Glimmervoid writes one the first time it maps mainline` };
  if (lookup.kind === 'invalid') return { ok: false, error: lookup.message };
  const model = buildCodemapModel(await client.extract(repoKey, mainlineSha), lookup.setup.modules);
  const shrinkOutcome: { dropped: readonly CodemapModuleEdge[] } = { dropped: [] };
  const updated = updateCodemapSetup(homeDir, repoKey, (current) => {
    if (!current) return null;
    const shrunk = shrunkAllowListOf(model, moduleImportAllowsOf(current.allow));
    const allow = [...shrunk.allow, ...structureAllowsOf(current.allow)];
    shrinkOutcome.dropped = shrunk.dropped;
    return JSON.stringify(allow) === JSON.stringify(current.allow) ? null : { ...current, allow };
  });
  const { dropped } = shrinkOutcome;
  if (updated.kind !== 'ok') return { ok: false, error: updated.kind === 'invalid' ? updated.message : `${repoKey} has no code map setup` };
  const repoName = path.basename(repoKey);
  const shortSha = mainlineSha.slice(0, 7);
  if (dropped.length === 0) return { ok: true, text: `codemap shrink: every allowed module import of ${repoName} is on mainline ${shortSha} or still waits for its first landing, so none was dropped.` };
  return { ok: true, text: `codemap shrink: dropped ${dropped.length} allowed module imports mainline ${shortSha} of ${repoName} no longer has: ${dropped.map((entry) => `${entry.from} -> ${entry.to}`).join(', ')}` };
}

interface RepoMapState {
  model: CodemapModel | null;
  modelLayoutKey: string | null;
  extractBase: CodemapExtractBase | null;
  failure: { sha: string; reason: string; retryAtMs: number } | null;
  mainlineStructure: { sha: string; graph: Promise<SymbolGraph> } | null;
  latestStatus: CodemapStatus | null;
  churnByModule: ReadonlyMap<string, number> | null;
  drawnModel: CodemapModel | null;
  drawnStatusKey: string | null;
  drawnOverlayKey: string | null;
  drawnOriginKey: string | null;
  drawRetryAtMs: number;
  startedCheckCount: number;
  appliedCheckNumber: number;
  refreshesInFlight: number;
}

interface MappedSession {
  id: string;
  path: string;
  on(event: 'commits-landed' | 'post-turn-check', listener: () => void): unknown;
}

interface SessionChanges {
  name: string;
  repos: { root: string; paths: string[] }[];
}

interface SessionOverlay {
  refreshNumber: number;
  sessionId: string;
  sessionName: string;
  paths: readonly string[];
}

const MATRIX_FILE_HASH_LENGTH = 16;
const AttachedMedia = z.looseObject({ media: BoxMedia });

interface OverlayDrawing {
  key: string;
  specPlan: SpecPlan | null;
  decorations: MapDecorations;
  stamp: MapOverlay | null;
}

function extractBaseOf(extract: CodemapExtract): CodemapExtractBase {
  return { sha: extract.sha, paths: extract.paths, specifiersByIndex: extract.specifiersByIndex, typeOnlySpecifiersByIndex: extract.typeOnlySpecifiersByIndex, exportedNamesByIndex: extract.exportedNamesByIndex, declaredNamesByIndex: extract.declaredNamesByIndex };
}

const MapBoardFile = z.strictObject({ boardId: z.string().min(1).nullable(), widthByRepoKey: z.record(z.string(), z.number().nonnegative()) });
type MapBoardFile = z.infer<typeof MapBoardFile>;
const MAP_BOARD_QUEUE_KEY = 'map board';

interface MapAreaRepo {
  repoKey: string;
  repoName: string;
  repoDir: string;
}

interface MapAreaList {
  repos(): Promise<readonly MapAreaRepo[]>;
  addRepo(repoDir: string): Promise<MapAreaRepo>;
  removeRepo(repoKey: string): Promise<unknown>;
}

function createMemoryAreaList(): MapAreaList {
  let listedRepos: readonly MapAreaRepo[] = [];
  return {
    repos: () => Promise.resolve(listedRepos),
    addRepo: (repoDir) => {
      const sameNamedCount = listedRepos.filter((candidate) => path.basename(candidate.repoDir) === path.basename(repoDir)).length;
      const repoName = sameNamedCount === 0 ? path.basename(repoDir) : `${path.basename(repoDir)}-${sameNamedCount + 1}`;
      const listed = listedRepos.find((candidate) => candidate.repoDir === repoDir) ?? { repoKey: crypto.randomUUID(), repoName, repoDir };
      if (!listedRepos.includes(listed)) listedRepos = [...listedRepos, listed];
      return Promise.resolve(listed);
    },
    removeRepo: (repoKey) => {
      listedRepos = listedRepos.filter((listed) => listed.repoKey !== repoKey);
      return Promise.resolve();
    },
  };
}
const PUT_BYTES_HEADROOM = 64 * 1024;

type DefaultBranchDetector = (probe: { projectPath: string }) => Promise<string | null>;

interface CurrentMap {
  model: CodemapModel | null;
  status: CodemapStatus;
  isBoardDrawn: boolean;
}

type CodemapOutcome = { ok: true; reply: AgentCodemapReply } | { ok: false; status: number; error: string };

const UNREADABLE_MAINLINE_STATUS = 409;
const UNKNOWN_TARGET_STATUS = 404;
const OPERATOR_ONLY_STATUS = 403;
const CONFLICTING_FILE_STATUS = 409;
const UNKNOWN_SESSION_STATUS = 404;
const BAD_REQUEST_STATUS = 400;

async function noDefaultBranch(): Promise<string | null> {
  return null;
}

type MapBoards = Pick<WhiteboardPort, 'handleAgent' | 'putWithoutReadCheck' | 'handleOperator' | 'readPlanBoard' | 'boxRectsOf'>;

interface CodemapServiceOptions {
  client?: CodemapClient;
  detectDefaultBranch?: DefaultBranchDetector;
  whiteboards?: MapBoards | null;
  mapBoardFilePath?: string | null;
  areas?: MapAreaList;
  isMappedDir?: (repoDir: string) => boolean;
  isAreaIdle?: (repoDir: string) => boolean;
  configuredMainlineBranch?: () => string | null;
  homeDir?: string | null;
  structureRunner?: StructureRunner | null;
  changesOfSession?: ((sessionId: string) => Promise<SessionChanges | null>) | null;
  specsRoot?: string;
  logger?: Pick<Console, 'warn'>;
}

function chunkedBySize(ops: readonly Op[]): Op[][] {
  const chunks: Op[][] = [];
  let current: Op[] = [];
  let currentBytes = 0;
  for (const op of ops) {
    const opBytes = Buffer.byteLength(JSON.stringify(op));
    const isFull = current.length >= WHITEBOARD_LIMITS.opsPerPut || currentBytes + opBytes > WHITEBOARD_LIMITS.putBytes - PUT_BYTES_HEADROOM;
    if (isFull && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(op);
    currentBytes += opBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const OpList = z.array(Op);

function createCodemapService({ client = createCodemapClient(), detectDefaultBranch = noDefaultBranch, whiteboards = null, mapBoardFilePath = null, areas = createMemoryAreaList(), isMappedDir = () => true, isAreaIdle = () => false, configuredMainlineBranch = () => null, homeDir = null, structureRunner = homeDir ? createStructureRunner({ homeDir, client }) : null, changesOfSession = null, specsRoot = path.join(os.homedir(), '.agents', 'specs'), logger = console }: CodemapServiceOptions = {}) {
  const overlayByRepoDir = new Map<string, SessionOverlay>();
  const folderChoicesByRepoDir = new Map<string, Map<string, boolean>>();
  const operatorOpenedRepoDirs = new Set<string>();
  const specPlanByRepoDir = new Map<string, SpecPlan>();
  let startedOverlayRefreshCount = 0;
  let boardDrawing: Promise<boolean> = Promise.resolve(true);
  let mapBoardId: string | null = null;
  const widthByRepoKey = new Map<string, number>();
  const mapBoardLookups = createKeyedSerialQueue();
  const mapBoardStore = createJsonStateStore<MapBoardFile>({
    name: 'code map board', filePath: mapBoardFilePath,
    parse: (raw) => MapBoardFile.safeParse(raw).data ?? null,
    adopt: (loadedFile) => {
      mapBoardId = loadedFile?.boardId ?? null;
      for (const [repoKey, width] of Object.entries(loadedFile?.widthByRepoKey ?? {})) widthByRepoKey.set(repoKey, width);
    },
    warn: (message, fields) => logger.warn(`[codemap] ${message} ${JSON.stringify(fields)}`),
  });

  async function rememberMapBoard(): Promise<void> {
    const boardFile: MapBoardFile = { boardId: mapBoardId, widthByRepoKey: Object.fromEntries(widthByRepoKey) };
    await mapBoardStore.write(boardFile, () => `${JSON.stringify(boardFile, null, 2)}\n`);
  }

  function mapBoardIdOf(boards: MapBoards, repoDir: string): Promise<string> {
    return mapBoardLookups.run(MAP_BOARD_QUEUE_KEY, () => lookUpMapBoardId(boards, repoDir));
  }

  async function lookUpMapBoardId(boards: MapBoards, repoDir: string): Promise<string> {
    await mapBoardStore.load();
    const caller = { id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir };
    if (mapBoardId && (await boards.readPlanBoard(caller, mapBoardId)).ok) return mapBoardId;
    const listed = await boards.handleAgent(caller, { sub: 'list', all: true });
    const titledBoardIds = 'boards' in listed.body ? listed.body.boards.filter((board) => board.title.toLowerCase() === CODE_MAP_BOARD_TITLE.toLowerCase()).map((board) => board.id) : [];
    if (titledBoardIds.length > 1) throw new Error(`${titledBoardIds.length} boards are titled ${CODE_MAP_BOARD_TITLE} and none is the remembered map board, so none was redrawn`);
    const created = titledBoardIds[0] ? null : await boards.handleOperator.create(CODE_MAP_BOARD_TITLE);
    const foundBoardId = titledBoardIds[0] ?? created?.board?.id ?? created?.summary?.id;
    if (!foundBoardId) throw new Error(`the map board could not be created: ${created?.error ?? 'no reason given'}`);
    mapBoardId = foundBoardId;
    await rememberMapBoard();
    return foundBoardId;
  }

  function mapBoardIdOfRepo(repoDir: string): Promise<string | null> {
    return whiteboards ? mapBoardIdOf(whiteboards, repoDir) : Promise.resolve(null);
  }

  async function areaRepoOf(repoDir: string): Promise<MapAreaRepo> {
    const listed = (await areas.repos()).find((candidate) => candidate.repoDir === repoDir);
    if (listed) return listed;
    const added = await areas.addRepo(repoDir);
    removeAreasOfMissingFolders(repoDir);
    return added;
  }

  async function isAreaOwed(repoDir: string): Promise<boolean> {
    if ((await areas.repos()).some((listed) => listed.repoDir === repoDir)) return true;
    return (await repoKeyOf(repoDir)) !== null;
  }

  async function repoOfBox(boxId: string): Promise<MapAreaRepo | null> {
    const areaPrefixesOf = (repoKey: string) => Object.values(CODEMAP_ID_PREFIXES).map((prefix) => repoIdPrefixOf(prefix, repoKey));
    return (await areas.repos()).find((listed) => areaPrefixesOf(listed.repoKey).some((areaPrefix) => boxId.startsWith(areaPrefix))) ?? null;
  }

  async function studioAreas(): Promise<{ boardId: string | null; areas: { repoKey: string; repoName: string; repoDir: string; isFolded: boolean; anchorBoxId: string; boxChoices: { boxId: string; title: string }[]; mapError: string | null; isMapFailed: boolean }[] }> {
    const listedRepos = await areas.repos();
    const drawnAreas = await Promise.all(listedRepos.map(async (listed) => {
      const map = await currentMap({ repoDir: listed.repoDir });
      const model = 'error' in map ? null : map.model;
      const isFolded = isAreaFolded(listed.repoDir);
      const boxChoices = model ? branchBoxChoicesOf(listed.repoKey, model, (repoPath) => drawnBoxIdOfPath(listed.repoKey, model, repoPath)).slice(0, CODEMAP_BOX_CHOICES_MAX) : [];
      const unbuiltError = model ? null : `the code map of ${listed.repoName} is not built yet`;
      const mapError = 'error' in map ? map.error : unbuiltError;
      const isMapFailed = 'error' in map || (!model && map.status.state === 'failed');
      return { repoKey: listed.repoKey, repoName: listed.repoName, repoDir: listed.repoDir, isFolded, anchorBoxId: areaCardIdOf(listed.repoKey), boxChoices, mapError, isMapFailed };
    }));
    const boardId = whiteboards && listedRepos.length > 0 ? await mapBoardIdOf(whiteboards, listedRepos[0]?.repoDir ?? '') : mapBoardId;
    return { boardId, areas: drawnAreas };
  }

  function openArea(repoDir: string): void {
    const opening = async () => {
      if (!isMappedDir(repoDir) || (await repoKeyOf(repoDir)) === null) return logger.warn(`[codemap] ${repoDir} is not a git repository, so it has no map area`);
      await areaRepoOf(repoDir);
      const map = await currentMap({ repoDir });
      if ('error' in map) logger.warn(`[codemap] the map area of ${repoDir} was not drawn: ${map.error}`);
    };
    opening().catch((error: unknown) => logger.warn(`[codemap] the map area of ${repoDir} was not opened: ${errorMessage(error)}`));
  }

  function removeAreasOfMissingFolders(keptRepoDir: string): void {
    areas.repos().then(async (listedRepos) => {
      for (const listed of listedRepos) {
        if (listed.repoDir === keptRepoDir) continue;
        const isFolderGone = await fsp.stat(listed.repoDir).then(() => false, (error: unknown) => errorCode(error) === 'ENOENT');
        if (!isFolderGone) continue;
        const removed = await removeArea(listed.repoDir);
        if (!removed.ok) logger.warn(`[codemap] ${removed.error}`);
      }
    }).catch((error: unknown) => logger.warn(`[codemap] the map areas of missing folders were not removed: ${errorMessage(error)}`));
  }

  function isAreaFolded(repoDir: string): boolean {
    return !operatorOpenedRepoDirs.has(repoDir) && isAreaIdle(repoDir);
  }

  async function areaPlaceOf(repoDir: string): Promise<Pick<MapArea, 'repoKey' | 'title' | 'origin' | 'isFolded'>> {
    await mapBoardStore.load();
    const areaRepo = await areaRepoOf(repoDir);
    const listedRepos = await areas.repos();
    const shownWidthOf = (listed: MapAreaRepo) => (isAreaFolded(listed.repoDir) ? FOLDED_AREA_WIDTH : widthByRepoKey.get(listed.repoKey) ?? 0);
    const origin = areaOriginsOf(listedRepos.map((listed) => ({ repoKey: listed.repoKey, width: shownWidthOf(listed) }))).get(areaRepo.repoKey) ?? { x: 0, y: 0 };
    return { repoKey: areaRepo.repoKey, title: areaRepo.repoName, origin, isFolded: isAreaFolded(repoDir) };
  }

  function noteBranchesChanged(): void {
    redrawListedAreas(() => true);
  }

  async function setAreaOpen(repoDir: string, isOpen: boolean): Promise<{ ok: true; isOpen: boolean } | { ok: false; error: string }> {
    if (isOpen) operatorOpenedRepoDirs.add(repoDir);
    if (!isOpen) operatorOpenedRepoDirs.delete(repoDir);
    const redrawn = await currentMap({ repoDir });
    redrawListedAreas((listedRepos, listedIndex) => listedRepos[listedIndex]?.repoDir !== repoDir);
    if (!('error' in redrawn) && redrawn.isBoardDrawn) return { ok: true, isOpen: !isAreaFolded(repoDir) };
    return { ok: false, error: 'error' in redrawn ? redrawn.error : `the map area of ${path.basename(repoDir)} was not redrawn` };
  }

  function redrawListedAreas(isRedrawn: (listedRepos: readonly MapAreaRepo[], listedIndex: number) => boolean): void {
    areas.repos().then((listedRepos) => {
      for (const [listedIndex, listed] of listedRepos.entries()) {
        if (!isRedrawn(listedRepos, listedIndex)) continue;
        currentMap({ repoDir: listed.repoDir }).catch((error: unknown) => logger.warn(`[codemap] the map area of ${listed.repoDir} was not moved: ${errorMessage(error)}`));
      }
    }).catch((error: unknown) => logger.warn(`[codemap] the Studio repo list could not be read, so no map area was moved: ${errorMessage(error)}`));
  }

  async function keepAreaWidth(repoDir: string, model: CodemapModel): Promise<void> {
    const { repoKey } = await areaPlaceOf(repoDir);
    const width = areaWidthOf(model);
    if (widthByRepoKey.get(repoKey) === width) return;
    widthByRepoKey.set(repoKey, width);
    await rememberMapBoard();
    redrawListedAreas((listedRepos, listedIndex) => listedIndex > listedRepos.findIndex((listed) => listed.repoKey === repoKey));
  }

  function hasRedWiresOutside(board: Pick<Board, 'elements'>, repoKey: string): boolean {
    const ownMapPrefix = repoIdPrefixOf(CODEMAP_ID_PREFIXES.map, repoKey);
    return [...board.elements.values()].some((element) => element.kind === 'wire' && element.tone === 'fail' && element.id.startsWith(CODEMAP_ID_PREFIXES.map) && !element.id.startsWith(ownMapPrefix));
  }

  async function drawMapBoard(boards: MapBoards, repoDir: string, changedModel: CodemapModel | null, status: CodemapStatus, overlay: OverlayDrawing): Promise<void> {
    const caller = { id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir };
    const boardId = await mapBoardIdOf(boards, repoDir);
    const read = await boards.readPlanBoard(caller, boardId);
    if (!read.ok) throw new Error(`the map board could not be read: ${JSON.stringify(read.reply.body)}`);
    const existingKindById = new Map([...read.board.elements].map(([id, element]) => [id, element.kind]));
    const place = await areaPlaceOf(repoDir);
    const area: MapArea = { ...place, hasRedWiresElsewhere: hasRedWiresOutside(read.board, place.repoKey) };
    const specOps = changedModel ? specPlanOpsOf(changedModel, overlay.specPlan, existingKindById, area.repoKey) : { removals: [], writes: [] };
    const decorations = changedModel ? { ...overlay.decorations, matrixMedia: await matrixMediaOf(boards, repoDir, changedModel) } : overlay.decorations;
    const rawOps = [...specOps.removals, ...mapStampOpsOf(status, existingKindById, area), ...(changedModel ? mapBoardOpsOf(changedModel, existingKindById, read.board.legend, decorations, area) : []), ...overlayOpsOf(overlay.stamp, existingKindById, area), ...specOps.writes];
    for (const ops of chunkedBySize(withoutUnchangedSets(OpList.parse(rawOps), read.board))) {
      const reply = await boards.putWithoutReadCheck(caller, boardId, ops);
      if (reply.status !== 200) throw new Error(`the map board refused the regeneration: ${JSON.stringify(reply.body)}`);
    }
  }

  async function matrixMediaOf(boards: MapBoards, repoDir: string, model: CodemapModel): Promise<BoxMedia | null> {
    if (!mapBoardFilePath) return null;
    const caller = { id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir };
    const repoHash = crypto.createHash('sha256').update(repoDir).digest('hex').slice(0, MATRIX_FILE_HASH_LENGTH);
    const matrixPath = path.join(path.dirname(mapBoardFilePath), `codemap-matrix-${repoHash}.csv`);
    const written = await fsp.writeFile(matrixPath, folderMatrixCsvOf(model)).then(() => null, (error: unknown) => errorMessage(error));
    const attached = written === null ? await boards.handleAgent(caller, { sub: 'attach', path: matrixPath }) : null;
    const media = attached ? AttachedMedia.safeParse(attached.body).data?.media ?? null : null;
    if (!media) logger.warn(`[codemap] the folder matrix of ${repoDir} was not attached, so the board keeps the one it has: ${written ?? JSON.stringify(attached?.body)}`);
    return media;
  }

  function redrawMapBoard(repoDir: string, changedModel: CodemapModel | null, status: CodemapStatus, overlay: OverlayDrawing): Promise<boolean> {
    if (!whiteboards) return Promise.resolve(true);
    const boards = whiteboards;
    const drawing = boardDrawing.then(() => drawMapBoard(boards, repoDir, changedModel, status, overlay)).then(() => true, (error: unknown) => {
      logger.warn(`[codemap] the map area of ${repoDir} was not redrawn: ${errorMessage(error)}`);
      return false;
    });
    boardDrawing = drawing;
    return drawing;
  }

  function overlayDrawingOf(state: RepoMapState, repoDir: string): OverlayDrawing {
    const overlay = overlayByRepoDir.get(repoDir) ?? null;
    const model = state.model;
    const overlaidModules = overlay && model ? [...new Set(overlay.paths.map((repoPath) => moduleOfPath(model, repoPath)))].sort() : [];
    const stamp = overlay ? { title: `Session ${overlay.sessionName}`, lines: [`changes ${overlay.paths.length} files in ${overlaidModules.length} modules`, ...overlaidModules] } : null;
    const specPlan = specPlanByRepoDir.get(repoDir) ?? null;
    const specKey = specPlan ? { ...specPlan, landedUnitIds: [...specPlan.landedUnitIds].sort() } : null;
    const folderChoices = [...folderChoicesByRepoDir.get(repoDir) ?? []].sort(([left], [right]) => left.localeCompare(right));
    return { key: JSON.stringify([stamp, overlaidModules, specKey, folderChoices]), specPlan, decorations: { churnByModule: state.churnByModule, overlaidModules: new Set(overlaidModules), folderChoices: new Map(folderChoices), matrixMedia: null }, stamp };
  }

  async function keepMapBoardDrawn(state: RepoMapState, repoDir: string, status: CodemapStatus): Promise<boolean> {
    const statusKey = JSON.stringify(status);
    const overlay = overlayDrawingOf(state, repoDir);
    const isOverlayChanged = state.drawnOverlayKey !== overlay.key;
    if (!state.model && !(await isAreaOwed(repoDir))) return true;
    const shownPlace = await areaPlaceOf(repoDir);
    const originKey = JSON.stringify([shownPlace.origin, shownPlace.isFolded]);
    const isAreaMoved = state.drawnOriginKey !== originKey;
    const changedModel = state.model && (state.drawnModel !== state.model || isOverlayChanged || isAreaMoved) ? state.model : null;
    if (!changedModel && state.drawnStatusKey === statusKey && !isOverlayChanged && !isAreaMoved) return true;
    if (clock.nowMs() < state.drawRetryAtMs) return false;
    if (await redrawMapBoard(repoDir, changedModel, status, overlay)) {
      state.drawnModel = state.model ?? state.drawnModel;
      state.drawnStatusKey = statusKey;
      state.drawnOverlayKey = overlay.key;
      state.drawnOriginKey = originKey;
      return true;
    }
    state.drawRetryAtMs = clock.nowMs() + CODEMAP_TUNABLES.failureRetryMs;
    return false;
  }

  async function repoMainlineShaOf(repoDir: string): Promise<string | null> {
    return mainlineShaOf(repoDir, configuredMainlineBranch() ?? await detectDefaultBranch({ projectPath: repoDir }));
  }

  async function isRepoGated(repoDir: string): Promise<boolean> {
    if (!homeDir) return false;
    const repoKey = await repoKeyOf(repoDir);
    const lookup = repoKey ? await readCodemapSetup(homeDir, repoKey) : { kind: 'none' as const };
    return lookup.kind === 'ok' && lookup.setup.gate;
  }

  async function moduleLayoutOf(repoDir: string): Promise<readonly string[] | null> {
    if (!homeDir) return null;
    const repoKey = await repoKeyOf(repoDir);
    const lookup = repoKey ? await readCodemapSetup(homeDir, repoKey) : { kind: 'none' as const };
    return lookup.kind === 'ok' ? lookup.setup.modules : null;
  }

  const stateByRepoDir = new Map<string, RepoMapState>();

  function stateOf(repoDir: string): RepoMapState {
    const known = stateByRepoDir.get(repoDir);
    if (known) return known;
    const created: RepoMapState = { model: null, modelLayoutKey: null, extractBase: null, failure: null, mainlineStructure: null, latestStatus: null, churnByModule: null, drawnModel: null, drawnStatusKey: null, drawnOverlayKey: null, drawnOriginKey: null, drawRetryAtMs: 0, startedCheckCount: 0, appliedCheckNumber: 0, refreshesInFlight: 0 };
    stateByRepoDir.set(repoDir, created);
    return created;
  }

  function statusOf(state: RepoMapState, mainlineSha: string): CodemapStatus {
    const sha = state.model?.sha ?? null;
    if (state.failure?.sha === mainlineSha) return { sha, mainlineSha, state: 'failed', reason: state.failure.reason };
    return { sha, mainlineSha, state: sha === mainlineSha ? 'current' : 'behind', reason: null };
  }

  async function currentMap(repo: CodemapRepo): Promise<CurrentMap | { error: string }> {
    if (!isMappedDir(repo.repoDir)) return { error: `${repo.repoDir} is not a repo Glimmervoid maps` };
    const state = stateOf(repo.repoDir);
    state.startedCheckCount += 1;
    const checkNumber = state.startedCheckCount;
    const mainlineSha = await repoMainlineShaOf(repo.repoDir);
    if (!mainlineSha) return { error: `${repo.repoDir} has no commit to map; the code map needs a git repository with a mainline commit` };
    const moduleLayout = await moduleLayoutOf(repo.repoDir);
    const layoutKey = JSON.stringify(moduleLayout);
    const isFailureFresh = state.failure?.sha === mainlineSha && clock.nowMs() < state.failure.retryAtMs;
    const isModelCurrent = state.model?.sha === mainlineSha && state.modelLayoutKey === layoutKey;
    if (!isModelCurrent && !isFailureFresh) await advanceMap(state, repo.repoDir, mainlineSha, checkNumber, moduleLayout);
    if (checkNumber < state.appliedCheckNumber && state.latestStatus) return { model: state.model, status: state.latestStatus, isBoardDrawn: true };
    state.appliedCheckNumber = checkNumber;
    const status = statusOf(state, mainlineSha);
    state.latestStatus = status;
    const isBoardDrawn = await keepMapBoardDrawn(state, repo.repoDir, status);
    return { model: state.model, status, isBoardDrawn };
  }

  const failureRetryTimerByRepoDir = new Map<string, NodeJS.Timeout>();

  function retryMapOnce(repoDir: string): void {
    clearTimeout(failureRetryTimerByRepoDir.get(repoDir));
    const timer = setTimeout(() => {
      failureRetryTimerByRepoDir.delete(repoDir);
      const failure = stateOf(repoDir).failure;
      if (failure) failure.retryAtMs = 0;
      currentMap({ repoDir }).catch((error: unknown) => logger.warn(`[codemap] the failed map of ${repoDir} was not retried: ${errorMessage(error)}`));
    }, CODEMAP_TUNABLES.failureRetryMs);
    timer.unref();
    failureRetryTimerByRepoDir.set(repoDir, timer);
  }

  async function advanceMap(state: RepoMapState, repoDir: string, mainlineSha: string, checkNumber: number, moduleLayout: readonly string[] | null): Promise<void> {
    try {
      const extract = await client.extract(repoDir, mainlineSha, state.extractBase);
      const recentCommits = await recentCommitsOf(repoDir, mainlineSha);
      if (checkNumber < state.appliedCheckNumber) return;
      state.appliedCheckNumber = checkNumber;
      state.model = buildCodemapModel(extract, moduleLayout);
      state.churnByModule = recentCommits ? churnByModuleOf(state.model, recentCommits) : null;
      state.modelLayoutKey = JSON.stringify(moduleLayout);
      state.extractBase = extractBaseOf(extract);
      state.failure = null;
      state.drawRetryAtMs = 0;
      await keepAreaWidth(repoDir, state.model);
      await settleSetup(repoDir, state.model).catch((error: unknown) => {
        logger.warn(`[codemap] the code map setup of ${repoDir} was not seeded or ratcheted: ${errorMessage(error)}`);
      });
      if (await isRepoGated(repoDir)) mainlineGraphOf(repoDir, mainlineSha).catch((error: unknown) => logger.warn(`[codemap] the structure of ${repoDir} at ${mainlineSha.slice(0, 7)} was not indexed: ${errorMessage(error)}`));
    } catch (error) {
      if (checkNumber < state.appliedCheckNumber) return;
      state.appliedCheckNumber = checkNumber;
      const isFirstFailureAtSha = state.failure?.sha !== mainlineSha;
      state.failure = { sha: mainlineSha, reason: errorMessage(error), retryAtMs: clock.nowMs() + CODEMAP_TUNABLES.failureRetryMs };
      state.drawRetryAtMs = 0;
      if (isFirstFailureAtSha) retryMapOnce(repoDir);
    }
  }

  function mainlineGraphOf(repoDir: string, mainlineSha: string): Promise<SymbolGraph> {
    if (!structureRunner) return Promise.reject(new Error('structure indexing is not available in this Glimmervoid'));
    const state = stateOf(repoDir);
    if (state.mainlineStructure?.sha === mainlineSha) return state.mainlineStructure.graph;
    const graph = structureRunner.symbolGraphOf(repoDir, mainlineSha);
    const cached = { sha: mainlineSha, graph };
    state.mainlineStructure = cached;
    const forget = () => {
      if (state.mainlineStructure === cached) state.mainlineStructure = null;
    };
    graph.then((resolved) => {
      if (resolved.unjudgedLanguages.length > 0) forget();
    }, forget);
    return graph;
  }

  function structureCheckOf(repoDir: string, mainlineSha: string): StructureCheck | null {
    if (!structureRunner) return null;
    return { runner: structureRunner, mainlineGraph: () => mainlineGraphOf(repoDir, mainlineSha) };
  }

  async function settleSetup(repoDir: string, model: CodemapModel): Promise<void> {
    if (!homeDir) return;
    const setupHome = homeDir;
    const repoKey = await repoKeyOf(repoDir);
    if (!repoKey) return;
    const lookup = await readCodemapSetup(setupHome, repoKey);
    if (lookup.kind === 'invalid') return;
    const isSetupUnchanged = (setup: CodemapSetup) => JSON.stringify(settledSetupOf(model, setup)) === JSON.stringify(setup);
    if (lookup.kind === 'ok' && isSetupUnchanged(lookup.setup)) return;
    const updated = updateCodemapSetup(setupHome, repoKey, (current) => {
      if (!current) return seededSetupOf(repoKey, model);
      return isSetupUnchanged(current) ? null : settledSetupOf(model, current);
    });
    if (updated.kind === 'invalid') throw new Error(updated.message);
  }

  async function builtInChecksOf(session: { path: string; worktreeDir: string | null }, commitSha: string | null): Promise<CheckOutcome[]> {
    if (!homeDir || !session.worktreeDir) return [];
    const map = await currentMap({ repoDir: session.path });
    const mainlineSha = 'error' in map ? null : map.status.mainlineSha;
    const repoKey = await repoKeyOf(session.path);
    const lookup = repoKey ? await readCodemapSetup(homeDir, repoKey) : { kind: 'none' as const };
    if (lookup.kind === 'ok' && !lookup.setup.gate) return [];
    if (lookup.kind === 'none' || !mainlineSha) {
      const reason = 'error' in map ? map.error : map.status.reason ?? 'mainline has not been mapped yet';
      return [{ id: CODEMAP_CHECK_ID, command: CODEMAP_BUILT_IN_COMMAND, status: 'skipped', exitCode: null, outputTail: `this repo is not import gated yet, since Glimmervoid writes its code map setup the first time it maps mainline: ${reason}` }];
    }
    const state = stateOf(session.path);
    const mainline = state.model?.sha === mainlineSha && state.extractBase ? { model: state.model, base: state.extractBase } : null;
    const checked = await checkWorktree({ client, structure: structureCheckOf(session.path, mainlineSha), homeDir, worktreeDir: session.worktreeDir, mainlineSha, mainline, commitSha }).catch((error: unknown) => ({ ok: false as const, error: errorMessage(error) }));
    const isRefusing = !checked.ok || checked.isRefusing;
    const text = checked.ok ? checked.text : `codemap check could not judge this tree: ${checked.error}`;
    return [{ id: CODEMAP_CHECK_ID, command: CODEMAP_BUILT_IN_COMMAND, status: isRefusing ? 'fail' : 'pass', exitCode: null, outputTail: text.slice(-VERIFICATION_OUTPUT_TAIL_BYTES) }];
  }

  async function requiredCheckIdsOf(session: { path: string }): Promise<string[]> {
    if (!homeDir) return [];
    await currentMap({ repoDir: session.path });
    const repoKey = await repoKeyOf(session.path);
    const lookup = repoKey ? await readCodemapSetup(homeDir, repoKey) : { kind: 'none' as const };
    if (lookup.kind === 'none') return [];
    return lookup.kind === 'invalid' || lookup.setup.gate ? [CODEMAP_CHECK_ID] : [];
  }

  async function specPlanOf(repoDir: string, slug: string): Promise<{ ok: true; plan: SpecPlan } | { ok: false; status: number; error: string }> {
    const repoName = path.basename(await repoKeyOf(repoDir) ?? repoDir);
    const lookup = await readDesignSpec(specsRoot, repoName, slug);
    if (lookup.kind === 'none') return { ok: false, status: UNKNOWN_TARGET_STATUS, error: `no design spec ${slug} for ${repoName} under ${specsRoot}` };
    if (lookup.kind === 'invalid') return { ok: false, status: BAD_REQUEST_STATUS, error: lookup.message };
    const specRepoKey = lookup.spec.repoRoot ? await repoKeyOf(lookup.spec.repoRoot) : null;
    const repoKey = await repoKeyOf(repoDir);
    if (specRepoKey && specRepoKey !== repoKey) return { ok: false, status: BAD_REQUEST_STATUS, error: `design spec ${slug} under ${repoName} belongs to ${specRepoKey}, not ${repoKey ?? repoDir}` };
    const mainlineSha = await repoMainlineShaOf(repoDir);
    const ticketTrailers = mainlineSha ? await ticketTrailersOf(repoDir, mainlineSha) : null;
    const landedUnitIds = new Set(lookup.spec.units.filter((unit) => ticketTrailers?.has(`${slug}/${unit.id}`)).map((unit) => unit.id));
    return { ok: true, plan: { slug, units: lookup.spec.units, dependsOn: lookup.spec.dependsOn, landedUnitIds } };
  }

  async function reloadSpecPlan(repoDir: string): Promise<void> {
    const shown = specPlanByRepoDir.get(repoDir);
    if (!shown) return;
    const reloaded = await specPlanOf(repoDir, shown.slug);
    if (reloaded.ok && specPlanByRepoDir.get(repoDir) === shown) specPlanByRepoDir.set(repoDir, reloaded.plan);
  }

  function refresh(session: MappedSession): void {
    const state = stateOf(session.path);
    state.refreshesInFlight += 1;
    void reloadSpecPlan(session.path).then(() => currentMap({ repoDir: session.path })).catch((error: unknown) => {
      logger.warn(`[codemap] the map of ${session.path} was not refreshed: ${errorMessage(error)}`);
    }).finally(() => {
      state.refreshesInFlight -= 1;
    });
  }

  async function sessionOverlayOf(repoDir: string, sessionId: string): Promise<SessionOverlay | null> {
    startedOverlayRefreshCount += 1;
    const refreshNumber = startedOverlayRefreshCount;
    const changes = changesOfSession ? await changesOfSession(sessionId) : null;
    if (!changes) return null;
    const repoKey = await repoKeyOf(repoDir);
    const pathsByRepo = await Promise.all(changes.repos.map(async (changedRepo) => ((await repoKeyOf(changedRepo.root)) === repoKey ? changedRepo.paths : [])));
    return { refreshNumber, sessionId, sessionName: changes.name, paths: [...new Set(pathsByRepo.flat())].sort() };
  }

  async function refreshOverlay(repoDir: string, sessionId: string): Promise<void> {
    const refreshed = await sessionOverlayOf(repoDir, sessionId);
    const shown = overlayByRepoDir.get(repoDir);
    if (refreshed && shown?.sessionId === sessionId && shown.refreshNumber < refreshed.refreshNumber) overlayByRepoDir.set(repoDir, refreshed);
    await currentMap({ repoDir });
  }

  function refreshOverlaysOf(sessionId: string): void {
    for (const [repoDir, overlay] of overlayByRepoDir) {
      if (overlay.sessionId !== sessionId) continue;
      void refreshOverlay(repoDir, sessionId).catch((error: unknown) => {
        logger.warn(`[codemap] the session overlay on the map of ${repoDir} was not refreshed: ${errorMessage(error)}`);
      });
    }
  }

  function attachSession(session: MappedSession): void {
    refresh(session);
    session.on('commits-landed', () => refresh(session));
    session.on('post-turn-check', () => refreshOverlaysOf(session.id));
  }

  async function applyOverlayRequest(repo: CodemapRepo, request: Extract<AgentCodemapRequest, { sub: 'overlay' }>): Promise<CodemapOutcome | null> {
    const repoName = path.basename(repo.repoDir);
    if (request.layer === 'none') {
      overlayByRepoDir.delete(repo.repoDir);
      specPlanByRepoDir.delete(repo.repoDir);
      return null;
    }
    if (request.layer === 'spec') {
      if (!request.id || !CODEMAP_SPEC_SLUG.test(request.id)) return { ok: false, status: BAD_REQUEST_STATUS, error: 'codemap overlay spec needs a design spec slug of lowercase letters, digits and dashes' };
      const loaded = await specPlanOf(repo.repoDir, request.id);
      if (!loaded.ok) return loaded;
      specPlanByRepoDir.set(repo.repoDir, loaded.plan);
      return null;
    }
    const sessionId = request.id ?? repo.sessionId ?? null;
    if (!sessionId) return { ok: false, status: BAD_REQUEST_STATUS, error: 'codemap overlay session needs a session id outside a session' };
    const overlay = await sessionOverlayOf(repo.repoDir, sessionId);
    if (!overlay) return { ok: false, status: UNKNOWN_SESSION_STATUS, error: `no live session ${sessionId} to overlay on the map of ${repoName}` };
    overlayByRepoDir.set(repo.repoDir, overlay);
    return null;
  }

  async function setFolderOpen(repoDir: string, boxId: string, isOpen: boolean): Promise<{ ok: true; isOpen: boolean } | { ok: false; error: string }> {
    const map = await currentMap({ repoDir });
    if ('error' in map) return { ok: false, error: map.error };
    if (!map.model) return { ok: false, error: `the code map of ${path.basename(repoDir)} is not built yet` };
    const { repoKey } = await areaRepoOf(repoDir);
    if (boxId === areaFrameIdOf(repoKey) || boxId === areaCardIdOf(repoKey)) return setAreaOpen(repoDir, isOpen);
    const folder = folderOfMapBoxId(repoKey, map.model, boxId);
    if (folder === null) return { ok: false, error: 'that box is not a folder on the code map' };
    const folderChoices = folderChoicesByRepoDir.get(repoDir) ?? new Map<string, boolean>();
    const previousChoice = folderChoices.get(folder);
    folderChoices.set(folder, isOpen);
    folderChoicesByRepoDir.set(repoDir, folderChoices);
    const redrawn = await currentMap({ repoDir });
    if (!('error' in redrawn) && redrawn.isBoardDrawn) return { ok: true, isOpen };
    if (previousChoice === undefined) folderChoices.delete(folder);
    if (previousChoice !== undefined) folderChoices.set(folder, previousChoice);
    return { ok: false, error: 'error' in redrawn ? redrawn.error : `the code map of ${path.basename(repoDir)} was not redrawn` };
  }

  async function boxesOfSession(repoDir: string, sessionId: string, paths: readonly string[]): Promise<{ ok: true; boardId: string | null; boxIdByPath: Record<string, string>; fallbackBoxId: string; changedBoxIds: string[]; boxChoices: { boxId: string; title: string }[]} | { ok: false; error: string; isMapFailed: boolean; boardId: string | null }> {
    const map = await currentMap({ repoDir });
    if ('error' in map) return { ok: false, error: map.error, isMapFailed: true, boardId: mapBoardId };
    const model = map.model;
    if (!model) return { ok: false, error: `the code map of ${path.basename(repoDir)} is not built yet`, isMapFailed: map.status.state === 'failed', boardId: mapBoardId };
    const { repoKey } = await areaRepoOf(repoDir);
    const boxIdOfPath = (repoPath: string) => drawnBoxIdOfPath(repoKey, model, repoPath);
    const repoRelativePaths = paths.filter((repoPath) => !path.isAbsolute(repoPath) && !repoPath.startsWith('..'));
    const overlay = await sessionOverlayOf(repoDir, sessionId);
    const boardId = whiteboards ? await mapBoardIdOf(whiteboards, repoDir) : null;
    return {
      ok: true,
      boardId,
      boxIdByPath: Object.fromEntries(repoRelativePaths.map((repoPath) => [repoPath, boxIdOfPath(repoPath)])),
      fallbackBoxId: fallbackBoxIdOf(repoKey, model),
      changedBoxIds: [...new Set((overlay?.paths ?? []).map(boxIdOfPath))].sort(),
      boxChoices: branchBoxChoicesOf(repoKey, model, boxIdOfPath).slice(0, CODEMAP_BOX_CHOICES_MAX),
    };
  }

  async function boxesOfStudioPaths(sessionId: string, studioPaths: readonly string[]): Promise<{ ok: true; boardId: string | null; boxIdByPath: Record<string, string> }> {
    const listedRepos = await areas.repos();
    const repoPathIn = (listed: MapAreaRepo, studioPath: string): string | null => {
      if (path.isAbsolute(studioPath)) {
        const pathFromRepo = path.relative(listed.repoDir, studioPath);
        const isInsideRepo = pathFromRepo !== '' && !pathFromRepo.startsWith('..') && !path.isAbsolute(pathFromRepo);
        return isInsideRepo ? pathFromRepo.split(path.sep).join('/') : null;
      }
      const [repoName, ...repoPathParts] = studioPath.split('/');
      return repoName?.toLowerCase() === listed.repoName.toLowerCase() && repoPathParts.length > 0 ? repoPathParts.join('/') : null;
    };
    const placedPaths = await Promise.all(studioPaths.map(async (studioPath) => {
      const placed = listedRepos.flatMap((listed) => {
        const repoPath = repoPathIn(listed, studioPath);
        return repoPath === null ? [] : [{ listed, repoPath }];
      })[0];
      if (!placed) return [];
      const boxes = await boxesOfSession(placed.listed.repoDir, sessionId, [placed.repoPath]);
      const boxId = boxes.ok ? boxes.boxIdByPath[placed.repoPath] : undefined;
      return boxId === undefined ? [] : [[studioPath, boxId] as const];
    }));
    const firstRepoDir = listedRepos[0]?.repoDir;
    const boardId = whiteboards && firstRepoDir ? await mapBoardIdOf(whiteboards, firstRepoDir) : mapBoardId;
    return { ok: true, boardId, boxIdByPath: Object.fromEntries(placedPaths.flat()) };
  }

  function boxRectsOf(boardId: string, boxIds: readonly string[]): Promise<Record<string, Rect>> {
    return whiteboards ? whiteboards.boxRectsOf(boardId, boxIds) : Promise.resolve({});
  }

  function branchTargetAt(boxId: string, repoPath: string): BranchTarget {
    const title = repoPath === '.' ? REPO_ROOT_BRANCH_TITLE : repoPath;
    if (title.length > WHITEBOARD_LIMITS.title) return { ok: false, error: `${repoPath} is too long a path to name a branch after; start the branch on a folder above it` };
    return { ok: true, boxId, title };
  }

  function branchTargetOfModule(repoKey: string, model: CodemapModel, moduleId: string): BranchTarget {
    return branchTargetAt(moduleId === '.' ? fallbackBoxIdOf(repoKey, model) : moduleBoxIdOf(repoKey, moduleId), moduleId);
  }

  async function branchTargetOf(repoDir: string, about: BranchAbout): Promise<BranchTarget> {
    const map = await currentMap({ repoDir });
    if ('error' in map) return { ok: false, error: map.error };
    if (!map.model) return { ok: false, error: `the code map of ${path.basename(repoDir)} is not built yet` };
    const model = map.model;
    const { repoKey, repoName } = await areaRepoOf(repoDir);
    if ('repoPath' in about) return branchTargetOfPath(repoKey, model, repoName, about.repoPath);
    const folder = folderOfMapBoxId(repoKey, model, about.boxId);
    if (folder !== null) return branchTargetAt(about.boxId, folder);
    const moduleId = model.modules.map((summary) => summary.id).find((candidate) => candidate !== '.' && moduleBoxIdOf(repoKey, candidate) === about.boxId) ?? (about.boxId === fallbackBoxIdOf(repoKey, model) ? '.' : null);
    if (moduleId === null) return { ok: false, error: 'that box is not a folder or file on the code map any more; pick another' };
    return branchTargetOfModule(repoKey, model, moduleId);
  }

  function branchTargetOfPath(repoKey: string, model: CodemapModel, repoName: string, aboutPath: string): BranchTarget {
    const repoPath = aboutPath.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (repoPath === '' || repoPath === '.' || repoPath.toLowerCase() === REPO_ROOT_BRANCH_TITLE) return branchTargetOfModule(repoKey, model, '.');
    const moduleIds = model.modules.map((summary) => summary.id);
    if (moduleIds.includes(repoPath)) return branchTargetOfModule(repoKey, model, repoPath);
    if (moduleIds.some((moduleId) => folderOf(moduleId) === repoPath)) return branchTargetAt(folderCardIdOf(repoKey, repoPath), repoPath);
    if (model.indexByPath.has(repoPath) || moduleIds.some((moduleId) => repoPath.startsWith(`${moduleId}/`))) return branchTargetOfModule(repoKey, model, moduleOfPath(model, repoPath));
    return { ok: false, error: `${aboutPath} is not a folder, module or file on the code map of ${repoName}; codemap map lists them, and repo root names the whole repo` };
  }

  function overlayTextOf(repoName: string, drawing: OverlayDrawing): string {
    const sessionText = drawing.stamp ? [`${drawing.stamp.title.toLowerCase()} ${drawing.stamp.lines.join(', ')}`] : [];
    const specText = drawing.specPlan ? [`spec ${drawing.specPlan.slug} draws ${drawing.specPlan.units.length} units as plan steps, ${drawing.specPlan.landedUnitIds.size} landed`] : [];
    const parts = [...sessionText, ...specText];
    return parts.length > 0 ? `codemap overlay on the map of ${repoName}: ${parts.join('; ')}` : `codemap overlay: the map of ${repoName} shows no overlay.`;
  }

  async function overlayOutcomeOf(repo: CodemapRepo, request: Extract<AgentCodemapRequest, { sub: 'overlay' }>): Promise<CodemapOutcome> {
    const repoName = path.basename(repo.repoDir);
    const refused = await applyOverlayRequest(repo, request);
    if (refused) return refused;
    stateOf(repo.repoDir).drawRetryAtMs = 0;
    const map = await currentMap(repo);
    if ('error' in map) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: map.error };
    if (!map.isBoardDrawn) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: `the map board of ${repoName} could not be redrawn, so the overlay is not shown yet; the next map read retries it` };
    return { ok: true, reply: { ok: true, text: overlayTextOf(repoName, overlayDrawingOf(stateOf(repo.repoDir), repo.repoDir)), status: map.status } };
  }

  async function eraseArea(boards: MapBoards, repoDir: string, repoKey: string): Promise<void> {
    const caller = { id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir };
    const boardId = await mapBoardIdOf(boards, repoDir);
    const read = await boards.readPlanBoard(caller, boardId);
    if (!read.ok) throw new Error(`the map board could not be read: ${JSON.stringify(read.reply.body)}`);
    const existingKindById = new Map([...read.board.elements].map(([id, element]) => [id, element.kind]));
    for (const ops of chunkedBySize(withoutUnchangedSets(OpList.parse(areaRemovalOpsOf(repoKey, existingKindById, read.board.legend, hasRedWiresOutside(read.board, repoKey))), read.board))) {
      const reply = await boards.putWithoutReadCheck(caller, boardId, ops);
      if (reply.status !== 200) throw new Error(`the map board refused the removal: ${JSON.stringify(reply.body)}`);
    }
  }

  async function removeArea(repoDir: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const listed = (await areas.repos()).find((candidate) => candidate.repoDir === repoDir);
    if (!listed) return { ok: true };
    const { repoKey } = listed;
    const boards = whiteboards;
    const erasing = boardDrawing.then(async () => {
      if (boards) await eraseArea(boards, repoDir, repoKey);
      await areas.removeRepo(repoKey);
    }).then(() => null, (error: unknown) => errorMessage(error));
    boardDrawing = erasing.then((eraseError) => eraseError === null);
    const eraseError = await erasing;
    if (eraseError !== null) return { ok: false, error: `the map area of ${path.basename(repoDir)} was not removed: ${eraseError}` };
    widthByRepoKey.delete(repoKey);
    stateByRepoDir.delete(repoDir);
    overlayByRepoDir.delete(repoDir);
    specPlanByRepoDir.delete(repoDir);
    folderChoicesByRepoDir.delete(repoDir);
    await rememberMapBoard();
    redrawListedAreas(() => true);
    return { ok: true };
  }

  function noticeOf(repoDir: string): string | null {
    const state = stateByRepoDir.get(repoDir);
    if (state?.latestStatus) return codemapNoticeOf(path.basename(repoDir), state.latestStatus);
    if (state && state.refreshesInFlight > 0) return `Code map of ${path.basename(repoDir)} is being built; read it with codemap map.`;
    return null;
  }

  async function handle(repo: CodemapRepo, request: AgentCodemapRequest): Promise<CodemapOutcome> {
    if (request.sub === 'allow') return { ok: false, status: OPERATOR_ONLY_STATUS, error: `only the operator allows a module import; ask the operator to run glimmervoid codemap allow ${repo.repoDir} ${request.from} ${request.to} outside a session` };
    if (request.sub === 'check') return checkOutcomeOf(repo);
    if (request.sub === 'shrink') return shrinkOutcomeOf(repo);
    if (request.sub === 'setup') return setupOutcomeOf(repo);
    if (request.sub === 'overlay') return overlayOutcomeOf(repo, request);
    if (request.sub === 'export') return exportOutcomeOf(repo, request.kind);
    const map = await currentMap(repo);
    if ('error' in map) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: map.error };
    const repoName = path.basename(repo.repoDir);
    if (request.sub === 'map') return { ok: true, reply: { ok: true, text: mapTextOf(map.model, map.status, repoName), status: map.status } };
    if (!map.model) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: mapTextOf(null, map.status, repoName) };
    const answer = request.sub === 'where' ? whereOf(map.model, request.target) : impactOf(map.model, request.paths);
    if (!answer.ok) return { ok: false, status: UNKNOWN_TARGET_STATUS, error: answer.error };
    return { ok: true, reply: { ok: true, text: answer.text, status: map.status } };
  }

  async function shrinkOutcomeOf(repo: CodemapRepo): Promise<CodemapOutcome> {
    const mainlineSha = await repoMainlineShaOf(repo.repoDir);
    const repoKey = await repoKeyOf(repo.repoDir);
    if (!mainlineSha || !repoKey) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: `${repo.repoDir} has no mainline commit to shrink the setup against` };
    if (!homeDir) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: 'the code map setup store is not available in this Glimmervoid' };
    const shrunk = await shrinkSetup({ client, homeDir, repoKey, mainlineSha });
    if (!shrunk.ok) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: shrunk.error };
    const map = await currentMap(repo);
    if ('error' in map) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: map.error };
    return { ok: true, reply: { ok: true, text: shrunk.text, status: map.status } };
  }

  async function setupOutcomeOf(repo: CodemapRepo): Promise<CodemapOutcome> {
    const repoKey = await repoKeyOf(repo.repoDir);
    if (!repoKey) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: `${repo.repoDir} is not inside a git repository` };
    if (!homeDir) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: 'the code map setup store is not available in this Glimmervoid' };
    const map = await currentMap(repo);
    if ('error' in map) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: map.error };
    const lookup = await readCodemapSetup(homeDir, repoKey);
    if (lookup.kind === 'invalid') return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: lookup.message };
    if (lookup.kind === 'none' && !map.model) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: mapTextOf(null, map.status, path.basename(repo.repoDir)) };
    const seeded = lookup.kind === 'none' && map.model ? seededSetupOf(repoKey, map.model) : null;
    const updated = updateCodemapSetup(homeDir, repoKey, (current) => {
      if (!current) return seeded;
      return current.gate ? null : { ...current, gate: true };
    });
    if (updated.kind !== 'ok') return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: updated.kind === 'invalid' ? updated.message : `${repoKey} has no code map setup to gate` };
    const { setup } = updated;
    const heldWireCount = moduleImportAllowsOf(setup.allow).filter((entry) => entry.fileImportCeiling !== null).length;
    const wasGated = lookup.kind === 'ok' && lookup.setup.gate;
    return { ok: true, reply: { ok: true, text: `the import gate of ${repoKey} is on${wasGated ? ' already' : ''}: ${moduleImportAllowsOf(setup.allow).length} allowed module imports, ${heldWireCount} crossed wires held to their file import ceilings. A merge from this repo is refused while codemap check names an import the setup does not allow; only the operator turns the gate off (glimmervoid codemap setup ${repoKey} --gate off) or allows an import.`, status: map.status } };
  }

  async function exportOutcomeOf(repo: CodemapRepo, kind: CodemapExportKind): Promise<CodemapOutcome> {
    const worktreeRoot = await worktreeRootOf(repo.worktreeDir ?? repo.repoDir);
    const repoKey = worktreeRoot ? await repoKeyOf(worktreeRoot) : null;
    const headSha = worktreeRoot ? await revParse(worktreeRoot, 'HEAD') : null;
    if (!worktreeRoot || !repoKey || !headSha) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: `${repo.worktreeDir ?? repo.repoDir} has no commit to export from` };
    if (!homeDir) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: 'the code map setup store is not available in this Glimmervoid' };
    const map = await currentMap(repo);
    const lookup = await readCodemapSetup(homeDir, repoKey);
    if (lookup.kind === 'invalid') return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: lookup.message };
    const enabledExports = lookup.kind === 'ok' ? lookup.setup.exports : [];
    if (lookup.kind === 'none' || !enabledExports.includes(kind)) return { ok: false, status: OPERATOR_ONLY_STATUS, error: `the code map setup of ${repoKey} does not enable the ${kind} export; only the operator enables one (glimmervoid codemap setup ${repoKey} --exports ${[...new Set([...enabledExports, kind])].join(',')})` };
    const fileName = CODEMAP_EXPORT_FILE_BY_KIND[kind];
    const text = kind === 'lint' ? lintConfigTextOf(lookup.setup) : exportedMapTextOf(buildCodemapModel(await client.extract(worktreeRoot, headSha), lookup.setup.modules));
    const writeError = await writeExportFile(path.join(worktreeRoot, fileName), text);
    if (writeError) return { ok: false, status: CONFLICTING_FILE_STATUS, error: `codemap export left ${fileName} in ${worktreeRoot} alone: ${writeError}` };
    const status = 'error' in map ? { sha: null, mainlineSha: null, state: 'failed' as const, reason: map.error } : map.status;
    const followUp = kind === 'map' ? ` It maps the source committed at ${headSha.slice(0, 7)}; commit it, and export again after committing more source, since codemap check refuses an out of date ${fileName}.` : ' Commit it; dependency-cruiser (npx depcruise --config .dependency-cruiser.cjs <source folders>) then refuses a module import this setup does not allow.';
    return { ok: true, reply: { ok: true, text: `codemap export wrote ${fileName} into ${worktreeRoot}.${followUp}`, status } };
  }

  async function checkOutcomeOf(repo: CodemapRepo): Promise<CodemapOutcome> {
    const mainlineSha = await repoMainlineShaOf(repo.repoDir);
    if (!mainlineSha) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: `${repo.repoDir} has no commit to check against` };
    if (!homeDir) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: 'the code map setup store is not available in this Glimmervoid' };
    const checked = await checkWorktree({ client, structure: structureCheckOf(repo.repoDir, mainlineSha), homeDir, worktreeDir: repo.worktreeDir ?? repo.repoDir, mainlineSha });
    if (!checked.ok) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: checked.error };
    const map = await currentMap(repo);
    const status = 'error' in map ? { sha: null, mainlineSha, state: 'failed' as const, reason: map.error } : map.status;
    return { ok: true, reply: { ok: true, text: checked.text, status } };
  }

  return { handle, attachSession, noticeOf, builtInChecksOf, requiredCheckIdsOf, boxesOfSession, boxRectsOf, branchTargetOf, setFolderOpen, mapBoardIdOfRepo, removeArea, openArea, repoOfBox, noteBranchesChanged, studioAreas, boxesOfStudioPaths, listedRepos: () => areas.repos() };
}

type CodemapService = ReturnType<typeof createCodemapService>;

export { checkWorktree, directImportersOf, shrinkSetup, createCodemapService };
export type { CodemapService };
