import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { nextBackoffMs } from '../../shared/backoff.ts';
import { NUDGES_PATH, WATCHER_PATH_PREFIX } from '../../shared/contracts/watcher-link.ts';
import type { DoormanGithubInstallation, DoormanTenant, DoormanTenantTable } from '../../shared/contracts/doorman.ts';

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

const INSTALLATION_TOKEN_PERMISSIONS = Object.freeze({
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'read',
  metadata: 'read',
  pull_requests: 'read',
  statuses: 'read',
});
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const TOKEN_REFRESH_LEAD_MS = 10 * 60_000;
const MINT_RETRY_BASE_MS = 60_000;
const MINT_RETRY_MAX_MS = 10 * 60_000;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function githubAppJwt(clientId: string, privateKey: crypto.KeyObject, nowMs: number): string {
  const issuedAtSeconds = Math.floor(nowMs / 1000) - JWT_BACKDATE_SECONDS;
  const signedPart = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({ iat: issuedAtSeconds, exp: issuedAtSeconds + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS, iss: clientId })}`;
  return `${signedPart}.${crypto.sign('sha256', Buffer.from(signedPart), privateKey).toString('base64url')}`;
}

function installationTokenRequestBody(installation: DoormanGithubInstallation): string {
  const repositoryScope = installation.repositories.length === 0 ? {} : { repositories: installation.repositories };
  return JSON.stringify({ ...repositoryScope, permissions: INSTALLATION_TOKEN_PERMISSIONS });
}

function tokenRefreshDelayMs(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, expiresAtMs - TOKEN_REFRESH_LEAD_MS - nowMs);
}

function mintRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  return Math.max(retryAfterMs ?? 0, nextBackoffMs({ attempt, baseMs: MINT_RETRY_BASE_MS, maxMs: MINT_RETRY_MAX_MS, jitter: 'none' }));
}

export { githubAppJwt, headersAtEdge, installationTokenRequestBody, isConnectFailure, isWakeAllowed, mintRetryDelayMs, nextForwardState, routeRequest, tokenRefreshDelayMs };
export type { DoormanRoute, ForwardState };
