import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Server } from 'node:http';

import { createBackendHttpApp } from '../server/backend-http.ts';
import type { BackendHttpDependencies } from '../server/backend-http.ts';
import { decideOpenExternalRequest, MAX_EXTERNAL_URL_LENGTH, parseOpenableUrl } from '../server/core/open-external-core.ts';
import { createHostUrlOpener } from '../server/host-url-opener.ts';
import type { HostOpenOutcome } from '../server/host-url-opener.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const PAGE_TOKEN = 'open-external-page-token';

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

type OpenerRun = { exitCode: number } | 'spawn-error';

function fakeChildProcess(run: OpenerRun): ChildProcess {
  const child = Object.assign(new EventEmitter(), { unref: () => {} });
  queueMicrotask(() => {
    if (run === 'spawn-error') {
      child.emit('error', new Error('ENOENT'));
      return;
    }
    child.emit('spawn');
    child.emit('exit', run.exitCode, null);
  });
  return child as EventEmitter & ChildProcess;
}

function recordingSpawn(calls: SpawnCall[], run: OpenerRun = { exitCode: 0 }) {
  return (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options });
    return fakeChildProcess(run);
  };
}

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

function offLoopbackEndpoint(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\glimmervoid-open-external-${process.pid}`;
  return path.join(os.tmpdir(), `glimmervoid-open-external-${process.pid}.sock`);
}

function postOverEndpoint(endpoint: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: endpoint,
        path: '/open-external',
        method: 'POST',
        headers: { host: 'localhost', origin: 'http://localhost', 'x-glimmervoid-page-token': PAGE_TOKEN },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ url: 'https://example.com/' }));
  });
}

test('a request arriving off loopback is refused 403', async () => {
  const openedUrls: string[] = [];
  const endpoint = offLoopbackEndpoint();
  fs.rmSync(endpoint, { force: true });
  const server = http.createServer(createBackendHttpApp(appDependencies({
    listenerPortsFor: () => [80],
    openUrlOnHost: async (url) => { openedUrls.push(url); return 'opened'; },
  })));
  await new Promise<void>((resolve) => { server.listen(endpoint, () => resolve()); });
  try {
    assert.equal(await postOverEndpoint(endpoint), 403);
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

test('the host opener spawns open on darwin with the url as its own argument', async () => {
  const calls: SpawnCall[] = [];
  const openUrlOnHost = createHostUrlOpener({ platform: 'darwin', spawnProcess: recordingSpawn(calls) });
  assert.equal(await openUrlOnHost('https://example.com/a?b=1&c=$(id)'), 'opened');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'open');
  assert.deepEqual(calls[0].args, ['https://example.com/a?b=1&c=$(id)']);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.detached, true);
});

test('the host opener spawns xdg-open on linux with the url as its own argument', async () => {
  const calls: SpawnCall[] = [];
  const openUrlOnHost = createHostUrlOpener({ platform: 'linux', spawnProcess: recordingSpawn(calls) });
  assert.equal(await openUrlOnHost('http://localhost:8080/'), 'opened');
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'xdg-open', args: ['http://localhost:8080/'] },
  ]);
  assert.equal(calls[0].options.shell, undefined);
});

test('the host opener spawns nothing on an unsupported platform', async () => {
  const calls: SpawnCall[] = [];
  const openUrlOnHost = createHostUrlOpener({ platform: 'win32', spawnProcess: recordingSpawn(calls) });
  assert.equal(await openUrlOnHost('https://example.com/'), 'unsupported-platform');
  assert.deepEqual(calls, []);
});

test('the host opener reports a spawn error instead of throwing', async () => {
  const calls: SpawnCall[] = [];
  const openUrlOnHost = createHostUrlOpener({ platform: 'linux', spawnProcess: recordingSpawn(calls, 'spawn-error') });
  assert.equal(await openUrlOnHost('https://example.com/'), 'spawn-failed');
});

test('the host opener reports failure when the opener starts but exits non-zero', async () => {
  const calls: SpawnCall[] = [];
  const openUrlOnHost = createHostUrlOpener({ platform: 'linux', spawnProcess: recordingSpawn(calls, { exitCode: 3 }) });
  assert.equal(await openUrlOnHost('https://example.com/'), 'spawn-failed');
});

function heldOpenChild() {
  const child = Object.assign(new EventEmitter(), { unref: () => {} }) as EventEmitter & ChildProcess;
  return { child, spawnProcess: () => child };
}

async function outcomeSoFar(pendingOutcome: Promise<HostOpenOutcome>): Promise<HostOpenOutcome | 'pending'> {
  return Promise.race([pendingOutcome, new Promise<'pending'>((resolve) => { setImmediate(() => resolve('pending')); })]);
}

test('the host opener reports opened once an opener still running outlasts the exit window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, spawnProcess } = heldOpenChild();
  const openUrlOnHost = createHostUrlOpener({ platform: 'linux', spawnProcess, exitWindowMs: 2000 });
  const pendingOutcome = openUrlOnHost('https://example.com/');
  child.emit('spawn');
  t.mock.timers.tick(1999);
  assert.equal(await outcomeSoFar(pendingOutcome), 'pending');
  t.mock.timers.tick(1);
  assert.equal(await pendingOutcome, 'opened');
});

test('the host opener ignores a non-zero exit that arrives after the exit window resolved opened', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, spawnProcess } = heldOpenChild();
  const openUrlOnHost = createHostUrlOpener({ platform: 'linux', spawnProcess });
  const pendingOutcome = openUrlOnHost('https://example.com/');
  child.emit('spawn');
  t.mock.timers.tick(2000);
  assert.equal(await pendingOutcome, 'opened');
  assert.equal(child.listenerCount('exit'), 0);
  child.emit('exit', 1, null);
  assert.equal(await pendingOutcome, 'opened');
});

test('parseOpenableUrl returns the normalized href of an absolute http or https url only', () => {
  assert.equal(parseOpenableUrl('HTTPS://Example.com'), 'https://example.com/');
  assert.equal(parseOpenableUrl('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000/x');
  assert.equal(parseOpenableUrl('data:text/html,hi'), null);
  assert.equal(parseOpenableUrl('//example.com/protocol-relative'), null);
  assert.equal(parseOpenableUrl(undefined), null);
});

test('decideOpenExternalRequest checks trust before it looks at the url', () => {
  const trusted = {
    isLoopback: true,
    trust: 'local' as const,
    origin: 'http://localhost:3000',
    listenerPorts: [3000],
    tokenOk: true,
  };
  assert.deepEqual(
    decideOpenExternalRequest({ ...trusted, requestedUrl: 'https://example.com/' }),
    { ok: true, url: 'https://example.com/' },
  );
  const notLoopback = decideOpenExternalRequest({ ...trusted, isLoopback: false, requestedUrl: 'file:///x' });
  assert.equal(notLoopback.ok ? 0 : notLoopback.status, 403);
  const remote = decideOpenExternalRequest({ ...trusted, trust: 'remote', requestedUrl: 'https://example.com/' });
  assert.equal(remote.ok ? 0 : remote.status, 403);
  const otherPort = decideOpenExternalRequest({ ...trusted, origin: 'http://localhost:5173', requestedUrl: 'https://example.com/' });
  assert.equal(otherPort.ok ? 0 : otherPort.status, 403);
});
