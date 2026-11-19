import path from 'node:path';

import type { AgentCodemapReply, AgentCodemapRequest, CodemapStatus } from '../../shared/contracts/codemap.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { runGit } from '../git/git-exec.ts';
import { buildCodemapModel, CODEMAP_TUNABLES, impactOf, mapTextOf, whereOf } from '../core/codemap-graph-core.ts';
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
}

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

function createCodemapService({ client = createCodemapClient(), detectDefaultBranch = noDefaultBranch }: { client?: CodemapClient; detectDefaultBranch?: DefaultBranchDetector } = {}) {
  async function mainlineShaOf({ repoDir, mainlineBranch }: CodemapRepo): Promise<string | null> {
    const branch = mainlineBranch ?? await detectDefaultBranch({ projectPath: repoDir });
    if (!branch) return revParse(repoDir, 'HEAD');
    return await revParse(repoDir, `refs/remotes/origin/${branch}`) ?? await revParse(repoDir, `refs/heads/${branch}`) ?? revParse(repoDir, 'HEAD');
  }

  const stateByRepoDir = new Map<string, RepoMapState>();

  function stateOf(repoDir: string): RepoMapState {
    const known = stateByRepoDir.get(repoDir);
    if (known) return known;
    const created: RepoMapState = { model: null, failure: null };
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
    if (state.model?.sha === mainlineSha || isFailureFresh) return { model: state.model, status: statusOf(state, mainlineSha) };
    try {
      state.model = buildCodemapModel(await client.extract(repo.repoDir, mainlineSha));
      state.failure = null;
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
