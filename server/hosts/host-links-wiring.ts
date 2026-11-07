import net from 'node:net';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { HubPhoneAlertFrame } from '../../shared/contracts/hosts.ts';
import type { HostEntry, HostStatus } from '../../shared/contracts/hosts.ts';
import { spawn } from '../child-process-safe.ts';
import { sshTunnelArgs } from './core/host-link-core.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { isSameHostEntry } from './core/host-registry-core.ts';
import { createHostLink } from './host-link-poller.ts';
import { relayUpgradeToHost } from './host-relay.ts';
import { hostUpgradeTarget } from '../core/upgrade-route.ts';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HostLinkHandle, HubSocketFrameHandlers, OpenHubSocket, OpenTunnel } from './host-link-poller.ts';

const HUB_ROLE_HEADERS = Object.freeze({ 'X-Glimmervoid-Role': 'hub' });
const TUNNEL_READY_TIMEOUT_MS = 20000;
const TUNNEL_READY_POLL_MS = 150;
const HOST_REQUEST_TIMEOUT_MS = 10000;
const STDERR_TAIL_CHARS = 2000;

const ControlTokenReply = z.object({ token: z.string().min(1) });
const SnapshotBuild = z.object({ type: z.literal('snapshot'), serverBuild: z.string().nullable() });

interface TunnelProcess {
  exited: Promise<string>;
  stop(): void;
}

type SpawnHostTunnel = (host: HostEntry, localPort: number) => TunnelProcess;

interface HostsStatusFrame {
  type: 'hosts-status';
  hosts: HostStatus[];
  [key: string]: unknown;
}

function lastNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

function spawnSshTunnel(host: HostEntry, localPort: number): TunnelProcess {
  const child = spawn('ssh', sshTunnelArgs(host, localPort), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<string>((resolve) => {
    child.once('error', (error) => resolve(`ssh could not start: ${error.message}`));
    child.once('close', (code, signal) => resolve(lastNonEmptyLine(stderrTail) || `ssh exited (${signal ?? code})`));
  });
  return { exited, stop: () => { child.kill(); } };
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

async function waitUntilListening(port: number, exited: Promise<string>): Promise<void> {
  let exitReason: string | null = null;
  void exited.then((reason) => { exitReason = reason; });
  const deadline = Date.now() + TUNNEL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitReason !== null) throw new Error(exitReason);
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, TUNNEL_READY_POLL_MS));
  }
  throw new Error(`ssh tunnel did not open within ${TUNNEL_READY_TIMEOUT_MS / 1000} s`);
}

async function fetchHostToken(tunnelPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${tunnelPort}/control-token`, { signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`host refused the control token (HTTP ${response.status})`);
  const reply = ControlTokenReply.safeParse(await response.json());
  if (!reply.success) throw new Error('host sent no control token');
  return reply.data.token;
}

function openHubSocket(host: HostEntry, tunnelPort: number, frames: HubSocketFrameHandlers): Promise<OpenHubSocket> {
  return fetchHostToken(tunnelPort).then((hostToken) => new Promise<OpenHubSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${tunnelPort}/control?token=${encodeURIComponent(hostToken)}`, {
      origin: `http://127.0.0.1:${host.dashboardPort}`,
      headers: { ...HUB_ROLE_HEADERS },
    });
    const openDeadline = setTimeout(() => socket.terminate(), HOST_REQUEST_TIMEOUT_MS);
    let hasSeenSnapshot = false;
    socket.on('message', (raw: Buffer) => {
      const frame = parseJsonOrNull(raw.toString('utf8'));
      const phoneAlert = HubPhoneAlertFrame.safeParse(frame);
      if (phoneAlert.success) {
        frames.onPhoneAlert(phoneAlert.data.text);
        return;
      }
      if (hasSeenSnapshot) return;
      const snapshot = SnapshotBuild.safeParse(frame);
      if (!snapshot.success) return;
      hasSeenSnapshot = true;
      frames.onSnapshot(snapshot.data.serverBuild);
    });
    const closed = new Promise<string>((resolveClosed) => {
      socket.once('close', (code) => resolveClosed(`host connection closed (${code})`));
    });
    socket.once('error', (error) => { clearTimeout(openDeadline); reject(error); });
    socket.once('close', () => { clearTimeout(openDeadline); reject(new Error('host closed the connection before it opened')); });
    socket.once('open', () => { clearTimeout(openDeadline); resolve({ hostToken, closed, close: () => socket.terminate() }); });
  }));
}

function createHostLinksWiring({ hosts, hubBuild, broadcast, relayPhoneAlert, spawnHostTunnel = spawnSshTunnel }: {
  hosts: readonly HostEntry[];
  hubBuild: string;
  broadcast: (frame: HostsStatusFrame) => void;
  relayPhoneAlert: (hostName: string, text: string) => void;
  spawnHostTunnel?: SpawnHostTunnel;
}) {
  const linkById = new Map<string, HostLinkHandle>();
  const startingTunnels = new Set<TunnelProcess>();
  let lastBroadcastJson = '';
  let isStopped = false;

  async function openTunnel(host: HostEntry): Promise<OpenTunnel> {
    const localPort = await reserveLoopbackPort();
    if (isStopped) throw new Error('host links stopped');
    const tunnel = spawnHostTunnel(host, localPort);
    startingTunnels.add(tunnel);
    try {
      await waitUntilListening(localPort, tunnel.exited);
    } catch (error) {
      tunnel.stop();
      throw error;
    } finally {
      startingTunnels.delete(tunnel);
    }
    return { localPort, exited: tunnel.exited, stop: tunnel.stop };
  }

  function statusFrame(): HostsStatusFrame {
    const statuses = [...linkById.values()].map((link) => link.status());
    statuses.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id));
    return { type: 'hosts-status', hosts: statuses };
  }

  function broadcastIfChanged(): void {
    const frame = statusFrame();
    const frameJson = JSON.stringify(frame);
    if (frameJson === lastBroadcastJson) return;
    lastBroadcastJson = frameJson;
    broadcast(frame);
  }

  function startLink(host: HostEntry): HostLinkHandle {
    return createHostLink(host, {
      hubBuild, openTunnel, openHubSocket, onStatusChange: broadcastIfChanged,
      onPhoneAlert: (alertingHost, text) => relayPhoneAlert(alertingHost.name, text),
    });
  }

  function reconcile(nextHosts: readonly HostEntry[]): void {
    if (isStopped) return;
    const nextById = new Map(nextHosts.map((host) => [host.id, host]));
    for (const [hostId, link] of linkById) {
      const nextHost = nextById.get(hostId);
      if (nextHost && isSameHostEntry(link.host, nextHost)) continue;
      link.stop();
      linkById.delete(hostId);
    }
    for (const host of nextHosts) {
      if (!linkById.has(host.id)) linkById.set(host.id, startLink(host));
    }
    broadcastIfChanged();
  }

  reconcile(hosts);

  function relayUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = hostUpgradeTarget(request.url);
    const route = target ? linkById.get(target.hostId)?.route() ?? null : null;
    relayUpgradeToHost({ request, socket, head, upstreamPath: target?.upstreamPath ?? '', route });
  }

  return {
    statusFrame,
    reconcile,
    relayUpgrade,
    stop(): void {
      isStopped = true;
      for (const tunnel of startingTunnels) tunnel.stop();
      startingTunnels.clear();
      for (const link of linkById.values()) link.stop();
      linkById.clear();
    },
  };
}

export { createHostLinksWiring };
export type { SpawnHostTunnel };
