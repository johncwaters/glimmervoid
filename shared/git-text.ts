const SHORT_SHA_CHARS = 7;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function shortSha(sha: unknown, { chars = SHORT_SHA_CHARS, validate = false }: { chars?: number; validate?: boolean } = {}): string {
  if (typeof sha !== 'string' || !sha) return '';
  if (!validate) return sha.slice(0, chars);
  const text = sha.trim();
  if (!HEX_SHA_RE.test(text)) return '';
  return text.slice(0, chars).toLowerCase();
}

const DIFF_HEADER_PREFIX = 'diff --git ';

function diffHeaderPathsOf(header: string): { oldPath: string; path: string } | null {
  if (!header.startsWith(DIFF_HEADER_PREFIX)) return null;
  const paths = header.slice(DIFF_HEADER_PREFIX.length);
  const halfLength = (paths.length - 1) / 2;
  const oldSide = paths.slice(0, halfLength);
  const newSide = paths.slice(halfLength + 1);
  const isSamePathOnBothSides = Number.isInteger(halfLength) && paths[halfLength] === ' '
    && oldSide.startsWith('a/') && newSide.startsWith('b/') && oldSide.slice(2) === newSide.slice(2);
  if (isSamePathOnBothSides) return { oldPath: oldSide.slice(2), path: newSide.slice(2) };
  const match = /^a\/(.+?) b\/(.+)$/.exec(paths);
  if (!match) return null;
  return { oldPath: match[1] ?? '', path: match[2] ?? '' };
}

interface RawLoggedCommit {
  sha: string;
  committedAt: number;
  subject: string;
  isSigned: boolean;
}

const RAW_COMMIT_START = /^commit ([0-9a-f]{40,64})\b/;
const RAW_COMMITTER_TIME = /^committer .* (\d+) [+-]\d{4}$/;

function rawLoggedCommitOf(entry: string): RawLoggedCommit | null {
  const sha = RAW_COMMIT_START.exec(entry)?.[1];
  if (!sha) return null;
  const headerEnd = entry.indexOf('\n\n');
  const headerLines = (headerEnd === -1 ? entry : entry.slice(0, headerEnd)).split('\n');
  const messageLines = headerEnd === -1 ? [] : entry.slice(headerEnd + 2).split('\n');
  const committerSeconds = headerLines.map((line) => RAW_COMMITTER_TIME.exec(line)?.[1]).find((seconds) => seconds !== undefined);
  return {
    sha,
    committedAt: Number(committerSeconds ?? 0) * 1000,
    subject: (messageLines[0] ?? '').trim(),
    isSigned: headerLines.some((line) => line.startsWith('gpgsig')),
  };
}

function parseRawCommitLog(rawLog: string): RawLoggedCommit[] {
  const entries: string[][] = [];
  let isInHeader = false;
  for (const line of rawLog.split('\n')) {
    if (!isInHeader && RAW_COMMIT_START.test(line)) {
      entries.push([line]);
      isInHeader = true;
      continue;
    }
    if (line === '') isInHeader = false;
    entries.at(-1)?.push(line);
  }
  return entries.flatMap((lines) => rawLoggedCommitOf(lines.join('\n')) ?? []);
}

export { FULL_SHA_RE, HEX_SHA_RE, diffHeaderPathsOf, parseRawCommitLog, shortSha };
