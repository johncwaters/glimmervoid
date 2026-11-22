import type { ProjectEntry } from '../config-store.ts';
import type { BranchLink } from '../../shared/contracts/session.ts';
import { branchPromptOf } from '../../shared/board-branch-core.ts';
import { errorMessage } from '../../shared/text.ts';
import type { Session } from '../../session/sessions.ts';
import { runHardenedGit } from '../git/git-workspace.ts';

const GIT_TIMEOUT_MS = 15000;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

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

interface BranchWiringDeps {
  findSession: (sessionId: string) => Session | null;
  createProjectSession: CreateProjectSession;
}

interface BranchSpawnRequest {
  parentId: string;
  aboutBoxId: string;
  aboutTitle: string;
  prompt: string;
}

type BranchSpawnOutcome = { ok: true; sessionId: string } | { ok: false; error: string };

async function headShaOf(worktreeDir: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await runHardenedGit(['rev-parse', 'HEAD'], { cwd: worktreeDir, env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
    return { ok: true, sha: stdout.trim() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function createBranchWiring({ findSession, createProjectSession }: BranchWiringDeps) {
  async function spawn(request: BranchSpawnRequest): Promise<BranchSpawnOutcome> {
    const parent = findSession(request.parentId);
    if (!parent) return { ok: false, error: 'That session is gone.' };
    if (!parent.isWorktree) return { ok: false, error: `${parent.name} has no worktree of its own, so a branch has no commit to start from.` };
    const parentDir = parent.effectiveCwd();
    const head = await headShaOf(parentDir);
    if (!head.ok) return { ok: false, error: `Could not read the last commit of ${parent.name}: ${head.error}` };
    const link: BranchLink = { parentId: parent.id, aboutBoxId: request.aboutBoxId, aboutTitle: request.aboutTitle };
    const created = createProjectSession({
      name: `${parent.name} ${request.aboutTitle.split('/').filter(Boolean).at(-1) ?? request.aboutTitle}`,
      path: parent.path,
      agent: parent.agentId,
      dangerouslySkipPermissions: parent.dangerouslySkipPermissions,
      saneYolo: parent.saneYolo,
      accountId: parent.accountId,
      requireExistingPath: true,
      runSettings: { startSha: head.sha, isStartPinned: true, branchOf: link },
    });
    if (!created.ok) return created;
    const branch = findSession(created.project.id);
    if (!branch) return { ok: false, error: `The branch session ${created.project.name} did not start.` };
    const queued = branch.queueChatMessage(branchPromptOf(parent.name, link.aboutTitle, request.prompt), []);
    if (!queued.ok) return { ok: false, error: queued.error };
    return { ok: true, sessionId: branch.id };
  }

  return { spawn };
}

export { createBranchWiring };
type BranchWiring = ReturnType<typeof createBranchWiring>;

export type { BranchWiring };
