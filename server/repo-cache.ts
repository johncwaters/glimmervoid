import path from 'node:path';
import os from 'node:os';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { prBaseRef, prHeadRef } from './core/team-review-core.ts';
import { GH_SEGMENT, repoParts } from '../shared/contracts/github-ids.ts';
import { runGit } from './git-exec.ts';
import type { CommandResult } from './git-exec.ts';
import { createSerialQueue } from './spawn-gate.ts';
import { CommitSha } from '../shared/contracts/team-review.ts';
import { errorMessage, isMissingFileError } from '../shared/text.ts';

type CommandRunner = (args: string[], cwd: string, env?: Record<string, string>, timeoutMs?: number) => Promise<CommandResult>;

interface RepoCacheOptions {
  rootDir: string;
  commandRunner?: CommandRunner;
  remoteUrlFor?: (repo: string) => string;
}

const NETWORK_GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
const GIT_COMMAND_TIMEOUT_MS = 120000;
const HEAD_TREE_HYDRATE_TIMEOUT_MS = 10 * 60 * 1000;
function isSafeBaseRef(baseRef: string): boolean {
  if (!baseRef || baseRef.startsWith('-') || baseRef.endsWith('/') || baseRef.includes('..')) return false;
  return baseRef.split('/').every((part) => GH_SEGMENT.test(part) && !part.endsWith('.lock'));
}

async function isDirectoryWithoutSymlink(directory: string): Promise<boolean | null> {
  try {
    const entry = await lstat(directory);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if (isMissingFileError(error, { includeNotDir: false })) return null;
    return false;
  }
}

async function childDirectoryNames(directory: string): Promise<string[]> {
  if (await isDirectoryWithoutSymlink(directory) !== true) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && GH_SEGMENT.test(entry.name)).map((entry) => entry.name);
}

function defaultCommandRunner(args: string[], cwd: string, env?: Record<string, string>, timeoutMs = GIT_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return runGit(args, { cwd, env, timeoutMs });
}

function createRepoCache({ rootDir, commandRunner = defaultCommandRunner, remoteUrlFor = (repo: string) => `https://github.com/${repo}.git` }: RepoCacheOptions) {
  const cacheRoot = path.resolve(rootDir);
  const queues = new Map<string, ReturnType<typeof createSerialQueue>>();

  function queueFor(repo: string) {
    const existing = queues.get(repo);
    if (existing) return existing;
    const queue = createSerialQueue();
    queues.set(repo, queue);
    return queue;
  }

  async function run(args: string[], cwd: string, env?: Record<string, string>, timeoutMs = GIT_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
    try {
      return await commandRunner(args, cwd, env, timeoutMs);
    } catch (error) {
      return { ok: false, out: '', err: errorMessage(error) };
    }
  }

  async function ensureRepoUnlocked(repo: string, parts: [string, string]): Promise<string | null> {
    try {
      await mkdir(cacheRoot, { recursive: true });
      if (await isDirectoryWithoutSymlink(cacheRoot) !== true) return null;
      const ownerDir = path.join(cacheRoot, parts[0]);
      await mkdir(ownerDir, { recursive: true });
      if (await isDirectoryWithoutSymlink(ownerDir) !== true) return null;
      const repoDir = path.join(ownerDir, parts[1]);
      const repoStatus = await isDirectoryWithoutSymlink(repoDir);
      if (repoStatus === false) return null;
      if (repoStatus === true && await isDirectoryWithoutSymlink(path.join(repoDir, '.git')) === true) return repoDir;
      const cloned = await run(['clone', '--filter=blob:none', '--no-checkout', remoteUrlFor(repo), repoDir], cacheRoot, NETWORK_GIT_ENV);
      if (!cloned.ok) return null;
      if (await isDirectoryWithoutSymlink(repoDir) !== true) return null;
      return await isDirectoryWithoutSymlink(path.join(repoDir, '.git')) === true ? repoDir : null;
    } catch {
      return null;
    }
  }

  async function isCachedClone(repoDir: string): Promise<boolean> {
    return await isDirectoryWithoutSymlink(repoDir) === true && await isDirectoryWithoutSymlink(path.join(repoDir, '.git')) === true;
  }

  return {
    async listRepos(): Promise<string[]> {
      const repoDirs: string[] = [];
      for (const owner of await childDirectoryNames(cacheRoot)) {
        const ownerDir = path.join(cacheRoot, owner);
        for (const name of await childDirectoryNames(ownerDir)) {
          const repoDir = path.join(ownerDir, name);
          if (await isCachedClone(repoDir)) repoDirs.push(repoDir);
        }
      }
      return repoDirs;
    },

    async ensureRepo(repo: string): Promise<string | null> {
      const parts = repoParts(repo);
      if (!parts) return null;
      return queueFor(repo).run(() => ensureRepoUnlocked(repo, parts));
    },

    async fetchPr(repo: string, number: number, baseRef: string): Promise<{ ok: boolean; headSha: string | null; err: string }> {
      const parts = repoParts(repo);
      if (!parts || !Number.isSafeInteger(number) || number <= 0 || !isSafeBaseRef(baseRef)) return { ok: false, headSha: null, err: '' };
      return queueFor(repo).run(async () => {
        const repoDir = await ensureRepoUnlocked(repo, parts);
        if (!repoDir) return { ok: false, headSha: null, err: '' };
        const fetched = await run([
          'fetch', '--filter=blob:none', 'origin',
          `+refs/pull/${number}/head:${prHeadRef(number)}`,
          `+refs/heads/${baseRef}:${prBaseRef(number)}`,
        ], repoDir, NETWORK_GIT_ENV);
        if (!fetched.ok) return { ok: false, headSha: null, err: fetched.err };
        const head = await run(['rev-parse', prHeadRef(number)], repoDir);
        const parsed = CommitSha.safeParse(head.out);
        if (!head.ok || !parsed.success) return { ok: false, headSha: null, err: head.err };
        return { ok: true, headSha: parsed.data, err: '' };
      });
    },

    async hydrateTree(repo: string, headSha: string): Promise<{ ok: boolean; err: string }> {
      const parts = repoParts(repo);
      if (!parts || !CommitSha.safeParse(headSha).success) return { ok: false, err: '' };
      return queueFor(repo).run(async () => {
        const repoDir = await ensureRepoUnlocked(repo, parts);
        if (!repoDir) return { ok: false, err: '' };
        const emptyTree = await run(['hash-object', '-t', 'tree', os.devNull], repoDir);
        if (!emptyTree.ok) return { ok: false, err: emptyTree.err };
        const hydrated = await run(['diff', '--shortstat', emptyTree.out, headSha], repoDir, NETWORK_GIT_ENV, HEAD_TREE_HYDRATE_TIMEOUT_MS);
        return { ok: hydrated.ok, err: hydrated.err };
      });
    },

    async hydrateRange(repo: string, number: number, headSha: string): Promise<{ ok: boolean; err: string }> {
      const parts = repoParts(repo);
      if (!parts || !Number.isSafeInteger(number) || number <= 0 || !CommitSha.safeParse(headSha).success) return { ok: false, err: '' };
      return queueFor(repo).run(async () => {
        const repoDir = await ensureRepoUnlocked(repo, parts);
        if (!repoDir) return { ok: false, err: '' };
        const hydrated = await run(['diff', '--shortstat', `${prBaseRef(number)}...${headSha}`], repoDir, NETWORK_GIT_ENV);
        return { ok: hydrated.ok, err: hydrated.err };
      });
    },

    async hydrateSince(repo: string, sinceSha: string, headSha: string): Promise<boolean> {
      const parts = repoParts(repo);
      if (!parts || !CommitSha.safeParse(sinceSha).success || !CommitSha.safeParse(headSha).success) return false;
      return queueFor(repo).run(async () => {
        const repoDir = await ensureRepoUnlocked(repo, parts);
        if (!repoDir) return false;
        const hydrated = await run(['diff', '--shortstat', sinceSha, headSha], repoDir, NETWORK_GIT_ENV);
        if (!hydrated.ok) return false;
        const isSinceAncestorOfHead = await run(['merge-base', '--is-ancestor', sinceSha, headSha], repoDir);
        return isSinceAncestorOfHead.ok;
      });
    },
  };
}

export { createRepoCache };
export type { CommandResult, CommandRunner, RepoCacheOptions };
