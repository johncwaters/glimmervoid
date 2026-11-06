import type { IncomingMessage, ServerResponse } from 'node:http';
import { WATCHER_JOB_MAX_BYTES, WATCHER_JOBS_PATH } from '../../shared/contracts/watcher-jobs.ts';
import type { ParsedWatcherJob, WatcherJobAck, WatcherJobKind } from '../../shared/contracts/watcher-jobs.ts';
import { errorMessage } from '../../shared/text.ts';
import { authorizeInboxRequest, createRecentJobIds, parseWatcherJob } from './core/job-inbox-core.ts';

const RECENT_JOB_ID_CAPACITY = 1000;

type WatcherJobHandlers = { [Kind in WatcherJobKind]: (job: Extract<ParsedWatcherJob, { kind: Kind }>) => Promise<void> };

const BUILT_IN_JOB_HANDLERS: WatcherJobHandlers = Object.freeze({
  ping: async () => {},
});

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

function runJob(handlers: WatcherJobHandlers, job: ParsedWatcherJob): Promise<void> {
  switch (job.kind) {
    case 'ping': return handlers.ping(job);
  }
}

function createJobInboxRequestHandler({ token, handlers = BUILT_IN_JOB_HANDLERS, log = console }: {
  token: string;
  handlers?: WatcherJobHandlers;
  log?: Pick<Console, 'warn'>;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const recentJobIds = createRecentJobIds(RECENT_JOB_ID_CAPACITY);
  const inFlightJobIds = new Set<string>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== WATCHER_JOBS_PATH) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    if (!authorizeInboxRequest(request.headers.authorization, token)) {
      sendJson(response, 401, { error: 'missing or wrong watcher token' });
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
      sendJson(response, 200, { jobId: job.jobId, status: 'duplicate' } satisfies WatcherJobAck);
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
    sendJson(response, 200, { jobId: job.jobId, status: 'accepted' } satisfies WatcherJobAck);
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
