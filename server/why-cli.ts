import fs from 'node:fs';
import path from 'node:path';
import { firstLine } from './core/text-core.ts';
import { findRecord, formatWhy, lastPromptBefore, parseCommitLog, parseWhyTarget } from './core/commit-session-core.ts';
import type { ListedCommit } from './core/commit-session-core.ts';
import {
  COMMIT_SESSIONS_FOLDER_NAME, GIT_MAX_BUFFER, GIT_TIMEOUT_MS, gitCommonDirectoryOf, patchIdsOfBatch, readStoreText, storePathFor,
} from './commit-sessions.ts';
import type { GitRunner } from './commit-sessions.ts';
import { runGit } from './git/git-exec.ts';
import { configSiblingPath } from './pairings-store.ts';

const TRACES_FOLDER_NAME = 'traces';
const UNCOMMITTED_SHA = /^0{40}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9-]+$/;

interface WhyCliOptions {
  targetArgument: string;
  cwd?: string;
  configPath?: string | null;
  runGitFn?: GitRunner;
  writeOutput?: (text: string) => void;
  writeError?: (text: string) => void;
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
  const blamed = await runGitFn(['blame', '--porcelain', '-L', `${target.line},${target.line}`, '--', target.file], gitOptions);
  if (!blamed.ok) return { failure: `cannot blame ${location}: ${firstLine(blamed.err)}` };
  if (UNCOMMITTED_SHA.test(blamed.out.slice(0, 40))) return { uncommittedLocation: location };
  const commit = parseBlame(blamed.out);
  return commit ? { commit, location } : { failure: `cannot read the blame of ${location}` };
}

async function readTraceText(storeRoot: string, sessionId: string): Promise<string> {
  if (!SAFE_SESSION_ID.test(sessionId)) return '';
  return fs.promises.readFile(path.join(path.dirname(storeRoot), TRACES_FOLDER_NAME, `${sessionId}.jsonl`), 'utf8').catch(() => '');
}

async function runWhyCli({
  targetArgument,
  cwd = process.cwd(),
  configPath = process.env.GLIMMERVOID_CONFIG ? path.resolve(process.env.GLIMMERVOID_CONFIG) : null,
  runGitFn = runGit,
  writeOutput = (text) => console.log(text),
  writeError = (text) => console.error(text),
}: WhyCliOptions): Promise<number> {
  const target = parseWhyTarget(targetArgument);
  if ('error' in target) {
    writeError(`glimmervoid why: ${target.error}`);
    return 1;
  }
  const gitCommonDirectory = await gitCommonDirectoryOf(cwd, runGitFn);
  if (!gitCommonDirectory) {
    writeError('glimmervoid why: run it inside a git checkout');
    return 1;
  }
  const blamed = await blamedCommit(target, cwd, runGitFn);
  if ('failure' in blamed) {
    writeError(`glimmervoid why: ${blamed.failure}`);
    return 1;
  }
  if ('uncommittedLocation' in blamed) {
    writeOutput(`${blamed.uncommittedLocation}\nnot committed yet`);
    return 0;
  }
  const storeRoot = configSiblingPath(configPath, COMMIT_SESSIONS_FOLDER_NAME);
  const storeText = await readStoreText(storePathFor(storeRoot, gitCommonDirectory));
  const { sha, committedAt } = blamed.commit;
  let record = storeText ? findRecord(storeText, { sha }) : null;
  if (storeText && !record) {
    const patchId = (await patchIdsOfBatch([sha], { cwd, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, runGitFn))?.get(sha);
    record = patchId ? findRecord(storeText, { patchId }) : null;
  }
  const prompt = record ? lastPromptBefore(await readTraceText(storeRoot, record.sessionId), record.committedAt) : null;
  writeOutput(formatWhy({ location: blamed.location, sha, committedAt, record, prompt }));
  return 0;
}

export { runWhyCli };
