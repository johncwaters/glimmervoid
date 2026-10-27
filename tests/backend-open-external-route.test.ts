import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackendHttpApp } from '../server/backend/backend-http.ts';
import type { BackendHttpDependencies } from '../server/backend/backend-http.ts';
import { MAX_EXTERNAL_URL_LENGTH } from '../server/core/open-external-core.ts';
import type { HostOpenOutcome } from '../server/host-url-opener.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const PAGE_TOKEN = 'open-external-page-token';

function appDependencies(overrides: Partial<BackendHttpDependencies>): BackendHttpDependencies {
  return {
    staticDir: null,
    configStore: { configPath: path.join(os.tmpdir(), 'glimmervoid-open-external-config.json') },
    remote: { allowedOrigins: [] },
    remoteAuth: null,
    allowedHosts: [],
    listenerPortsFor: (socket) => (typeof socket?.localPort === 'number' ? [socket.localPort] : []),
    pageToken: PAGE_TOKEN,
    tokenMatches: (presented) => presented === PAGE_TOKEN,
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: () => null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    logger: { warn: () => {} },
    ...overrides,
  };
}

async function startApp(overrides: Partial<BackendHttpDependencies>): Promise<{ server: Server; base: string }> {
  const server = http.createServer(createBackendHttpApp(appDependencies(overrides)));
  await listenOnLoopback(server);
  return { server, base: `http://127.0.0.1:${boundPort(server)}` };
}

async function stopApp(server: Server): Promise<void> {
  server.closeAllConnections();
  await closeServer(server);
}

function postOpenExternal(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/open-external`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-glimmervoid-page-token': PAGE_TOKEN, ...headers },
    body: JSON.stringify(body),
  });
}

test('a loopback page with its own origin and the page token opens an https url on the host', async () => {
  const openedUrls: string[] = [];
  const { server, base } = await startApp({
    openUrlOnHost: async (url) => { openedUrls.push(url); return 'opened'; },
  });
  try {
    const response = await postOpenExternal(base, { url: 'https://github.com/owner/repo/pull/7' });
    assert.equal(response.status, 204);
    assert.deepEqual(openedUrls, ['https://github.com/owner/repo/pull/7']);
  } finally {
    await stopApp(server);
  }
});

test('the route refuses a missing origin, a foreign origin, and a missing or wrong page token', async () => {
  const openedUrls: string[] = [];
  const { server, base } = await startApp({
    openUrlOnHost: async (url) => { openedUrls.push(url); return 'opened'; },
  });
  try {
    const url = 'https://example.com/';
    const foreignOrigin = await postOpenExternal(base, { url }, { origin: 'http://localhost:5999' });
    assert.equal(foreignOrigin.status, 403);
    const evilOrigin = await postOpenExternal(base, { url }, { origin: 'https://evil.example' });
    assert.equal(evilOrigin.status, 403);
    const wrongToken = await postOpenExternal(base, { url }, { 'x-glimmervoid-page-token': 'guess' });
    assert.equal(wrongToken.status, 403);
    const noOrigin = await fetch(`${base}/open-external`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-glimmervoid-page-token': PAGE_TOKEN },
      body: JSON.stringify({ url }),
    });
    assert.equal(noOrigin.status, 403);
    assert.deepEqual(openedUrls, []);
  } finally {
    await stopApp(server);
  }
});

test('the route refuses non-http schemes, relative, malformed and overlong urls with 400', async () => {
  const openedUrls: string[] = [];
  const { server, base } = await startApp({
    openUrlOnHost: async (url) => { openedUrls.push(url); return 'opened'; },
  });
  try {
    const refusedUrls: unknown[] = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'vscode://settings',
      'x-apple.systempreferences:com.apple.preference',
      '/relative/path',
      'not a url',
      '',
      42,
      null,
      `https://example.com/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`,
    ];
    for (const url of refusedUrls) {
      const response = await postOpenExternal(base, { url });
      assert.equal(response.status, 400, `refused ${String(url).slice(0, 40)}`);
    }
    assert.deepEqual(openedUrls, []);
  } finally {
    await stopApp(server);
  }
});

test('a request on the remote listener port is refused even though it arrives on loopback', async () => {
  const openedUrls: string[] = [];
  const server = http.createServer();
  await listenOnLoopback(server);
  const port = boundPort(server);
  server.on('request', createBackendHttpApp(appDependencies({
    remoteListenerPort: port,
    openUrlOnHost: async (url) => { openedUrls.push(url); return 'opened'; },
  })));
  try {
    const response = await postOpenExternal(`http://127.0.0.1:${port}`, { url: 'https://example.com/' });
    assert.equal(response.status, 403);
    assert.deepEqual(openedUrls, []);
  } finally {
    await stopApp(server);
  }
});

test('a request arriving off loopback is refused 403', async () => {
  const openedUrls: string[] = [];
  const app = createBackendHttpApp(appDependencies({
    openUrlOnHost: async (url) => { openedUrls.push(url); return 'opened'; },
  }));
  const server = http.createServer((request, response) => {
    Object.defineProperty(request.socket, 'remoteAddress', { value: '203.0.113.10' });
    app(request, response);
  });
  await listenOnLoopback(server);
  try {
    const response = await postOpenExternal(`http://127.0.0.1:${boundPort(server)}`, { url: 'https://example.com/' });
    assert.equal(response.status, 403);
    await response.text();
    assert.deepEqual(openedUrls, []);
  } finally {
    await stopApp(server);
  }
});

test('a host that cannot open the link answers non-2xx so the page falls back', async () => {
  const outcomes: HostOpenOutcome[] = ['unsupported-platform', 'spawn-failed'];
  for (const outcome of outcomes) {
    const { server, base } = await startApp({ openUrlOnHost: async () => outcome });
    try {
      const response = await postOpenExternal(base, { url: 'https://example.com/' });
      assert.equal(response.ok, false, outcome);
      assert.equal(response.status >= 500, true, outcome);
    } finally {
      await stopApp(server);
    }
  }
});

test('the route never wires up without a token check', async () => {
  const openedUrls: string[] = [];
  const { tokenMatches: _unused, ...withoutTokenCheck } = appDependencies({
    openUrlOnHost: async (url) => { openedUrls.push(url); return 'opened'; },
  });
  const server = http.createServer(createBackendHttpApp(withoutTokenCheck));
  await listenOnLoopback(server);
  const base = `http://127.0.0.1:${boundPort(server)}`;
  try {
    const response = await postOpenExternal(base, { url: 'https://example.com/' });
    assert.equal(response.status, 403);
    assert.deepEqual(openedUrls, []);
  } finally {
    await stopApp(server);
  }
});
