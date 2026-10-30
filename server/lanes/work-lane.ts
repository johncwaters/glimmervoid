import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { runHardenedGit } from '../git/git-workspace.ts';

function isWorktreeAdminDirOf({ adminDir, commonGitDir }: { adminDir: string; commonGitDir: string }): boolean {
  return path.dirname(path.resolve(adminDir)) === path.resolve(commonGitDir, 'worktrees');
}

async function readLaneCommonGitDir(cwd: string): Promise<string> {
  const { stdout } = await runHardenedGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 30_000 });
  return realpath(stdout.trim());
}

export async function readGitDirsOfOwnCheckout(cwd: string): Promise<{ commonGitDir: string; worktreeAdminDir: string }> {
  const commonGitDir = await readLaneCommonGitDir(cwd);
  const { stdout: adminPath } = await runHardenedGit(['rev-parse', '--absolute-git-dir'], { cwd, timeout: 30_000 });
  const worktreeAdminDir = await realpath(adminPath.trim());
  const isLinkedWorktree = worktreeAdminDir !== commonGitDir;
  if (isLinkedWorktree && !isWorktreeAdminDirOf({ adminDir: worktreeAdminDir, commonGitDir })) throw new Error('Git admin directory is outside the linked worktree registry');
  return { commonGitDir, worktreeAdminDir };
}
