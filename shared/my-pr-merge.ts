import type { MyPr, MyPrMergeMethod } from './contracts/my-prs.ts';

const MERGE_METHOD_LABELS: Readonly<Record<MyPrMergeMethod, string>> = { MERGE: 'a merge commit', SQUASH: 'squash and merge', REBASE: 'rebase and merge' };
const FAILING_CHECK_STATES: ReadonlySet<string> = new Set(['FAILURE', 'ERROR']);

export function mergeMethodLabel(method: MyPrMergeMethod): string {
  return MERGE_METHOD_LABELS[method];
}

export function myPrMergeBlocker(pr: MyPr): string | null {
  if (pr.state === 'MERGED') return 'Already merged';
  if (pr.state !== 'OPEN') return 'Closed';
  if (pr.isDraft) return 'Drafts cannot be merged';
  if (pr.isInMergeQueue) return 'Already in the merge queue';
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'Resolve the merge conflicts first';
  const hasFailingChecks = pr.checks.failing.length > 0 || (pr.checks.state !== null && FAILING_CHECK_STATES.has(pr.checks.state));
  if (hasFailingChecks) return 'Checks are failing';
  if (pr.stage !== 'ready') return 'Not ready to merge yet';
  return null;
}

export function myPrMergeRefusal(pr: MyPr | undefined, seenHeadRefOid: string): string | null {
  if (!pr) return 'That pull request is not one of your tracked pull requests';
  const blocker = myPrMergeBlocker(pr);
  if (blocker) return blocker;
  if (pr.headRefOid !== seenHeadRefOid) return 'The pull request has new commits since you looked at it';
  return null;
}
