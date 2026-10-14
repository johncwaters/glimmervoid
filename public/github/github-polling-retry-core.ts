import type { MyPrsStatus } from '#shared/contracts/my-prs.ts';

export type ReviewsPollingStatus = Pick<MyPrsStatus, 'error' | 'nextAttemptAt' | 'retry' | 'isRefreshing' | 'refreshNotice' | 'configured'>;

export function hasReviewsCountdown(status: ReviewsPollingStatus | null, nowMs: number): boolean {
  return !!status?.error && !status.isRefreshing && typeof status.nextAttemptAt === 'number' && status.nextAttemptAt > nowMs;
}

export function reviewsErrorNotice(status: ReviewsPollingStatus | null, nowMs: number): string | null {
  if (!status?.error) return null;
  const errorText = status.error.trim().replace(/[.!]+$/, '');
  const prefix = `Could not reach GitHub: ${errorText}.`;
  if (status.isRefreshing) return `${prefix} Refreshing.`;
  if (typeof status.nextAttemptAt !== 'number') return prefix;
  const remainingSeconds = Math.max(0, Math.ceil((status.nextAttemptAt - nowMs) / 1000));
  if (remainingSeconds === 0) return `${prefix} Retrying now.`;
  if (status.retry) return `${prefix} Retrying in ${remainingSeconds}s (${status.retry.attempt} of ${status.retry.limit}).`;
  const waitText = remainingSeconds >= 60 ? `${Math.ceil(remainingSeconds / 60)} min` : `${remainingSeconds}s`;
  return `${prefix} Next try in ${waitText}.`;
}

export function reviewsRefreshText(status: ReviewsPollingStatus | null, isPending: boolean, outcomeText: string): string {
  if (status?.refreshNotice && status.isRefreshing) return status.refreshNotice;
  if (isPending || status?.isRefreshing) return 'Refreshing.';
  return outcomeText || status?.refreshNotice || '';
}
