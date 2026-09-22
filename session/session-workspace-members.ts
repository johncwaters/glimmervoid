import fs from 'node:fs';
import path from 'node:path';
import type { GitWorkspaceInstance } from '../server/git-workspace.ts';
import { renderWorkspaceAgentsMd, WORKSPACE_CLAUDE_MD } from './core/workspace-core.ts';
import type { WorkspacePlan, WorkspaceMember } from './core/workspace-core.ts';

export type WorkspaceMemberGit = Pick<GitWorkspaceInstance, 'ensureWorkspaceMember' | 'removeWorkspaceMember'>;

async function writeWhenAbsent(filePath: string, contents: string): Promise<void> {
  await fs.promises.writeFile(filePath, contents, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

export function createSessionWorkspaceMembers({ plan, sessionName, shareList, gitWorkspace }: {
  plan: WorkspacePlan;
  sessionName: string;
  shareList: string[] | null;
  gitWorkspace: WorkspaceMemberGit;
}) {
  type ProvisionOutcome = { ok: true; members: WorkspaceMember[] } | { ok: false; error: string };
  let activeProvision: Promise<ProvisionOutcome> | null = null;

  async function provisionBody(): Promise<ProvisionOutcome> {
    try {
      await fs.promises.mkdir(plan.folder, { recursive: true });
      const members: WorkspaceMember[] = [];
      for (const member of plan.members) {
        const ensured = await gitWorkspace.ensureWorkspaceMember({ projectPath: member.repoPath, wtDir: member.dir, branch: plan.branch, shareList });
        if (!ensured.isGit) return { ok: false, error: `${member.name}: ${ensured.reason || ensured.error || 'worktree creation failed'}${ensured.conflictPath ? ` (${ensured.conflictPath})` : ''}` };
        members.push({ ...member, base: ensured.base });
      }
      await writeWhenAbsent(path.join(plan.folder, 'AGENTS.md'), renderWorkspaceAgentsMd({ sessionName, branch: plan.branch, members }));
      await writeWhenAbsent(path.join(plan.folder, 'CLAUDE.md'), WORKSPACE_CLAUDE_MD);
      return { ok: true, members };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function provision(): Promise<ProvisionOutcome> {
    if (activeProvision) return activeProvision;
    const attempt = provisionBody();
    activeProvision = attempt;
    void attempt.then(() => {
      if (activeProvision === attempt) activeProvision = null;
    });
    return attempt;
  }

  async function release(): Promise<{ keptDirs: string[] }> {
    if (activeProvision) await activeProvision;
    const keptDirs: string[] = [];
    for (const member of plan.members) {
      const exists = await fs.promises.stat(member.dir).then(() => true, () => false);
      if (!exists) continue;
      const removed = await gitWorkspace.removeWorkspaceMember({ projectPath: member.repoPath, cwd: member.dir, shareList });
      if (!removed.ok) keptDirs.push(member.dir);
    }
    const entries = await fs.promises.readdir(plan.folder).catch(() => []);
    if (entries.some((entry) => entry !== 'AGENTS.md' && entry !== 'CLAUDE.md')) return { keptDirs };
    for (const entry of entries) await fs.promises.rm(path.join(plan.folder, entry), { force: true });
    await fs.promises.rmdir(plan.folder).catch(() => {});
    return { keptDirs };
  }

  return { provision, release, branch: plan.branch };
}
