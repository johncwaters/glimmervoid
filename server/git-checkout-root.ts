import { readGitDirsOfOwnCheckout, repositoryRootOfCommonGitDir } from './lanes/work-lane.ts';

async function mainCheckoutOf(checkoutPath: string): Promise<string | null> {
  const gitDirs = await readGitDirsOfOwnCheckout(checkoutPath).catch(() => null);
  if (gitDirs === null) return null;
  const isBareRepository = gitDirs.commonGitDir === checkoutPath;
  if (isBareRepository) return null;
  const isLinkedWorktree = gitDirs.worktreeAdminDir !== gitDirs.commonGitDir;
  if (!isLinkedWorktree) return checkoutPath;
  return repositoryRootOfCommonGitDir(gitDirs.commonGitDir);
}

export { mainCheckoutOf };
