import fs from 'node:fs';
import path from 'node:path';
import type { CommitSessionRecord } from '../shared/contracts/commit-session.ts';
import { errorMessage } from '../shared/text.ts';
import {
  COMMIT_LOG_FORMAT, FETCHED_NOTES_REF_PREFIX, NOTES_COMMIT_IDENTITY, NOTES_FETCH_REFSPEC, NOTES_REF_PREFIX, encodeNote, noteKeysOf, parseCommitLog, parseNote, parsePatchIds, recordedShasOf, repoKeyOf, repoNotesRefOf, writerNotesRef,
} from './core/commit-session-core.ts';
import type { ListedCommit, SharedProvenanceNote } from './core/commit-session-core.ts';
import { GIT_FETCH_TIMEOUT_MS } from './core/branch-sync-core.ts';
import { runGit } from './git/git-exec.ts';
import type { RunGitOptions } from './git/git-exec.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendJsonLines, createJsonStateStore } from './json-file.ts';
import { createKeyedSerialQueue } from './spawn-gate.ts';
import { clock } from '../shared/clock.ts';

const COMMIT_SESSIONS_FOLDER_NAME = 'commit-sessions';
const PROVENANCE_WRITER_FILE_NAME = 'provenance-writer.json';
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

async function repoNotesRefFor(directory: string, machineWriterId: string, runGitFn: GitRunner = runGit): Promise<string | null> {
  const gitCommonDirectory = await gitCommonDirectoryOf(directory, runGitFn);
  return gitCommonDirectory ? repoNotesRefOf(machineWriterId, gitCommonDirectory) : null;
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

async function notesRefsUnder(prefix: string, gitOptions: RunGitOptions, runGitFn: GitRunner): Promise<string[]> {
  const listed = await runGitFn(['for-each-ref', '--format=%(refname)', prefix], gitOptions);
  return listed.ok ? listed.out.split('\n').filter(Boolean) : [];
}

async function findNoteUnder(prefix: string, commit: { sha: string; patchId: string | null }, gitOptions: RunGitOptions, runGitFn: GitRunner): Promise<SharedProvenanceNote | null> {
  const noteRefs = await notesRefsUnder(prefix, gitOptions, runGitFn);
  for (const noteKey of noteKeysOf(commit)) {
    for (const noteRef of noteRefs) {
      const shown = await runGitFn(['notes', '--ref', noteRef, 'show', noteKey], gitOptions);
      const note = shown.ok ? parseNote(shown.out) : null;
      if (note) return note;
    }
  }
  return null;
}

async function findSharedNote(cwd: string, commit: { sha: string; patchId: string | null }, runGitFn: GitRunner = runGit): Promise<SharedProvenanceNote | null> {
  const gitOptions: RunGitOptions = { cwd, timeoutMs: GIT_TIMEOUT_MS };
  const localNote = await findNoteUnder(NOTES_REF_PREFIX, commit, gitOptions, runGitFn);
  if (localNote) return localNote;
  await runGitFn(['fetch', '--quiet', '--no-tags', 'origin', NOTES_FETCH_REFSPEC], { cwd, timeoutMs: GIT_FETCH_TIMEOUT_MS });
  return findNoteUnder(FETCHED_NOTES_REF_PREFIX, commit, gitOptions, runGitFn);
}

const ProvenanceWriterState = z.object({ writerId: z.string().refine((writerId) => writerNotesRef(writerId) !== null) }).strict();

function createProvenanceWriterId(filePath: string, logger: Pick<Console, 'warn'>): () => Promise<string> {
  let writerId: string | null = null;
  const stateStore = createJsonStateStore<z.infer<typeof ProvenanceWriterState>>({
    name: 'provenance writer id',
    filePath,
    parse: (raw) => {
      const parsed = ProvenanceWriterState.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    adopt: (loaded) => { writerId = writerId ?? loaded?.writerId ?? null; },
    warn: (message, fields) => logger.warn(`[commit-sessions] ${message} ${JSON.stringify(fields)}`),
  });
  return async () => {
    await stateStore.load();
    if (writerId) return writerId;
    const freshState = { writerId: randomUUID() };
    writerId = freshState.writerId;
    await stateStore.write(freshState, () => JSON.stringify(freshState, null, 2));
    return writerId;
  };
}

function createCommitSessions({ storeRoot, runGitFn = runGit, logger, nowFn = clock.nowMs, writerIdFn = () => Promise.resolve(null) }: {
  storeRoot: string;
  runGitFn?: GitRunner;
  logger: Pick<Console, 'warn'>;
  nowFn?: () => number;
  writerIdFn?: () => Promise<string | null>;
}) {
  const lastCapturedHeadBySessionId = new Map<string, string>();
  const recordedShasBySessionId = new Map<string, Set<string>>();
  const gitCommonDirectoryByWorktreeDir = new Map<string, string>();
  const captureQueue = createKeyedSerialQueue();

  async function cachedGitCommonDirectoryOf(worktreeDir: string): Promise<string | null> {
    const known = gitCommonDirectoryByWorktreeDir.get(worktreeDir);
    if (known) return known;
    const gitCommonDirectory = await gitCommonDirectoryOf(worktreeDir, runGitFn);
    if (gitCommonDirectory) gitCommonDirectoryByWorktreeDir.set(worktreeDir, gitCommonDirectory);
    return gitCommonDirectory;
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
    const gitCommonDirectory = await cachedGitCommonDirectoryOf(change.worktreeDir);
    if (!gitCommonDirectory) return;
    const storePath = storePathFor(storeRoot, gitCommonDirectory);
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
    await writeNotes(records, gitCommonDirectory, gitOptions);
    await appendJsonLines(storePath, records, { mkdir: true, mode: 0o600 });
    lastCapturedHeadBySessionId.set(change.sessionId, change.headSha);
    for (const record of records) recordedShas.add(record.sha);
  }

  async function addNoteKeepingFirst(noteRef: string, note: string, noteKey: string, gitOptions: RunGitOptions): Promise<boolean> {
    const added = await runGitFn(['notes', '--ref', noteRef, 'add', '-m', note, noteKey], { ...gitOptions, env: NOTES_COMMIT_IDENTITY });
    if (added.ok) return true;
    const existing = await runGitFn(['notes', '--ref', noteRef, 'show', noteKey], gitOptions);
    return existing.ok;
  }

  async function writeNotes(records: readonly CommitSessionRecord[], gitCommonDirectory: string, gitOptions: RunGitOptions): Promise<void> {
    const noteRef = repoNotesRefOf((await writerIdFn()) ?? '', gitCommonDirectory);
    if (!noteRef) return;
    const failedShas: string[] = [];
    for (const record of records) {
      const note = encodeNote(record);
      const [shaKey, patchIdKey] = noteKeysOf(record);
      const isShaNoteWritten = await addNoteKeepingFirst(noteRef, note, shaKey ?? record.sha, gitOptions);
      const isPatchIdNoteWritten = !patchIdKey || await addNoteKeepingFirst(noteRef, note, patchIdKey, gitOptions);
      if (!isShaNoteWritten || !isPatchIdNoteWritten) failedShas.push(record.sha.slice(0, 12));
    }
    if (failedShas.length > 0) logger.warn(`[commit-sessions] could not write the shared note for ${failedShas.join(', ')}`);
  }

  async function noteHeadChange(change: SessionHeadChange): Promise<void> {
    const { baseRef } = change;
    if (!baseRef) return;
    const repoKey = (await cachedGitCommonDirectoryOf(change.worktreeDir).catch(() => null)) ?? change.worktreeDir;
    return captureQueue.run(repoKey, () => capture({ ...change, baseRef }))
      .catch((error: unknown) => logger.warn(`[commit-sessions] capture failed for ${change.sessionId}: ${errorMessage(error)}`));
  }

  return { noteHeadChange };
}

type CommitSessions = ReturnType<typeof createCommitSessions>;

export {
  COMMIT_SESSIONS_FOLDER_NAME, GIT_MAX_BUFFER, PROVENANCE_WRITER_FILE_NAME, createProvenanceWriterId, GIT_TIMEOUT_MS, createCommitSessions, findSharedNote, gitCommonDirectoryOf, patchIdsOfBatch, repoNotesRefFor, storePathFor,
};
export type { CommitSessions, GitRunner };
