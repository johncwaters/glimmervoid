import { z } from 'zod';
import { TeamReviewCandidatesPayload } from './team-review-candidates.ts';

const WATCHER_JOB_VERSION = 1;
export const WATCHER_JOB_MAX_BYTES = 1024 * 1024;
export const WATCHER_JOBS_PATH = '/jobs';

export const WATCHER_JOB_KINDS = Object.freeze({
  ping: z.object({}).strict(),
  'team-review.candidates': TeamReviewCandidatesPayload,
});

export type WatcherJobKind = keyof typeof WATCHER_JOB_KINDS;
export type WatcheeJobKind = Exclude<WatcherJobKind, 'ping'>;
export type WatcherJobPayload<Kind extends WatcherJobKind> = z.infer<(typeof WATCHER_JOB_KINDS)[Kind]>;

export const WatcherJobEnvelope = z.object({
  version: z.literal(WATCHER_JOB_VERSION),
  jobId: z.uuid(),
  sentAt: z.iso.datetime(),
  kind: z.string().min(1),
  payload: z.unknown(),
}).strict();

export const WatcherJobAck = z.object({
  jobId: z.uuid(),
  status: z.enum(['accepted', 'duplicate']),
}).strict();

export type WatcherJobAck = z.infer<typeof WatcherJobAck>;

export type ParsedWatcherJob = {
  [Kind in WatcherJobKind]: { jobId: string; kind: Kind; payload: z.infer<(typeof WATCHER_JOB_KINDS)[Kind]> };
}[WatcherJobKind];

export function isWatcherJobKind(kind: string): kind is WatcherJobKind {
  return Object.hasOwn(WATCHER_JOB_KINDS, kind);
}
