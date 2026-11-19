import path from 'node:path';
import { z } from 'zod';

import type { AgentCodemapReply, AgentCodemapRequest, CodemapExtract, CodemapExtractBase, CodemapStatus } from '../../shared/contracts/codemap.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { Op, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import { CODEMAP_AUTHOR } from '../../shared/whiteboard-ops-core.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';
import { createJsonStateStore } from '../json-file.ts';
import { changedPathsSince, mainlineShaOf, readCodemapSetup, repoKeyOf, revParse } from './codemap-store.ts';
import { buildCodemapModel, checkTextOf, CODEMAP_TUNABLES, codemapNoticeOf, unallowedEdgesOf, unjudgedPathsOf, impactOf, mapBoardOpsOf, mapStampOpsOf, mapTextOf, whereOf } from '../core/codemap-graph-core.ts';
import type { CodemapModel } from '../core/codemap-graph-core.ts';
import { createCodemapClient } from './codemap-client.ts';
import type { CodemapClient } from './codemap-client.ts';

interface CodemapRepo {
  repoDir: string;
  worktreeDir?: string | null;
}

interface WorktreeCheck {
  client: CodemapClient;
  homeDir: string;
  worktreeDir: string;
  mainlineSha: string;
}

type WorktreeCheckOutcome = { ok: true; isRefusing: boolean; text: string } | { ok: false; error: string };

async function checkWorktree({ client, homeDir, worktreeDir, mainlineSha }: WorktreeCheck): Promise<WorktreeCheckOutcome> {
  const repoKey = await repoKeyOf(worktreeDir);
  if (!repoKey) return { ok: false, error: `${worktreeDir} is not inside a git repository` };
  const repoName = path.basename(repoKey);
  const lookup = await readCodemapSetup(homeDir, repoKey);
  if (lookup.kind === 'none') return { ok: true, isRefusing: false, text: `codemap check: ${repoName} has no code map setup, so no module import is judged.` };
  if (lookup.kind === 'invalid') return { ok: false, error: lookup.message };
  const headSha = await revParse(worktreeDir, 'HEAD');
  const changedPaths = await changedPathsSince(worktreeDir, mainlineSha);
  if (!headSha || !changedPaths) return { ok: false, error: `${worktreeDir} has no commit to compare with mainline ${mainlineSha.slice(0, 7)}` };
  const model = buildCodemapModel(await client.extract(worktreeDir, headSha), lookup.setup.modules);
  const unallowedEdges = unallowedEdgesOf(model, changedPaths, lookup.setup.allow);
  const unjudgedPaths = unjudgedPathsOf(model, changedPaths);
  const gateNote = lookup.setup.gate ? null : 'The import gate is off for this repo, so these never refuse a push.';
  return { ok: true, isRefusing: lookup.setup.gate && (unallowedEdges.length > 0 || unjudgedPaths.length > 0), text: checkTextOf(repoName, unallowedEdges, unjudgedPaths, gateNote) };
}

interface RepoMapState {
  model: CodemapModel | null;
  modelLayoutKey: string | null;
  extractBase: CodemapExtractBase | null;
  failure: { sha: string; reason: string; retryAtMs: number } | null;
  latestStatus: CodemapStatus | null;
  drawnModel: CodemapModel | null;
  drawnStatusKey: string | null;
  drawRetryAtMs: number;
  startedCheckCount: number;
  appliedCheckNumber: number;
  refreshesInFlight: number;
}

interface MappedSession {
  path: string;
  on(event: 'commits-landed', listener: (landed: { repoDir: string }) => void): unknown;
}

function extractBaseOf(extract: CodemapExtract): CodemapExtractBase {
  return { sha: extract.sha, paths: extract.paths, specifiersByIndex: extract.specifiersByIndex, exportedNamesByIndex: extract.exportedNamesByIndex };
}

const MapBoardIds = z.record(z.string(), z.string());
const PUT_BYTES_HEADROOM = 64 * 1024;

type DefaultBranchDetector = (probe: { projectPath: string }) => Promise<string | null>;

interface CurrentMap {
  model: CodemapModel | null;
  status: CodemapStatus;
}

type CodemapOutcome = { ok: true; reply: AgentCodemapReply } | { ok: false; status: number; error: string };

const UNREADABLE_MAINLINE_STATUS = 409;
const UNKNOWN_TARGET_STATUS = 404;
const OPERATOR_ONLY_STATUS = 403;

async function noDefaultBranch(): Promise<string | null> {
  return null;
}

type MapBoards = Pick<WhiteboardPort, 'handleAgent' | 'handleOperator' | 'readPlanBoard'>;

interface CodemapServiceOptions {
  client?: CodemapClient;
  detectDefaultBranch?: DefaultBranchDetector;
  whiteboards?: MapBoards | null;
  mapBoardIdsFilePath?: string | null;
  configuredMainlineBranch?: () => string | null;
  homeDir?: string | null;
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

function createCodemapService({ client = createCodemapClient(), detectDefaultBranch = noDefaultBranch, whiteboards = null, mapBoardIdsFilePath = null, configuredMainlineBranch = () => null, homeDir = null, logger = console }: CodemapServiceOptions = {}) {
  const drawingByRepoDir = new Map<string, Promise<boolean>>();
  const mapBoardIdByRepoDir = new Map<string, string>();
  const mapBoardIdStore = createJsonStateStore({
    name: 'code map boards', filePath: mapBoardIdsFilePath,
    parse: (raw) => MapBoardIds.safeParse(raw).data ?? null,
    adopt: (loadedBoardIds) => {
      for (const [repoDir, boardId] of Object.entries(loadedBoardIds ?? {})) mapBoardIdByRepoDir.set(repoDir, boardId);
    },
    warn: (message, fields) => logger.warn(`[codemap] ${message} ${JSON.stringify(fields)}`),
  });

  async function rememberMapBoard(repoDir: string, boardId: string): Promise<string> {
    mapBoardIdByRepoDir.set(repoDir, boardId);
    const boardIds = Object.fromEntries(mapBoardIdByRepoDir);
    await mapBoardIdStore.write(boardIds, () => `${JSON.stringify(boardIds, null, 2)}\n`);
    return boardId;
  }

  async function mapBoardIdOf(boards: MapBoards, repoDir: string): Promise<string> {
    await mapBoardIdStore.load();
    const caller = { id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir };
    const rememberedBoardId = mapBoardIdByRepoDir.get(repoDir);
    if (rememberedBoardId && (await boards.readPlanBoard(caller, rememberedBoardId)).ok) return rememberedBoardId;
    const title = `Code map: ${path.basename(repoDir)}`.slice(0, WHITEBOARD_LIMITS.title);
    const listed = await boards.handleAgent(caller, { sub: 'list' });
    const titledBoardIds = 'boards' in listed.body ? listed.body.boards.filter((board) => board.title.toLowerCase() === title.toLowerCase()).map((board) => board.id) : [];
    if (titledBoardIds.length > 1) throw new Error(`${titledBoardIds.length} boards are titled ${title} and none is the remembered map board, so none was redrawn`);
    if (titledBoardIds[0]) return rememberMapBoard(repoDir, titledBoardIds[0]);
    const created = await boards.handleOperator.create(title);
    const createdBoardId = created.board?.id ?? created.summary?.id;
    if (!created.ok || !createdBoardId) throw new Error(`the map board could not be created: ${created.error ?? 'no reason given'}`);
    return rememberMapBoard(repoDir, createdBoardId);
  }

  async function drawMapBoard(boards: MapBoards, repoDir: string, changedModel: CodemapModel | null, status: CodemapStatus): Promise<void> {
    const caller = { id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir };
    const boardId = await mapBoardIdOf(boards, repoDir);
    const read = await boards.readPlanBoard(caller, boardId);
    if (!read.ok) throw new Error(`the map board could not be read: ${JSON.stringify(read.reply.body)}`);
    const existingKindById = new Map([...read.board.elements].map(([id, element]) => [id, element.kind]));
    const rawOps = [...(changedModel ? mapBoardOpsOf(changedModel, existingKindById) : []), ...mapStampOpsOf(status, existingKindById)];
    for (const ops of chunkedBySize(OpList.parse(rawOps))) {
      const reply = await boards.handleAgent(caller, { sub: 'put', board: boardId, ops });
      if (reply.status !== 200) throw new Error(`the map board refused the regeneration: ${JSON.stringify(reply.body)}`);
    }
  }

  function redrawMapBoard(repoDir: string, changedModel: CodemapModel | null, status: CodemapStatus): Promise<boolean> {
    if (!whiteboards) return Promise.resolve(true);
    const boards = whiteboards;
    const previous = drawingByRepoDir.get(repoDir) ?? Promise.resolve(true);
    const drawing = previous.then(() => drawMapBoard(boards, repoDir, changedModel, status)).then(() => true, (error: unknown) => {
      logger.warn(`[codemap] the map board of ${repoDir} was not redrawn: ${errorMessage(error)}`);
      return false;
    });
    drawingByRepoDir.set(repoDir, drawing);
    return drawing;
  }

  async function keepMapBoardDrawn(state: RepoMapState, repoDir: string, status: CodemapStatus): Promise<void> {
    const statusKey = JSON.stringify(status);
    const changedModel = state.model && state.drawnModel !== state.model ? state.model : null;
    if (!changedModel && state.drawnStatusKey === statusKey) return;
    if (clock.nowMs() < state.drawRetryAtMs) return;
    if (await redrawMapBoard(repoDir, changedModel, status)) {
      state.drawnModel = state.model ?? state.drawnModel;
      state.drawnStatusKey = statusKey;
      return;
    }
    state.drawRetryAtMs = clock.nowMs() + CODEMAP_TUNABLES.failureRetryMs;
  }

  async function repoMainlineShaOf(repoDir: string): Promise<string | null> {
    return mainlineShaOf(repoDir, configuredMainlineBranch() ?? await detectDefaultBranch({ projectPath: repoDir }));
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
    const created: RepoMapState = { model: null, modelLayoutKey: null, extractBase: null, failure: null, latestStatus: null, drawnModel: null, drawnStatusKey: null, drawRetryAtMs: 0, startedCheckCount: 0, appliedCheckNumber: 0, refreshesInFlight: 0 };
    stateByRepoDir.set(repoDir, created);
    return created;
  }

  function statusOf(state: RepoMapState, mainlineSha: string): CodemapStatus {
    const sha = state.model?.sha ?? null;
    if (state.failure?.sha === mainlineSha) return { sha, mainlineSha, state: 'failed', reason: state.failure.reason };
    return { sha, mainlineSha, state: sha === mainlineSha ? 'current' : 'behind', reason: null };
  }

  async function currentMap(repo: CodemapRepo): Promise<CurrentMap | { error: string }> {
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
    if (checkNumber < state.appliedCheckNumber && state.latestStatus) return { model: state.model, status: state.latestStatus };
    state.appliedCheckNumber = checkNumber;
    const status = statusOf(state, mainlineSha);
    state.latestStatus = status;
    await keepMapBoardDrawn(state, repo.repoDir, status);
    return { model: state.model, status };
  }

  async function advanceMap(state: RepoMapState, repoDir: string, mainlineSha: string, checkNumber: number, moduleLayout: readonly string[] | null): Promise<void> {
    try {
      const extract = await client.extract(repoDir, mainlineSha, state.extractBase);
      if (checkNumber < state.appliedCheckNumber) return;
      state.appliedCheckNumber = checkNumber;
      state.model = buildCodemapModel(extract, moduleLayout);
      state.modelLayoutKey = JSON.stringify(moduleLayout);
      state.extractBase = extractBaseOf(extract);
      state.failure = null;
      state.drawRetryAtMs = 0;
    } catch (error) {
      if (checkNumber < state.appliedCheckNumber) return;
      state.appliedCheckNumber = checkNumber;
      state.failure = { sha: mainlineSha, reason: errorMessage(error), retryAtMs: clock.nowMs() + CODEMAP_TUNABLES.failureRetryMs };
      state.drawRetryAtMs = 0;
    }
  }

  function refresh(session: MappedSession): void {
    const state = stateOf(session.path);
    state.refreshesInFlight += 1;
    void currentMap({ repoDir: session.path }).catch((error: unknown) => {
      logger.warn(`[codemap] the map of ${session.path} was not refreshed: ${errorMessage(error)}`);
    }).finally(() => {
      state.refreshesInFlight -= 1;
    });
  }

  function attachSession(session: MappedSession): void {
    refresh(session);
    session.on('commits-landed', () => refresh(session));
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
    const map = await currentMap(repo);
    if ('error' in map) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: map.error };
    const repoName = path.basename(repo.repoDir);
    if (request.sub === 'map') return { ok: true, reply: { ok: true, text: mapTextOf(map.model, map.status, repoName), status: map.status } };
    if (!map.model) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: mapTextOf(null, map.status, repoName) };
    const answer = request.sub === 'where' ? whereOf(map.model, request.target) : impactOf(map.model, request.paths);
    if (!answer.ok) return { ok: false, status: UNKNOWN_TARGET_STATUS, error: answer.error };
    return { ok: true, reply: { ok: true, text: answer.text, status: map.status } };
  }

  async function checkOutcomeOf(repo: CodemapRepo): Promise<CodemapOutcome> {
    const mainlineSha = await repoMainlineShaOf(repo.repoDir);
    if (!mainlineSha) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: `${repo.repoDir} has no commit to check against` };
    if (!homeDir) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: 'the code map setup store is not available in this Glimmervoid' };
    const checked = await checkWorktree({ client, homeDir, worktreeDir: repo.worktreeDir ?? repo.repoDir, mainlineSha });
    if (!checked.ok) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: checked.error };
    const map = await currentMap(repo);
    const status = 'error' in map ? { sha: null, mainlineSha, state: 'failed' as const, reason: map.error } : map.status;
    return { ok: true, reply: { ok: true, text: checked.text, status } };
  }

  return { handle, attachSession, noticeOf };
}

type CodemapService = ReturnType<typeof createCodemapService>;

export { checkWorktree, createCodemapService };
export type { CodemapService };
