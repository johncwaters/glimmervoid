import type { HostEntry, HostStatus } from '../../shared/contracts/hosts.ts';
import { errorMessage } from '../../shared/text.ts';
import { initialHostLink, nextHostLink } from './core/host-link-core.ts';
import type { HostLinkEffect, HostLinkEvent } from './core/host-link-core.ts';
import type { HostRoute } from './core/host-relay-core.ts';

interface OpenTunnel {
  localPort: number;
  exited: Promise<string>;
  stop(): void;
}

interface OpenHubSocket {
  hostToken: string;
  closed: Promise<string>;
  close(): void;
}

interface HostLinkDependencies {
  hubVersion: string;
  openTunnel(host: HostEntry): Promise<OpenTunnel>;
  openHubSocket(host: HostEntry, tunnelPort: number, onSnapshot: (serverBuild: string | null) => void): Promise<OpenHubSocket>;
  onStatusChange(): void;
}

function createHostLink(host: HostEntry, dependencies: HostLinkDependencies) {
  const { hubVersion, openTunnel, openHubSocket, onStatusChange } = dependencies;
  let link = initialHostLink();
  let tunnel: OpenTunnel | null = null;
  let hubSocket: OpenHubSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attemptNumber = 0;
  let isStopped = false;

  function apply(event: HostLinkEvent): void {
    if (isStopped) return;
    const transition = nextHostLink(link, event, hubVersion);
    link = transition.link;
    for (const effect of transition.effects) runEffect(effect, transition.retryDelayMs);
    onStatusChange();
  }

  function runEffect(effect: HostLinkEffect, retryDelayMs: number | null): void {
    switch (effect) {
      case 'spawn-tunnel':
        void startTunnel();
        return;
      case 'open-hub-socket':
        void startHubSocket();
        return;
      case 'close-hub-socket':
        closeHubSocket();
        return;
      case 'close-tunnel':
        closeTunnel();
        return;
      case 'schedule-retry':
        scheduleRetry(retryDelayMs ?? 0);
        return;
    }
  }

  function isCurrentAttempt(attempt: number): boolean {
    return !isStopped && attempt === attemptNumber;
  }

  async function startTunnel(): Promise<void> {
    attemptNumber += 1;
    const attempt = attemptNumber;
    try {
      const openedTunnel = await openTunnel(host);
      if (!isCurrentAttempt(attempt)) {
        openedTunnel.stop();
        return;
      }
      tunnel = openedTunnel;
      void openedTunnel.exited.then((exitReason) => {
        if (tunnel !== openedTunnel) return;
        tunnel = null;
        apply({ kind: 'link-down', error: exitReason });
      });
      apply({ kind: 'tunnel-up' });
    } catch (error) {
      if (!isCurrentAttempt(attempt)) return;
      apply({ kind: 'link-down', error: errorMessage(error) });
    }
  }

  async function startHubSocket(): Promise<void> {
    const openedTunnel = tunnel;
    if (!openedTunnel) return;
    const attempt = attemptNumber;
    const delivery: { socket: OpenHubSocket | null; earlySnapshot: { serverBuild: string | null } | null } = { socket: null, earlySnapshot: null };
    try {
      const openedSocket = await openHubSocket(host, openedTunnel.localPort, (serverBuild) => {
        if (!delivery.socket) {
          delivery.earlySnapshot = { serverBuild };
          return;
        }
        if (hubSocket === delivery.socket) apply({ kind: 'snapshot', serverBuild });
      });
      if (!isCurrentAttempt(attempt) || tunnel !== openedTunnel) {
        openedSocket.close();
        return;
      }
      hubSocket = openedSocket;
      delivery.socket = openedSocket;
      if (delivery.earlySnapshot) apply({ kind: 'snapshot', serverBuild: delivery.earlySnapshot.serverBuild });
      void openedSocket.closed.then((closeReason) => {
        if (hubSocket !== openedSocket) return;
        hubSocket = null;
        apply({ kind: 'link-down', error: closeReason });
      });
    } catch (error) {
      if (!isCurrentAttempt(attempt) || tunnel !== openedTunnel) return;
      apply({ kind: 'link-down', error: errorMessage(error) });
    }
  }

  function closeHubSocket(): void {
    const openedSocket = hubSocket;
    hubSocket = null;
    openedSocket?.close();
  }

  function closeTunnel(): void {
    const openedTunnel = tunnel;
    tunnel = null;
    openedTunnel?.stop();
  }

  function scheduleRetry(delayMs: number): void {
    if (retryTimer) clearTimeout(retryTimer);
    const timer = setTimeout(() => {
      retryTimer = null;
      apply({ kind: 'retry-due' });
    }, delayMs);
    timer.unref();
    retryTimer = timer;
  }

  function status(): HostStatus {
    return { id: host.id, name: host.name, state: link.state, hostVersion: link.hostVersion, hubVersion, lastError: link.lastError };
  }

  function route(): HostRoute | null {
    if (link.state !== 'connected' || !tunnel || !hubSocket) return null;
    return { tunnelPort: tunnel.localPort, hostDashboardPort: host.dashboardPort, hostToken: hubSocket.hostToken };
  }

  function stop(): void {
    isStopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    closeHubSocket();
    closeTunnel();
  }

  void startTunnel();
  return { status, route, stop };
}

type HostLinkHandle = ReturnType<typeof createHostLink>;

export { createHostLink };
export type { HostLinkHandle, OpenHubSocket, OpenTunnel };
