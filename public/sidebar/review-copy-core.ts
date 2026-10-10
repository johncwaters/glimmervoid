import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';

export interface MergeActionVerdict {
  isRendered: boolean;
  isEnabled: boolean;
}

export interface MergeDisabledInputs {
  status: string;
  hasCommits: boolean;
  live: boolean;
  state: string;
}

export interface ReviewHeadline {
  text: string;
  namesMergeTarget: boolean;
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
}): ReviewHeadline {
  if (status === 'parked' && mergeReason === 'base-diverged') {
    return { text: 'Parked: base branch diverged', namesMergeTarget: false };
  }
  if (status === 'parked') return { text: 'Parked: merge conflict', namesMergeTarget: false };
  if (status === 'merging') return { text: 'Merging', namesMergeTarget: false };
  if (status === 'merged') return { text: 'Merged', namesMergeTarget: false };
  if (!fetched) return { text: 'Checking for changes', namesMergeTarget: false };
  if (!hasChanges) return { text: 'No changes yet', namesMergeTarget: false };
  if (isWorkspace) return { text: 'Changes in this worktree', namesMergeTarget: false };
  if (canMerge) return { text: `Ready to merge into ${baseLabel(effectiveBase)}`, namesMergeTarget: true };
  if (!live) return { text: 'Session ended', namesMergeTarget: false };
  if (!hasCommits) return { text: 'Uncommitted changes', namesMergeTarget: false };
  return { text: 'Not ready to merge', namesMergeTarget: false };
}

export function committedMergeTargetText(headline: ReviewHeadline, effectiveBase: string | null | undefined): string | null {
  if (headline.namesMergeTarget) return null;
  return `merges into ${baseLabel(effectiveBase)}`;
}

export function decidePrimaryReviewAction({ status, mergeReason, live, isMergeRendered, hasChanges }: {
  status: string;
  mergeReason: string | null;
  live: boolean;
  isMergeRendered: boolean;
  hasChanges: boolean;
}): 'merge' | 'resolve' | 'none' {
  if (status === 'parked' && live && mergeReason !== 'base-diverged') return 'resolve';
  if (!hasChanges && status !== 'parked' && status !== 'merging') return 'none';
  if (isMergeRendered) return 'merge';
  return 'none';
}

export function baseLabel(effectiveBase: string | null | undefined): string {
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

export type ReviewBranchSync = Pick<ServerMessageOf<'branch-sync-status'>, 'branch' | 'upstream' | 'state' | 'ahead' | 'behind' | 'fetched' | 'action' | 'error'>;

export type BranchSyncClickAction = 'resync' | 'recheck';

export function hasReviewChanges({ fetched, changedFileCount, hasCommits }: {
  fetched: boolean;
  changedFileCount: number;
  hasCommits: boolean;
}): boolean {
  return !fetched || changedFileCount > 0 || hasCommits;
}

function upstreamLabel(upstream: string | null): string {
  return upstream || 'its upstream';
}

export function branchSyncLabel(sync: ReviewBranchSync | null | undefined): string | null {
  if (!sync) return null;
  const branch = sync.branch || 'Base branch';
  const { state, ahead, behind } = sync;
  const upstream = upstreamLabel(sync.upstream);
  if (state === 'no-upstream') return `${branch}: no upstream`;
  if (state === 'unknown') return `${branch}: sync state unknown vs ${upstream}`;
  if (state === 'in-sync') return `${branch}: in sync with ${upstream}`;
  if (state === 'ahead') return `${branch}: ${ahead} ahead of ${upstream}`;
  if (state === 'behind') return `${branch}: ${behind} behind ${upstream}`;
  if (state === 'diverged') return `${branch}: ${ahead} ahead, ${behind} behind ${upstream}`;
  return null;
}

export function branchSyncClickAction(sync: ReviewBranchSync | null | undefined): BranchSyncClickAction {
  if (!sync || sync.fetched === false) return 'recheck';
  if (sync.state === 'ahead' || sync.state === 'behind') return 'resync';
  return 'recheck';
}

export function branchSyncActionTitle(sync: ReviewBranchSync | null | undefined, resolveShortcutHint: string, shortcutResyncs: boolean): string {
  const suffix = shortcutResyncs ? ` (${resolveShortcutHint})` : '';
  if (!sync || branchSyncClickAction(sync) === 'recheck') return `Click to fetch and check again${suffix}`;
  const branch = sync.branch || 'Base branch';
  const upstream = upstreamLabel(sync.upstream);
  if (sync.state === 'behind') return `Click to fast-forward ${branch} to ${upstream}${suffix}`;
  return `Click to push ${branch} to ${upstream}${suffix}`;
}

export function shouldShowBranchSyncLabel(sync: ReviewBranchSync | null | undefined): boolean {
  return sync?.state !== 'in-sync' || sync.fetched === false;
}

export function shouldShowReviewHeaderCounts({ fetched, changedFileCount, view }: {
  fetched: boolean;
  changedFileCount: number;
  view: string;
}): boolean {
  if (!fetched || changedFileCount === 0) return false;
  return view !== 'diff';
}

export function resyncOutcomeText(sync: ReviewBranchSync): string | null {
  if (sync.error) return `Resync failed: ${sync.error}`;
  const branch = sync.branch || 'The base branch';
  const upstream = upstreamLabel(sync.upstream);
  if (sync.action === 'fast-forwarded') return `Fast-forwarded ${branch} to ${upstream}.`;
  if (sync.action === 'pushed') return `Pushed ${branch} to ${upstream}.`;
  if (sync.state === 'diverged') return `${branch} has diverged from ${upstream}. Resolve manually.`;
  if (sync.state === 'in-sync') return null;
  if (sync.state === 'no-upstream') return `${branch} has no upstream to resync against.`;
  return 'Could not determine sync status.';
}
