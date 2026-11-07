import http from 'node:http';
import { createRecentRequestIds, signedRequestFromHeaders, verifyRequest } from '../link/core/link-signing-core.ts';
import { CREDENTIALS_PATH, HEALTH_PATH, MAX_LINK_BODY_BYTES, PROBE_SET_PATH, ProbeSet, STATUS_PATH, WatcherCredentials } from '../../shared/contracts/watcher-link.ts';
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

function createWatcherListener({ runner, signingKey, now = Date.now, log = console }: {
  runner: Pick<ProbeRunner, 'applyProbeSet' | 'applyCredentials' | 'status'>;
  signingKey: Buffer;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}) {
  const seenRequestIds = createRecentRequestIds();

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
    return { status: 404, payload: { error: 'not found' } };
  }

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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
    const verdict = verifyRequest(signingKey, signedRequestFromHeaders(request.headers, method, path, body), now(), seenRequestIds);
    if (!verdict.ok) {
      log.warn(`[watcher] refused ${method} ${path}: ${verdict.reason}`);
      answer(response, 401, { error: 'unauthorized' });
      return;
    }
    const routed = await route(method, path, body);
    answer(response, routed.status, routed.payload);
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((handleError: unknown) => {
      log.warn(`[watcher] request failed: ${(handleError as Error).message}`);
      if (!response.headersSent) answer(response, 500, { error: 'watcher error' });
    });
  });

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

  return { listen, close };
}

export { createWatcherListener };
