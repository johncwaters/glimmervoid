import { STATES } from '#shared/states.ts';
import type { DiffFile } from './diff-core.ts';
import { parseUnifiedDiff, summarizeFiles } from './diff-core.ts';
import { parkedStatusText, reviewHeadline } from './review-copy-core.ts';
import type { SessionDiffPayload } from './review-copy-core.ts';

type ReaderFileStatus = 'A' | 'M' | 'D' | 'R';

export type ReaderFile = Pick<DiffFile, 'path' | 'oldPath' | 'added' | 'removed' | 'binary' | 'oldBlobId' | 'patch'> & {
  status: ReaderFileStatus;
  contentHash: string | null;
  isGenerated: boolean;
};

const STATUS_LETTER_BY_DIFF_STATUS: Record<string, ReaderFileStatus> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

interface ReviewInput {
  status: string;
  reason: string | null;
  isFetched: boolean;
  hasCommits: boolean;
  hasDiffError: boolean;
  isWorkspace: boolean;
  state: string;
  files: readonly ReaderFile[];
}

export type DiffLayout = 'unified' | 'split';

const SPLIT_MIN_WIDTH_PX = 600;

export function effectiveDiffLayout(chosenLayout: DiffLayout, diffWidthPx: number): DiffLayout {
  return diffWidthPx < SPLIT_MIN_WIDTH_PX ? 'unified' : chosenLayout;
}

export interface ReviewView {
  sentence: string;
  statusLine: string | null;
  isEmpty: boolean;
  totals: { files: number; added: number; removed: number };
}

export function readerFilesOf(payload: SessionDiffPayload | null | undefined): ReaderFile[] {
  if (!payload) return [];
  const generatedPaths = new Set(payload.generatedPaths);
  const files = parseUnifiedDiff(payload.patch).map((file): ReaderFile => ({
    path: file.path,
    oldPath: file.oldPath,
    status: STATUS_LETTER_BY_DIFF_STATUS[file.status] ?? 'M',
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    oldBlobId: file.oldBlobId,
    patch: file.patch,
    contentHash: payload.contentHashByPath[file.path] ?? null,
    isGenerated: generatedPaths.has(file.path),
  }));
  return [...files.filter((file) => !file.isGenerated), ...files.filter((file) => file.isGenerated)];
}

export function findReaderFile(files: readonly ReaderFile[], path: string | null): ReaderFile | null {
  if (path === null) return null;
  return files.find((file) => file.path === path) ?? files.find((file) => file.oldPath === path) ?? null;
}

export function stepReaderFile(files: readonly ReaderFile[], selectedPath: string | null, step: 1 | -1): string | null {
  const selectedIndex = files.findIndex((file) => file.path === selectedPath);
  const fallbackIndex = step === 1 ? 0 : files.length - 1;
  const nextIndex = selectedIndex === -1 ? fallbackIndex : Math.min(files.length - 1, Math.max(0, selectedIndex + step));
  return files[nextIndex]?.path ?? null;
}

function isLiveState(state: string) {
  return state !== STATES.DORMANT && state !== STATES.DONE && state !== STATES.FAILED;
}

const LANDING_STATUSES = new Set(['parked', 'merging', 'merged']);

export function reviewViewOf(input: ReviewInput): ReviewView {
  const { status, reason, isFetched, hasCommits, isWorkspace, state } = input;
  const totals = summarizeFiles(input.files);
  const headline = reviewHeadline({
    status, mergeReason: reason, fetched: isFetched, hasDiffError: input.hasDiffError, hasChanges: totals.files > 0 || hasCommits, hasCommits,
    isWorkspace, live: isLiveState(state), changedFileCount: totals.files,
  });
  const sentence = status === 'parked' ? `${headline.text}. ${parkedStatusText(reason)}` : headline.text;
  return {
    sentence,
    statusLine: LANDING_STATUSES.has(status) ? sentence : null,
    isEmpty: headline.isEmpty === true,
    totals,
  };
}
