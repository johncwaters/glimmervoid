import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { execFileAsync } from './child-process-safe.ts';
import { createSerialQueue } from './spawn-gate.ts';
import { CommitSha } from '../shared/contracts/team-review.ts';

interface CommandResult {
  ok: boolean;
  out: string;
  err: string;
}

type CommandRunner = (args: string[], cwd: string, env?: Record<string, string>) => Promise<CommandResult>;

interface RepoCacheOptions {
  rootDir: string;
  commandRunner?: CommandRunner;
  remoteUrlFor?: (repo: string) => string;
}

const NETWORK_GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
const GH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function repoParts(repo: string): [string, string] | null {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts.every((part) => GH_SEGMENT.test(part))) return null;
  return [parts[0], parts[1]];
}

function isSafeBaseRef(baseRef: string): boolean {
  if (!baseRef || baseRef.startsWith('-') || baseRef.endsWith('/') || baseRef.includes('..')) return false;
  return baseRef.split('/').every((part) => GH_SEGMENT.test(part) && !part.endsWith('.lock'));
}

async function isDirectoryWithoutSymlink(directory: string): Promise<boolean | null> {
  try {
    const entry = await lstat(directory);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    return false;
  }
}

async function runGit(args: string[], cwd: string, env?: Record<string, string>): Promise<CommandResult> {
  try {
    const childEnv = env ? { env: { ...process.env, ...env } } : {};
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 120000, ...childEnv });
    return { ok: true, out: stdout.trim(), err: '' };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return { ok: false, out: '', err: failure.message };
  }
}

function createRepoCache({ rootDir, commandRunner = runGit, remoteUrlFor = (repo: string) => `https://github.com/${repo}.git` }: RepoCacheOptions) {
  const cacheRoot = path.resolve(rootDir);
  const queues = new Map<string, ReturnType<typeof createSerialQueue>>();

  function queueFor(repo: string) {
    const existing = queues.get(repo);
    if (existing) return existing;
    const queue = createSerialQueue();
    queues.set(repo, queue);
    return queue;
  }

  async function run(args: string[], cwd: string, env?: Record<string, string>): Promise<CommandResult> {
    try {
      return await commandRunner(args, cwd, env);
    } catch (error) {
      return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) };
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

  return {
    async ensureRepo(repo: string): Promise<string | null> {
      const parts = repoParts(repo);
      if (!parts) return null;
      return queueFor(repo).run(() => ensureRepoUnlocked(repo, parts));
    },

    async fetchPr(repo: string, number: number, baseRef: string): Promise<{ ok: boolean; headSha: string | null }> {
      const parts = repoParts(repo);
      if (!parts || !Number.isSafeInteger(number) || number <= 0 || !isSafeBaseRef(baseRef)) return { ok: false, headSha: null };
      return queueFor(repo).run(async () => {
        const repoDir = await ensureRepoUnlocked(repo, parts);
        if (!repoDir) return { ok: false, headSha: null };
        const fetched = await run([
          'fetch', '--filter=blob:none', 'origin',
          `+refs/pull/${number}/head:refs/glimmervoid-pr/${number}`,
          `+refs/heads/${baseRef}:refs/glimmervoid-base/${number}`,
        ], repoDir, NETWORK_GIT_ENV);
        if (!fetched.ok) return { ok: false, headSha: null };
        const head = await run(['rev-parse', `refs/glimmervoid-pr/${number}`], repoDir);
        const parsed = CommitSha.safeParse(head.out);
        if (!head.ok || !parsed.success) return { ok: false, headSha: null };
        return { ok: true, headSha: parsed.data };
      });
    },
  };
}

export { createRepoCache };
export type { CommandResult, CommandRunner, RepoCacheOptions };
