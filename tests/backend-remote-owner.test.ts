import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { createPairingsStore } from '../server/pairings-store.ts';
import { createRemoteAuth } from '../server/remote-auth.ts';
import { closeServer, listenOnLoopback, reserveFreePort } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const OWNER_LOGIN = 'owner@example.com';
const OWNER_HEADERS = { 'Tailscale-User-Login': OWNER_LOGIN };
const INTRUDER_HEADERS = { 'Tailscale-User-Login': 'intruder@example.com' };

interface OwnerGatedContext {
  tmpDir: string;
  previousConfigEnv: string | undefined;
  localServer: Server;
  remoteServer: Server;
  backend: Backend;
  remotePort: number;
}

const booted: { context: OwnerGatedContext | null } = { context: null };

function ctx(): OwnerGatedContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function remoteUrl(requestPath: string): string {
  return `http://127.0.0.1:${ctx().remotePort}${requestPath}`;
}

async function pairOwnerDevice(): Promise<string> {
  const minted = createPairingsStore({ filePath: path.join(ctx().tmpDir, 'pairings.json') })
    .mintPending({ name: 'owner device' });
  assert.ok(minted, 'the store minted a pending pairing');
  const res = await fetch(remoteUrl(`/pair/${minted.token}`), { redirect: 'manual', headers: OWNER_HEADERS });
  assert.equal(res.status, 303, 'the owner redeems a fresh token');
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'the redeem response mints a device cookie');
  return setCookie.split(';')[0];
}

function upgradeStatus(requestPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx().remotePort}${requestPath}`, { headers, origin: 'https://glimmervoid.test' });
    ws.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => {
      resolve(101);
      ws.close();
    });
    ws.once('error', reject);
  });
}

test.before(async () => {
  const remotePort = await reserveFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-remote-owner-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [], teams: [], repoRoots: [],
    remote: {
      enabled: true, port: remotePort, publicHost: 'glimmervoid.test',
      allowedOrigins: ['https://glimmervoid.test'], ownerLogin: 'Owner@Example.com',
    },
  }, null, 2), 'utf8');
  const previousConfigEnv = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;

  const localServer = http.createServer();
  const backend = createBackend(localServer, { staticDir: path.join(import.meta.dirname, '..', 'public') });
  localServer.on('request', backend.app);
  await listenOnLoopback(localServer);

  const remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  await listenOnLoopback(remoteServer, remotePort);

  booted.context = { tmpDir, previousConfigEnv, localServer, remoteServer, backend, remotePort };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, localServer, remoteServer, previousConfigEnv, tmpDir } = booted.context;
  backend.shutdown();
  for (const server of [localServer, remoteServer]) {
    server.closeAllConnections();
    await closeServer(server);
  }
  if (previousConfigEnv == null) delete process.env.GLIMMERVOID_CONFIG;
  if (previousConfigEnv != null) process.env.GLIMMERVOID_CONFIG = previousConfigEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a request with no Tailscale login is refused as not the owner', async () => {
  assert.equal((await fetch(remoteUrl('/'))).status, 403);
});

test('a request from another Tailscale login is refused even on the pair route', async () => {
  assert.equal((await fetch(remoteUrl('/'), { headers: INTRUDER_HEADERS })).status, 403);
  assert.equal((await fetch(remoteUrl('/pair/some-token'), { headers: INTRUDER_HEADERS })).status, 403);
});

test('the owner still needs a paired device', async () => {
  assert.equal((await fetch(remoteUrl('/'), { headers: OWNER_HEADERS })).status, 401);
});

test('the owner with a paired device reaches the dashboard', async () => {
  const cookie = await pairOwnerDevice();
  assert.equal((await fetch(remoteUrl('/index.html'), { headers: { ...OWNER_HEADERS, Cookie: cookie } })).status, 200);
});

test('a paired device cookie presented under another Tailscale login cannot open a WebSocket', async () => {
  const cookie = await pairOwnerDevice();
  assert.equal(await upgradeStatus('/control', { ...INTRUDER_HEADERS, Cookie: cookie }), 401);
  assert.equal(await upgradeStatus('/control', { ...OWNER_HEADERS, Cookie: cookie }), 101);
});

function ownerCheckLogLines(ownerLogin: string, enabled: boolean): string[] {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-remote-owner-log-'));
  const loggedLines: string[] = [];
  const remoteAuth = createRemoteAuth({
    remote: { enabled, port: 3456, publicHost: '', allowedOrigins: [], ownerLogin },
    pairingsStore: createPairingsStore({ filePath: path.join(storeDir, 'pairings.json') }),
    log: (message) => loggedLines.push(message),
  });
  remoteAuth.stop();
  fs.rmSync(storeDir, { recursive: true, force: true });
  return loggedLines.filter((line) => line.startsWith('[remote] owner check'));
}

test('an enabled remote listener logs which owner check is in force', () => {
  assert.deepEqual(ownerCheckLogLines(OWNER_LOGIN, true), [
    `[remote] owner check on: only Tailscale login ${OWNER_LOGIN} is answered`,
  ]);
  assert.deepEqual(ownerCheckLogLines('', true), [
    '[remote] owner check off: set remote.ownerLogin to answer only your Tailscale login',
  ]);
});

test('a disabled remote listener logs no owner check', () => {
  assert.deepEqual(ownerCheckLogLines(OWNER_LOGIN, false), []);
});
