import crypto from 'node:crypto';
import path from 'node:path';
import type { z } from 'zod';
import { CommitSessionRecord } from '../../shared/contracts/commit-session.ts';
import { TraceRecord } from '../../shared/contracts/trace.ts';

const COMMIT_LOG_FORMAT = '%H %ct';
const REPO_KEY_HASH_LENGTH = 12;
const SHORT_SHA_LENGTH = 7;
const MAX_PROMPT_CHARS = 200;
const PROMPT_MARKER = '"kind":"prompt"';

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

type WhyTarget = { file: string; line: number } | { sha: string } | { error: string };

interface WhyAnswer {
  location: string;
  sha: string;
  committedAt: number;
  record: CommitSessionRecord | null;
  prompt: { text: string; ts: number } | null;
}

function parsedLineAround<Schema extends z.ZodType>(text: string, offset: number, schema: Schema): z.infer<Schema> | null {
  const lineStart = text.lastIndexOf('\n', offset) + 1;
  const lineEnd = text.indexOf('\n', offset);
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function findRecord(storeText: string, key: { sha: string } | { patchId: string }): CommitSessionRecord | null {
  const marker = 'sha' in key ? `"sha":"${key.sha}"` : `"patchId":"${key.patchId}"`;
  for (let at = storeText.indexOf(marker); at !== -1; at = storeText.indexOf(marker, at + marker.length)) {
    const record = parsedLineAround(storeText, at, CommitSessionRecord);
    if (record && ('sha' in key ? record.sha === key.sha : record.patchId === key.patchId)) return record;
  }
  return null;
}

function parseWhyTarget(argument: string): WhyTarget {
  if (/^[0-9a-f]{4,40}$/i.test(argument)) return { sha: argument.toLowerCase() };
  const separatorAt = argument.lastIndexOf(':');
  const lineText = argument.slice(separatorAt + 1);
  if (separatorAt <= 0 || !/^[1-9][0-9]*$/.test(lineText)) return { error: `expected <file>:<line> or a commit sha, got ${argument}` };
  return { file: argument.slice(0, separatorAt), line: Number(lineText) };
}

function lastPromptBefore(traceText: string, committedAtMs: number): { text: string; ts: number } | null {
  let latest: { text: string; ts: number } | null = null;
  for (let at = traceText.indexOf(PROMPT_MARKER); at !== -1; at = traceText.indexOf(PROMPT_MARKER, at + PROMPT_MARKER.length)) {
    const record = parsedLineAround(traceText, at, TraceRecord);
    if (record?.kind !== 'prompt' || record.ts > committedAtMs || (latest && latest.ts > record.ts)) continue;
    const firstPromptLine = record.text.trim().split('\n')[0] ?? '';
    if (firstPromptLine) latest = { text: firstPromptLine.slice(0, MAX_PROMPT_CHARS), ts: record.ts };
  }
  return latest;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

function localTime(ms: number): string {
  const date = new Date(ms);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function formatWhy(answer: WhyAnswer): string {
  const heading = `${answer.location}  ${answer.sha.slice(0, SHORT_SHA_LENGTH)}  ${localDay(answer.committedAt)} ${localTime(answer.committedAt)}`;
  const { record } = answer;
  if (!record) return `${heading}\nno Glimmervoid session made this commit`;
  const lines = [heading, `session  ${record.sessionName} (${record.agent})  ${record.sessionId.slice(0, 8)}`];
  if (record.taskTitle) lines.push(`task     ${record.taskTitle}`);
  if (answer.prompt) lines.push(`asked    ${JSON.stringify(answer.prompt.text)} (${localTime(answer.prompt.ts)})`);
  return lines.join('\n');
}

function recordedShasOf(storeText: string, sessionId: string): Set<string> {
  const recordedShas = new Set<string>();
  const sessionMarker = `"sessionId":${JSON.stringify(sessionId)}`;
  for (let at = storeText.indexOf(sessionMarker); at !== -1; at = storeText.indexOf(sessionMarker, at + sessionMarker.length)) {
    const record = parsedLineAround(storeText, at, CommitSessionRecord);
    if (record?.sessionId === sessionId) recordedShas.add(record.sha);
  }
  return recordedShas;
}

export { COMMIT_LOG_FORMAT, findRecord, formatWhy, lastPromptBefore, parseCommitLog, parsePatchIds, parseWhyTarget, recordedShasOf, repoKeyOf };
export type { ListedCommit };
