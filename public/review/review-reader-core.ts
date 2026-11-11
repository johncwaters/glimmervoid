import { STATES } from '#shared/states.ts';
import type { DiffFile } from './diff-core.ts';
import { parseUnifiedDiff, summarizeFiles } from './diff-core.ts';
import { parkedStatusText, reviewHeadline } from './review-copy-core.ts';
import type { SessionDiffPayload } from './review-copy-core.ts';

export type ReaderFile = Pick<DiffFile, 'path' | 'oldPath' | 'added' | 'removed' | 'binary' | 'hunks'>;

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

export interface ReviewView {
  sentence: string;
  statusLine: string | null;
  isEmpty: boolean;
  totals: { files: number; added: number; removed: number };
}

export function readerFilesOf(payload: SessionDiffPayload | null | undefined): ReaderFile[] {
  if (!payload) return [];
  const fileByPath = new Map<string, ReaderFile>();
  for (const file of [...parseUnifiedDiff(payload.committed?.diff), ...parseUnifiedDiff(payload.uncommitted?.diff)]) {
    const known = fileByPath.get(file.path);
    if (!known) {
      fileByPath.set(file.path, { path: file.path, oldPath: file.oldPath, added: file.added, removed: file.removed, binary: file.binary, hunks: [...file.hunks] });
      continue;
    }
    known.added += file.added;
    known.removed += file.removed;
    known.binary = known.binary || file.binary;
    known.hunks.push(...file.hunks);
  }
  return [...fileByPath.values()];
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
