import type { ProjectEntry } from '../config-store.ts';
import { branchParentIdOf } from '../../shared/parent-link.ts';
import type { ParentLink } from '../../shared/contracts/session.ts';
import { branchPromptOf, overlappingBranchTitle } from '../../shared/board-branch-core.ts';
import type { BranchAbout, BranchTarget } from '../../shared/board-branch-core.ts';
import type { StudioBranchAgent } from '../../shared/contracts/studio-repos.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import type { Session } from '../../session/sessions.ts';

type CreateProjectSession = (args: {
  name: string;
  path: string;
  agent?: ProjectEntry['agent'];
  dangerouslySkipPermissions?: boolean;
  saneYolo?: boolean;
  requireExistingPath?: boolean;
  accountId?: string | null;
  runSettings?: Partial<ProjectEntry>;
}) => { ok: true; project: ProjectEntry } | { ok: false; error: string };

interface BranchRepo {
  repoKey: string;
  repoName: string;
  repoDir: string;
}

interface BranchWiringDeps {
  findSession: (sessionId: string) => Session | null;
  listSessions: () => Iterable<Session>;
  listRepos: () => Promise<readonly BranchRepo[]>;
  repoOfBox: (boxId: string) => Promise<BranchRepo | null>;
  branchAgentOf: (repoKey: string) => Promise<StudioBranchAgent | null>;
  resolveTarget: (repoDir: string, about: BranchAbout) => Promise<BranchTarget>;
  createProjectSession: CreateProjectSession;
}

type BranchPlace = { boxId: string } | { repo: string; about: string };

interface BranchSpawnRequest {
  orchestratorId: string;
  place: BranchPlace;
  prompt: string;
}

type BranchSpawnOutcome = { ok: true; sessionId: string; name: string; repoName: string; title: string } | { ok: false; error: string };

type PlacedRepo = { ok: true; repo: BranchRepo; about: BranchAbout } | { ok: false; error: string };

const NO_REPOS_TEXT = 'Studio has no repo yet; the operator adds one by opening it in Studio.';

function namedRepoOf(repos: readonly BranchRepo[], named: string): { ok: true; repo: BranchRepo } | { ok: false; error: string } {
  const wanted = named.trim().toLowerCase();
  const listedText = repos.map((repo) => `${repo.repoName} (${repo.repoKey})`).join(', ');
  if (repos.length === 0) return { ok: false, error: NO_REPOS_TEXT };
  const namedRepo = repos.find((repo) => repo.repoKey.toLowerCase() === wanted || repo.repoName.toLowerCase() === wanted || repo.repoDir.toLowerCase() === wanted);
  if (namedRepo) return { ok: true, repo: namedRepo };
  return { ok: false, error: `${named} is not a Studio repo; the Studio repos are ${listedText}` };
}

function createBranchWiring({ findSession, listSessions, listRepos, repoOfBox, branchAgentOf, resolveTarget, createProjectSession }: BranchWiringDeps) {
  const spawnsByRepoKey = createKeyedSerialQueue();

  async function placedRepoOf(place: BranchPlace): Promise<PlacedRepo> {
    if ('boxId' in place) {
      const boxRepo = await repoOfBox(place.boxId);
      return boxRepo ? { ok: true, repo: boxRepo, about: { boxId: place.boxId } } : { ok: false, error: 'that box is not on the code map of a Studio repo any more; pick another' };
    }
    const named = namedRepoOf(await listRepos(), place.repo);
    return named.ok ? { ok: true, repo: named.repo, about: { repoPath: place.about } } : named;
  }

  async function spawn(request: BranchSpawnRequest): Promise<BranchSpawnOutcome> {
    const placed = await placedRepoOf(request.place);
    if (!placed.ok) return placed;
    return spawnsByRepoKey.run(placed.repo.repoKey, () => spawnNow(request, placed.repo, placed.about));
  }

  async function spawnNow(request: BranchSpawnRequest, repo: BranchRepo, about: BranchAbout): Promise<BranchSpawnOutcome> {
    const orchestrator = findSession(request.orchestratorId);
    if (!orchestrator) return { ok: false, error: 'That session is gone.' };
    if (!orchestrator.isStudioMain) return { ok: false, error: `${orchestrator.name} is not the Studio Orchestrator, so it starts no branches.` };
    const target = await resolveTarget(repo.repoDir, about);
    if (!target.ok) return target;
    const { repoName } = repo;
    const liveRepoBranches = [...listSessions()].filter((session) => branchParentIdOf(session.parent) === orchestrator.id && session.path === repo.repoDir && !session._destroyed);
    const heldTitle = overlappingBranchTitle(target.title, liveRepoBranches.map((branch) => branch.parent?.box?.title ?? ''));
    const holder = liveRepoBranches.find((branch) => branch.parent?.box?.title === heldTitle);
    if (heldTitle !== null) return { ok: false, error: `${holder?.name ?? 'A live branch'} already works on ${heldTitle} in ${repoName}, which overlaps ${target.title}; send that branch the work, or close it in Studio first.` };
    const link: ParentLink = { sessionId: orchestrator.id, box: { id: target.boxId, title: target.title, repoName } };
    const branchAgent = await branchAgentOf(repo.repoKey);
    const created = createProjectSession({
      name: `${repoName} ${target.title.split('/').filter(Boolean).at(-1) ?? target.title}`,
      path: repo.repoDir,
      agent: branchAgent?.agentId ?? orchestrator.agentId,
      dangerouslySkipPermissions: orchestrator.dangerouslySkipPermissions,
      saneYolo: orchestrator.saneYolo,
      accountId: branchAgent ? branchAgent.accountId : orchestrator.accountId,
      requireExistingPath: true,
      runSettings: { parent: link, ...(branchAgent?.setup ? { agentSetup: { ...branchAgent.setup, instructions: '' } } : {}) },
    });
    if (!created.ok) return created;
    const branch = findSession(created.project.id);
    if (!branch) return { ok: false, error: `The branch session ${created.project.name} did not start.` };
    const queued = branch.queueChatMessage(branchPromptOf(orchestrator.name, repoName, target.title, request.prompt), []);
    if (!queued.ok) return { ok: false, error: queued.error };
    return { ok: true, sessionId: branch.id, name: branch.name, repoName, title: target.title };
  }

  return { spawn };
}

export { createBranchWiring };
type BranchWiring = ReturnType<typeof createBranchWiring>;

export type { BranchWiring };
