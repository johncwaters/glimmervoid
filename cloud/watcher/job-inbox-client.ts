import { WatcherJobAck } from '../../shared/contracts/watcher-jobs.ts';
import { WatcheeSettingsReply } from '../../shared/contracts/watchee-settings.ts';
import { isRecord } from '../../shared/coerce.ts';
import { errorMessage } from '../../shared/text.ts';
import { classifyInboxReply, deliveryRetryDelayMs, describeRefusal } from './core/watcher-core.ts';

const REQUEST_TIMEOUT_MS = 10_000;

type Delivery = { ok: true; ack: WatcherJobAck } | { ok: false; reason: string };

function describeUnreachable(error: unknown): string {
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : null;
  const causeCode = cause !== null && typeof cause.code === 'string' ? cause.code : null;
  return `inbox unreachable: ${causeCode ?? errorMessage(error)}`;
}

function replyErrorOf(replyBody: unknown): string | null {
  if (!isRecord(replyBody) || typeof replyBody.error !== 'string') return null;
  return replyBody.error;
}

function parseReplyText(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function postJobOnce(jobsUrl: string, token: string, job: { jobId: string }): Promise<{ status: number; replyBody: unknown } | Error> {
  try {
    const response = await fetch(jobsUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, replyBody: parseReplyText(await response.text()) };
  } catch (error) {
    return asError(error);
  }
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function sendJob({ jobsUrl, token, job, maxAttempts }: {
  jobsUrl: string;
  token: string;
  job: { jobId: string };
  maxAttempts: number;
}): Promise<Delivery> {
  let lastFailureReason = 'no delivery attempt was made';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) await waitMs(deliveryRetryDelayMs(attempt - 1, Math.random));
    const reply = await postJobOnce(jobsUrl, token, job);
    if (reply instanceof Error) {
      lastFailureReason = describeUnreachable(reply);
      continue;
    }
    const { status, replyBody } = reply;
    const outcome = classifyInboxReply(status);
    if (outcome === 'retry') {
      lastFailureReason = describeRefusal(status, replyErrorOf(replyBody));
      continue;
    }
    if (outcome === 'refused') return { ok: false, reason: describeRefusal(status, replyErrorOf(replyBody)) };
    const ack = WatcherJobAck.safeParse(replyBody);
    if (!ack.success || ack.data.jobId !== job.jobId) return { ok: false, reason: 'the inbox sent a malformed ack' };
    return { ok: true, ack: ack.data };
  }
  return { ok: false, reason: lastFailureReason };
}

async function fetchWatcheeSettings({ settingsUrl, token }: { settingsUrl: string; token: string }): Promise<{ ok: true; reply: WatcheeSettingsReply } | { ok: false; reason: string }> {
  try {
    const response = await fetch(settingsUrl, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const replyBody = parseReplyText(await response.text());
    if (!response.ok) return { ok: false, reason: `the inbox answered ${response.status}: ${replyErrorOf(replyBody) ?? 'no reason given'}` };
    const reply = WatcheeSettingsReply.safeParse(replyBody);
    if (!reply.success) return { ok: false, reason: 'the inbox sent malformed watchee settings' };
    return { ok: true, reply: reply.data };
  } catch (error) {
    return { ok: false, reason: describeUnreachable(error) };
  }
}

export { fetchWatcheeSettings, sendJob };
