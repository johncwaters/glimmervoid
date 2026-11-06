import { nextBackoffMs } from '../../../shared/backoff.ts';
import { isLoopbackHostname } from '../../../shared/loopback-hosts.ts';
import { WATCHER_JOBS_PATH } from '../../../shared/contracts/watcher-jobs.ts';

const DELIVERY_RETRY_BASE_MS = 1000;
const DELIVERY_RETRY_MAX_MS = 30_000;
const STATUS_ACKED = 200;
const STATUS_STILL_RUNNING = 409;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_UNAUTHORIZED = 401;
const FIRST_SERVER_ERROR_STATUS = 500;

type InboxReplyOutcome = 'acked' | 'retry' | 'refused';

function classifyInboxReply(status: number): InboxReplyOutcome {
  if (status === STATUS_ACKED) return 'acked';
  if (status === STATUS_STILL_RUNNING || status === STATUS_TOO_MANY_REQUESTS || status >= FIRST_SERVER_ERROR_STATUS) return 'retry';
  return 'refused';
}

function describeRefusal(status: number, replyError: string | null): string {
  if (status === STATUS_UNAUTHORIZED) return `inbox refused the token (${status})`;
  if (replyError === null) return `inbox refused the job (${status})`;
  return `inbox refused the job (${status}): ${replyError}`;
}

function deliveryRetryDelayMs(attempt: number, random: () => number): number {
  return nextBackoffMs({ attempt, baseMs: DELIVERY_RETRY_BASE_MS, maxMs: DELIVERY_RETRY_MAX_MS, jitter: 'half', random });
}

function parseInboxUrl(rawInboxUrl: string | null): { ok: true; jobsUrl: string } | { ok: false; reason: string } {
  if (rawInboxUrl === null || rawInboxUrl === '') return { ok: false, reason: 'pass --inbox <url>, for example --inbox http://127.0.0.1:7700' };
  if (!URL.canParse(rawInboxUrl)) return { ok: false, reason: `--inbox ${rawInboxUrl} is not a URL` };
  const inboxUrl = new URL(rawInboxUrl);
  if (inboxUrl.protocol !== 'http:' && inboxUrl.protocol !== 'https:') return { ok: false, reason: `--inbox must be an http or https URL, not ${inboxUrl.protocol}` };
  if (inboxUrl.protocol === 'http:' && !isLoopbackHostname(inboxUrl.hostname)) {
    return { ok: false, reason: `--inbox ${rawInboxUrl} would send the watcher token unencrypted; use https for a host other than this machine` };
  }
  return { ok: true, jobsUrl: new URL(WATCHER_JOBS_PATH, inboxUrl).href };
}

function createPingJob(jobId: string, sentAt: Date) {
  return { version: 1, jobId, sentAt: sentAt.toISOString(), kind: 'ping', payload: {} } as const;
}

export { classifyInboxReply, createPingJob, deliveryRetryDelayMs, describeRefusal, parseInboxUrl };
