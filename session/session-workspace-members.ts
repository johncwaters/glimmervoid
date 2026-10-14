import { errorMessage } from "../shared/text.ts";
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GitWorkspaceInstance } from '../server/git/git-workspace.ts';
import { caseFoldedPathKey } from '../shared/paths.ts';
import { renderWorkspaceAgentsMd, WORKSPACE_CLAUDE_MD } from './core/workspace-core.ts';
import type { WorkspacePlan, WorkspaceMember } from './core/workspace-core.ts';

export type WorkspaceMemberGit = Pick<GitWorkspaceInstance, 'ensureWorkspaceMember' | 'removeWorkspaceMember'>;

async function writeWhenAbsent(filePath: string, contents: string): Promise<void> {
  await fs.promises.writeFile(filePath, contents, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

const WORKSPACE_MAP_FILE = 'AGENTS.md';
const WORKSPACE_POINTER_FILE = 'CLAUDE.md';
const WORKSPACE_MAP_HASH_FILE = '.glimmervoid-map-hash';
const GENERATED_WORKSPACE_FILES = new Set([WORKSPACE_MAP_FILE, WORKSPACE_POINTER_FILE, WORKSPACE_MAP_HASH_FILE]);

function hashWorkspaceMap(contents: string): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function readWhenPresent(filePath: string): Promise<string | null> {
  return fs.promises.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function writeWorkspaceMap(folder: string, contents: string): Promise<void> {
  const mapPath = path.join(folder, WORKSPACE_MAP_FILE);
  const hashPath = path.join(folder, WORKSPACE_MAP_HASH_FILE);
  const existingMap = await readWhenPresent(mapPath);
  const recordedHash = (await readWhenPresent(hashPath))?.trim() ?? null;
  const renderedHash = hashWorkspaceMap(contents);
  if (existingMap !== null && existingMap !== contents && hashWorkspaceMap(existingMap) !== recordedHash) return;
  if (existingMap === contents && recordedHash === renderedHash) return;
  await fs.promises.writeFile(mapPath, contents);
  await fs.promises.writeFile(hashPath, `${renderedHash}\n`);
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
      await writeWorkspaceMap(plan.folder, renderWorkspaceAgentsMd({ sessionName, branch: plan.branch, members }));
      await writeWhenAbsent(path.join(plan.folder, WORKSPACE_POINTER_FILE), WORKSPACE_CLAUDE_MD);
      return { ok: true, members };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
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

  async function release({ keepRepoPaths = [] }: { keepRepoPaths?: string[] } = {}): Promise<{ keptDirs: string[] }> {
    if (activeProvision) await activeProvision;
    const keptRepoKeys = new Set(keepRepoPaths.map((repoPath) => caseFoldedPathKey(path.resolve(repoPath))));
    const keptDirs: string[] = [];
    for (const member of plan.members) {
      if (keptRepoKeys.has(caseFoldedPathKey(member.repoPath))) continue;
      const exists = await fs.promises.stat(member.dir).then(() => true, () => false);
      if (!exists) continue;
      const removed = await gitWorkspace.removeWorkspaceMember({ projectPath: member.repoPath, cwd: member.dir, shareList });
      if (!removed.ok) keptDirs.push(member.dir);
    }
    const entries = await fs.promises.readdir(plan.folder).catch(() => []);
    if (entries.some((entry) => !GENERATED_WORKSPACE_FILES.has(entry))) return { keptDirs };
    for (const entry of entries) await fs.promises.rm(path.join(plan.folder, entry), { force: true });
    await fs.promises.rmdir(plan.folder).catch(() => {});
    return { keptDirs };
  }

  return { provision, release, branch: plan.branch };
}
