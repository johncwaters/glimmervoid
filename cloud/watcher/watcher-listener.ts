import http from 'node:http';
import { createRecentRequestIds, signedRequestFromHeaders, verifyRequest } from '../link/core/link-signing-core.ts';
import { AWAKE_USAGE_PATH, CREDENTIALS_PATH, GITHUB_TOKEN_PATH, HEALTH_PATH, HOST_STOP_PATH, MAX_LINK_BODY_BYTES, PROBE_SET_PATH, ProbeSet, STATUS_PATH, WatcherCredentials } from '../../shared/contracts/watcher-link.ts';
import type { AwakeUsage, GithubTokenAnswer, HostStopOutcome } from '../../shared/contracts/watcher-link.ts';
import type { ProbeRunner } from './probe-runner.ts';

const LOOPBACK_HOST = '127.0.0.1';

function readBody(request: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_LINK_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function answer(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function createWatcherListener({ runner, signingKey, stopHost = async () => 'no-adapter', mintGithubToken = async () => ({ grant: null }), awakeUsage = () => null, now = Date.now, log = console }: {
  runner: Pick<ProbeRunner, 'applyProbeSet' | 'applyCredentials' | 'status'>;
  signingKey: Buffer;
  stopHost?: () => Promise<HostStopOutcome>;
  mintGithubToken?: () => Promise<GithubTokenAnswer | null>;
  awakeUsage?: () => AwakeUsage | null;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}) {
  const seenRequestIds = createRecentRequestIds();
  const listenerStartedAtMs = now();

  async function route(method: string, path: string, body: string): Promise<{ status: number; payload: unknown }> {
    if (method === 'POST' && path === PROBE_SET_PATH) {
      const probeSet = ProbeSet.safeParse(jsonOrNull(body));
      if (!probeSet.success) return { status: 400, payload: { error: 'invalid probe set' } };
      await runner.applyProbeSet(probeSet.data);
      return { status: 200, payload: { revision: probeSet.data.revision } };
    }
    if (method === 'POST' && path === CREDENTIALS_PATH) {
      const credentials = WatcherCredentials.safeParse(jsonOrNull(body));
      if (!credentials.success) return { status: 400, payload: { error: 'invalid credentials' } };
      await runner.applyCredentials(credentials.data);
      return { status: 200, payload: {} };
    }
    if (method === 'GET' && path === STATUS_PATH) return { status: 200, payload: runner.status() };
    if (method === 'GET' && path === AWAKE_USAGE_PATH) return { status: 200, payload: { awakeUsage: awakeUsage() } };
    if (method === 'POST' && path === HOST_STOP_PATH) {
      const outcome = await stopHost();
      return { status: outcome === 'stopping' ? 202 : 200, payload: { outcome } };
    }
    if (method === 'POST' && path === GITHUB_TOKEN_PATH) {
      const tokenAnswer = await mintGithubToken();
      if (tokenAnswer === null) return { status: 503, payload: { error: 'GitHub token mint failed' } };
      return { status: 200, payload: tokenAnswer };
    }
    return { status: 404, payload: { error: 'not found' } };
  }

  async function handleSigned(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const method = request.method ?? '';
    const path = new URL(request.url ?? '/', 'http://watcher').pathname;
    if (method === 'GET' && path === HEALTH_PATH) {
      answer(response, 200, { ok: true });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      answer(response, 413, { error: 'body too large' });
      return;
    }
    const signedRequest = signedRequestFromHeaders(request.headers, method, path, body);
    const verdict = verifyRequest(signingKey, signedRequest, now(), seenRequestIds);
    if (!verdict.ok) {
      log.warn(`[watcher] refused ${method} ${path}: ${verdict.reason}`);
      answer(response, 401, { error: 'unauthorized' });
      return;
    }
    if (path === HOST_STOP_PATH && signedRequest.timestampMs < listenerStartedAtMs) {
      log.warn(`[watcher] refused ${method} ${path}: signed before this watcher started`);
      answer(response, 401, { error: 'unauthorized' });
      return;
    }
    const routed = await route(method, path, body);
    answer(response, routed.status, routed.payload);
  }

  function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    return handleSigned(request, response).catch((handleError: unknown) => {
      log.warn(`[watcher] request failed: ${(handleError as Error).message}`);
      if (!response.headersSent) answer(response, 500, { error: 'watcher error' });
    });
  }

  const server = http.createServer((request, response) => void handle(request, response));

  function listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, LOOPBACK_HOST, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { handle, listen, close };
}

export { createWatcherListener };
