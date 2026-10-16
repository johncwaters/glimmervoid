import fs from 'node:fs';
import path from 'node:path';

import { commonRepoFolders, rankRepoRootSuggestions } from './core/repo-root-suggestions-core.ts';
import type { RepoRootCandidate, RepoRootSuggestion } from './core/repo-root-suggestions-core.ts';

function hasGitEntry(directory: string): Promise<boolean> {
  return fs.promises.stat(path.join(directory, '.git')).then(() => true, () => false);
}

async function countGitRepoChildren(folder: string): Promise<number> {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const childDirectories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  const gitChecks = await Promise.all(childDirectories.map((entry) => hasGitEntry(path.join(folder, entry.name))));
  return gitChecks.filter(Boolean).length;
}

async function readCandidate(folder: { path: string; label: string }): Promise<RepoRootCandidate | null> {
  try {
    const realPath = await fs.promises.realpath(folder.path);
    return { ...folder, realPath, gitRepoCount: await countGitRepoChildren(folder.path) };
  } catch {
    return null;
  }
}

function realPathOrSelf(root: string): Promise<string> {
  return fs.promises.realpath(root).catch(() => root);
}

async function suggestRepoRoots({ homeDir, configuredRoots }: { homeDir: string; configuredRoots: readonly string[] }): Promise<RepoRootSuggestion[]> {
  const candidates = await Promise.all(commonRepoFolders(homeDir).map(readCandidate));
  const configuredRealPaths = new Set(await Promise.all(configuredRoots.map(realPathOrSelf)));
  const readableCandidates = candidates.filter((candidate): candidate is RepoRootCandidate => candidate !== null);
  return rankRepoRootSuggestions(readableCandidates, configuredRealPaths);
}

export { suggestRepoRoots };
