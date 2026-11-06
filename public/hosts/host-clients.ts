import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { HostStatus } from '#shared/contracts/hosts.ts';
import { createControlClient, setControlRouter } from '../control-ws.ts';
import type { ControlClient } from '../control-ws.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { hostOfSession, rememberSessionHost } from './session-hosts.ts';

const clientByHostId = new Map<string, ControlClient>();
let dispatchRemoteFrame: (hostId: string, message: ServerMessage) => void = () => {};

const disconnectedHostClient: ControlClient = {
  connect: () => {},
  abandon: () => {},
  reconnectNow: () => {},
  send: () => false,
  request: () => Promise.reject(new Error(NOT_CONNECTED_TEXT)),
};

function sessionIdOf(message: Record<string, unknown>): string | null {
  if (typeof message.id === 'string') return message.id;
  if (typeof message.sessionId === 'string') return message.sessionId;
  return null;
}

setControlRouter((message) => {
  const sessionId = sessionIdOf(message);
  const hostId = sessionId ? hostOfSession(sessionId) : null;
  if (!hostId) return null;
  return clientByHostId.get(hostId) ?? disconnectedHostClient;
}, () => [...clientByHostId.values()]);

export function setRemoteFrameDispatcher(dispatch: (hostId: string, message: ServerMessage) => void) {
  dispatchRemoteFrame = dispatch;
}

function openHostClient(hostId: string): ControlClient {
  const client = createControlClient({
    pathPrefix: `/hosts/${encodeURIComponent(hostId)}`,
    isLocal: false,
    onMessage: (message) => {
      if (message.type === 'session-added') rememberSessionHost(message.id, hostId);
      dispatchRemoteFrame(hostId, message);
    },
  });
  client.connect();
  return client;
}

export function syncHostClients(statuses: readonly HostStatus[]): string[] {
  const connectedIds = new Set(statuses.filter((status) => status.state === 'connected').map((status) => status.id));
  const closedHostIds: string[] = [];
  for (const [hostId, client] of [...clientByHostId]) {
    if (connectedIds.has(hostId)) continue;
    client.abandon();
    clientByHostId.delete(hostId);
    closedHostIds.push(hostId);
  }
  for (const hostId of connectedIds) {
    if (!clientByHostId.has(hostId)) clientByHostId.set(hostId, openHostClient(hostId));
  }
  return closedHostIds;
}
