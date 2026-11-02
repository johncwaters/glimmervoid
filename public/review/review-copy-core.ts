import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';

interface MergeActionVerdict {
  isRendered: boolean;
  isEnabled: boolean;
}

interface MergeDisabledInputs {
  status: string;
  hasCommits: boolean;
  live: boolean;
  state: string;
}

interface ReviewHeadline {
  text: string;
  namesMergeTarget: boolean;
  isEmpty?: boolean;
}

function changeHeadline({ changedFileCount, hasCommits, canMerge, isWorkspace, live, effectiveBase }: {
  changedFileCount: number;
  hasCommits: boolean;
  canMerge: boolean;
  isWorkspace: boolean;
  live: boolean;
  effectiveBase: string | null | undefined;
}): ReviewHeadline {
  const filesChanged = `${changedFileCount} file${changedFileCount === 1 ? '' : 's'} changed`;
  const withFileCount = (phrase: string, sentence: string) => (changedFileCount > 0 ? `${filesChanged}, ${phrase}` : sentence);
  if (isWorkspace) return { text: changedFileCount > 0 ? `${filesChanged} in this worktree` : 'Changes in this worktree', namesMergeTarget: false };
  if (canMerge) {
    const target = baseLabel(effectiveBase);
    return { text: withFileCount(`ready to merge into ${target}`, `Ready to merge into ${target}`), namesMergeTarget: true };
  }
  if (!live) return { text: withFileCount('session ended', 'Session ended'), namesMergeTarget: false };
  if (!hasCommits) return { text: withFileCount('not committed yet', 'Not committed yet'), namesMergeTarget: false };
  return { text: withFileCount('not ready to merge', 'Not ready to merge'), namesMergeTarget: false };
}

export function reviewHeadline({
  status, mergeReason, fetched, hasDiffError, hasChanges, hasCommits, canMerge, isWorkspace, live, effectiveBase, changedFileCount = 0,
}: {
  status: string;
  mergeReason: string | null;
  fetched: boolean;
  hasDiffError: boolean;
  hasChanges: boolean;
  hasCommits: boolean;
  canMerge: boolean;
  isWorkspace: boolean;
  live: boolean;
  effectiveBase: string | null | undefined;
  changedFileCount?: number;
}): ReviewHeadline {
  if (status === 'parked' && mergeReason === 'base-diverged') {
    return { text: 'Parked: base branch diverged', namesMergeTarget: false };
  }
  if (status === 'parked') return { text: 'Parked: merge conflict', namesMergeTarget: false };
  if (status === 'merging') return { text: 'Merging', namesMergeTarget: false };
  if (status === 'merged') return { text: 'Merged', namesMergeTarget: false };
  if (hasDiffError) return { text: 'Could not read changes', namesMergeTarget: false };
  if (!fetched) return { text: 'Checking for changes', namesMergeTarget: false };
  if (!hasChanges) return { text: 'No changes yet', namesMergeTarget: false, isEmpty: true };
  return changeHeadline({ changedFileCount, hasCommits, canMerge, isWorkspace, live, effectiveBase });
}

function baseLabel(effectiveBase: string | null | undefined): string {
  return effectiveBase || 'base';
}

export function mergeActionTitle(effectiveBase: string | null | undefined, mergeShortcutHint: string): string {
  return `Merge into ${baseLabel(effectiveBase)}, push it, and rebase this worktree, then keep working (${mergeShortcutHint})`;
}

export function parkedStatusText(reason: string | null | undefined): string {
  if (reason === 'base-diverged') return 'Resync the base branch by hand, then Merge again.';
  return 'Needs manual merge';
}

export function decideMergeAction(
  status: string,
  mergeReason: string | null,
  isMergeable: boolean,
): MergeActionVerdict {
  const isBaseDiverged = status === 'parked' && mergeReason === 'base-diverged';
  const isRendered = status !== 'parked' || isBaseDiverged;
  return {
    isRendered,
    isEnabled: isRendered && status !== 'merging' && isMergeable,
  };
}

export function mergeDisabledReason({
  status,
  hasCommits,
  live,
  state,
}: MergeDisabledInputs): string | null {
  if (status === 'merging') return null;
  if (!hasCommits) return null;
  if (!live && (status === 'parked' || status === 'merged')) return 'Session ended.';
  if (!live) return null;
  if (status === 'parked') return null;
  if (state === 'INITIALIZING' || state === 'STARTING') {
    return 'Starting up. Mergeable once the session is live.';
  }
  return null;
}

export type SessionDiffPayload = Pick<ServerMessageOf<'session-diff'>, 'committed' | 'uncommitted' | 'hasCommits' | 'bases'>;

export function hasReviewChanges({ fetched, changedFileCount, hasCommits }: {
  fetched: boolean;
  changedFileCount: number;
  hasCommits: boolean;
}): boolean {
  return !fetched || changedFileCount > 0 || hasCommits;
}
