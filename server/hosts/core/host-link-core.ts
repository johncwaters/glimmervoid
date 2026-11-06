import type { HostEntry, HostLinkState } from '../../../shared/contracts/hosts.ts';

const FAILURES_BEFORE_UNREACHABLE = 3;
const FIRST_RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 60000;
const SELF_LINK_ERROR = 'this host is the Glimmervoid you are using; remove it and link another machine';

interface HostLink {
  state: HostLinkState;
  consecutiveFailures: number;
  hostVersion: string | null;
  lastError: string | null;
}

type HostLinkEvent =
  | { kind: 'tunnel-up' }
  | { kind: 'snapshot'; serverBuild: string | null }
  | { kind: 'link-down'; error: string }
  | { kind: 'retry-due' };

type HostLinkEffect = 'spawn-tunnel' | 'open-hub-socket' | 'close-hub-socket' | 'close-tunnel' | 'schedule-retry';

interface HostLinkTransition {
  link: HostLink;
  effects: HostLinkEffect[];
  retryDelayMs: number | null;
}

function sshTunnelArgs(host: HostEntry, localPort: number): string[] {
  return [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${host.dashboardPort}`,
    '--', host.sshTarget,
  ];
}

function versionPart(serverBuild: string | null): string | null {
  if (!serverBuild) return null;
  const buildSeparatorIndex = serverBuild.indexOf('+');
  return buildSeparatorIndex === -1 ? serverBuild : serverBuild.slice(0, buildSeparatorIndex);
}

function retryDelayAfter(consecutiveFailures: number): number {
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1), MAX_RETRY_DELAY_MS);
}

function initialHostLink(): HostLink {
  return { state: 'connecting', consecutiveFailures: 0, hostVersion: null, lastError: null };
}

function onSnapshot(serverBuild: string | null, hubBuild: string): HostLinkTransition {
  const hostVersion = versionPart(serverBuild);
  if (serverBuild === hubBuild) {
    return { link: { state: 'unreachable', consecutiveFailures: 0, hostVersion, lastError: SELF_LINK_ERROR }, effects: ['close-hub-socket', 'close-tunnel'], retryDelayMs: null };
  }
  if (hostVersion !== versionPart(hubBuild)) {
    return { link: { state: 'version-differs', consecutiveFailures: 0, hostVersion, lastError: null }, effects: ['close-hub-socket', 'schedule-retry'], retryDelayMs: MAX_RETRY_DELAY_MS };
  }
  return { link: { state: 'connected', consecutiveFailures: 0, hostVersion, lastError: null }, effects: [], retryDelayMs: null };
}

function onLinkDown(link: HostLink, error: string): HostLinkTransition {
  const consecutiveFailures = link.consecutiveFailures + 1;
  const state = consecutiveFailures >= FAILURES_BEFORE_UNREACHABLE ? 'unreachable' : 'reconnecting';
  return {
    link: { ...link, state, consecutiveFailures, lastError: error },
    effects: ['close-hub-socket', 'close-tunnel', 'schedule-retry'],
    retryDelayMs: retryDelayAfter(consecutiveFailures),
  };
}

function nextHostLink(link: HostLink, event: HostLinkEvent, hubBuild: string): HostLinkTransition {
  switch (event.kind) {
    case 'tunnel-up':
      return { link, effects: ['open-hub-socket'], retryDelayMs: null };
    case 'snapshot':
      return onSnapshot(event.serverBuild, hubBuild);
    case 'link-down':
      return onLinkDown(link, event.error);
    case 'retry-due':
      return { link, effects: [link.state === 'version-differs' ? 'open-hub-socket' : 'spawn-tunnel'], retryDelayMs: null };
  }
}

export { initialHostLink, nextHostLink, sshTunnelArgs, versionPart };
export type { HostLinkEffect, HostLinkEvent };
