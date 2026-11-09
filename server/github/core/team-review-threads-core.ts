import { TeamReviewThreadResult } from '../../../shared/contracts/team-review.ts';
import type { ReviewDraft, TeamReviewCompareFiles, TeamReviewThread, TeamReviewThreadNode, TeamReviewThreadResult as ThreadResult, ViewerThreadTally } from '../../../shared/contracts/team-review.ts';
import { parseLeadingFindingHeader, withoutAutomatedNote } from '../../../shared/team-review-markdown.ts';
import { UNTRUSTED_PAYLOAD_FILENAME, UNTRUSTED_PREAMBLE } from '../../../shared/contracts/untrusted-payload.ts';
import type { UntrustedItem } from '../../../shared/contracts/untrusted-payload.ts';

export const THREAD_JUDGE_BACKOFF_MS = 15 * 60 * 1000;
export const THREAD_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
export const THREAD_PLACEHOLDER_ERROR = 'No local review draft. Review the answered threads below.';
const THREAD_COMMENTS_MAX_CHARS = 20000;
const THREAD_PATCH_MAX_CHARS = 120000;
const THREAD_JUDGE_PART_MAX_CHARS = 6000;
const COMPARE_FILES_MAX = 300;
export const THREAD_JUDGE_ITEM_MAX_CHARS = THREAD_JUDGE_PART_MAX_CHARS;

export interface ThreadJudgeRequest {
  prompt: string;
  untrustedItems: UntrustedItem[];
}

export function viewerThreadTally(nodes: readonly TeamReviewThreadNode[]): ViewerThreadTally {
  const viewerThreads = nodes.filter((node) => node.comments.nodes[0]?.viewerDidAuthor);
  return { total: viewerThreads.length, resolved: viewerThreads.filter((node) => node.isResolved).length };
}

export function countViewerThreadResolved(tally: ViewerThreadTally | undefined): ViewerThreadTally | undefined {
  if (!tally) return undefined;
  return { ...tally, resolved: Math.min(tally.total, tally.resolved + 1) };
}

function threadBodyPreview(body: string): { text: string; isTruncated: boolean } {
  const trimmedBody = body.trim();
  const preview = trimmedBody.slice(0, 1500);
  const isTruncated = trimmedBody.length > preview.length;
  const lastCodeUnit = preview.charCodeAt(preview.length - 1);
  if (isTruncated && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) return { text: preview.slice(0, -1).trimEnd(), isTruncated };
  return { text: preview.trimEnd(), isTruncated };
}

export function answeredViewerThreads(nodes: readonly TeamReviewThreadNode[], previous: readonly TeamReviewThread[], head: string, autoResolvedThreadIds: readonly string[] = []): TeamReviewThread[] {
  return nodes.flatMap((node) => {
    const first = node.comments.nodes.at(0);
    const last = node.comments.nodes.at(-1);
    if (node.isResolved || node.comments.pageInfo.hasNextPage || !first?.viewerDidAuthor || !last || last === first || last.viewerDidAuthor) return [];
    const prior = previous.find((thread) => thread.id === node.id);
    const isSameReply = prior?.lastReplyAt === last.createdAt;
    const viewerComment = threadBodyPreview(withoutAutomatedNote(first.body));
    const lastReply = threadBodyPreview(last.body);
    const thread: TeamReviewThread = {
      id: node.id, path: node.path, line: node.line, isResolved: node.isResolved, viewerCanResolve: node.viewerCanResolve,
      isNit: parseLeadingFindingHeader(withoutAutomatedNote(first.body))?.severity === 'LOW' && !autoResolvedThreadIds.includes(node.id),
      viewerComment: viewerComment.text, lastReplyBody: lastReply.text,
      ...(viewerComment.isTruncated ? { viewerCommentTruncated: true } : {}), ...(lastReply.isTruncated ? { lastReplyTruncated: true } : {}),
      url: first.url, lastReplyAuthor: last.author?.login ?? 'Deleted account', lastReplyAt: last.createdAt,
    };
    if (!isSameReply) return [thread];
    if (prior.resolveAttemptReplyAt) thread.resolveAttemptReplyAt = prior.resolveAttemptReplyAt;
    if (prior.resolveError) thread.resolveError = prior.resolveError;
    if (prior.judgement?.head === head && prior.judgement.lastReplyAt === last.createdAt) thread.judgement = prior.judgement;
    if (prior.judgeAttempt?.head === head) thread.judgeAttempt = prior.judgeAttempt;
    if (prior.unjudgeable?.head === head && prior.unjudgeable.lastReplyAt === last.createdAt) thread.unjudgeable = prior.unjudgeable;
    return [thread];
  });
}

export function hasPresentableThreads(threads: readonly TeamReviewThread[]): boolean {
  return threads.some((thread) => !thread.isResolved && (!thread.isNit || thread.resolveError !== undefined));
}

export function isThreadPlaceholderDraft(draft: Pick<ReviewDraft, 'error'> | null | undefined): boolean {
  return draft?.error === THREAD_PLACEHOLDER_ERROR;
}

export function shouldAutoResolveThread(thread: TeamReviewThread): boolean {
  return thread.isNit && !thread.isResolved && thread.viewerCanResolve && thread.resolveAttemptReplyAt !== thread.lastReplyAt;
}

export function shouldJudgeThread(thread: TeamReviewThread, head: string, nowMs: number): boolean {
  if (thread.isNit || thread.isResolved) return false;
  if (thread.judgement?.head === head && thread.judgement.lastReplyAt === thread.lastReplyAt) return false;
  if (thread.unjudgeable?.head === head && thread.unjudgeable.lastReplyAt === thread.lastReplyAt) return false;
  const attempt = thread.judgeAttempt;
  return !attempt || attempt.head !== head || attempt.lastReplyAt !== thread.lastReplyAt || attempt.retryAt <= nowMs;
}

interface ThreadJudgeEvidence {
  commentParts: string[];
  patchParts: { filename: string; text: string }[];
}

function isCommentedFile(node: TeamReviewThreadNode, file: TeamReviewCompareFiles['files'][number]): boolean {
  return file.filename === node.path || file.previous_filename === node.path;
}

function commentedFileFirst(node: TeamReviewThreadNode, files: TeamReviewCompareFiles['files']): TeamReviewCompareFiles['files'] {
  return [...files.filter((file) => isCommentedFile(node, file)), ...files.filter((file) => !isCommentedFile(node, file))];
}

function textParts(text: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const character of text) {
    if (part.length + character.length > THREAD_JUDGE_PART_MAX_CHARS) {
      parts.push(part);
      part = '';
    }
    part += character;
  }
  parts.push(part);
  return parts;
}

type ComparedFile = TeamReviewCompareFiles['files'][number];

function isSameChange(threadFile: ComparedFile, mainFile: ComparedFile | undefined): boolean {
  if (!mainFile) return false;
  if (threadFile.patch !== undefined) return mainFile.patch === threadFile.patch;
  return mainFile.patch === undefined && threadFile.sha !== undefined && mainFile.sha === threadFile.sha && mainFile.previous_filename === threadFile.previous_filename;
}

function mainOnlyFileNames(threadFiles: TeamReviewCompareFiles['files'], mainSinceComment: TeamReviewCompareFiles | null): ReadonlySet<string> {
  if (!mainSinceComment) return new Set();
  const mainFileByFilename = new Map(mainSinceComment.files.map((file) => [file.filename, file] as const));
  return new Set(threadFiles.flatMap((file) => (isSameChange(file, mainFileByFilename.get(file.filename)) ? [file.filename] : [])));
}

export function threadJudgeEvidence(node: TeamReviewThreadNode, comparison: TeamReviewCompareFiles | null, mainSinceComment: TeamReviewCompareFiles | null = null): { evidence: ThreadJudgeEvidence } | { unjudgeableReason: string } {
  if (!comparison) return { unjudgeableReason: 'History was rewritten since your comment, so the change cannot be compared' };
  if (comparison.files.length >= COMPARE_FILES_MAX) return { unjudgeableReason: 'Too many changed files to judge' };
  const mainOnlyFiles = mainOnlyFileNames(comparison.files, mainSinceComment);
  const changedFiles = comparison.files.filter((file) => !mainOnlyFiles.has(file.filename) || isCommentedFile(node, file));
  const fileWithoutDiff = changedFiles.find((file) => file.patch === undefined);
  if (fileWithoutDiff) return { unjudgeableReason: `GitHub sent no text diff for ${fileWithoutDiff.filename}, as for a binary file, a rename or a very large diff` };
  const comments = JSON.stringify({ path: node.path, line: node.line, comments: node.comments.nodes.map(({ body, author, createdAt }) => ({ body, author: author?.login ?? null, createdAt })) });
  if (comments.length > THREAD_COMMENTS_MAX_CHARS) return { unjudgeableReason: 'Thread too long to judge' };
  const files = commentedFileFirst(node, changedFiles);
  const changeChars = files.reduce((total, file) => total + file.filename.length + (file.patch ?? '').length, 0);
  if (changeChars > THREAD_PATCH_MAX_CHARS) return { unjudgeableReason: 'Change too large to judge' };
  return { evidence: { commentParts: textParts(comments), patchParts: files.flatMap((file) => textParts(file.patch ?? '').map((text) => ({ filename: file.filename, text }))) } };
}

export function buildThreadJudgeRequest(node: TeamReviewThreadNode, head: string, evidence: ThreadJudgeEvidence): ThreadJudgeRequest {
  const prompt = [
    'Judge whether the latest reply and the code changes at the current head address the original review finding.',
    `The evidence is in ${UNTRUSTED_PAYLOAD_FILENAME}: thread-comments items holding the thread, then patch items holding the diff of every file changed since the commented commit, the commented file first. Long text is split across consecutive items of the same kind and ref; join their text in order.`,
    `${UNTRUSTED_PAYLOAD_FILENAME} can be too large for one Read: read it with offset and limit, 5 lines at a time, until you have read every item. Use no tool except reading that file and writing the result file.`,
    'Write thread-result.json in your cwd with exactly {"addressed": boolean, "reason": "explanation"}.',
    'Return addressed false when the evidence is insufficient. A reply claiming a fix is not proof; a fix in any changed file counts.',
    `Current head: ${head}.`,
    UNTRUSTED_PREAMBLE,
  ].join('\n');
  const threadUrl = node.comments.nodes[0]?.url ?? node.path;
  return {
    prompt,
    untrustedItems: [
      ...evidence.commentParts.map((text) => ({ kind: 'thread-comments', ref: threadUrl, text })),
      ...evidence.patchParts.map(({ filename, text }) => ({ kind: 'patch', ref: filename, text })),
    ],
  };
}

export function parseThreadJudgeResult(raw: unknown): ThreadResult | null {
  const parsed = TeamReviewThreadResult.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
