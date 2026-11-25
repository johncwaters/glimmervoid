import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import NodeWebSocket from 'ws';

import { createBackend } from '../server/backend/backend.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

const SESSION_ID = 'resend-test-session';

function waitUntil(isDone: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!isDone()) return;
      clearInterval(poll);
      resolve();
    }, 10);
  });
}

test('a dashboard request whose control socket is replaced before the answer arrives resolves with the server answer', async (testContext) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-resend-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: SESSION_ID, name: 'resend probe', path: tmpDir }], teams: [], repoRoots: [] }), 'utf8');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  const dashboardOrigin = `http://127.0.0.1:${boundPort(server)}`;
  const realFetch = globalThis.fetch;
  const browserGlobals = {
    location: new URL(`${dashboardOrigin}/`),
    fetch: (input: string, init?: RequestInit) => realFetch(new URL(input, dashboardOrigin), { ...init, headers: { origin: dashboardOrigin } }),
    WebSocket: class extends NodeWebSocket {
      constructor(url: string) {
        super(url, { origin: dashboardOrigin });
      }
    },
  };
  const previousGlobals = { location: Reflect.get(globalThis, 'location'), fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  Object.assign(globalThis, browserGlobals);
  const control = await import('../public/control-ws.ts');
  testContext.after(async () => {
    control.abandonControlSocket();
    Object.assign(globalThis, previousGlobals);
    await settleBackendShutdown(backend);
    server.closeAllConnections();
    await closeServer(server);
    if (previousConfigPath == null) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath != null) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let openedSocketCount = 0;
  control.onControlSocketChange((change) => {
    if (change === 'opened') openedSocketCount += 1;
  });
  control.connectControl();
  await waitUntil(() => openedSocketCount === 1);

  const answer = control.sendControlRequest('chat-send', { id: SESSION_ID, text: 'hello', attachments: [] }, { timeoutMs: 10000 });
  const settledAnswer = answer.then((reply) => reply, (error: Error) => error);
  control.replaceControlSocket();
  await waitUntil(() => openedSocketCount === 2);

  const reply = await settledAnswer;
  assert.ok(!(reply instanceof Error), `the request rejected: ${reply instanceof Error ? reply.message : ''}`);
  assert.equal(reply.type, 'chat-send-result');
  assert.equal(reply.id, SESSION_ID);
});
