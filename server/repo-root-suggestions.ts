import fs from 'node:fs';
import path from 'node:path';

import { commonRepoFolders, pickFolderNames, rankRepoRootSuggestions, splitFolderQuery } from './core/repo-root-suggestions-core.ts';
import type { RepoRootCandidate, RepoRootSuggestion } from './core/repo-root-suggestions-core.ts';

function hasGitEntry(directory: string): Promise<boolean> {
  return fs.promises.stat(path.join(directory, '.git')).then(() => true, () => false);
}

async function countGitRepoChildren(folder: string): Promise<number> {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const childDirectories = entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'));
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

type FolderEntry = { name: string; path: string; isGit: boolean };

async function isDirectoryEntry(folder: string, entry: fs.Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return fs.promises.stat(path.join(folder, entry.name)).then((stats) => stats.isDirectory(), () => false);
}

async function listFolders({ query, homeDir }: { query: string; homeDir: string }): Promise<{ folder: string; entries: FolderEntry[] } | { folder: string; error: string }> {
  const { folder, prefix } = splitFolderQuery(query, homeDir);
  try {
    const dirents = await fs.promises.readdir(folder, { withFileTypes: true });
    const directoryChecks = await Promise.all(dirents.map(async (entry) => ({ name: entry.name, isDirectory: await isDirectoryEntry(folder, entry) })));
    const folderNames = pickFolderNames(directoryChecks.filter((check) => check.isDirectory).map((check) => check.name), prefix);
    const entries = await Promise.all(folderNames.map(async (folderName) => {
      const entryPath = path.join(folder, folderName);
      return { name: folderName, path: `${entryPath}${path.sep}`, isGit: await hasGitEntry(entryPath) };
    }));
    return { folder, entries };
  } catch (error) {
    return { folder, error: `cannot read ${folder}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export { listFolders, suggestRepoRoots };
