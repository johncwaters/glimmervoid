import path from 'node:path';
import { z } from 'zod';

import type { AgentCodemapReply, AgentCodemapRequest, CodemapStatus } from '../../shared/contracts/codemap.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { Op, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import { CODEMAP_AUTHOR } from '../../shared/whiteboard-ops-core.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';
import { createJsonStateStore } from '../json-file.ts';
import { runGit } from '../git/git-exec.ts';
import { buildCodemapModel, CODEMAP_TUNABLES, impactOf, mapBoardOpsOf, mapTextOf, whereOf } from '../core/codemap-graph-core.ts';
import type { CodemapModel } from '../core/codemap-graph-core.ts';
import { createCodemapClient } from './codemap-client.ts';
import type { CodemapClient } from './codemap-client.ts';

interface CodemapRepo {
  repoDir: string;
  mainlineBranch: string | null;
}

interface RepoMapState {
  model: CodemapModel | null;
  failure: { sha: string; reason: string; retryAtMs: number } | null;
  drawnSha: string | null;
  drawRetryAtMs: number;
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

async function revParse(repoDir: string, ref: string): Promise<string | null> {
  const parsed = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoDir });
  const sha = parsed.out.trim();
  return parsed.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function noDefaultBranch(): Promise<string | null> {
  return null;
}

type MapBoards = Pick<WhiteboardPort, 'handleAgent' | 'handleOperator' | 'readPlanBoard'>;

interface CodemapServiceOptions {
  client?: CodemapClient;
  detectDefaultBranch?: DefaultBranchDetector;
  whiteboards?: MapBoards | null;
  mapBoardIdsFilePath?: string | null;
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

function createCodemapService({ client = createCodemapClient(), detectDefaultBranch = noDefaultBranch, whiteboards = null, mapBoardIdsFilePath = null, logger = console }: CodemapServiceOptions = {}) {
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

  async function drawMapBoard(boards: MapBoards, repoDir: string, model: CodemapModel): Promise<void> {
    const caller = { id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir };
    const boardId = await mapBoardIdOf(boards, repoDir);
    const read = await boards.readPlanBoard(caller, boardId);
    if (!read.ok) throw new Error(`the map board could not be read: ${JSON.stringify(read.reply.body)}`);
    const existingKindById = new Map([...read.board.elements].map(([id, element]) => [id, element.kind]));
    for (const ops of chunkedBySize(OpList.parse(mapBoardOpsOf(model, existingKindById)))) {
      const reply = await boards.handleAgent(caller, { sub: 'put', board: boardId, ops });
      if (reply.status !== 200) throw new Error(`the map board refused the regeneration: ${JSON.stringify(reply.body)}`);
    }
  }

  function redrawMapBoard(repoDir: string, model: CodemapModel): Promise<boolean> {
    if (!whiteboards) return Promise.resolve(true);
    const boards = whiteboards;
    const previous = drawingByRepoDir.get(repoDir) ?? Promise.resolve(true);
    const drawing = previous.then(() => drawMapBoard(boards, repoDir, model)).then(() => true, (error: unknown) => {
      logger.warn(`[codemap] the map board of ${repoDir} was not redrawn: ${errorMessage(error)}`);
      return false;
    });
    drawingByRepoDir.set(repoDir, drawing);
    return drawing;
  }

  async function keepMapBoardDrawn(state: RepoMapState, repoDir: string, model: CodemapModel): Promise<void> {
    if (state.drawnSha === model.sha || clock.nowMs() < state.drawRetryAtMs) return;
    if (await redrawMapBoard(repoDir, model)) {
      state.drawnSha = model.sha;
      return;
    }
    state.drawRetryAtMs = clock.nowMs() + CODEMAP_TUNABLES.failureRetryMs;
  }

  async function mainlineShaOf({ repoDir, mainlineBranch }: CodemapRepo): Promise<string | null> {
    const branch = mainlineBranch ?? await detectDefaultBranch({ projectPath: repoDir });
    if (!branch) return revParse(repoDir, 'HEAD');
    return await revParse(repoDir, `refs/remotes/origin/${branch}`) ?? await revParse(repoDir, `refs/heads/${branch}`) ?? revParse(repoDir, 'HEAD');
  }

  const stateByRepoDir = new Map<string, RepoMapState>();

  function stateOf(repoDir: string): RepoMapState {
    const known = stateByRepoDir.get(repoDir);
    if (known) return known;
    const created: RepoMapState = { model: null, failure: null, drawnSha: null, drawRetryAtMs: 0 };
    stateByRepoDir.set(repoDir, created);
    return created;
  }

  function statusOf(state: RepoMapState, mainlineSha: string): CodemapStatus {
    const sha = state.model?.sha ?? null;
    if (state.failure?.sha === mainlineSha) return { sha, mainlineSha, state: 'failed', reason: state.failure.reason };
    return { sha, mainlineSha, state: sha === mainlineSha ? 'current' : 'behind', reason: null };
  }

  async function currentMap(repo: CodemapRepo): Promise<CurrentMap | { error: string }> {
    const mainlineSha = await mainlineShaOf(repo);
    if (!mainlineSha) return { error: `${repo.repoDir} has no commit to map; the code map needs a git repository with a mainline commit` };
    const state = stateOf(repo.repoDir);
    const isFailureFresh = state.failure?.sha === mainlineSha && clock.nowMs() < state.failure.retryAtMs;
    if (state.model?.sha === mainlineSha) await keepMapBoardDrawn(state, repo.repoDir, state.model);
    if (state.model?.sha === mainlineSha || isFailureFresh) return { model: state.model, status: statusOf(state, mainlineSha) };
    try {
      const model = buildCodemapModel(await client.extract(repo.repoDir, mainlineSha));
      state.model = model;
      state.failure = null;
      state.drawRetryAtMs = 0;
      await keepMapBoardDrawn(state, repo.repoDir, model);
    } catch (error) {
      state.failure = { sha: mainlineSha, reason: errorMessage(error), retryAtMs: clock.nowMs() + CODEMAP_TUNABLES.failureRetryMs };
    }
    return { model: state.model, status: statusOf(state, mainlineSha) };
  }

  async function handle(repo: CodemapRepo, request: AgentCodemapRequest): Promise<CodemapOutcome> {
    const map = await currentMap(repo);
    if ('error' in map) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: map.error };
    const repoName = path.basename(repo.repoDir);
    if (request.sub === 'map') return { ok: true, reply: { ok: true, text: mapTextOf(map.model, map.status, repoName), status: map.status } };
    if (!map.model) return { ok: false, status: UNREADABLE_MAINLINE_STATUS, error: mapTextOf(null, map.status, repoName) };
    const answer = request.sub === 'where' ? whereOf(map.model, request.target) : impactOf(map.model, request.paths);
    if (!answer.ok) return { ok: false, status: UNKNOWN_TARGET_STATUS, error: answer.error };
    return { ok: true, reply: { ok: true, text: answer.text, status: map.status } };
  }

  return { handle };
}

type CodemapService = ReturnType<typeof createCodemapService>;

export { createCodemapService };
export type { CodemapService };
