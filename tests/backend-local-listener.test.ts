import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend/backend.ts';
import { dashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { agentIngressBase, settleBackendShutdown } from './helpers/lanes.ts';

interface LocalListenerContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  boundPort: number;
}

const booted: { context: LocalListenerContext | null } = { context: null };

function ctx(): LocalListenerContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-local-listener-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }, null, 2), 'utf8');
  const prevEnv = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  const port = boundPort(server);

  booted.context = { tmpDir, prevEnv, server, backend, base: `http://127.0.0.1:${port}`, boundPort: port };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, prevEnv, tmpDir } = booted.context;
  await settleBackendShutdown(backend);
  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLIMMERVOID_CONFIG;
  if (prevEnv != null) process.env.GLIMMERVOID_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the hook route answers on the agent ingress listener (404 unknown-session, not 401)', async () => {
  const res = await fetch(`${await agentIngressBase(ctx().backend)}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, reason: body.reason }, { ok: false, reason: 'unknown-session' });
});

test('the dashboard port serves no agent ingress route', async () => {
  for (const ingressPath of ['/hook/no-such-session/Stop', '/agent/no-such-session/sessions', '/sign/no-such-session']) {
    const res = await fetch(`${ctx().base}${ingressPath}`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404, ingressPath);
    assert.equal((await res.text()).includes('unknown-session'), false, `${ingressPath} reached an ingress handler`);
  }
});

test('a control upgrade with no cookie connects and receives a snapshot', async () => {
  const client = await dashboardClient(ctx().boundPort);
  const ws = new WebSocket(client.url('/control'), client.options);
  const snapshot = await new Promise<{ type: string; sessions?: unknown }>((resolve, reject) => {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'snapshot') resolve(msg);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('no snapshot within 3s')), 3000).unref();
  });
  assert.equal(Array.isArray(snapshot.sessions), true);
  ws.close();
});

test('a localhost Origin on the listener port is accepted on the control upgrade', async () => {
  const port = ctx().boundPort;
  const { token } = await dashboardClient(port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/control?token=${token}`, { origin: `http://localhost:${port}` });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.close();
});

test('a foreign Origin is refused with a 401 status line', async () => {
  const port = ctx().boundPort;
  const received = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /control HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: https://evil.example',
        '', '',
      ].join('\r\n'));
    });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => { socket.destroy(); reject(new Error('socket stayed open')); }, 3000).unref();
  });
  assert.match(received, /^HTTP\/1\.1 401 /);
});

test('a data-terminal upgrade for an unknown session is still refused after the origin check', async () => {
  const client = await dashboardClient(ctx().boundPort);
  const ws = new WebSocket(client.url('/terminals/no-such-session'), client.options);
  const outcome = await new Promise<string>((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', () => resolve('error'));
    ws.on('close', () => resolve('close'));
  });

  assert.notEqual(outcome, 'error');
  ws.close();
});
