import type { RepositoryCloneJob } from '../../shared/contracts/control/settings-messages.ts';

const MAX_CONCURRENT_CLONES = 2;
const CLONE_PROGRESS_RE = /^(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/;
const LINE_BREAKS_RE = /[\r\n]+/;
const NAME_SEPARATORS_RE = /[/:]/;
const GIT_SUFFIX_RE = /\.git$/;
const IN_FLIGHT_FOLDER_PREFIX = '.glimmervoid-clone-';
const IN_FLIGHT_FOLDER_RE = /^\.glimmervoid-clone-(\d+)-([0-9a-f]+)-./;

function cloneProgressOf(stderrTail: string): string {
  const latestLine = stderrTail.split(LINE_BREAKS_RE).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  const progress = CLONE_PROGRESS_RE.exec(latestLine);
  return progress ? `${progress[1]} ${progress[2]}%` : '';
}

function cloneJobNameOf(repositoryUrl: string): string {
  return repositoryUrl.replace(GIT_SUFFIX_RE, '').split(NAME_SEPARATORS_RE).filter(Boolean).slice(-2).join('/');
}

function sourcesToStart(jobs: readonly Pick<RepositoryCloneJob, 'source' | 'state'>[]): string[] {
  const freeSlots = MAX_CONCURRENT_CLONES - jobs.filter((job) => job.state === 'cloning').length;
  return jobs.filter((job) => job.state === 'queued').slice(0, Math.max(0, freeSlots)).map((job) => job.source);
}

type InFlightCloneOwner = { pid: number; runId: string };
type InFlightCloneFolder = { owner: InFlightCloneOwner; ageMs: number };

function inFlightCloneFolderName(owner: InFlightCloneOwner, repoName: string): string {
  return `${IN_FLIGHT_FOLDER_PREFIX}${owner.pid}-${owner.runId}-${repoName}`;
}

function inFlightCloneOwnerOf(folderName: string): InFlightCloneOwner | null {
  const named = IN_FLIGHT_FOLDER_RE.exec(folderName);
  return named ? { pid: Number(named[1]), runId: named[2] } : null;
}

function isInterruptedClone(folder: InFlightCloneFolder, thisRun: InFlightCloneOwner, { isOwnerRunning, longestCloneMs }: { isOwnerRunning: boolean; longestCloneMs: number }): boolean {
  if (folder.owner.runId === thisRun.runId) return false;
  if (folder.owner.pid === thisRun.pid) return true;
  return !isOwnerRunning || folder.ageMs > longestCloneMs;
}

export { cloneJobNameOf, cloneProgressOf, inFlightCloneFolderName, inFlightCloneOwnerOf, isInterruptedClone, sourcesToStart };
export type { InFlightCloneOwner };
