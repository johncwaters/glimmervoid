import { RepositoryCloneJobs } from '#shared/contracts/control/settings-messages.ts';
import type { RepositoryCloneJob } from '#shared/contracts/control/settings-messages.ts';
import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../control-ws.ts';

export type GithubRepo = ServerMessageOf<'github-repos-listed'>['repos'][number];
type GithubRepoListing = { kind: 'listed'; repos: GithubRepo[] } | { kind: 'unreachable' } | { kind: 'failed'; error: string };

const GITHUB_LIST_REPLY_TIMEOUT_MS = 90_000;

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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function requestGithubRepos(): Promise<GithubRepoListing> {
  const reply = await sendControlRequest('list-github-repos', {}, { timeoutMs: GITHUB_LIST_REPLY_TIMEOUT_MS }).catch((error: unknown) => errorText(error));
  if (typeof reply === 'string') return { kind: 'failed', error: `Could not list your GitHub repositories: ${reply}` };
  if (reply.type !== 'github-repos-listed') return { kind: 'failed', error: 'Could not list your GitHub repositories: the server gave no answer' };
  if (reply.source === 'none') return { kind: 'unreachable' };
  if (reply.error) return { kind: 'failed', error: reply.error };
  return { kind: 'listed', repos: reply.repos };
}

export async function requestRepositoryClones(sources: readonly string[]): Promise<string | null> {
  const reply = await sendControlRequest('start-repository-clones', { sources: [...sources] }).catch((error: unknown) => errorText(error));
  if (typeof reply === 'string' || reply.type !== 'repository-clones') return `Could not start the clone: ${typeof reply === 'string' ? reply : 'the server gave no answer'}`;
  applyCloneJobs(reply.jobs);
  return reply.error ?? null;
}
