import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend.ts';
import { createBackendHttpApp } from '../server/backend-http.ts';
import type { OutcomeName } from '../shared/outcome-names.ts';
import type { Session } from '../session/sessions.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'hook-route-session';

interface HookRouteContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  session: Session;
  token: string;
}

const booted: { context: HookRouteContext | null } = { context: null };

function ctx(): HookRouteContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-hookroute-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'hook route', path: projectDir }],
    teams: [],
    repoRoots: [],
    millEnabled: false,
    autoResume: false,
  }, null, 2), 'utf8');
  const prevEnv = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });

  server.on('request', backend.app);
  await listenOnLoopback(server);

  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the boot loop created the configured session');
  session._hooks.inject();
  const token = session._hooks.token();
  assert.ok(token, 'hook injection produced a token');

  booted.context = { tmpDir, prevEnv, server, backend, base: `http://127.0.0.1:${boundPort(server)}`, session, token };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, prevEnv, tmpDir } = booted.context;
  backend.shutdown();

  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLIMMERVOID_CONFIG;
  if (prevEnv != null) process.env.GLIMMERVOID_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unknown session id is rejected 404 with ok:false', async () => {
  const res = await fetch(`${ctx().base}/hook/no-such-session/Stop`, {
    method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'unknown-session');
});

test('missing and bad tokens are rejected', async () => {
  const noToken = await fetch(`${ctx().base}/hook/any/Stop`, { method: 'POST', body: '{}' });
  assert.notEqual(noToken.status, 200, 'no token never yields 200');
  const badToken = await fetch(`${ctx().base}/hook/any/Stop?t=wrong-token`, { method: 'POST', body: '{}' });
  assert.notEqual(badToken.status, 200, 'bad token never yields 200');
});

test('a rejected hook call logs nothing carrying its token, session id or body', async () => {
  const { base } = ctx();
  const secretToken = 'glimmervoid-fake-bearer-DO-NOT-LOG-9f3c1a';
  const secretBody = JSON.stringify({ transcript_path: '/home/someone/never-logged.jsonl' });
  const captured: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const realError = console.error;
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  try {
    const rejected = await fetch(`${base}/hook/${SESSION_ID}/Stop?t=${encodeURIComponent(secretToken)}`, {
      method: 'POST', body: secretBody, headers: { 'content-type': 'application/json' },
    });
    assert.equal(rejected.status, 403);
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
  }

  const everythingLogged = captured.join('\n');
  assert.equal(everythingLogged.includes(secretToken), false, 'the presented token is never logged');
  assert.equal(everythingLogged.includes(SESSION_ID), false, 'the session id is never logged');
  assert.equal(everythingLogged.includes('never-logged.jsonl'), false, 'the request body is never logged');
});

function offLoopbackEndpoint(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\glimmervoid-hookroute-${process.pid}`;
  return path.join(os.tmpdir(), `glimmervoid-hookroute-${process.pid}.sock`);
}

function postOverEndpoint(endpoint: string, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: endpoint, path: requestPath, method: 'POST', headers: { host: 'localhost' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

test('a hook call arriving off loopback is refused under its own outcome name', async () => {
  const recorded: OutcomeName[] = [];
  const app = createBackendHttpApp({
    staticDir: null,
    configStore: { configPath: path.join(ctx().tmpDir, 'config.json') },
    remote: { allowedOrigins: [] },
    remoteAuth: null,
    allowedHosts: [],
    listenerPortsFor: () => [],
    pageToken: 'page-token',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: () => null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    recordOutcome: (name) => { recorded.push(name); },
    logger: { warn: () => {} },
  });
  const endpoint = offLoopbackEndpoint();
  fs.rmSync(endpoint, { force: true });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => { server.listen(endpoint, () => resolve()); });

  try {
    assert.equal(await postOverEndpoint(endpoint, `/hook/${SESSION_ID}/Stop`), 403);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }

  assert.deepEqual(recorded, ['hookRejectedNonLoopback']);
});

test('successful hook callbacks answer only ok and reason', async () => {
  const { base, token } = ctx();
  const res = await fetch(`${base}/hook/${SESSION_ID}/NotARealHook?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'reason']);
  assert.equal(body.ok, true);
  assert.equal(body.reason, 'ignored-event');
});

test('malformed JSON body is tolerated (route answers, does not throw)', async () => {
  const res = await fetch(`${ctx().base}/hook/no-such-session/Stop`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 404, 'body parse failure falls back to {} and the route still answers');
});

test('oversize body (>64KB) is aborted and the server survives', async () => {
  const { base } = ctx();
  const big = 'x'.repeat(70 * 1024);

  await fetch(`${base}/hook/no-such-session/Stop`, { method: 'POST', body: big })
    .then((res) => assert.notEqual(res.status, 200, 'oversize never yields 200'))
    .catch(() => {  });

  const after = await fetch(`${base}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(after.status, 404, 'server is still alive and routing after the aborted request');
});
