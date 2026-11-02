import fs from 'node:fs';
import path from 'node:path';
import { firstLine } from './core/text-core.ts';
import { findRecord, formatWhy, lastPromptBefore, parseCommitLog, parseWhyTarget } from './core/commit-session-core.ts';
import type { ListedCommit } from './core/commit-session-core.ts';
import {
  COMMIT_SESSIONS_FOLDER_NAME, GIT_MAX_BUFFER, GIT_TIMEOUT_MS, findSharedNote, gitCommonDirectoryOf, patchIdsOfBatch, storePathFor,
} from './commit-sessions.ts';
import type { CommitSessionRecord } from '../shared/contracts/commit-session.ts';
import type { GitRunner } from './commit-sessions.ts';
import { runGit } from './git/git-exec.ts';
import { configSiblingPath } from './pairings-store.ts';

const TRACES_FOLDER_NAME = 'traces';
const UNCOMMITTED_SHA = /^0{40}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9-]+$/;

type WhyLookup = { ok: true; text: string } | { ok: false; status: 400 | 404; error: string };

interface WhyLookupOptions {
  target: string;
  cwd: string;
  configPath: string | null;
  runGitFn?: GitRunner;
}

type BlamedCommit = { commit: ListedCommit; location: string } | { failure: string } | { uncommittedLocation: string };

function parseBlame(blameOutput: string): ListedCommit | null {
  const sha = blameOutput.slice(0, 40);
  const committerTime = /^committer-time (\d+)$/m.exec(blameOutput)?.[1];
  if (!/^[0-9a-f]{40}$/.test(sha) || !committerTime) return null;
  return { sha, committedAt: Number(committerTime) * 1000 };
}

async function blamedCommit(target: { file: string; line: number } | { sha: string }, cwd: string, runGitFn: GitRunner): Promise<BlamedCommit> {
  const gitOptions = { cwd, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, preferStderr: true };
  if ('sha' in target) {
    const listed = await runGitFn(['log', '-1', '--no-walk', '--format=%H %ct', `${target.sha}^{commit}`, '--'], gitOptions);
    const [commit] = listed.ok ? parseCommitLog(listed.out) : [];
    return commit ? { commit, location: commit.sha.slice(0, 12) } : { failure: `no commit ${target.sha}: ${firstLine(listed.err)}` };
  }
  const location = `${target.file}:${target.line}`;
  const blamed = await runGitFn(['blame', '--porcelain', '-L', `${target.line},${target.line}`, '--', path.basename(target.file)], gitOptions);
  if (!blamed.ok) return { failure: `cannot blame ${location}: ${firstLine(blamed.err)}` };
  if (UNCOMMITTED_SHA.test(blamed.out.slice(0, 40))) return { uncommittedLocation: location };
  const commit = parseBlame(blamed.out);
  return commit ? { commit, location } : { failure: `cannot read the blame of ${location}` };
}

async function readTraceText(storeRoot: string, sessionId: string): Promise<string> {
  if (!SAFE_SESSION_ID.test(sessionId)) return '';
  return fs.promises.readFile(path.join(path.dirname(storeRoot), TRACES_FOLDER_NAME, `${sessionId}.jsonl`), 'utf8').catch(() => '');
}

async function findLocalRecord(storeText: string, sha: string, patchIdOfCommit: () => Promise<string | null>): Promise<CommitSessionRecord | null> {
  if (!storeText) return null;
  const bySha = findRecord(storeText, { sha });
  if (bySha) return bySha;
  const patchId = await patchIdOfCommit();
  return patchId ? findRecord(storeText, { patchId }) : null;
}

async function lookupWhy({ target: targetArgument, cwd: sessionDirectory, configPath, runGitFn = runGit }: WhyLookupOptions): Promise<WhyLookup> {
  const target = parseWhyTarget(targetArgument);
  if ('error' in target) return { ok: false, status: 400, error: target.error };
  const cwd = 'file' in target ? path.dirname(path.resolve(sessionDirectory, target.file)) : sessionDirectory;
  const gitCommonDirectory = await gitCommonDirectoryOf(cwd, runGitFn);
  if (!gitCommonDirectory) return { ok: false, status: 400, error: `${cwd} is not inside a git checkout` };
  const blamed = await blamedCommit(target, cwd, runGitFn);
  if ('failure' in blamed) return { ok: false, status: 404, error: blamed.failure };
  if ('uncommittedLocation' in blamed) return { ok: true, text: `${blamed.uncommittedLocation}\nnot committed yet` };
  const storeRoot = configSiblingPath(configPath, COMMIT_SESSIONS_FOLDER_NAME);
  const storePath = storePathFor(storeRoot, gitCommonDirectory);
  const storeText = await fs.promises.readFile(storePath, 'utf8').catch(() => '');
  const { sha, committedAt } = blamed.commit;
  let patchId: string | null | undefined;
  const patchIdOfCommit = async (): Promise<string | null> => {
    if (patchId === undefined) patchId = (await patchIdsOfBatch([sha], { cwd, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, runGitFn))?.get(sha) ?? null;
    return patchId;
  };
  const record = await findLocalRecord(storeText, sha, patchIdOfCommit);
  if (record) {
    const prompt = lastPromptBefore(await readTraceText(storeRoot, record.sessionId), record.committedAt);
    return { ok: true, text: formatWhy({ location: blamed.location, sha, committedAt, record, prompt }) };
  }
  const sharedNote = await findSharedNote(cwd, { sha, patchId: await patchIdOfCommit() }, runGitFn);
  if (!storeText && !sharedNote) {
    return { ok: false, status: 404, error: `no commit-session records for this repository at ${storePath}; a moved checkout or a different --config looks here, or no session has committed in it yet` };
  }
  return { ok: true, text: formatWhy({ location: blamed.location, sha, committedAt, record: null, sharedNote, prompt: null }) };
}

export { lookupWhy };
export type { WhyLookup };
