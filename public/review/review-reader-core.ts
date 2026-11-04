import type { SessionState } from '#shared/states.ts';
import { MERGEABLE_LIVE_STATES, STATES } from '#shared/states.ts';
import type { DiffFile } from './diff-core.ts';
import { parseUnifiedDiff, summarizeFiles } from './diff-core.ts';
import { decideMergeAction, hasReviewChanges, mergeDisabledReason, parkedStatusText, reviewHeadline } from './review-copy-core.ts';
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
  effectiveBase: string | null | undefined;
  isMergeInFlight: boolean;
  files: readonly ReaderFile[];
}

export interface ReviewView {
  sentence: string;
  isEmpty: boolean;
  totals: { files: number; added: number; removed: number };
  isMergeShown: boolean;
  isMergeEnabled: boolean;
  mergeRefusal: string | null;
  isDiscardShown: boolean;
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

function isMergeableLive(state: string, hasCommits: boolean) {
  return (MERGEABLE_LIVE_STATES.includes(state as SessionState) || state === STATES.RUNNING) && hasCommits;
}

export function reviewViewOf(input: ReviewInput): ReviewView {
  const { status, reason, isFetched, hasCommits, isWorkspace, state, effectiveBase } = input;
  const totals = summarizeFiles(input.files);
  const isLive = isLiveState(state);
  const mergeAction = decideMergeAction(status, reason, isMergeableLive(state, hasCommits));
  const hasChanges = hasReviewChanges({ fetched: isFetched, changedFileCount: totals.files, hasCommits });
  const headline = reviewHeadline({
    status, mergeReason: reason, fetched: isFetched, hasDiffError: input.hasDiffError, hasChanges: totals.files > 0 || hasCommits, hasCommits,
    canMerge: !isWorkspace && mergeAction.isEnabled, isWorkspace, live: isLive, effectiveBase, changedFileCount: totals.files,
  });
  const isMergeShown = !isWorkspace && mergeAction.isRendered && (hasChanges || status === 'parked' || status === 'merging');
  const mergeRefusal = mergeDisabledReason({ status, hasCommits, live: isLive, state });
  return {
    sentence: status === 'parked' ? `${headline.text}. ${parkedStatusText(reason)}` : headline.text,
    isEmpty: headline.isEmpty === true,
    totals,
    isMergeShown,
    isMergeEnabled: isMergeShown && mergeAction.isEnabled && !input.isMergeInFlight,
    mergeRefusal,
    isDiscardShown: !isWorkspace && !isLive && (status === 'pending-review' || status === 'parked'),
  };
}
