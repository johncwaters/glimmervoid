import fs from 'node:fs';
import path from 'node:path';
import type { CommitSessionRecord } from '../shared/contracts/commit-session.ts';
import { errorMessage } from '../shared/text.ts';
import { COMMIT_LOG_FORMAT, parseCommitLog, parsePatchIds, recordedShasOf, repoKeyOf } from './core/commit-session-core.ts';
import type { ListedCommit } from './core/commit-session-core.ts';
import { runGit } from './git/git-exec.ts';
import type { RunGitOptions } from './git/git-exec.ts';
import { appendJsonLines } from './json-file.ts';
import { createKeyedSerialQueue } from './spawn-gate.ts';

const COMMIT_SESSIONS_FOLDER_NAME = 'commit-sessions';
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface SessionHeadChange {
  sessionId: string;
  sessionName: string;
  agent: string;
  taskTitle: string | null;
  worktreeDir: string;
  headSha: string;
  baseRef: string | null;
}

type GitRunner = (args: readonly string[], options: RunGitOptions) => ReturnType<typeof runGit>;

function storePathFor(storeRoot: string, gitCommonDirectory: string): string {
  return path.join(storeRoot, `${repoKeyOf(gitCommonDirectory)}.jsonl`);
}

async function gitCommonDirectoryOf(directory: string, runGitFn: GitRunner = runGit): Promise<string | null> {
  const result = await runGitFn(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok || !result.out) return null;
  return fs.promises.realpath(result.out).catch(() => result.out);
}

async function patchIdsOfBatch(shas: readonly string[], gitOptions: RunGitOptions, runGitFn: GitRunner = runGit): Promise<Map<string, string> | null> {
  const patches = await runGitFn(['show', '--no-color', '--format=commit %H', '-p', ...shas], { ...gitOptions, trim: false });
  if (!patches.ok) return null;
  const patchIds = await runGitFn(['patch-id', '--stable'], { ...gitOptions, input: patches.out });
  return patchIds.ok ? parsePatchIds(patchIds.out) : null;
}

async function readStoreText(storePath: string): Promise<string> {
  return fs.promises.readFile(storePath, 'utf8').catch(() => '');
}

function createCommitSessions({ storeRoot, runGitFn = runGit, logger, nowFn = Date.now }: {
  storeRoot: string;
  runGitFn?: GitRunner;
  logger: Pick<Console, 'warn'>;
  nowFn?: () => number;
}) {
  const lastCapturedHeadBySessionId = new Map<string, string>();
  const recordedShasBySessionId = new Map<string, Set<string>>();
  const storePathByWorktreeDir = new Map<string, string>();
  const captureQueue = createKeyedSerialQueue();

  async function storePathOf(worktreeDir: string): Promise<string | null> {
    const known = storePathByWorktreeDir.get(worktreeDir);
    if (known) return known;
    const gitCommonDirectory = await gitCommonDirectoryOf(worktreeDir, runGitFn);
    if (!gitCommonDirectory) return null;
    const storePath = storePathFor(storeRoot, gitCommonDirectory);
    storePathByWorktreeDir.set(worktreeDir, storePath);
    return storePath;
  }

  async function recordedShasFor(sessionId: string, storePath: string): Promise<Set<string>> {
    const known = recordedShasBySessionId.get(sessionId);
    if (known) return known;
    const recordedShas = recordedShasOf(await readStoreText(storePath), sessionId);
    recordedShasBySessionId.set(sessionId, recordedShas);
    return recordedShas;
  }

  async function patchIdsOf(commits: readonly ListedCommit[], gitOptions: RunGitOptions): Promise<Map<string, string>> {
    const shas = commits.map((commit) => commit.sha);
    const batchPatchIds = await patchIdsOfBatch(shas, gitOptions, runGitFn);
    if (batchPatchIds || shas.length === 1) return batchPatchIds ?? new Map();
    const patchIdBySha = new Map<string, string>();
    for (const sha of shas) {
      const singlePatchId = (await patchIdsOfBatch([sha], gitOptions, runGitFn))?.get(sha);
      if (singlePatchId) patchIdBySha.set(sha, singlePatchId);
    }
    return patchIdBySha;
  }

  async function capture(change: SessionHeadChange & { baseRef: string }): Promise<void> {
    if (lastCapturedHeadBySessionId.get(change.sessionId) === change.headSha) return;
    const storePath = await storePathOf(change.worktreeDir);
    if (!storePath) return;
    const gitOptions: RunGitOptions = { cwd: change.worktreeDir, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER };
    const listed = await runGitFn(['log', '--no-merges', `--format=${COMMIT_LOG_FORMAT}`, `${change.baseRef}..${change.headSha}`], gitOptions);
    if (!listed.ok) return;
    const recordedShas = await recordedShasFor(change.sessionId, storePath);
    const newCommits = parseCommitLog(listed.out).filter((commit) => !recordedShas.has(commit.sha));
    if (newCommits.length === 0) {
      lastCapturedHeadBySessionId.set(change.sessionId, change.headSha);
      return;
    }
    const patchIdBySha = await patchIdsOf(newCommits, gitOptions);
    const shasWithoutPatchId = newCommits.filter((commit) => !patchIdBySha.has(commit.sha)).map((commit) => commit.sha.slice(0, 12));
    if (shasWithoutPatchId.length > 0) logger.warn(`[commit-sessions] no patch-id for ${shasWithoutPatchId.join(', ')} in ${change.sessionId}; a rebased copy will not trace back`);
    const recordedAt = nowFn();
    const records: CommitSessionRecord[] = newCommits.map((commit) => ({
      sha: commit.sha,
      patchId: patchIdBySha.get(commit.sha) ?? null,
      sessionId: change.sessionId,
      sessionName: change.sessionName.slice(0, 200),
      agent: change.agent.slice(0, 64),
      taskTitle: change.taskTitle?.slice(0, 300) ?? null,
      committedAt: commit.committedAt,
      recordedAt,
    }));
    await appendJsonLines(storePath, records, { mkdir: true, mode: 0o600 });
    lastCapturedHeadBySessionId.set(change.sessionId, change.headSha);
    for (const record of records) recordedShas.add(record.sha);
  }

  function noteHeadChange(change: SessionHeadChange): Promise<void> {
    const { baseRef } = change;
    if (!baseRef) return Promise.resolve();
    return captureQueue.run(change.sessionId, () => capture({ ...change, baseRef }))
      .catch((error: unknown) => logger.warn(`[commit-sessions] capture failed for ${change.sessionId}: ${errorMessage(error)}`));
  }

  return { noteHeadChange };
}

type CommitSessions = ReturnType<typeof createCommitSessions>;

export { COMMIT_SESSIONS_FOLDER_NAME, GIT_MAX_BUFFER, GIT_TIMEOUT_MS, createCommitSessions, gitCommonDirectoryOf, patchIdsOfBatch, storePathFor };
export type { CommitSessions, GitRunner };
