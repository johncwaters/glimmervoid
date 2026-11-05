import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend/backend.ts';
import { loadPricing } from '../server/usage/usage-pricing.ts';
import { createUsageScanner } from '../server/usage/usage-scanner.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

interface BootedHost {
  tmpDir: string;
  server: Server;
  backend: Backend;
  port: number;
}

const bootedHosts: BootedHost[] = [];
const openedSockets: WebSocket[] = [];

async function bootHost(usageWiringOptions: Record<string, unknown> = {}): Promise<BootedHost> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-remote-hosts-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }), 'utf8');
  const previousConfig = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: path.join(import.meta.dirname, '..', 'public'), usageWiringOptions });
  server.on('request', backend.app);
  const port = await listenOnLoopback(server);
  if (previousConfig == null) delete process.env.GLIMMERVOID_CONFIG;
  if (previousConfig != null) process.env.GLIMMERVOID_CONFIG = previousConfig;
  const host = { tmpDir, server, backend, port };
  bootedHosts.push(host);
  return host;
}

test.after(async () => {
  for (const socket of openedSockets) socket.terminate();
  for (const host of bootedHosts) {
    await settleBackendShutdown(host.backend);
    host.server.closeAllConnections();
    await closeServer(host.server);
    fs.rmSync(host.tmpDir, { recursive: true, force: true });
  }
});

async function pageTokenOf(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/control-token`);
  const body: { token: string } = await response.json();
  return body.token;
}

function openControlSocket(port: number, token: string, headers: Record<string, string> = {}): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/control?token=${encodeURIComponent(token)}`, { origin: `http://127.0.0.1:${port}`, headers });
  openedSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, frames }));
    socket.once('error', reject);
  });
}

async function waitForFrame(frames: Record<string, unknown>[], type: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = frames.find((candidate) => candidate.type === type);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no ${type} frame arrived`);
}

test('a control socket announcing the hub role is not counted as an open dashboard and wakes no lane', async () => {
  let usageScannersCreated = 0;
  const host = await bootHost({
    loadPricingFn: (pricingArguments: Parameters<typeof loadPricing>[0]) => loadPricing({ ...pricingArguments, fetchEnabled: false }),
    createScanner: (scannerDependencies: Parameters<typeof createUsageScanner>[0]) => {
      usageScannersCreated += 1;
      return createUsageScanner(scannerDependencies);
    },
  });
  const token = await pageTokenOf(host.port);
  const hubSocket = await openControlSocket(host.port, token, { 'X-Glimmervoid-Role': 'hub' });
  await waitForFrame(hubSocket.frames, 'snapshot');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(usageScannersCreated, 0);

  const viewerSocket = await openControlSocket(host.port, token);

  viewerSocket.socket.send(JSON.stringify({ type: 'request-health-snapshot' }));
  const snapshot = await waitForFrame(viewerSocket.frames, 'health-snapshot');
  const stats = snapshot.stats as { websockets: { control: number; hubControl: number } };
  assert.deepEqual({ control: stats.websockets.control, hubControl: stats.websockets.hubControl }, { control: 2, hubControl: 1 });
});
