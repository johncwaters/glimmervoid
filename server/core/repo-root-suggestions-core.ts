import path from 'node:path';

type RepoRootCandidate = { path: string; realPath: string; label: string; gitRepoCount: number };
type RepoRootSuggestion = { path: string; label: string; gitRepoCount: number };

const COMMON_REPO_FOLDER_NAMES: readonly string[] = ['Projects', 'projects', 'code', 'src', 'dev', 'repos', 'git', 'workspace', 'Developer', path.join('source', 'repos')];

const MAX_REPO_ROOT_SUGGESTIONS = 5;

function commonRepoFolders(homeDir: string): { path: string; label: string }[] {
  return COMMON_REPO_FOLDER_NAMES.map((folderName) => ({ path: path.join(homeDir, folderName), label: path.join('~', folderName) }));
}

function rankRepoRootSuggestions(candidates: readonly RepoRootCandidate[], configuredRealPaths: ReadonlySet<string>): RepoRootSuggestion[] {
  const seenRealPaths = new Set<string>();
  const suggestions: RepoRootSuggestion[] = [];
  for (const candidate of candidates) {
    if (candidate.gitRepoCount === 0) continue;
    if (configuredRealPaths.has(candidate.realPath)) continue;
    if (seenRealPaths.has(candidate.realPath)) continue;
    seenRealPaths.add(candidate.realPath);
    suggestions.push({ path: candidate.path, label: candidate.label, gitRepoCount: candidate.gitRepoCount });
  }
  return suggestions
    .sort((left, right) => right.gitRepoCount - left.gitRepoCount)
    .slice(0, MAX_REPO_ROOT_SUGGESTIONS);
}

export { commonRepoFolders, rankRepoRootSuggestions };
export type { RepoRootCandidate, RepoRootSuggestion };
