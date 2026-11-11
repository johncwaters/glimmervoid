import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';

interface ReviewHeadline {
  text: string;
  isEmpty?: boolean;
}

function changeHeadline({ changedFileCount, hasCommits, isWorkspace, live }: {
  changedFileCount: number;
  hasCommits: boolean;
  isWorkspace: boolean;
  live: boolean;
}): ReviewHeadline {
  const filesChanged = `${changedFileCount} file${changedFileCount === 1 ? '' : 's'} changed`;
  const withFileCount = (phrase: string, sentence: string) => (changedFileCount > 0 ? `${filesChanged}, ${phrase}` : sentence);
  if (isWorkspace) return { text: changedFileCount > 0 ? `${filesChanged} in this worktree` : 'Changes in this worktree' };
  if (!live) return { text: withFileCount('session ended', 'Session ended') };
  if (!hasCommits) return { text: withFileCount('not committed yet', 'Not committed yet') };
  return { text: changedFileCount > 0 ? filesChanged : 'Committed' };
}

export function reviewHeadline({
  status, mergeReason, fetched, hasDiffError, hasChanges, hasCommits, isWorkspace, live, changedFileCount = 0,
}: {
  status: string;
  mergeReason: string | null;
  fetched: boolean;
  hasDiffError: boolean;
  hasChanges: boolean;
  hasCommits: boolean;
  isWorkspace: boolean;
  live: boolean;
  changedFileCount?: number;
}): ReviewHeadline {
  if (status === 'parked' && mergeReason === 'base-diverged') return { text: 'Parked: base branch diverged' };
  if (status === 'parked') return { text: 'Parked: merge conflict' };
  if (status === 'merging') return { text: 'Merging' };
  if (status === 'merged') return { text: 'Merged' };
  if (hasDiffError) return { text: 'Could not read changes' };
  if (!fetched) return { text: 'Checking for changes' };
  if (!hasChanges) return { text: 'No changes yet', isEmpty: true };
  return changeHeadline({ changedFileCount, hasCommits, isWorkspace, live });
}

export function parkedStatusText(reason: string | null | undefined): string {
  if (reason === 'base-diverged') return 'Resync the base branch by hand, then ask the agent to merge again.';
  return 'Needs manual merge';
}

export type SessionDiffPayload = Pick<ServerMessageOf<'session-diff'>, 'patch' | 'contentHashByPath' | 'generatedPaths' | 'hasCommits' | 'bases'>;
