import path from 'node:path';

type RepoRootCandidate = { path: string; realPath: string; label: string; gitRepoCount: number };
type RepoRootSuggestion = { path: string; label: string; gitRepoCount: number };

const COMMON_REPO_FOLDER_NAMES: readonly string[] = ['Projects', 'projects', 'code', 'src', 'dev', 'repos', 'git', 'workspace', 'Developer', path.join('source', 'repos')];

const MAX_REPO_ROOT_SUGGESTIONS = 5;
const MAX_FOLDER_COMPLETIONS = 50;

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

function resolveFromHome(folderText: string, homeDir: string): string {
  if (folderText === '' || folderText === '~') return homeDir;
  if (folderText.startsWith('~/') || folderText.startsWith(`~${path.sep}`)) return path.join(homeDir, folderText.slice(2));
  if (path.isAbsolute(folderText)) return path.normalize(folderText);
  return path.join(homeDir, folderText);
}

function splitFolderQuery(query: string, homeDir: string): { folder: string; prefix: string } {
  const trimmedQuery = query.trim();
  if (trimmedQuery === '~') return { folder: homeDir, prefix: '' };
  const lastSeparatorIndex = Math.max(trimmedQuery.lastIndexOf('/'), trimmedQuery.lastIndexOf('\\'));
  return { folder: resolveFromHome(trimmedQuery.slice(0, lastSeparatorIndex + 1), homeDir), prefix: trimmedQuery.slice(lastSeparatorIndex + 1) };
}

function pickFolderNames(folderNames: readonly string[], prefix: string): string[] {
  const lowercasePrefix = prefix.toLowerCase();
  const showsHidden = prefix.startsWith('.');
  return folderNames
    .filter((folderName) => showsHidden || !folderName.startsWith('.'))
    .filter((folderName) => folderName.toLowerCase().startsWith(lowercasePrefix))
    .toSorted((first, second) => first.localeCompare(second))
    .slice(0, MAX_FOLDER_COMPLETIONS);
}

export { commonRepoFolders, pickFolderNames, rankRepoRootSuggestions, resolveFromHome, splitFolderQuery };
export type { RepoRootCandidate, RepoRootSuggestion };
