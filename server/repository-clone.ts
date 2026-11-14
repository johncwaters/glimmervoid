import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { clock } from '../shared/clock.ts';
import type { RepositoryCloneJob } from '../shared/contracts/control/settings-messages.ts';
import { spawn } from './child-process-safe.ts';
import { cloneJobNameOf, cloneProgressOf, inFlightCloneFolderName, inFlightCloneOwnerOf, isInterruptedClone, sourcesToStart } from './core/clone-jobs-core.ts';
import type { InFlightCloneOwner } from './core/clone-jobs-core.ts';
import { runGh } from './git/git-exec.ts';
import { CLONE_SAFETY_ARGS, GITHUB_USER_INSTALLATIONS_PATH, GITHUB_USER_INSTALLATION_IDS_JQ_FILTER, chooseGithubCredential, cloneEnvOf, githubInstallationIdsFromLines, githubReposFromLines, githubReposJqFilter, githubReposPath, githubUserInstallationReposPath, mergedGithubRepos, parseRepositorySource } from './core/repository-source-core.ts';
import type { GithubCredential, GithubRepo, ParsedRepositorySource } from './core/repository-source-core.ts';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 20_000;
const GH_LIST_TIMEOUT_MS = 60_000;
const GH_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const CLONE_STDERR_TAIL_CHARS = 4_000;
const LINE_BREAKS_RE = /[\r\n]+/;
const CLONE_CHANGE_EVENT = 'change';
const LONGEST_CLONE_MS = CLONE_TIMEOUT_MS + 60_000;
const THIS_RUN: InFlightCloneOwner = { pid: process.pid, runId: crypto.randomBytes(4).toString('hex') };
const TAKEN_FOLDER_CODES: ReadonlySet<string> = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR']);
const PASSING_LOCK_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MOVE_ATTEMPTS = 20;
const MOVE_RETRY_WAIT_MS = 500;

type CloneOutcome = { ok: true; path: string } | { ok: false; error: string };
type CloneWatch = { signal: AbortSignal; onProgress: (progress: string) => void };
type CloneRun = { ok: boolean; err: string };

function lastLineOf(text: string): string {
  return text.trim().split(LINE_BREAKS_RE).filter(Boolean).at(-1) ?? text.trim();
}

function errorCodeOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function alreadyExistsText(target: string): string {
  return `${target} already exists; open it from the project list, or remove it first`;
}

async function claimWorkingFolder(cloneRoot: string, target: string, workingFolder: string): Promise<string | null> {
  const rootError = await fs.promises.mkdir(cloneRoot, { recursive: true }).then(() => null, (error: unknown) => `cannot create the repository folder ${cloneRoot}: ${messageOf(error)}`);
  if (rootError) return rootError;
  if (await isTaken(target)) return alreadyExistsText(target);
  return fs.promises.mkdir(workingFolder).then(() => null, (error: unknown) => {
    if (errorCodeOf(error) === 'EEXIST') return `another clone into ${target} is running`;
    return `cannot create ${workingFolder}: ${messageOf(error)}`;
  });
}

function isTaken(target: string): Promise<boolean> {
  return fs.promises.lstat(target).then(() => true, () => false);
}

async function moveIntoPlace(workingFolder: string, target: string, attemptsLeft = MOVE_ATTEMPTS): Promise<string | null> {
  if (await isTaken(target)) return alreadyExistsText(target);
  const moveError = await fs.promises.rename(workingFolder, target).then(() => null, (error: unknown) => error);
  if (moveError === null) return null;
  if (TAKEN_FOLDER_CODES.has(errorCodeOf(moveError))) return alreadyExistsText(target);
  if (!PASSING_LOCK_CODES.has(errorCodeOf(moveError)) || attemptsLeft <= 1) return `cannot move the clone to ${target}: ${messageOf(moveError)}`;
  await new Promise((resolve) => setTimeout(resolve, MOVE_RETRY_WAIT_MS));
  return moveIntoPlace(workingFolder, target, attemptsLeft - 1);
}

function cloneInto(parsed: ParsedRepositorySource, target: string, cloneRoot: string, githubToken: string | null, watch: CloneWatch): Promise<CloneRun> {
  return new Promise((resolve) => {
    let stderrTail = '';
    const git = spawn('git', [...CLONE_SAFETY_ARGS, 'clone', '--progress', '--', parsed.url, target], {
      cwd: cloneRoot,
      env: { ...process.env, ...cloneEnvOf(parsed, githubToken, process.env.GIT_SSH_COMMAND), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
      signal: watch.signal,
      timeout: CLONE_TIMEOUT_MS,
    });
    git.stderr?.setEncoding('utf8');
    git.stderr?.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-CLONE_STDERR_TAIL_CHARS);
      watch.onProgress(cloneProgressOf(stderrTail));
    });
    git.once('error', (error) => resolve({ ok: false, err: stderrTail || messageOf(error) }));
    git.once('close', (exitCode) => resolve({ ok: exitCode === 0, err: stderrTail }));
  });
}

async function cloneRepository({ source, cloneRoot, githubToken, watch }: { source: string; cloneRoot: string; githubToken: string | null; watch: CloneWatch }): Promise<CloneOutcome> {
  const parsed = parseRepositorySource(source);
  if (!parsed.ok) return parsed;
  const target = path.join(cloneRoot, parsed.repoName);
  const workingFolder = path.join(cloneRoot, inFlightCloneFolderName(THIS_RUN, parsed.repoName));
  const claimError = await claimWorkingFolder(cloneRoot, target, workingFolder);
  if (claimError) return { ok: false, error: claimError };
  try {
    const cloneError = await cloneWithTokenFallback(parsed, workingFolder, cloneRoot, githubToken, watch);
    if (cloneError) return { ok: false, error: cloneError };
    const moveError = await moveIntoPlace(workingFolder, target);
    return moveError ? { ok: false, error: moveError } : { ok: true, path: target };
  } finally {
    await fs.promises.rm(workingFolder, { recursive: true, force: true }).catch(() => {});
  }
}

async function cloneWithTokenFallback(parsed: ParsedRepositorySource, workingFolder: string, cloneRoot: string, githubToken: string | null, watch: CloneWatch): Promise<string | null> {
  const cloned = await cloneInto(parsed, workingFolder, cloneRoot, githubToken, watch);
  if (cloned.ok) return null;
  const failureText = `git clone ${parsed.url} failed: ${lastLineOf(cloned.err)}`;
  if (!githubToken || !parsed.isGithubHttps || watch.signal.aborted) return failureText;
  await fs.promises.rm(workingFolder, { recursive: true, force: true });
  await fs.promises.mkdir(workingFolder);
  const clonedWithoutToken = await cloneInto(parsed, workingFolder, cloneRoot, null, watch);
  return clonedWithoutToken.ok ? null : failureText;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) === 'EPERM';
  }
}

async function removeInterruptedCloneFolders(cloneRoots: readonly string[], { log = console.log, nowMs = clock.nowMs }: { log?: (line: string) => void; nowMs?: () => number } = {}): Promise<void> {
  for (const cloneRoot of cloneRoots) {
    const folderNames = await fs.promises.readdir(cloneRoot).catch((): string[] => []);
    for (const folderName of folderNames) {
      const owner = inFlightCloneOwnerOf(folderName);
      if (owner === null) continue;
      const folderPath = path.join(cloneRoot, folderName);
      const folderStat = await fs.promises.lstat(folderPath).catch(() => null);
      if (folderStat === null || !folderStat.isDirectory()) continue;
      const isInterrupted = isInterruptedClone({ owner, ageMs: nowMs() - folderStat.mtimeMs }, THIS_RUN, { isOwnerRunning: isProcessRunning(owner.pid), longestCloneMs: LONGEST_CLONE_MS });
      if (!isInterrupted) continue;
      const removalError = await fs.promises.rm(folderPath, { recursive: true, force: true }).then(() => null, messageOf);
      log(removalError ? `[clone] could not remove ${folderPath}: ${removalError}` : `[clone] removed ${folderPath}, left by a clone that was running when Glimmervoid stopped`);
    }
  }
}

type CloneJob = RepositoryCloneJob & { stop: AbortController };
type CloneJobsOptions = {
  cloneRootFor: () => Promise<string>;
  tokenFor: (source: string) => Promise<string | null>;
  onCloned: (cloneRoot: string) => void;
  log?: (line: string) => void;
  nowMs?: () => number;
};

function createCloneJobs({ cloneRootFor, tokenFor, onCloned, log = console.log, nowMs = clock.nowMs }: CloneJobsOptions) {
  const jobsBySource = new Map<string, CloneJob>();
  const events = new EventEmitter();

  function list(): RepositoryCloneJob[] {
    return [...jobsBySource.values()].map(({ stop: _stop, ...job }) => job);
  }

  function announce(): void {
    events.emit(CLONE_CHANGE_EVENT);
  }

  function settle(job: CloneJob, settled: Pick<RepositoryCloneJob, 'state' | 'path' | 'error'>, logLine: string): void {
    Object.assign(job, { progress: '', path: undefined, error: undefined }, settled);
    log(logLine);
    announce();
    startQueued();
  }

  async function cloneOutcomeOf(job: CloneJob): Promise<{ outcome: CloneOutcome; cloneRoot: string | null }> {
    try {
      const cloneRoot = await cloneRootFor();
      const outcome = await cloneRepository({
        source: job.source,
        cloneRoot,
        githubToken: await tokenFor(job.source),
        watch: { signal: job.stop.signal, onProgress: (progress) => noteProgress(job, progress) },
      });
      return { outcome, cloneRoot };
    } catch (error) {
      return { outcome: { ok: false, error: messageOf(error) }, cloneRoot: null };
    }
  }

  function noteProgress(job: CloneJob, progress: string): void {
    if (progress === '' || progress === job.progress || job.state !== 'cloning') return;
    job.progress = progress;
    announce();
  }

  async function run(job: CloneJob): Promise<void> {
    job.state = 'cloning';
    const startedAtMs = nowMs();
    log(`[clone] started ${job.name}`);
    announce();
    const { outcome, cloneRoot } = await cloneOutcomeOf(job);
    if (job.stop.signal.aborted) {
      settle(job, { state: 'cancelled' }, `[clone] cancelled ${job.name}`);
      return;
    }
    if (!outcome.ok || cloneRoot === null) {
      const error = outcome.ok ? 'the clone folder could not be read' : outcome.error;
      settle(job, { state: 'failed', error }, `[clone] failed ${job.name}: ${error}`);
      return;
    }
    onCloned(cloneRoot);
    settle(job, { state: 'done', path: outcome.path }, `[clone] finished ${job.name} in ${Math.round((nowMs() - startedAtMs) / 1000)} s`);
  }

  function startQueued(): void {
    for (const source of sourcesToStart(list())) {
      const job = jobsBySource.get(source);
      if (job) void run(job);
    }
  }

  function start(sources: readonly string[]): string | null {
    let firstRefusal: string | null = null;
    for (const source of sources) {
      const runningState = jobsBySource.get(source)?.state;
      if (runningState === 'queued' || runningState === 'cloning') continue;
      const parsed = parseRepositorySource(source);
      if (!parsed.ok) {
        firstRefusal ??= parsed.error;
        continue;
      }
      jobsBySource.delete(source);
      jobsBySource.set(source, { source, name: cloneJobNameOf(parsed.url), state: 'queued', progress: '', stop: new AbortController() });
    }
    announce();
    startQueued();
    return firstRefusal;
  }

  function cancel(source: string): void {
    const job = jobsBySource.get(source);
    if (job?.state === 'cloning') {
      job.stop.abort();
      return;
    }
    if (job?.state !== 'queued') return;
    job.stop.abort();
    settle(job, { state: 'cancelled' }, `[clone] cancelled ${job.name}`);
  }

  async function forgetMissingFolders(): Promise<void> {
    const doneJobs = [...jobsBySource.values()].filter((job) => job.state === 'done');
    const isFolderThere = await Promise.all(doneJobs.map((job) => fs.promises.access(job.path ?? '').then(() => true, () => false)));
    const goneJobs = doneJobs.filter((job, jobIndex) => !isFolderThere[jobIndex] && jobsBySource.get(job.source) === job && job.state === 'done');
    for (const job of goneJobs) jobsBySource.delete(job.source);
    if (goneJobs.length > 0) announce();
  }

  function onChange(listener: () => void): void {
    events.on(CLONE_CHANGE_EVENT, listener);
  }

  return { cancel, forgetMissingFolders, list, onChange, start };
}

async function ghLoginToken(): Promise<string | null> {
  const result = await runGh(['auth', 'token'], { timeoutMs: GH_TIMEOUT_MS });
  if (!result.ok) return null;
  return result.out.trim() || null;
}

async function resolveGithubCredential({ readToken, userToken, appTokens }: { readToken: string | null; userToken: () => Promise<string | null>; appTokens: readonly string[] }): Promise<GithubCredential> {
  const loginToken = await ghLoginToken();
  const hasEarlierCredential = loginToken !== null || readToken !== null;
  return chooseGithubCredential({ ghLoginToken: loginToken, readToken, userToken: hasEarlierCredential ? null : await userToken(), appTokens });
}

function parsedJsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type RepoListing = { ok: true; repos: GithubRepo[] } | { ok: false; error: string };

async function listGithubRepos(credential: Exclude<GithubCredential, { kind: 'none' }>): Promise<RepoListing> {
  if (credential.kind === 'connection') return listConnectionRepos(credential.token);
  if (credential.kind !== 'app') return listGithubReposAt(githubReposPath(credential.kind), githubReposJqFilter(credential.kind), credential.token);
  const installationReposPath = githubReposPath('app');
  return mergedListings(credential.tokens.map((token) => () => listGithubReposAt(installationReposPath, githubReposJqFilter('app'), token)));
}

async function mergedListings(listings: readonly (() => Promise<RepoListing>)[]): Promise<RepoListing> {
  const repoLists: GithubRepo[][] = [];
  for (const list of listings) {
    const listed = await list();
    if (!listed.ok) return listed;
    repoLists.push(listed.repos);
  }
  return { ok: true, repos: mergedGithubRepos(repoLists) };
}

function couldNotList(ghError: string): RepoListing {
  return { ok: false, error: `gh api could not list your repositories: ${lastLineOf(ghError)}` };
}

async function listConnectionRepos(userToken: string): Promise<RepoListing> {
  const installations = await runGh(['api', '--paginate', GITHUB_USER_INSTALLATIONS_PATH, '--jq', GITHUB_USER_INSTALLATION_IDS_JQ_FILTER], { timeoutMs: GH_LIST_TIMEOUT_MS, env: { GH_TOKEN: userToken } });
  if (!installations.ok) return couldNotList(installations.err);
  const installationIds = githubInstallationIdsFromLines(installations.out.split('\n').filter(Boolean));
  if (!installationIds) return { ok: false, error: 'GitHub answered the installation list in a shape Glimmervoid does not read' };
  return mergedListings(installationIds.map((installationId) => () => listGithubReposAt(githubUserInstallationReposPath(installationId), githubReposJqFilter('app'), userToken)));
}

async function listGithubReposAt(apiPath: string, jqFilter: string, token: string): Promise<RepoListing> {
  const listed = await runGh(['api', '--paginate', apiPath, '--jq', jqFilter], {
    timeoutMs: GH_LIST_TIMEOUT_MS,
    maxBuffer: GH_LIST_MAX_BUFFER_BYTES,
    env: { GH_TOKEN: token },
  });
  if (!listed.ok) return couldNotList(listed.err);
  const repos = githubReposFromLines(listed.out.split('\n').filter(Boolean).map(parsedJsonOf));
  if (!repos) return { ok: false, error: 'GitHub answered the repository list in a shape Glimmervoid does not read' };
  return { ok: true, repos };
}

export { createCloneJobs, listGithubRepos, removeInterruptedCloneFolders, resolveGithubCredential };
