import fs from 'node:fs';
import path from 'node:path';

import { runGh, runGit } from './git/git-exec.ts';
import { CLONE_SAFETY_ARGS, chooseGithubCredential, cloneEnvOf, githubReposFromLines, githubReposJqFilter, githubReposPath, parseRepositorySource } from './core/repository-source-core.ts';
import type { GithubCredential, GithubRepo, ParsedRepositorySource } from './core/repository-source-core.ts';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 20_000;
const GH_LIST_TIMEOUT_MS = 60_000;
const GH_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

type CloneOutcome = { ok: true; path: string } | { ok: false; error: string };

function lastLineOf(text: string): string {
  return text.trim().split('\n').filter(Boolean).at(-1) ?? text.trim();
}

function errorCodeOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function claimEmptyFolder(cloneRoot: string, target: string): Promise<string | null> {
  const rootError = await fs.promises.mkdir(cloneRoot, { recursive: true }).then(() => null, (error: unknown) => `cannot create the repository folder ${cloneRoot}: ${messageOf(error)}`);
  if (rootError) return rootError;
  return fs.promises.mkdir(target).then(() => null, (error: unknown) => {
    if (errorCodeOf(error) === 'EEXIST') return `${target} already exists; open it from the project list, or remove it first`;
    return `cannot create ${target}: ${messageOf(error)}`;
  });
}

function cloneInto(parsed: ParsedRepositorySource, target: string, cloneRoot: string, githubToken: string | null) {
  return runGit([...CLONE_SAFETY_ARGS, 'clone', '--', parsed.url, target], {
    cwd: cloneRoot,
    timeoutMs: CLONE_TIMEOUT_MS,
    env: cloneEnvOf(parsed, githubToken, process.env.GIT_SSH_COMMAND),
    preferStderr: true,
  });
}

async function cloneRepository({ source, cloneRoot, githubToken }: { source: string; cloneRoot: string; githubToken: string | null }): Promise<CloneOutcome> {
  const parsed = parseRepositorySource(source);
  if (!parsed.ok) return parsed;
  const target = path.join(cloneRoot, parsed.repoName);
  const claimError = await claimEmptyFolder(cloneRoot, target);
  if (claimError) return { ok: false, error: claimError };
  const cloned = await cloneInto(parsed, target, cloneRoot, githubToken);
  if (cloned.ok) return { ok: true, path: target };
  if (githubToken && parsed.isGithubHttps) {
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.mkdir(target);
    const clonedWithoutToken = await cloneInto(parsed, target, cloneRoot, null);
    if (clonedWithoutToken.ok) return { ok: true, path: target };
  }
  await fs.promises.rm(target, { recursive: true, force: true });
  return { ok: false, error: `git clone ${parsed.url} failed: ${lastLineOf(cloned.err)}` };
}

async function ghLoginToken(): Promise<string | null> {
  const result = await runGh(['auth', 'token'], { timeoutMs: GH_TIMEOUT_MS });
  if (!result.ok) return null;
  return result.out.trim() || null;
}

async function resolveGithubCredential({ readToken, appToken }: { readToken: string | null; appToken: string | null }): Promise<GithubCredential> {
  return chooseGithubCredential({ ghLoginToken: await ghLoginToken(), readToken, appToken });
}

function parsedJsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function listGithubRepos(credential: Exclude<GithubCredential, { kind: 'none' }>): Promise<{ ok: true; repos: GithubRepo[] } | { ok: false; error: string }> {
  const listed = await runGh(['api', '--paginate', githubReposPath(credential.kind), '--jq', githubReposJqFilter(credential.kind)], {
    timeoutMs: GH_LIST_TIMEOUT_MS,
    maxBuffer: GH_LIST_MAX_BUFFER_BYTES,
    env: { GH_TOKEN: credential.token },
  });
  if (!listed.ok) return { ok: false, error: `gh api could not list your repositories: ${lastLineOf(listed.err)}` };
  const repos = githubReposFromLines(listed.out.split('\n').filter(Boolean).map(parsedJsonOf));
  if (!repos) return { ok: false, error: 'GitHub answered the repository list in a shape Glimmervoid does not read' };
  return { ok: true, repos };
}

export { cloneRepository, listGithubRepos, resolveGithubCredential };
