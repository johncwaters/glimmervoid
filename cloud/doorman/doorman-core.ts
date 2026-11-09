import type { IncomingHttpHeaders } from 'node:http';
import { NUDGES_PATH, WATCHER_PATH_PREFIX } from '../../shared/contracts/watcher-link.ts';
import type { DoormanTenant, DoormanTenantTable } from '../../shared/contracts/doorman.ts';

type DoormanRoute =
  | { kind: 'watcher'; tenant: DoormanTenant }
  | { kind: 'forward'; tenant: DoormanTenant }
  | { kind: 'refuse'; status: 404 | 421 };

type ForwardState = 'answering' | 'waking' | 'unreachable';
type ForwardEvent = 'connectFailed' | 'connected' | 'holdTimedOut' | 'cooldownPassedAndRequest';

const FORWARD_TRANSITIONS: Readonly<Record<ForwardState, Partial<Record<ForwardEvent, ForwardState>>>> = Object.freeze({
  answering: { connectFailed: 'waking' },
  waking: { connected: 'answering', holdTimedOut: 'unreachable' },
  unreachable: { cooldownPassedAndRequest: 'waking', connected: 'answering' },
});

const TAILSCALE_HEADER_PREFIX = 'tailscale-';
const FORWARDED_HEADER_NAMES = Object.freeze(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']);

function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader === '') return null;
  const parsedHost = URL.parse(`http://${hostHeader}`);
  return parsedHost === null ? null : parsedHost.hostname.toLowerCase();
}

function tenantFor(table: DoormanTenantTable, hostHeader: string | undefined): DoormanTenant | null {
  if (table.tenantDomain === null) return table.tenants[0] ?? null;
  const hostname = hostnameOf(hostHeader);
  const tenantSuffix = `.${table.tenantDomain}`;
  if (hostname === null || !hostname.endsWith(tenantSuffix)) return null;
  const slug = hostname.slice(0, -tenantSuffix.length);
  return table.tenants.find((tenant) => tenant.slug === slug) ?? null;
}

function routeRequest(table: DoormanTenantTable, hostHeader: string | undefined, pathname: string): DoormanRoute {
  const tenant = tenantFor(table, hostHeader);
  if (tenant === null) return { kind: 'refuse', status: 421 };
  if (pathname === NUDGES_PATH) return { kind: 'refuse', status: 404 };
  if (pathname.startsWith(WATCHER_PATH_PREFIX)) return { kind: 'watcher', tenant };
  return { kind: 'forward', tenant };
}

function nextForwardState(state: ForwardState, event: ForwardEvent): ForwardState {
  return FORWARD_TRANSITIONS[state][event] ?? state;
}

function isWakeAllowed(lastWakeAtMs: number | null, nowMs: number, wakeCooldownMs: number): boolean {
  return lastWakeAtMs === null || nowMs - lastWakeAtMs >= wakeCooldownMs;
}

function headersAtEdge(headers: IncomingHttpHeaders, isBehindTlsEdge: boolean): IncomingHttpHeaders {
  const withoutIdentity = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(TAILSCALE_HEADER_PREFIX)));
  if (isBehindTlsEdge) return withoutIdentity;
  const edgeHeaders = Object.fromEntries(Object.entries(withoutIdentity).filter(([name]) => !FORWARDED_HEADER_NAMES.includes(name)));
  return { ...edgeHeaders, 'x-forwarded-proto': 'http' };
}

function isConnectFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT';
}

export { headersAtEdge, isConnectFailure, isWakeAllowed, nextForwardState, routeRequest };
export type { DoormanRoute, ForwardState };
