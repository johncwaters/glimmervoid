import type { IncomingMessage, ServerResponse } from 'node:http';
import { WATCHER_JOB_MAX_BYTES, WATCHER_JOBS_PATH } from '../../shared/contracts/watcher-jobs.ts';
import type { WatcherJobAck, WatcherJobKind, WatcherJobOfKind } from '../../shared/contracts/watcher-jobs.ts';
import { WATCHEE_SETTINGS_PATH } from '../../shared/contracts/watchee-settings.ts';
import type { WatcheeSettingsReply } from '../../shared/contracts/watchee-settings.ts';
import { errorMessage } from '../../shared/text.ts';
import { authorizeInboxRequest, createRecentJobIds, parseWatcherJob } from './core/job-inbox-core.ts';

const RECENT_JOB_ID_CAPACITY = 1000;

type WatcherJobHandlers = { [Kind in WatcherJobKind]: (job: WatcherJobOfKind<Kind>) => Promise<void> };

const OVERSIZED_BODY_MESSAGE = 'the job is over 1 MiB';

function isOversizedBodyError(error: unknown): boolean {
  return error instanceof Error && error.message === OVERSIZED_BODY_MESSAGE;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > WATCHER_JOB_MAX_BYTES) {
        request.removeAllListeners('data');
        request.resume();
        reject(new Error(OVERSIZED_BODY_MESSAGE));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function runJob<Kind extends WatcherJobKind>(handlers: WatcherJobHandlers, job: WatcherJobOfKind<Kind>): Promise<void> {
  const handler: (job: WatcherJobOfKind<Kind>) => Promise<void> = handlers[job.kind];
  return handler(job);
}

function createJobInboxRequestHandler({ token, handlers, watcheeSettings = () => null, log = console }: {
  token: string;
  handlers: WatcherJobHandlers;
  watcheeSettings?: () => WatcheeSettingsReply | null;
  log?: Pick<Console, 'warn'>;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const recentJobIds = createRecentJobIds(RECENT_JOB_ID_CAPACITY);
  const inFlightJobIds = new Set<string>();

  function ackFor(jobId: string, status: WatcherJobAck['status']): WatcherJobAck {
    const settingsRevision = watcheeSettings()?.revision;
    return settingsRevision === undefined ? { jobId, status } : { jobId, status, settingsRevision };
  }

  function isInboxRoute(request: IncomingMessage): boolean {
    if (request.method === 'POST' && request.url === WATCHER_JOBS_PATH) return true;
    return request.method === 'GET' && request.url === WATCHEE_SETTINGS_PATH;
  }

  function sendWatcheeSettings(response: ServerResponse): void {
    const published = watcheeSettings();
    if (published === null) {
      sendJson(response, 503, { error: 'the server has not published watchee settings yet' });
      return;
    }
    sendJson(response, 200, published);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isInboxRoute(request)) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    if (!authorizeInboxRequest(request.headers.authorization, token)) {
      sendJson(response, 401, { error: 'missing or wrong watcher token' });
      return;
    }
    if (request.method === 'GET') {
      sendWatcheeSettings(response);
      return;
    }
    const body = await readBody(request);
    const parsed = parseWatcherJob(parseJsonBody(body));
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.reason });
      return;
    }
    const { job } = parsed;
    if (recentJobIds.hasSeen(job.jobId)) {
      sendJson(response, 200, ackFor(job.jobId, 'duplicate'));
      return;
    }
    if (inFlightJobIds.has(job.jobId)) {
      sendJson(response, 409, { error: `the ${job.kind} job is still running; retry later` });
      return;
    }
    inFlightJobIds.add(job.jobId);
    try {
      await runJob(handlers, job);
    } catch (error) {
      log.warn(`[job-inbox] ${job.kind} job ${job.jobId} failed: ${errorMessage(error)}`);
      sendJson(response, 500, { error: `the ${job.kind} job failed` });
      return;
    } finally {
      inFlightJobIds.delete(job.jobId);
    }
    recentJobIds.remember(job.jobId);
    sendJson(response, 200, ackFor(job.jobId, 'accepted'));
  }

  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      if (isOversizedBodyError(error)) {
        response.setHeader('connection', 'close');
        sendJson(response, 413, { error: OVERSIZED_BODY_MESSAGE });
        return;
      }
      sendJson(response, 400, { error: 'the job could not be read' });
    });
  };
}

export { createJobInboxRequestHandler };
export type { WatcherJobHandlers };
