import fs from 'node:fs';
import path from 'node:path';

import { runGit } from './git/git-exec.ts';
import { CLONE_SAFETY_ARGS, cloneEnvOf, parseRepositorySource } from './core/repository-source-core.ts';

const CLONE_TIMEOUT_MS = 10 * 60_000;

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

async function cloneRepository({ source, cloneRoot, githubToken }: { source: string; cloneRoot: string; githubToken: string | null }): Promise<CloneOutcome> {
  const parsed = parseRepositorySource(source);
  if (!parsed.ok) return parsed;
  const target = path.join(cloneRoot, parsed.repoName);
  const claimError = await claimEmptyFolder(cloneRoot, target);
  if (claimError) return { ok: false, error: claimError };
  const cloned = await runGit([...CLONE_SAFETY_ARGS, 'clone', '--', parsed.url, target], {
    cwd: cloneRoot,
    timeoutMs: CLONE_TIMEOUT_MS,
    env: cloneEnvOf(parsed, githubToken, process.env.GIT_SSH_COMMAND),
    preferStderr: true,
  });
  if (cloned.ok) return { ok: true, path: target };
  await fs.promises.rm(target, { recursive: true, force: true });
  return { ok: false, error: `git clone ${parsed.url} failed: ${lastLineOf(cloned.err)}` };
}

export { cloneRepository };
