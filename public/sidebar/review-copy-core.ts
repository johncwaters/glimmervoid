export interface MergeActionVerdict {
  isRendered: boolean;
  isEnabled: boolean;
}

export interface MergeDisabledInputs {
  status: string;
  mergeReason: string | null;
  fetched: boolean;
  hasCommits: boolean;
  live: boolean;
  state: string;
}

export function reviewHeadline({
  status, mergeReason, fetched, hasChanges, hasCommits, canMerge, isWorkspace, live, effectiveBase,
}: {
  status: string;
  mergeReason: string | null;
  fetched: boolean;
  hasChanges: boolean;
  hasCommits: boolean;
  canMerge: boolean;
  isWorkspace: boolean;
  live: boolean;
  effectiveBase: string | null | undefined;
}): { text: string; tone: 'ready' | 'parked' | 'busy' | 'merged' | 'idle' } {
  if (status === 'parked' && mergeReason === 'base-diverged') {
    return { text: 'Parked: base branch diverged', tone: 'parked' };
  }
  if (status === 'parked') return { text: 'Parked: merge conflict', tone: 'parked' };
  if (status === 'merging') return { text: 'Merging', tone: 'busy' };
  if (status === 'merged') return { text: 'Merged', tone: 'merged' };
  if (!fetched) return { text: 'Checking for changes', tone: 'idle' };
  if (!hasChanges) return { text: 'No changes yet', tone: 'idle' };
  if (isWorkspace) return { text: 'Changes in this worktree', tone: 'idle' };
  if (canMerge) return { text: `Ready to merge into ${baseLabel(effectiveBase)}`, tone: 'ready' };
  if (!live) return { text: 'Session ended', tone: 'idle' };
  if (!hasCommits) return { text: 'Uncommitted changes', tone: 'idle' };
  return { text: 'Not ready to merge', tone: 'idle' };
}

export function decidePrimaryReviewAction({ status, mergeReason, live, isMergeRendered }: {
  status: string;
  mergeReason: string | null;
  live: boolean;
  isMergeRendered: boolean;
}): 'merge' | 'resolve' | 'none' {
  if (status === 'parked' && live && mergeReason !== 'base-diverged') return 'resolve';
  if (isMergeRendered) return 'merge';
  return 'none';
}

export function baseLabel(effectiveBase: string | null | undefined): string {
  return effectiveBase || 'base';
}

export function mergeActionTitle(effectiveBase: string | null | undefined, mergeShortcutHint: string): string {
  return `Merge into ${baseLabel(effectiveBase)}, push it, and rebase this worktree, then keep working (${mergeShortcutHint})`;
}

export function mergeTargetText(effectiveBase: string | null | undefined): string {
  return `merges into ${baseLabel(effectiveBase)}`;
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
  mergeReason,
  fetched,
  hasCommits,
  live,
  state,
}: MergeDisabledInputs): string | null {
  if (status === 'merging') return null;
  if (!fetched) return 'Checking for changes...';
  if (!hasCommits) return null;
  if (!live) return 'Session ended.';
  if (status === 'parked' && mergeReason === 'base-diverged') {
    return 'Resync the base branch by hand before merging.';
  }
  if (status === 'parked') return 'Resolve the conflict, then merge.';
  if (state === 'INITIALIZING' || state === 'STARTING') {
    return 'Starting up. Mergeable once the session is live.';
  }
  return null;
}
