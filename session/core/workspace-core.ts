import path from 'node:path';
import { caseFoldedPathKey, sanitizeWorktreeName } from '../../shared/paths.ts';

export interface WorkspaceMember {
  name: string;
  repoPath: string;
  dir: string;
  base?: string | null;
}

export interface WorkspacePlan {
  folder: string;
  branch: string;
  members: WorkspaceMember[];
}

export type WorkspacePlanningResult = { ok: true; plan: WorkspacePlan } | { ok: false; error: string };

export function planWorkspace({ worktreeRoot, sessionName, sessionId, repoPaths }: {
  worktreeRoot: string;
  sessionName: string;
  sessionId: string;
  repoPaths: string[];
}): WorkspacePlanningResult {
  const folder = path.join(worktreeRoot, `ws-${sanitizeWorktreeName(sessionName) || 'workspace'}-${sessionId.slice(0, 8)}`);
  return planWorkspaceMembers({ folder, sessionId, repoPaths });
}

export function planWorkspaceMembers({ folder, sessionId, repoPaths }: {
  folder: string;
  sessionId: string;
  repoPaths: string[];
}): WorkspacePlanningResult {
  if (repoPaths.length < 2) return { ok: false, error: 'A workspace needs at least two repositories' };
  const branch = `glimmervoid/workspace/${sessionId}`;
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();
  const members: WorkspaceMember[] = [];
  for (const repoPath of repoPaths) {
    const resolvedPath = path.resolve(repoPath);
    const pathKey = caseFoldedPathKey(resolvedPath);
    const name = path.basename(resolvedPath);
    const nameKey = caseFoldedPathKey(name);
    if (seenPaths.has(pathKey)) return { ok: false, error: `Duplicate repository path: ${repoPath}` };
    if (seenNames.has(nameKey)) return { ok: false, error: `Duplicate repository directory name: ${name}` };
    seenPaths.add(pathKey);
    seenNames.add(nameKey);
    members.push({ name, repoPath: resolvedPath, dir: path.join(folder, name) });
  }
  return { ok: true, plan: { folder, branch, members } };
}

export function renderWorkspaceAgentsMd({ sessionName, branch, members }: { sessionName: string; branch: string; members: WorkspaceMember[] }): string {
  const lines = [
    `# ${sessionName}`,
    '',
    `Each subfolder is a separate git worktree of its repository on branch ${branch}, forked from origin's default branch.`,
    '',
  ];
  for (const member of members) {
    lines.push(`- ${member.name}/: ${member.repoPath}${member.base ? ` (base ${member.base})` : ''}`);
    lines.push(`  Read ${member.name}/AGENTS.md or ${member.name}/CLAUDE.md before editing there.`);
  }
  lines.push('', 'You own commits, pushes and pull requests in each repository. Glimmervoid never merges or rebases them.', '');
  return lines.join('\n');
}

export const WORKSPACE_CLAUDE_MD = '@AGENTS.md\n';
