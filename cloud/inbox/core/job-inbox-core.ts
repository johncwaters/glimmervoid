import { decideBindHost } from '../../../server/core/remote-config.ts';
import { tokensMatch } from '../../../server/core/agent-api-core.ts';
import { WATCHER_JOB_PAYLOADS, WatcherJobEnvelope, isWatcherJobKind } from '../../../shared/contracts/watcher-jobs.ts';
import type { ParsedWatcherJob, WatcherJobKind, WatcherJobOfKind } from '../../../shared/contracts/watcher-jobs.ts';

const BEARER_PREFIX = 'Bearer ';
const ANY_FREE_PORT = 0;

type InboxBindDecision =
  | { listen: false; reason: string | null }
  | { listen: true; host: string; port: number; tokenSource: 'env' | 'per-boot' };

function decideInboxBind({ autoStart, inboxHost, inboxPort, envToken }: {
  autoStart: boolean;
  inboxHost: string | null;
  inboxPort: number | null;
  envToken: string | null;
}): InboxBindDecision {
  const hasEnvToken = envToken !== null && envToken !== '';
  const bind = decideBindHost({ envHost: inboxHost ?? '', insecureBind: hasEnvToken });
  if (!bind.allowed) return { listen: false, reason: `refusing inbox bind ${bind.host}: set GLIMMERVOID_WATCHER_TOKEN` };
  if (hasEnvToken) {
    if (inboxPort === null) return { listen: false, reason: 'GLIMMERVOID_WATCHER_TOKEN is set but watcher.inboxPort is not' };
    return { listen: true, host: bind.host, port: inboxPort, tokenSource: 'env' };
  }
  if (!autoStart) return { listen: false, reason: null };
  return { listen: true, host: bind.host, port: inboxPort ?? ANY_FREE_PORT, tokenSource: 'per-boot' };
}

function authorizeInboxRequest(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith(BEARER_PREFIX)) return false;
  if (expectedToken === '') return false;
  return tokensMatch(authorizationHeader.slice(BEARER_PREFIX.length), expectedToken);
}

function parseWatcherJob(body: unknown): { ok: true; job: ParsedWatcherJob } | { ok: false; reason: string } {
  const envelope = WatcherJobEnvelope.safeParse(body);
  if (!envelope.success) return { ok: false, reason: 'the job envelope is malformed' };
  const { jobId, kind, payload } = envelope.data;
  if (!isWatcherJobKind(kind)) return { ok: false, reason: `unknown job kind ${kind}` };
  const job = parsedJobOfKind(jobId, kind, payload);
  if (job === null) return { ok: false, reason: `the ${kind} payload is malformed` };
  return { ok: true, job };
}

function parsedJobOfKind<Kind extends WatcherJobKind>(jobId: string, kind: Kind, payload: unknown): WatcherJobOfKind<Kind> | null {
  const parsed = WATCHER_JOB_PAYLOADS[kind].safeParse(payload);
  return parsed.success ? { jobId, kind, payload: parsed.data } : null;
}

function createRecentJobIds(capacity: number): { hasSeen(jobId: string): boolean; remember(jobId: string): void } {
  const rememberedJobIds = new Set<string>();
  return {
    hasSeen: (jobId) => rememberedJobIds.has(jobId),
    remember(jobId) {
      rememberedJobIds.add(jobId);
      if (rememberedJobIds.size <= capacity) return;
      const oldestJobId = rememberedJobIds.values().next().value;
      if (oldestJobId !== undefined) rememberedJobIds.delete(oldestJobId);
    },
  };
}

export { authorizeInboxRequest, createRecentJobIds, decideInboxBind, parseWatcherJob };
export type { InboxBindDecision };
