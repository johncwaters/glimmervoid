import { RepositoryCloneJobs } from '#shared/contracts/control/settings-messages.ts';
import type { RepositoryCloneJob } from '#shared/contracts/control/settings-messages.ts';

let latestCloneJobs: RepositoryCloneJob[] = [];
const cloneJobListeners = new Set<() => void>();
const cloneJobsSettledListeners = new Set<() => void>();

export function isCloneJobUnsettled(job: RepositoryCloneJob | null): boolean {
  return job?.state === 'queued' || job?.state === 'cloning';
}

export function applyCloneJobs(jobs: unknown) {
  const parsed = RepositoryCloneJobs.safeParse(jobs);
  if (!parsed.success) return;
  const wereUnsettled = hasUnsettledCloneJobs();
  latestCloneJobs = parsed.data;
  for (const listener of cloneJobListeners) listener();
  if (!wereUnsettled || hasUnsettledCloneJobs()) return;
  for (const listener of cloneJobsSettledListeners) listener();
}

export function cloneJobOf(source: string): RepositoryCloneJob | null {
  return latestCloneJobs.find((job) => job.source === source) ?? null;
}

export function clonedSources(): string[] {
  return latestCloneJobs.filter((job) => job.state === 'done').map((job) => job.source);
}

export function hasUnsettledCloneJobs(): boolean {
  return latestCloneJobs.some(isCloneJobUnsettled);
}

export function onCloneJobsChanged(listener: () => void): () => void {
  cloneJobListeners.add(listener);
  return () => { cloneJobListeners.delete(listener); };
}

export function onCloneJobsSettled(listener: () => void) {
  cloneJobsSettledListeners.add(listener);
}

export function cloneJobStatusText(job: RepositoryCloneJob | null): string {
  if (job === null) return '';
  if (job.state === 'queued') return 'Queued';
  if (job.state === 'cloning') return job.progress || 'Starting';
  if (job.state === 'done') return 'Cloned';
  if (job.state === 'cancelled') return 'Cancelled';
  return job.error ?? 'The clone failed.';
}
