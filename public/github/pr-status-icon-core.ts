export type PrStatusIcon =
  | 'merged' | 'draft' | 'conflict' | 'behind' | 'failed' | 'running' | 'passed' | 'ready' | 'changes-requested'
  | 'thread' | 'reviewer' | 'your-turn' | 'queued' | 'fork' | 'discarded' | 'stale' | 'unknown' | 'none';

export interface PrStatusLegendEntry { label: string; meaning: string }

export const PR_STATUS_LEGEND: Readonly<Record<PrStatusIcon, PrStatusLegendEntry>> = {
  ready: { label: 'Ready', meaning: 'Ready to merge, or nothing left for you to do.' },
  passed: { label: 'Passed', meaning: 'Checks passing, approved, or nothing open.' },
  failed: { label: 'Failed', meaning: 'Checks failing, an automated review failed, or an auto-rebase failed.' },
  conflict: { label: 'Conflict', meaning: 'Merge conflicts with the base branch.' },
  'your-turn': { label: 'Your turn', meaning: 'Waiting on you: a review to give or a thread to answer.' },
  'changes-requested': { label: 'Changes', meaning: 'A reviewer requested changes.' },
  thread: { label: 'Threads', meaning: 'Unresolved review threads or comments.' },
  behind: { label: 'Behind', meaning: 'The branch is behind its base.' },
  stale: { label: 'Out of date', meaning: 'New commits landed since the automated review.' },
  fork: { label: 'Fork', meaning: 'Opened from a fork, so it is reviewed by hand.' },
  running: { label: 'Running', meaning: 'Checks or an automated review in progress.' },
  reviewer: { label: 'Reviewer', meaning: 'Waiting on a reviewer.' },
  queued: { label: 'Queued', meaning: 'Waiting for an automated review slot.' },
  draft: { label: 'Draft', meaning: 'Still a draft.' },
  merged: { label: 'Merged', meaning: 'Merged.' },
  discarded: { label: 'Discarded', meaning: 'Review discarded or dismissed.' },
  unknown: { label: 'Unknown', meaning: 'GitHub has not computed this yet.' },
  none: { label: 'None', meaning: 'Nothing applies, such as no checks or no review requested.' },
};
