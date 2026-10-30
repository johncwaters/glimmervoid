import crypto from 'node:crypto';
import path from 'node:path';
import { CommitSessionRecord } from '../../shared/contracts/commit-session.ts';

const COMMIT_LOG_FORMAT = '%H %ct';
const REPO_KEY_HASH_LENGTH = 12;

interface ListedCommit {
  sha: string;
  committedAt: number;
}

function repoKeyOf(gitCommonDirectory: string): string {
  const repoName = path.basename(path.dirname(gitCommonDirectory)).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo';
  const hash = crypto.createHash('sha1').update(gitCommonDirectory).digest('hex').slice(0, REPO_KEY_HASH_LENGTH);
  return `${repoName}-${hash}`;
}

function parseCommitLog(logOutput: string): ListedCommit[] {
  return logOutput.split('\n').flatMap((line) => {
    const [sha, seconds] = line.trim().split(' ');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !seconds) return [];
    return [{ sha, committedAt: Number(seconds) * 1000 }];
  });
}

function parsePatchIds(patchIdOutput: string): Map<string, string> {
  const patchIdBySha = new Map<string, string>();
  for (const line of patchIdOutput.split('\n')) {
    const [patchId, sha] = line.trim().split(' ');
    if (patchId && sha) patchIdBySha.set(sha, patchId);
  }
  return patchIdBySha;
}

function recordAround(storeText: string, offset: number): CommitSessionRecord | null {
  const lineStart = storeText.lastIndexOf('\n', offset) + 1;
  const lineEnd = storeText.indexOf('\n', offset);
  try {
    const parsed = CommitSessionRecord.safeParse(JSON.parse(storeText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function recordedShasOf(storeText: string, sessionId: string): Set<string> {
  const recordedShas = new Set<string>();
  const sessionMarker = `"sessionId":${JSON.stringify(sessionId)}`;
  for (let at = storeText.indexOf(sessionMarker); at !== -1; at = storeText.indexOf(sessionMarker, at + sessionMarker.length)) {
    const record = recordAround(storeText, at);
    if (record?.sessionId === sessionId) recordedShas.add(record.sha);
  }
  return recordedShas;
}

export { COMMIT_LOG_FORMAT, parseCommitLog, parsePatchIds, recordedShasOf, repoKeyOf };
export type { ListedCommit };
