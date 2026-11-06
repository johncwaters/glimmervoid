import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend/backend.ts';
import { sshTunnelArgs } from '../server/hosts/core/host-link-core.ts';
import type { SpawnHostTunnel } from '../server/hosts/host-links-wiring.ts';
import { HostEntry } from '../shared/contracts/hosts.ts';
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

async function bootHost({ usageWiringOptions = {}, hosts, spawnHostTunnel, extraConfig = {} }: {
  usageWiringOptions?: Record<string, unknown>;
  hosts?: HostEntry[];
  spawnHostTunnel?: SpawnHostTunnel;
  extraConfig?: Record<string, unknown>;
} = {}): Promise<BootedHost> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-remote-hosts-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [], teams: [], repoRoots: [], ...(hosts ? { hosts } : {}), ...extraConfig }), 'utf8');
  const previousConfig = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: path.join(import.meta.dirname, '..', 'public'), usageWiringOptions, spawnHostTunnel });
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
  for (const host of bootedHosts.toReversed()) {
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

function openControlSocket(port: number, token: string, headers: Record<string, string> = {}, path = '/control'): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`, { origin: `http://127.0.0.1:${port}`, headers });
  openedSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, frames }));
    socket.once('error', reject);
  });
}

async function waitForFrame(frames: Record<string, unknown>[], type: string, isWanted: (frame: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const frame = frames.find((candidate) => candidate.type === type && isWanted(candidate));
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no matching ${type} frame arrived`);
}

function createLoopbackTunnels(): { spawnHostTunnel: SpawnHostTunnel; dropAll(): void } {
  const dropByTunnel = new Set<() => void>();
  const spawnHostTunnel: SpawnHostTunnel = (host, localPort) => {
    const pipedSockets = new Set<net.Socket>();
    const listener = net.createServer((client) => {
      const upstream = net.connect(host.dashboardPort, '127.0.0.1');
      for (const socket of [client, upstream]) {
        pipedSockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => { client.destroy(); upstream.destroy(); });
      }
      client.pipe(upstream).pipe(client);
    });
    let reportExit: (reason: string) => void = () => {};
    const exited = new Promise<string>((resolve) => { reportExit = resolve; });
    const drop = (reason: string) => {
      dropByTunnel.delete(dropTunnel);
      listener.close();
      for (const socket of pipedSockets) socket.destroy();
      reportExit(reason);
    };
    const dropTunnel = () => drop('Connection to devbox closed by remote host.');
    dropByTunnel.add(dropTunnel);
    listener.listen(localPort, '127.0.0.1');
    return { exited, stop: () => drop('stopped') };
  };
  return { spawnHostTunnel, dropAll: () => { for (const dropTunnel of [...dropByTunnel]) dropTunnel(); } };
}

function hostStateIs(state: string) {
  return (frame: Record<string, unknown>) => (frame.hosts as Array<{ state: string }>).some((host) => host.state === state);
}

test('a control socket announcing the hub role is not counted as an open dashboard and wakes no lane', async () => {
  let usageScannersCreated = 0;
  const host = await bootHost({
    usageWiringOptions: {
      loadPricingFn: (pricingArguments: Parameters<typeof loadPricing>[0]) => loadPricing({ ...pricingArguments, fetchEnabled: false }),
      createScanner: (scannerDependencies: Parameters<typeof createUsageScanner>[0]) => {
        usageScannersCreated += 1;
        return createUsageScanner(scannerDependencies);
      },
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

test('the ssh tunnel never prompts, never trusts an unknown key, and keeps the target out of option parsing', () => {
  const host = HostEntry.parse({ id: 'devbox', name: 'Devbox', sshTarget: 'me@devbox', dashboardPort: 3000 });
  const argv = sshTunnelArgs(host, 41000);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes']) assert.ok(argv.includes(option), option);
  assert.deepEqual(argv.slice(-2), ['--', 'me@devbox']);
  assert.equal(HostEntry.safeParse({ ...host, sshTarget: '-oProxyCommand=touch /tmp/pwned' }).success, false);
});

test('the hub links a registered host, reconnects after the tunnel drops, and pipes a browser socket through to it', async () => {
  const devbox = await bootHost();
  const tunnels = createLoopbackTunnels();
  const hub = await bootHost({
    hosts: [{ id: 'devbox', name: 'Devbox', sshTarget: 'devbox', dashboardPort: devbox.port }],
    spawnHostTunnel: tunnels.spawnHostTunnel,
  });
  const viewer = await openControlSocket(hub.port, await pageTokenOf(hub.port));

  const connected = await waitForFrame(viewer.frames, 'hosts-status', hostStateIs('connected'));
  const [status] = connected.hosts as Array<{ id: string; hostVersion: string; hubVersion: string; lastError: string | null }>;
  assert.equal(status.id, 'devbox');
  assert.equal(status.hostVersion, status.hubVersion);

  viewer.frames.length = 0;
  tunnels.dropAll();
  const reconnecting = await waitForFrame(viewer.frames, 'hosts-status', hostStateIs('reconnecting'));
  assert.ok((reconnecting.hosts as Array<{ lastError: string | null }>)[0].lastError);
  await waitForFrame(viewer.frames, 'hosts-status', hostStateIs('connected'));

  const hubToken = await pageTokenOf(hub.port);
  const piped = await openControlSocket(hub.port, hubToken, {}, '/hosts/devbox/control');
  const pipedHealth = await waitForFrame(piped.frames, 'health-snapshot');
  assert.equal((pipedHealth.stats as { websockets: { hubControl: number } }).websockets.hubControl, 1);
  await assert.rejects(openControlSocket(hub.port, hubToken, {}, '/hosts/gpu/control'), /503/);
  await assert.rejects(openControlSocket(hub.port, 'wrong-token', {}, '/hosts/devbox/control'), /401|403|socket hang up|Unexpected server response/);
});

function captureTelegramSends(): string[] {
  const sentTexts: string[] = [];
  const fakeRequest = (_url: string, _options: unknown, onResponse: (response: EventEmitter & { statusCode: number; resume(): void; setEncoding(): void }) => void) => {
    const request = Object.assign(new EventEmitter(), { body: '', write(chunk: string) { request.body += chunk; }, setTimeout() {}, destroy() {}, end() {
      sentTexts.push(JSON.parse(request.body).text);
      const response = Object.assign(new EventEmitter(), { statusCode: 200, resume() {}, setEncoding() {} });
      onResponse(response);
      setImmediate(() => { response.emit('data', '{"ok":true}'); response.emit('end'); });
    } });
    return request;
  };
  Object.assign(https, { request: fakeRequest });
  return sentTexts;
}

test('a session that starts waiting before the hub links, on a host with no Telegram of its own, reaches the hub Telegram named by host', async () => {
  const sentTexts = captureTelegramSends();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-remote-project-'));
  const devbox = await bootHost({ extraConfig: { projects: [{ id: 'remote-one', name: 'remote one', path: projectDir }], phoneEscalationMs: 50, autoResume: false } });
  devbox.backend.getSession('remote-one')?.emit('state-change', { from: 'RUNNING', to: 'WAITING', event: 'hook:notification', detail: null });
  const tunnels = createLoopbackTunnels();
  const hub = await bootHost({
    hosts: [{ id: 'devbox', name: 'Devbox', sshTarget: 'devbox', dashboardPort: devbox.port }],
    spawnHostTunnel: tunnels.spawnHostTunnel,
    extraConfig: { notifyDebounceMs: 10, telegramNotifications: true, telegram: { botToken: 'hub-bot', chatId: '1' } },
  });
  const viewer = await openControlSocket(hub.port, await pageTokenOf(hub.port));
  await waitForFrame(viewer.frames, 'hosts-status', hostStateIs('connected'));

  for (let attempt = 0; attempt < 100 && sentTexts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sentTexts, ['Devbox: remote one needs your input']);
  fs.rmSync(projectDir, { recursive: true, force: true });
});
