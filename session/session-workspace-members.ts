import { errorMessage } from "../shared/text.ts";
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GitWorkspaceInstance } from '../server/git/git-workspace.ts';
import { holdsCheckout } from '../server/owned-paths-ledger.ts';
import type { KeptWorkPath } from '../shared/contracts/control-messages.ts';
import type { OwnedPathEntry, OwnedPathOwner } from '../shared/contracts/owned-paths.ts';
import { caseFoldedPathKey } from '../shared/paths.ts';
import { renderWorkspaceAgentsMd, WORKSPACE_CLAUDE_MD } from './core/workspace-core.ts';
import type { WorkspacePlan, WorkspaceMember } from './core/workspace-core.ts';

export type WorkspaceMemberGit = Pick<GitWorkspaceInstance, 'ensureWorkspaceMember' | 'removeWorkspaceMember' | 'describeWorkspaceMemberWork' | 'recordOwnedFolder' | 'forgetRemovedPath' | 'listOwnedPaths'>;


async function writeWhenAbsent(filePath: string, contents: string): Promise<void> {
  await fs.promises.writeFile(filePath, contents, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

const WORKSPACE_MAP_FILE = 'AGENTS.md';
const WORKSPACE_POINTER_FILE = 'CLAUDE.md';
const WORKSPACE_MAP_HASH_FILE = '.glimmervoid-map-hash';

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

export function createSessionWorkspaceMembers({ plan, owner, sessionName, shareList, gitWorkspace }: {
  plan: WorkspacePlan;
  owner: OwnedPathOwner;
  sessionName: string;
  shareList: string[] | null;
  gitWorkspace: WorkspaceMemberGit;
}) {
  type ProvisionOutcome = { ok: true; members: WorkspaceMember[] } | { ok: false; error: string };
  let activeProvision: Promise<ProvisionOutcome> | null = null;

  async function provisionBody(): Promise<ProvisionOutcome> {
    try {
      await fs.promises.mkdir(plan.folder, { recursive: true });
      await gitWorkspace.recordOwnedFolder({ folderPath: plan.folder, owner });
      const members: WorkspaceMember[] = [];
      for (const member of plan.members) {
        const ensured = await gitWorkspace.ensureWorkspaceMember({ projectPath: member.repoPath, owner, wtDir: member.dir, branch: plan.branch, shareList });
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

  type AddOutcome = { ok: true; path: string; branch: string } | { ok: false; error: string };

  async function addBody(repoPath: string): Promise<AddOutcome> {
    const resolvedRepoPath = path.resolve(repoPath);
    const name = path.basename(resolvedRepoPath);
    const existing = plan.members.find((member) => caseFoldedPathKey(member.repoPath) === caseFoldedPathKey(resolvedRepoPath));
    if (existing && await pathExists(existing.dir)) return { ok: true, path: existing.dir, branch: plan.branch };
    if (existing) plan.members.splice(plan.members.indexOf(existing), 1);
    if (plan.members.some((member) => caseFoldedPathKey(member.name) === caseFoldedPathKey(name))) return { ok: false, error: `this session already has a checkout named ${name}` };
    try {
      await fs.promises.mkdir(plan.folder, { recursive: true });
      await gitWorkspace.recordOwnedFolder({ folderPath: plan.folder, owner });
      const member: WorkspaceMember = { name, repoPath: resolvedRepoPath, dir: path.join(plan.folder, name) };
      const ensured = await gitWorkspace.ensureWorkspaceMember({ projectPath: member.repoPath, owner, wtDir: member.dir, branch: plan.branch, shareList });
      if (!ensured.isGit) return { ok: false, error: `${name}: ${ensured.reason || ensured.error || 'worktree creation failed'}${ensured.conflictPath ? ` (${ensured.conflictPath})` : ''}` };
      plan.members.push({ ...member, base: ensured.base });
      return { ok: true, path: member.dir, branch: plan.branch };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  let pendingAdds: Promise<unknown> = Promise.resolve();

  async function adoptRecordedCheckouts(entries: OwnedPathEntry[]): Promise<void> {
    const canonicalFolder = await fs.promises.realpath(plan.folder).catch(() => null);
    if (canonicalFolder === null) return;
    const memberKeys = new Set(plan.members.map((member) => caseFoldedPathKey(member.dir)));
    for (const entry of entries) {
      if (entry.kind !== 'git-worktree' || entry.projectPath === null) continue;
      if (caseFoldedPathKey(path.dirname(entry.path)) !== caseFoldedPathKey(canonicalFolder)) continue;
      if (memberKeys.has(caseFoldedPathKey(entry.path)) || !(await pathExists(entry.path))) continue;
      plan.members.push({ name: path.basename(entry.path), repoPath: entry.projectPath, dir: entry.path });
    }
  }

  function adopt(entries: OwnedPathEntry[]): Promise<void> {
    const attempt = pendingAdds.then(async () => {
      if (activeProvision) await activeProvision;
      return adoptRecordedCheckouts(entries);
    });
    pendingAdds = attempt;
    return attempt;
  }

  function add(repoPath: string): Promise<AddOutcome> {
    const attempt = pendingAdds.then(async () => {
      if (activeProvision) await activeProvision;
      return addBody(repoPath);
    });
    pendingAdds = attempt;
    return attempt;
  }

  const pathExists = (candidatePath: string) => fs.promises.stat(candidatePath).then(() => true, () => false);

  async function findMemberWork(member: WorkspaceMember): Promise<string | null> {
    return gitWorkspace.describeWorkspaceMemberWork({ projectPath: member.repoPath, cwd: member.dir, branch: plan.branch })
      .catch((error: unknown) => `its work could not be checked: ${errorMessage(error)}`);
  }

  async function findKeptWork(): Promise<KeptWorkPath[]> {
    if (activeProvision) await activeProvision;
    await pendingAdds;
    const kept: KeptWorkPath[] = [];
    for (const member of plan.members) {
      if (!(await pathExists(member.dir))) continue;
      const reason = await findMemberWork(member);
      if (reason) kept.push({ path: member.dir, reason });
    }
    return kept;
  }

  async function releaseMember(member: WorkspaceMember, discardWork: boolean): Promise<KeptWorkPath | null> {
    if (!(await pathExists(member.dir))) return null;
    const reason = discardWork ? null : await findMemberWork(member);
    if (reason) return { path: member.dir, reason };
    const removed = await gitWorkspace.removeWorkspaceMember({ projectPath: member.repoPath, cwd: member.dir, shareList, discardWork, cause: 'session' });
    if (removed.ok) return null;
    return { path: member.dir, reason: removed.err?.split('\n')[0] || 'git refused to remove it' };
  }

  async function release({ keepRepoPaths = [], discardWork = false }: { keepRepoPaths?: string[]; discardWork?: boolean } = {}): Promise<{ kept: KeptWorkPath[] }> {
    if (activeProvision) await activeProvision;
    await pendingAdds;
    const keptRepoKeys = new Set(keepRepoPaths.map((repoPath) => caseFoldedPathKey(path.resolve(repoPath))));
    const kept: KeptWorkPath[] = [];
    for (const member of plan.members) {
      if (keptRepoKeys.has(caseFoldedPathKey(member.repoPath))) continue;
      const keptMember = await releaseMember(member, discardWork);
      if (keptMember) kept.push(keptMember);
    }
    if (keptRepoKeys.size > 0) return { kept };
    if (await holdsCheckout(plan.folder)) return { kept };
    await fs.promises.rm(plan.folder, { recursive: true, force: true });
    await gitWorkspace.forgetRemovedPath(plan.folder);
    return { kept };
  }

  return { provision, add, adopt, release, findKeptWork, folder: plan.folder, branch: plan.branch };
}
