import type { MyPrsStatus } from '#shared/contracts/my-prs.ts';

export type GithubPollingStatus = Pick<MyPrsStatus, 'error' | 'nextAttemptAt' | 'retry' | 'isRefreshing' | 'refreshNotice' | 'configured'>;

export function hasGithubPollingCountdown(status: GithubPollingStatus | null, nowMs: number): boolean {
  return !!status?.error && !status.isRefreshing && typeof status.nextAttemptAt === 'number' && status.nextAttemptAt > nowMs;
}

export function githubPollingErrorNotice(status: GithubPollingStatus | null, nowMs: number): string | null {
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

export function githubPollingRefreshText(status: GithubPollingStatus | null, isPending: boolean, outcomeText: string): string {
  if (status?.refreshNotice && status.isRefreshing) return status.refreshNotice;
  if (isPending || status?.isRefreshing) return 'Refreshing.';
  return outcomeText || status?.refreshNotice || '';
}
